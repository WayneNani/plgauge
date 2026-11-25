/**
 * Orchestrates a coverage run against a database:
 *
 *  1. baseline test runs without coverage (timing; twice by default), after a warm-up run
 *     (optional: without it the first baseline run warms up and is not timed)
 *  2. baseline test run with utPLSQL's own coverage (line coverage for comparison; optional);
 *     a test whose result changes across 1 and 2 is flaky
 *  3. instrument + compile all code objects of the schema
 *  4. test run on instrumented code, flush probes
 *  5. restore original code (always, also on failure)
 *  6. compare test results of 1 and 4 (instrumentation must not change behaviour;
 *     flaky tests left aside)
 *
 * With runCommand, step 4 starts that command instead of utPLSQL and measures what other
 * sessions run meanwhile (UI tests against ORDS, say); steps 1, 2 and 6 are left out.
 */
import oracledb from 'oracledb';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  connect, contextName, databaseInfo, dbIdent, failureSummary, firstLine, utInfoContext, restoreJournal, ensureJournal, journalEntries, loadObjects, lockRun, replaceSourceDetailed, restoreAll, RUN_LOCK, runScript, runTestHooks, sha256, splitScript,
  runTestsJunit as runTests, suiteTests, tryExecute, type ConnectConfig, type SourceObject, type TestCase, type TestRun,
} from '@plgauge/core';
import { instrument } from './instrument.js';
import { analyze, type ObjectResult } from './analyze.js';
import { newIds, type Hits, type ObjectMap, type TestHits, type TestInfo } from './model.js';
import { HITS_TABLE, LOGOFF_TRIGGER, RUNS_TABLE, RUNTIME_SPEC, runtimeBody } from './runtime.js';

export interface RunConfig {
  user: string;
  password: string;
  connectString: string;
  /** Schema whose code is measured. */
  schema: string;
  /**
   * Several schemas (A4): code objects of all of them are measured, the runtime cov$ stays in
   * runtimeSchema (default: the connected user) and is called qualified. Needs CREATE ANY
   * PROCEDURE (TYPE, TRIGGER for those) and GRANT on cov$; see README.
   */
  schemas?: string[];
  runtimeSchema?: string;
  /** utPLSQL suite paths to run, e.g. ["demo"]. */
  tests: string[];
  /** Optional regular expressions to include / exclude objects, tested on NAME; a pattern with an escaped dot (\.) on OWNER.NAME. */
  include?: string;
  exclude?: string;
  /** "auto" enables SQL probes on 23ai and later. */
  sqlProbes?: 'auto' | boolean;
  /** Record which test reaches which probe (default true). */
  perTest?: boolean;
  /** Test runs without coverage before measuring (default 2); a test whose result changes is flaky. */
  baselineRuns?: number;
  /** A warm-up test run before the baseline (default true); without it the first baseline run warms up. */
  warmup?: boolean;
  /** A test run with utPLSQL's own coverage (DBMS_PROFILER) for the line-rate comparison (default true). */
  utplsqlCompare?: boolean;
  /**
   * Scripts (paths) the run installs first, under the run lock and after restoring what a
   * crashed run left: installed earlier, they would be overwritten by those old originals.
   */
  installScripts?: string[];
  /**
   * Scripts (paths) run once before the objects are read and tested (test seams: synonyms to
   * mocks, say) and once at the very end, after the originals are back, also when the run fails
   * or is cancelled (not after a hard kill).
   */
  beforeTests?: string[];
  afterTests?: string[];
  /** Exit with code 5 (CLI) when tests fail or error already without instrumentation. */
  failOnTestErrors?: boolean;
  /**
   * Instead of utPLSQL, the measuring run starts this command (program and arguments) and counts
   * what other sessions execute until it ends: UI or API tests against ORDS, say. There is no
   * baseline, warm-up, utPLSQL comparison or equivalence check, and `tests` may be empty. Needs
   * CREATE ANY CONTEXT: pooled sessions reset their package state after every request.
   */
  runCommand?: string[];
  /**
   * A regular expression on USERENV CLIENT_PROGRAM_NAME: only other sessions whose program
   * matches count, e.g. "^Oracle REST Data Services$" for APEX and ORDS requests without the
   * scripts that prepare their data. Default: every other session.
   */
  backgroundProgram?: string;
}

export type { TestCase, TestRun } from '@plgauge/core';

export interface RunReport {
  generated: string;
  database: string;
  schema: string;
  sqlProbes: boolean;
  /** baselineMs is missing when no baseline run was warm, utplsqlCoverageMs without the utPLSQL run. */
  timings: { baselineMs?: number; utplsqlCoverageMs?: number; instrumentedMs: number; instrumentMs: number; compileMs: number };
  baseline: TestRun;
  /** Test run with utPLSQL's own coverage (DBMS_PROFILER + DBMS_PLSQL_CODE_COVERAGE); missing when skipped. */
  utplsqlRun?: TestRun;
  instrumentedRun: TestRun;
  /** Same results with and without instrumentation, flaky tests left aside. */
  equivalent: boolean;
  /** Tests ("suite::name") whose result changed between runs without our instrumentation. */
  flakyTests?: string[];
  /** Stable tests whose result differs with instrumentation: "suite::name: before → after". */
  differingTests?: string[];
  /** Tests of the run; per-test coverage refers to indices into this list. */
  tests: TestInfo[];
  perTest: boolean;
  /** Runs without coverage before measuring. */
  baselineRuns?: number;
  /** Whether the warm-up run and the utPLSQL run took place (missing in older reports: both did). */
  warmup?: boolean;
  utplsqlCompare?: boolean;
  objects: ObjectResult[];
  log: string[];
  /** Objects whose originals did not go back at the end (their entries stay in the journal). */
  unrestored?: number;
  /** An afterTests script failed: the test seams may still be switched. */
  afterTestsFailed?: string;
  /** The run measured a runCommand instead of utPLSQL tests: the command and its exit code. */
  runCommand?: { command: string[]; exitCode: number | null };
}

/** The global context in which other sessions keep their keys (one per runtime schema). */
export function coverageContextName(schema: string): string {
  return `PLGAUGE_COV_${createHash('sha256').update(schema.toUpperCase()).digest('hex').slice(0, 12).toUpperCase()}`;
}

/** Runs the command of runCommand with the terminal attached; resolves with its exit code. */
function runExternal(command: string[]): Promise<{ run: TestRun; exitCode: number | null }> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve({ run: { tests: [], ms: performance.now() - t0 }, exitCode: code }));
  });
}

export async function runCoverage(cfg: RunConfig, log: (m: string) => void = console.error): Promise<RunReport> {
  const messages: string[] = [];
  const say = (m: string) => { messages.push(m); log(m); };
  const schema = cfg.schema.toUpperCase();
  const multi = !!cfg.schemas?.length;
  const schemas = multi ? cfg.schemas!.map((s) => s.toUpperCase()) : [schema];
  const rtOwner = (multi ? cfg.runtimeSchema ?? cfg.user : schema).toUpperCase();
  // a connection of its own in the schema of the journal (rtOwner), closed again if then fails
  const connectHome = async (then?: (c: oracledb.Connection) => Promise<void>, callTimeout?: number) => {
    const c = await connect(cfg);
    if (callTimeout) c.callTimeout = callTimeout;
    try {
      await c.execute(`alter session set current_schema = ${dbIdent(rtOwner)}`);
      await then?.(c);
      return c;
    } catch (e) {
      await c.close().catch(() => {});
      throw e;
    }
  };
  // the run lock (shared with mutation runs), held to the end, where a mutation run of that schema
  // takes it too; a silently dropped connection must not hang the check until TCP gives up
  const takeLock = () => connectHome((c) => lockRun(c, RUN_LOCK), 15_000);
  let lock = await takeLock();
  // the lock went to another run: it restored this run's journal at its start and works on the
  // schema now; this run changes nothing there any more, not even to restore
  let foreign = false;
  // the run is over: a check still taking the lock again closes what it took
  let down = false;
  let checking: Promise<void> | undefined;
  // the lock's session still there (an idle one may be ended: IDLE_TIME, a firewall), else taken
  // again; before every change and every minute
  const keepLock = () => (checking ??= (async () => {
    if (foreign) throw new Error('Run lock lost to another run');
    if (await lock.execute('select 1 from dual').then(() => true, () => false)) return;
    await lock.close().catch(() => {});
    if (down) return;
    try {
      const c = await takeLock();
      if (down) await c.close().catch(() => {});
      else lock = c;
    } catch (e) {
      if ((e as Error).message.includes('Another plgauge run')) foreign = true;
      throw new Error(`Run lock lost: ${firstLine(e)}${foreign ? ' – code already instrumented stays in the journal: plgauge restore once the lock is free' : ''}`);
    }
  })().finally(() => { checking = undefined; }));
  // the lock confirmed before a change at the end (restore, trigger drop): without it another run
  // may own the schema, and this one leaves its changes to the journal
  const confirmed = () => keepLock().then(() => true, (e: Error) => {
    say(`WARNING: ${e.message}`);
    return false;
  });
  // this run's objects back through the journal check: what someone compiled or dropped while the
  // tests ran stays (a warning), like after a crashed run; returns how many stay changed
  const restoreOwn = async (objs: SourceObject[], c: oracledb.Connection = conn) => {
    const mine = new Set(objs.map((o) => `${o.owner}|${o.name}|${o.type}`));
    const n = await restoreJournal(c, (await journalEntries(c)).filter((e) => mine.has(`${e.owner}|${e.name}|${e.type}`)), say);
    if (n) say(`ERROR: ${n} objects not restored, their instrumented code is in the journal: plgauge restore`);
    return n;
  };
  // the logoff trigger this run created, dropped under a confirmed lock (a run that took the lock
  // meanwhile may have its own there now); one left behind is reported
  let logoff = false;
  const dropLogoff = async (c: oracledb.Connection = conn) => {
    if (!logoff || !(await confirmed())) return;
    await c.execute(`drop trigger cov$_logoff`).then(
      () => { logoff = false; },
      (e: Error) => { if (e.message.includes('ORA-04080')) logoff = false; });
  };
  const ping = setInterval(() => keepLock().catch((e: Error) => say(`WARNING: ${e.message}`)), 60_000);
  ping.unref();
  const conn = await connect(cfg).catch(async (e) => {
    clearInterval(ping);
    await lock.close().catch(() => {});
    throw e;
  });
  // Ctrl-C, a CI cancel: a test run is broken off (never a compile), the run stops at the next
  // step, and the finally below puts the originals back; a second signal must not kill that
  let interrupted = false;
  let testing = false;
  const onSig = () => {
    if (interrupted) {
      say('Restoring the originals, please wait (otherwise: plgauge restore)');
      return;
    }
    interrupted = true;
    say('Cancel requested, restoring the originals …');
    if (testing) conn.break().catch(() => {});
  };
  const checkpoint = () => {
    if (interrupted) throw new Error('Cancel requested, originals restored');
  };
  const testRun = async (paths: string[], cov: string[] | null) => {
    checkpoint();
    testing = true;
    try {
      return await runTests(conn, paths, cov);
    } finally {
      testing = false;
      // a test may have switched CURRENT_SCHEMA: journal, cov$ and the trigger are in rtOwner
      await conn.execute(`alter session set current_schema = ${dbIdent(rtOwner)}`).catch(() => {});
      checkpoint();
    }
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  const restore: SourceObject[] = [];
  // the run reached its beforeTests (configured or not): afterTests runs at the end, whatever happens after
  let seams = false;
  let report: RunReport | undefined;
  const granted: string[] = [];
  try {
    const nls = (await conn.execute<[string]>(`select value from nls_session_parameters where parameter = 'NLS_LENGTH_SEMANTICS'`)).rows?.[0]?.[0] ?? 'BYTE';
    await conn.execute(`alter session set current_schema = ${dbIdent(rtOwner)}`);
    const { banner, major } = await databaseInfo(conn);
    const sqlProbes = cfg.sqlProbes === 'auto' || cfg.sqlProbes === undefined ? major >= 23 : cfg.sqlProbes;
    say(`Database: ${banner} · SQL probes ${sqlProbes ? 'on' : 'off'}`);

    await ensureJournal(conn);
    // what a run that died left changed (either tool): back to the originals first, or this run
    // would instrument the changed code and forget the entry with the true original
    const left = await journalEntries(conn);
    if (left.length) {
      say(`Restoring ${left.length} objects of an aborted run from the journal`);
      // on a connection of its own: compiling sets session parameters the install must not inherit
      const r = await connectHome();
      try {
        await restoreJournal(r, left, say);
        const still = await journalEntries(r);
        if (still.length) throw new Error(`${still.length} objects of an aborted run could not be restored (${still.map((e) => e.name).join(', ')}); run plgauge restore first`);
      } finally {
        await r.close().catch(() => {});
      }
    }
    // then the project's install scripts: the new code is the original
    for (const path of cfg.installScripts ?? []) await runScript(conn, splitScript(readFileSync(path, 'utf8')), path);
    if (cfg.installScripts?.length) say(`${cfg.installScripts.length} scripts installed`);
    const external = cfg.runCommand?.length ? cfg.runCommand : undefined;
    const context = await installRuntime(conn, rtOwner, cfg.backgroundProgram);
    if (!context) {
      if (external) throw new Error('runCommand needs CREATE ANY CONTEXT and SELECT on V_$GLOBALCONTEXT: the other sessions keep their hits in a global context');
      say('  Note: no global context (CREATE ANY CONTEXT or SELECT on V_$GLOBALCONTEXT missing): other sessions write their hits every 1000 statements and at logoff');
    }
    // left by a run that died during its instrumented test run
    await conn.execute(`drop trigger cov$_logoff`).catch(() => {});

    // before the objects are read: a script that replaces a measured unit (a mock) or its
    // settings is what the tests run against, so it is what gets instrumented. On a connection
    // of their own in rtOwner, like the install scripts: their session state (CURRENT_SCHEMA,
    // parameters) must not reach the tests. From here on afterTests runs at the end, also
    // without beforeTests
    checkpoint();
    seams = true;
    if (cfg.beforeTests?.length) {
      await connectHome(async (c) => runTestHooks(c, cfg.beforeTests!)).then((c) => c.close());
      say(`${cfg.beforeTests.length} beforeTests scripts run`);
    }
    const objects: SourceObject[] = [];
    for (const s of schemas) objects.push(...(await loadObjects(conn, s, { include: cfg.include, exclude: cfg.exclude, skip: ['COV$', 'COV$_LOGOFF'] })));
    say(`${objects.length} objects found: ${objects.map((o) => (multi ? `${o.owner}.${o.name}` : o.name)).join(', ')}`);
    for (const owner of new Set(objects.map((o) => o.owner).filter((o) => o !== rtOwner))) {
      // instrumented code of other schemas calls the runtime qualified; a grant that was there
      // before (deliberate, or kept for unrestored code) is not this run's to take back
      const had = await conn.execute(`select 1 from all_tab_privs where table_schema = :o and table_name = 'COV$' and grantee = :g and privilege = 'EXECUTE'`, { o: rtOwner, g: owner });
      if (had.rows?.length) continue;
      await conn.execute(`grant execute on ${dbIdent(rtOwner)}.cov$ to ${dbIdent(owner)}`);
      granted.push(owner);
    }
    // warm-up: utPLSQL builds its annotation cache on the first run
    const warmup = !external && cfg.warmup !== false;
    if (warmup) await testRun(cfg.tests, null);
    say(external ? '1/4 Test run without coverage skipped (runCommand)' : '1/4 Test run without coverage …');
    const repeat = external ? 0 : Math.max(1, cfg.baselineRuns ?? 2);
    // without the warm-up the first baseline run is cold: its results count, its time does not
    // (the last run gives the timing, so only a single cold run leaves none)
    const timed = warmup || repeat > 1;
    // Every run starts with fresh package state, like the instrumented run after compiling:
    // tests that depend on state left by earlier tests then behave the same in all runs.
    const fresh = () => conn.execute('begin dbms_session.reset_package; end;');
    let baseline: Awaited<ReturnType<typeof testRun>> = { run: { tests: [], ms: 0 }, sonar: new Map() };
    const observed: TestCase[][] = [];
    for (let k = 0; k < repeat; k++) {
      await fresh();
      baseline = await testRun(cfg.tests, null);
      observed.push(baseline.run.tests);
    }
    // red before any instrumentation: their objects' coverage is low for that reason, not for missing tests
    for (const w of failureSummary(baseline.run.tests, 'before instrumentation')) say(w);
    let utCov: Awaited<ReturnType<typeof testRun>> | undefined;
    if (!external && cfg.utplsqlCompare !== false) {
      say('2/4 Test run with utPLSQL coverage (DBMS_PROFILER) …');
      await fresh();
      utCov = await testRun(cfg.tests, schemas);
    } else say('2/4 Test run with utPLSQL coverage skipped');

    say('3/4 Instrumenting and compiling …');
    const ids = newIds();
    // package and type specs with PRAGMA RESTRICT_REFERENCES: their bodies' SQL takes the probes
    // with full purity (see instrument)
    const restricted = new Set<string>();
    for (const s of schemas) {
      const r = await conn.execute<[string]>(`select distinct name from all_source where owner = :o and type in ('PACKAGE', 'TYPE') and upper(text) like '%RESTRICT\\_REFERENCES%' escape '\\'`, { o: s });
      for (const [n] of r.rows ?? []) restricted.add(`${s}.${n}`);
    }
    const maps: (ObjectMap | { error: string; obj: SourceObject })[] = [];
    let instrumentMs = 0;
    let compileMs = 0;
    for (const obj of objects) {
      checkpoint();
      const t0 = performance.now();
      let res;
      try {
        res = instrument(obj.processed, obj.owner, ids, { sqlProbes, runtime: obj.owner === rtOwner ? undefined : `${rtOwner.toLowerCase()}.cov$`, restricted: restricted.has(`${obj.owner}.${obj.name}`) });
      } catch (e) {
        maps.push({ error: `Parser: ${(e as Error).message}`, obj });
        say(`  ✗ ${obj.name}: ${(e as Error).message}`);
        continue;
      } finally {
        instrumentMs += performance.now() - t0;
      }
      const t1 = performance.now();
      await keepLock();
      restore.push(obj);
      const out = await replaceSourceDetailed(conn, obj, res.instrumented, 'coverage');
      compileMs += performance.now() - t1;
      if (out.error) {
        say(`  ✗ ${obj.name}: instrumented code does not compile (${out.error})`);
        // rejected at once, never changed: the original is in place, nothing to restore
        if (out.untouched) restore.pop();
        // back at once; if that fails, the end of the run tries again (it stays in restore)
        else if (!(await restoreAll(conn, [obj], (m) => (m.includes('✗') ? say(m) : undefined)))) {
          restore.pop();
          say(`    original back in place`);
        }
        maps.push({ error: `Compilation: ${out.error}`, obj });
        continue;
      }
      maps.push(res.map);
      say(`  ✓ ${obj.type.toLowerCase()} ${obj.name}`);
    }

    say('4/4 Test run on instrumented code …');
    const runId = randomUUID();
    const perTest = cfg.perTest !== false;
    await fresh();
    await conn.execute(`begin cov$.reset; cov$.per_test(:p = 1); cov$.start_run(:r); end;`, { p: perTest ? 1 : 0, r: runId });
    // without the context, other sessions write their counters at logoff (with it, they need not)
    if (!context) await conn.execute(LOGOFF_TRIGGER).then(() => { logoff = true; }, (e) => say(`  Note: no logoff trigger (${firstLine(e)}), other sessions write only every 1000 statements`));
    let instrumentedRun;
    let exitCode: number | null = null;
    // compiling left the last object's length semantics in the session; the tests (DDL in them)
    // run with the session's own, as in the baseline
    await conn.execute(`alter session set nls_length_semantics = ${nls === 'CHAR' ? 'CHAR' : 'BYTE'}`);
    try {
      if (external) {
        checkpoint();
        say(`  running ${external.join(' ')}`);
        ({ run: instrumentedRun, exitCode } = await runExternal(external).then(({ run, exitCode: c }) => ({ run: { run, sonar: new Map() }, exitCode: c })));
        say(`  command exited with ${exitCode}`);
        checkpoint();
      } else instrumentedRun = await testRun(cfg.tests, null);
      // a test that reset all package state took the counters with it
      const intact = (await conn.execute<[number]>(`select cov$.intact from dual`)).rows?.[0]?.[0];
      if (intact !== 1) say('WARNING: the state of cov$ was reset during the tests (DBMS_SESSION.RESET_PACKAGE in a test?): the coverage of this run is incomplete');
      await conn.execute(`begin cov$.flush(:r); end;`, { r: runId });
      await waitForJobs(conn, say);
      if (context) await collectContext(conn, context, runId, perTest);
    } finally {
      await conn.execute(`begin cov$.stop_run(:r); end;`, { r: runId }).catch(() => {});
      await dropLogoff();
    }
    const hits = await loadHits(conn, runId);
    await conn.execute(`delete from plgauge_hits where run_id = :r`, { r: runId });
    await conn.commit();

    // (a check that failed above for a moment: the trigger goes now)
    await dropLogoff();
    if (!(await confirmed())) {
      // another run may have restored this one's code at its start, maybe while the tests ran
      restore.length = 0;
      throw new Error('Run lock lost during the run (another run or the old session holds it): the measurement is invalid, instrumented code stays in the journal; plgauge restore once the lock is free');
    }
    const unrestored = await restoreOwn(restore);
    restore.length = 0;

    // Flaky: the result changed although our instrumentation was not involved (baseline runs and
    // the run with utPLSQL's own coverage). They are left out of the equivalence check.
    if (utCov) observed.push(utCov.run.tests);
    const key = (t: TestCase) => `${t.suite}::${t.name}`;
    const seen = new Map<string, Set<string>>();
    for (const run of observed) for (const t of run) seen.set(key(t), (seen.get(key(t)) ?? new Set()).add(t.status));
    const flaky = new Set([...seen].filter(([, st]) => st.size > 1).map(([k]) => k));
    const before = new Map(baseline.run.tests.map((t) => [key(t), t.status]));
    const differing = instrumentedRun.run.tests
      .filter((t) => !flaky.has(key(t)) && before.get(key(t)) !== t.status)
      .map((t) => `${key(t)}: ${before.get(key(t)) ?? 'missing'} → ${t.status}`);
    const equivalent = differing.length === 0 && baseline.run.tests.filter((t) => !flaky.has(key(t))).every((t) => instrumentedRun.run.tests.some((u) => key(u) === key(t)));
    for (const f of flaky) say(`  flaky (result changes without instrumentation): ${f}`);
    for (const d of differing) say(`  differs with instrumentation: ${d}`);
    const tests = await loadTestCatalog(conn, rtOwner, external ? [] : cfg.tests, baseline.run.tests, instrumentedRun.run.tests, hits);
    const testIndex = new Map(tests.map((t, k) => [t.path, k]));
    for (const t of tests) if (!t.setup && flaky.has(`${t.suite}::${t.description}`)) t.status = 'flaky';
    if (!external) say(equivalent ? `Test results identical with and without instrumentation ✓${flaky.size ? ` (${flaky.size} flaky tests excluded)` : ''}` : 'WARNING: test results differ!');

    const objectsOut: ObjectResult[] = maps.map((m) => {
      if ('error' in m) {
        const lines = m.obj.processed.replace(/\n$/, '').split('\n');
        const empty = { covered: 0, total: 0 };
        return {
          key: `${m.obj.type} ${m.obj.owner}.${m.obj.name}`.toLowerCase(), owner: m.obj.owner, name: m.obj.name, type: m.obj.type, lines,
          metrics: { stmt: empty, branch: empty, cond: empty, mcdc: empty, loop: empty },
          statements: [], branches: [], decisions: [], loops: [], lineStatus: {}, lineHits: {}, lineTests: {}, gaps: [], findings: [],
          instrumentError: m.error, sourceSha256: sha256(m.obj.processed), rawSha256: sha256(m.obj.original),
        };
      }
      const obj = objects.find((o) => o.owner === m.owner && o.name === m.name && o.type === m.type)!;
      const r = analyze(m, hits, testIndex);
      const ut = utCov?.sonar.get(r.key);
      return Object.assign(r, { sourceSha256: sha256(obj.processed), rawSha256: sha256(obj.original) }, ut ? { utplsql: ut } : {});
    });

    return (report = {
      generated: new Date().toISOString(),
      database: banner,
      schema: multi ? schemas.join(',') : schema,
      sqlProbes,
      timings: { baselineMs: timed ? baseline.run.ms : undefined, utplsqlCoverageMs: utCov?.run.ms, instrumentedMs: instrumentedRun.run.ms, instrumentMs, compileMs },
      baseline: baseline.run, utplsqlRun: utCov?.run, instrumentedRun: instrumentedRun.run,
      equivalent, flakyTests: [...flaky].sort(), baselineRuns: repeat, warmup, utplsqlCompare: !!utCov, differingTests: differing,
      tests, perTest, objects: objectsOut, log: messages,
      ...(unrestored ? { unrestored } : {}),
      ...(external ? { runCommand: { command: external, exitCode } } : {}),
    });
  } finally {
    clearInterval(ping);
    // the main connection may be what failed (a test crashed its server process): the cleanup on
    // a fresh one then
    let fin = conn;
    if ((logoff || restore.length) && !(await conn.execute('select 1 from dual').then(() => true, () => false))) {
      fin = await connectHome().catch(() => conn);
    }
    await dropLogoff(fin).catch(() => {});
    if (logoff) say('ERROR: trigger cov$_logoff not dropped: plgauge restore');
    try {
      if (restore.length && !(await confirmed())) {
        say(`ERROR: ${restore.length} objects not restored (run lock not confirmed), their instrumented code is in the journal: plgauge restore`);
      } else if (restore.length) {
        await restoreOwn(restore, fin).catch((e: Error) => say(`ERROR: originals not restored (${firstLine(e)}), the instrumented code is in the journal: plgauge restore`));
      }
      // no grant left behind, but a schema whose instrumented code stays (journal) keeps its own,
      // or that code turns invalid until plgauge restore; without the lock another run may need them
      if (granted.length && (await confirmed())) {
        const left = await journalEntries(fin).catch(() => undefined);
        if (left) await revokeRuntime(fin, rtOwner, granted.filter((o) => !left.some((e) => e.owner === o)), say);
      }
    } finally {
      if (fin !== conn) await fin.close().catch(() => {});
      await conn.close().catch(() => {});
      // after the restore and never instead of it; only while the schema is still this run's
      if (seams && cfg.afterTests?.length) {
        const failed = !(await confirmed()) ? 'run lock not confirmed, not run'
          : await connectHome(async (c) => runTestHooks(c, cfg.afterTests!, true)).then((c) => c.close()).then(() => undefined, (e: Error) => firstLine(e));
        if (failed) {
          say(`ERROR: afterTests: ${failed} (the test seams may still be switched)`);
          if (report) report.afterTestsFailed = failed;
        } else say(`${cfg.afterTests.length} afterTests scripts run`);
      }
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
      // (a check in flight may still swap the connection; after this none takes the lock again)
      down = true;
      await checking?.catch(() => {});
      await lock.close().catch(() => {});
    }
  }
}

/** Scheduler jobs started by the tests write their hits when they end: wait for them (at most a minute). */
async function waitForJobs(conn: oracledb.Connection, say: (m: string) => void) {
  const running = async () => (await conn.execute<[number]>(`select count(*) from user_scheduler_running_jobs`)).rows![0][0];
  let n = await running().catch(() => 0);
  if (!n) return;
  say(`  waiting for ${n} running scheduler jobs …`);
  for (let i = 0; i < 120 && n > 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    n = await running().catch(() => 0);
  }
  await new Promise((r) => setTimeout(r, 1000)); // their logoff writes the hits
}

/**
 * The keys that other sessions left in the global context become hits of the run, also as the
 * "#background" entry of the per-test coverage. The runner reads them from V$GLOBALCONTEXT
 * (DBMS_SESSION.LIST_CONTEXT lists only what the session itself set).
 */
async function collectContext(conn: oracledb.Connection, context: string, runId: string, perTest: boolean) {
  await conn.execute(`insert into plgauge_hits (run_id, kind, k, hits)
    select :r, substr(value, 1, 1), substr(value, 3), 1 from v$globalcontext where namespace = :c`, { r: runId, c: context });
  if (perTest) {
    await conn.execute(`insert into plgauge_hits (run_id, kind, k, hits, test)
      select :r, lower(substr(value, 1, 1)), substr(value, 3), 1, '#background' from v$globalcontext
       where namespace = :c and substr(value, 1, 1) in ('S', 'B', 'C', 'D')`, { r: runId, c: context });
  }
  await conn.commit();
}

/**
 * Installs the hit tables and cov$ in rtOwner (the session's current schema), with the global
 * context of other sessions when the user may create it and read V$GLOBALCONTEXT. Returns the
 * context's name, or undefined without one of the two privileges.
 */
export async function installRuntime(conn: oracledb.Connection, rtOwner?: string, program?: string): Promise<string | undefined> {
  rtOwner ??= (await conn.execute<[string]>(`select sys_context('userenv', 'current_schema') from dual`)).rows![0][0];
  await tryExecute(conn, HITS_TABLE, 'ORA-00955');
  await tryExecute(conn, RUNS_TABLE, 'ORA-00955');
  const ctx = coverageContextName(rtOwner);
  const missing = (e: Error) => {
    if (e.message.includes('ORA-01031') || e.message.includes('ORA-00942')) return undefined;
    throw e;
  };
  const context = await conn.execute(`create or replace context ${ctx} using ${dbIdent(rtOwner)}.cov$ accessed globally`)
    .then(() => conn.execute(`select count(*) from v$globalcontext where namespace = :c`, { c: ctx }))
    .then(() => ctx, missing);
  await conn.execute(RUNTIME_SPEC);
  await conn.execute(runtimeBody({ context, program, utInfo: await utInfoContext(conn) }));
  // Native compilation makes the probes cheaper; it does not affect the instrumented code itself.
  await conn.execute(`alter package cov$ compile body plsql_code_type = native plsql_optimize_level = 3`);
  const nativeErr = await conn.execute(`select 1 from user_errors where name = 'COV$'`);
  if (nativeErr.rows?.length) await conn.execute(`alter package cov$ compile body plsql_code_type = interpreted plsql_optimize_level = 3`);
  const err = await conn.execute<[number, string]>(`select line, text from user_errors where name = 'COV$' order by sequence`);
  if (err.rows?.length) throw new Error(`Runtime cov$ does not compile: ${err.rows.map((r) => `${r[0]}: ${r[1]}`).join('; ')}`);
  return context;
}

/**
 * Takes back EXECUTE on cov$ (or the mutation runtime's plgauge_ctl) from the schemas given; a
 * grant that is gone already is no error. Returns the schemas whose grant was really taken back.
 */
export async function revokeRuntime(conn: oracledb.Connection, rtOwner: string, grantees: string[], say: (m: string) => void, pkg = 'cov$'): Promise<string[]> {
  const revoked: string[] = [];
  for (const g of grantees) {
    const done = await tryExecute(conn, `revoke execute on ${dbIdent(rtOwner)}.${pkg} from ${dbIdent(g)}`, 'ORA-01927', 'ORA-04043', 'ORA-00942')
      .catch((e: Error) => say(`WARNING: execute on ${pkg} not revoked from ${g}: ${firstLine(e)}`));
    if (done) revoked.push(g);
  }
  return revoked;
}

const RUNTIME_TABLES = ['PLGAUGE_HITS', 'PLGAUGE_RUNS', 'PLGAUGE_JOURNAL', 'PLGAUGE_MARKER'];

/**
 * plgauge uninstall: removes what runs of either tool leave in the runtime schema home (logoff
 * trigger, the grants on cov$ and plgauge_ctl, cov$, plgauge_ctl, plgauge_rt, the tables
 * plgauge_hits, plgauge_runs, plgauge_journal, plgauge_marker, plgauge_lock, the contexts of
 * mutation runs and of other sessions in coverage runs). Refused while the journal has entries:
 * their originals would be lost. Idempotent.
 */
export async function uninstallRuntime(cfg: ConnectConfig, home: string, say: (m: string) => void): Promise<void> {
  const conn = await connect(cfg);
  let lock: oracledb.Connection | undefined;
  try {
    const rows = async (sql: string, binds: Record<string, string> = { o: home }) => ((await conn.execute<[string]>(sql, binds)).rows ?? []).map((r) => r[0]);
    const tables = await rows(`select table_name from all_tables where owner = :o and table_name in ('PLGAUGE_HITS', 'PLGAUGE_RUNS', 'PLGAUGE_JOURNAL', 'PLGAUGE_MARKER', 'PLGAUGE_LOCK')`);
    const objs = await rows(`select object_type || ' ' || object_name from all_objects where owner = :o and object_name in ('COV$', 'COV$_LOGOFF', 'PLGAUGE_CTL', 'PLGAUGE_RT') and object_type in ('PACKAGE', 'TRIGGER')`);
    // contexts belong to SYS; one may outlive its package (an uninstall without DROP ANY CONTEXT)
    const ctxs = await rows(`select object_name from all_objects where owner = 'SYS' and object_type = 'CONTEXT' and object_name in (:m, :c)`, { m: contextName(home), c: coverageContextName(home) });
    if (objs.includes('PACKAGE PLGAUGE_CTL') && !ctxs.includes(contextName(home))) ctxs.push(contextName(home));
    // CREATE ANY CONTEXT does not include dropping one: then a DBA does it, the rest goes anyway
    const dropContexts = async () => {
      const gone: string[] = [];
      for (const ctx of ctxs) {
        await tryExecute(conn, `drop context ${ctx}`, 'ORA-04043').then(() => gone.push(ctx), (e: Error) => {
          say(`  Context ${ctx} stays (${firstLine(e)}); a user with DROP ANY CONTEXT removes it: drop context ${ctx};`);
        });
      }
      return gone;
    };
    if (!tables.length && !objs.length) {
      const gone = await dropContexts();
      say(gone.length ? `Schema ${home}: ${gone.map((c) => `context ${c.toLowerCase()}`).join(', ')} removed` : `Schema ${home}: nothing to remove`);
      return;
    }
    await conn.execute(`alter session set current_schema = ${dbIdent(home)}`);
    // a running run (either tool) holds the lock: it fails here and nothing is touched
    lock = await connect(cfg);
    await lock.execute(`alter session set current_schema = ${dbIdent(home)}`);
    await lockRun(lock, RUN_LOCK);
    if (tables.includes('PLGAUGE_JOURNAL')) {
      const n = (await conn.execute<[number]>(`select count(*) from plgauge_journal`)).rows![0][0];
      if (n) throw new Error(`Schema ${home}: ${n} objects in the restore journal, their originals would be lost: run plgauge restore first`);
    }
    if (objs.includes('TRIGGER COV$_LOGOFF')) await tryExecute(conn, `drop trigger cov$_logoff`, 'ORA-04080');
    for (const pkg of ['COV$', 'PLGAUGE_CTL', 'PLGAUGE_RT'].filter((p) => objs.includes(`PACKAGE ${p}`))) {
      // every grantee, also those of runs before this version, which never revoked
      const grantees = await rows(`select distinct grantee from all_tab_privs where table_schema = :o and table_name = :p`, { o: home, p: pkg });
      const revoked = await revokeRuntime(conn, home, grantees, say, pkg.toLowerCase());
      await tryExecute(conn, `drop package ${pkg}`, 'ORA-04043');
      if (revoked.length) say(`Execute on ${pkg.toLowerCase()} revoked from ${revoked.join(', ')}`);
    }
    for (const t of RUNTIME_TABLES.filter((x) => tables.includes(x))) await tryExecute(conn, `drop table ${t} purge`, 'ORA-00942');
    const ctxGone = await dropContexts();
    // the lock table last, after the lock is given up; a run that started in between keeps it
    await lock.close();
    lock = undefined;
    if (!(await tryExecute(conn, `drop table plgauge_lock purge`, 'ORA-00942', 'ORA-00054'))) say('  (a run started meanwhile: its table plgauge_lock stays)');
    say(`Schema ${home}: plgauge runtime removed (${[...objs.map((o) => o.toLowerCase()), ...tables.map((t) => `table ${t.toLowerCase()}`), ...ctxGone.map((c) => `context ${c.toLowerCase()}`)].join(', ')})`);
  } finally {
    await lock?.close().catch(() => {});
    await conn.close().catch(() => {});
  }
}

async function loadHits(conn: oracledb.Connection, runId: string): Promise<Hits> {
  const res = await conn.execute<[string, string, number, string | null]>(
    `select kind, k, sum(hits), test from plgauge_hits where run_id = :r group by kind, k, test`, { r: runId },
  );
  const hits: Hits = { stmt: new Map(), branch: new Map(), cond: new Map(), dec: new Map(), vec: new Map(), loop: new Map(), perTest: new Map() };
  const forTest = (name: string): TestHits => {
    const key = name.toLowerCase();
    let th = hits.perTest.get(key);
    if (!th) hits.perTest.set(key, (th = { s: new Set(), b: new Set(), c: new Set(), d: new Set() }));
    return th;
  };
  for (const [kind, k, n, test] of res.rows ?? []) {
    switch (kind) {
      case 'S': hits.stmt.set(Number(k), n); break;
      case 'B': hits.branch.set(Number(k), n); break;
      case 'C': hits.cond.set(k, n); break;
      case 'D': hits.dec.set(k, n); break;
      case 'L': hits.loop.set(k, n); break;
      case 's': case 'b': forTest(test!)[kind].add(Number(k)); break;
      case 'c': case 'd': forTest(test!)[kind].add(k); break;
      case 'V': {
        // d|evaluated|true|null|outcome (bit masks) -> d|vector|T/F/N
        const [d, e, t, nl, o] = k.split('|').map(Number);
        let vec = '';
        for (let b = 0; b < 30; b++) {
          const bit = 2 ** b;
          vec += Math.floor(e / bit) % 2 ? (Math.floor(t / bit) % 2 ? 'T' : Math.floor(nl / bit) % 2 ? 'N' : 'F') : '-';
        }
        const key = `${d}|${vec}|${['T', 'F', 'N'][o]}`;
        hits.vec.set(key, (hits.vec.get(key) ?? 0) + n);
        break;
      }
    }
  }
  return hits;
}

/**
 * Builds the test list: every utPLSQL test below the configured paths (path from
 * ut_runner.get_suites_info, status from the JUnit results) plus one setup bucket per
 * suite for probes reached outside a test (beforeall / afterall).
 */
async function loadTestCatalog(
  conn: oracledb.Connection, schema: string, paths: string[], baseline: TestCase[], instrumented: TestCase[], hits: Hits,
): Promise<TestInfo[]> {
  const owners = new Set([schema, ...paths.filter((p) => !p.startsWith(':')).map((p) => p.split('.')[0].toUpperCase())]);
  const tests: TestInfo[] = [];
  const caseOf = (list: TestCase[], suite: string, desc: string) => list.find((t) => t.suite.toLowerCase() === suite && t.name === desc);
  for (const owner of owners) {
    for (const { owner: o, object: obj, item, description: desc, path } of await suiteTests(conn, owner)) {
      const full = `${o}.${obj}.${item}`.toLowerCase();
      // utPLSQL paths: "schema", "schema.package[.procedure]", "package[.procedure]" in the current schema, ":suitepath"
      const inScope = paths.some((p) => {
        const q = p.toLowerCase();
        if (q.startsWith(':')) return path.toLowerCase().startsWith(q.slice(1));
        return [q, `${schema.toLowerCase()}.${q}`].some((x) => x === o.toLowerCase() || full === x || full.startsWith(x + '.'));
      });
      if (!inScope || tests.some((t) => t.path === full)) continue;
      const suite = path.toLowerCase().split('.').slice(0, -1).join('.');
      const description = desc || item.toLowerCase();
      const run = caseOf(instrumented, suite, description);
      const status = run?.status ?? 'unknown';
      if (status === 'unknown' && !hits.perTest.has(full)) continue; // not part of this run
      const base = caseOf(baseline, suite, description);
      const message = run?.message ?? base?.message;
      tests.push({
        path: full, suite, description, setup: false, status, baselineStatus: base?.status ?? 'unknown', ms: (run?.time ?? 0) * 1000, ...(message ? { message } : {}),
      });
    }
  }
  for (const name of hits.perTest.keys()) {
    if (name.startsWith('#') && !tests.some((t) => t.path === name)) {
      const description = name === '#background' ? 'Other sessions (scheduler jobs, parallel queries)' : `Setup outside a test (${name.slice(1) || 'without utPLSQL'})`;
      tests.push({ path: name, suite: name.slice(1), description, setup: true, status: 'unknown', baselineStatus: 'unknown', ms: 0 });
    }
  }
  return tests;
}


export { parseJunit, parseSonar } from '@plgauge/core';
