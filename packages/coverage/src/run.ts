/**
 * Orchestrates a coverage run against a database:
 *
 *  1. baseline test runs without coverage (timing; twice by default)
 *  2. baseline test run with utPLSQL's own coverage (line coverage for comparison);
 *     a test whose result changes across 1 and 2 is flaky
 *  3. instrument + compile all code objects of the schema
 *  4. test run on instrumented code, flush probes
 *  5. restore original code (always, also on failure)
 *  6. compare test results of 1 and 4 (instrumentation must not change behaviour;
 *     flaky tests left aside)
 */
import oracledb from 'oracledb';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  connect, databaseInfo, dbIdent, firstLine, utInfoContext, restoreJournal, ensureJournal, journalEntries, loadObjects, lockRun, replaceSourceDetailed, restoreAll, RUN_LOCK, runScript, sha256, splitScript,
  runTestsJunit as runTests, suiteTests, tryExecute, type SourceObject, type TestCase, type TestRun,
} from '@plgauge/core';
import { instrument } from './instrument.js';
import { analyze, type ObjectResult } from './analyze.js';
import { newIds, type Hits, type ObjectMap, type TestHits, type TestInfo } from './model.js';
import { HITS_TABLE, LOGOFF_TRIGGER, RUNS_TABLE, RUNTIME_BODY, RUNTIME_SPEC } from './runtime.js';

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
  /** Optional regular expression of object names to include / exclude. */
  include?: string;
  exclude?: string;
  /** "auto" enables SQL probes on 23ai and later. */
  sqlProbes?: 'auto' | boolean;
  /** Record which test reaches which probe (default true). */
  perTest?: boolean;
  /** Test runs without coverage before measuring (default 2); a test whose result changes is flaky. */
  baselineRuns?: number;
  /**
   * Scripts (paths) the run installs first, under the run lock and after restoring what a
   * crashed run left: installed earlier, they would be overwritten by those old originals.
   */
  installScripts?: string[];
}

export type { TestCase, TestRun } from '@plgauge/core';

export interface RunReport {
  generated: string;
  database: string;
  schema: string;
  sqlProbes: boolean;
  timings: { baselineMs: number; utplsqlCoverageMs: number; instrumentedMs: number; instrumentMs: number; compileMs: number };
  baseline: TestRun;
  /** Test run with utPLSQL's own coverage (DBMS_PROFILER + DBMS_PLSQL_CODE_COVERAGE). */
  utplsqlRun: TestRun;
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
  objects: ObjectResult[];
  log: string[];
  /** Objects whose originals did not go back at the end (their entries stay in the journal). */
  unrestored?: number;
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
    if (foreign) throw new Error('Laufsperre an einen anderen Lauf verloren');
    if (await lock.execute('select 1 from dual').then(() => true, () => false)) return;
    await lock.close().catch(() => {});
    if (down) return;
    try {
      const c = await takeLock();
      if (down) await c.close().catch(() => {});
      else lock = c;
    } catch (e) {
      if ((e as Error).message.includes('anderer plgauge-Lauf')) foreign = true;
      throw new Error(`Laufsperre verloren: ${firstLine(e)}${foreign ? ' – schon instrumentierter Code bleibt im Journal: plgauge restore, sobald die Sperre frei ist' : ''}`);
    }
  })().finally(() => { checking = undefined; }));
  // the lock confirmed before a change at the end (restore, trigger drop): without it another run
  // may own the schema, and this one leaves its changes to the journal
  const confirmed = () => keepLock().then(() => true, (e: Error) => {
    say(`WARNUNG: ${e.message}`);
    return false;
  });
  // this run's objects back through the journal check: what someone compiled or dropped while the
  // tests ran stays (a warning), like after a crashed run; returns how many stay changed
  const restoreOwn = async (objs: SourceObject[], c: oracledb.Connection = conn) => {
    const mine = new Set(objs.map((o) => `${o.owner}|${o.name}|${o.type}`));
    const n = await restoreJournal(c, (await journalEntries(c)).filter((e) => mine.has(`${e.owner}|${e.name}|${e.type}`)), say);
    if (n) say(`FEHLER: ${n} Objekte nicht wiederhergestellt, ihr instrumentierter Code steht im Journal: plgauge restore`);
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
  const ping = setInterval(() => keepLock().catch((e: Error) => say(`WARNUNG: ${e.message}`)), 60_000);
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
      say('Die Originale werden gerade wiederhergestellt, bitte warten (sonst: plgauge restore)');
      return;
    }
    interrupted = true;
    say('Abbruch angefordert, stelle Originale wieder her …');
    if (testing) conn.break().catch(() => {});
  };
  const checkpoint = () => {
    if (interrupted) throw new Error('Abbruch angefordert, Originale wiederhergestellt');
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
  try {
    const nls = (await conn.execute<[string]>(`select value from nls_session_parameters where parameter = 'NLS_LENGTH_SEMANTICS'`)).rows?.[0]?.[0] ?? 'BYTE';
    await conn.execute(`alter session set current_schema = ${dbIdent(rtOwner)}`);
    const { banner, major } = await databaseInfo(conn);
    const sqlProbes = cfg.sqlProbes === 'auto' || cfg.sqlProbes === undefined ? major >= 23 : cfg.sqlProbes;
    say(`Datenbank: ${banner} · SQL-Sonden ${sqlProbes ? 'aktiv' : 'aus'}`);

    await ensureJournal(conn);
    // what a run that died left changed (either tool): back to the originals first, or this run
    // would instrument the changed code and forget the entry with the true original
    const left = await journalEntries(conn);
    if (left.length) {
      say(`${left.length} Objekte eines abgebrochenen Laufs werden aus dem Journal wiederhergestellt`);
      // on a connection of its own: compiling sets session parameters the install must not inherit
      const r = await connectHome();
      try {
        await restoreJournal(r, left, say);
        const still = await journalEntries(r);
        if (still.length) throw new Error(`${still.length} Objekte eines abgebrochenen Laufs ließen sich nicht wiederherstellen (${still.map((e) => e.name).join(', ')}); erst plgauge restore`);
      } finally {
        await r.close().catch(() => {});
      }
    }
    // then the project's install scripts: the new code is the original
    for (const path of cfg.installScripts ?? []) await runScript(conn, splitScript(readFileSync(path, 'utf8')), path);
    if (cfg.installScripts?.length) say(`${cfg.installScripts.length} Skripte installiert`);
    await installRuntime(conn);
    // left by a run that died during its instrumented test run
    await conn.execute(`drop trigger cov$_logoff`).catch(() => {});
    const objects: SourceObject[] = [];
    for (const s of schemas) objects.push(...(await loadObjects(conn, s, { include: cfg.include, exclude: cfg.exclude, skip: ['COV$', 'COV$_LOGOFF'] })));
    say(`${objects.length} Objekte gefunden: ${objects.map((o) => (multi ? `${o.owner}.${o.name}` : o.name)).join(', ')}`);
    for (const owner of new Set(objects.map((o) => o.owner).filter((o) => o !== rtOwner))) {
      // instrumented code of other schemas calls the runtime qualified
      await conn.execute(`grant execute on ${dbIdent(rtOwner)}.cov$ to ${dbIdent(owner)}`);
    }

    await testRun(cfg.tests, null); // warm-up: utPLSQL builds its annotation cache on the first run
    say('1/4 Testlauf ohne Coverage …');
    const repeat = Math.max(1, cfg.baselineRuns ?? 2);
    // Every run starts with fresh package state, like the instrumented run after compiling:
    // tests that depend on state left by earlier tests then behave the same in all runs.
    const fresh = () => conn.execute('begin dbms_session.reset_package; end;');
    let baseline!: Awaited<ReturnType<typeof testRun>>;
    const observed: TestCase[][] = [];
    for (let k = 0; k < repeat; k++) {
      await fresh();
      baseline = await testRun(cfg.tests, null);
      observed.push(baseline.run.tests);
    }
    say('2/4 Testlauf mit utPLSQL-Coverage (DBMS_PROFILER) …');
    await fresh();
    const utCov = await testRun(cfg.tests, schemas);

    say('3/4 Instrumentieren und kompilieren …');
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
        say(`  ✗ ${obj.name}: instrumentierter Code kompiliert nicht (${out.error})`);
        // rejected at once, never changed: the original is in place, nothing to restore
        if (out.untouched) restore.pop();
        // back at once; if that fails, the end of the run tries again (it stays in restore)
        else if (!(await restoreAll(conn, [obj], (m) => (m.includes('✗') ? say(m) : undefined)))) {
          restore.pop();
          say(`    Original wieder aktiv`);
        }
        maps.push({ error: `Kompilierung: ${out.error}`, obj });
        continue;
      }
      maps.push(res.map);
      say(`  ✓ ${obj.type.toLowerCase()} ${obj.name}`);
    }

    say('4/4 Testlauf auf instrumentiertem Code …');
    const runId = randomUUID();
    const perTest = cfg.perTest !== false;
    await fresh();
    await conn.execute(`begin cov$.reset; cov$.per_test(:p = 1); cov$.start_run(:r); end;`, { p: perTest ? 1 : 0, r: runId });
    await conn.execute(LOGOFF_TRIGGER).then(() => { logoff = true; }, (e) => say(`  Hinweis: ohne Logoff-Trigger (${firstLine(e)}), andere Sessions schreiben nur alle 1000 Anweisungen`));
    let instrumentedRun;
    // compiling left the last object's length semantics in the session; the tests (DDL in them)
    // run with the session's own, as in the baseline
    await conn.execute(`alter session set nls_length_semantics = ${nls === 'CHAR' ? 'CHAR' : 'BYTE'}`);
    try {
      instrumentedRun = await testRun(cfg.tests, null);
      // a test that reset all package state took the counters with it
      const intact = (await conn.execute<[number]>(`select cov$.intact from dual`)).rows?.[0]?.[0];
      if (intact !== 1) say('WARNUNG: Der Zustand von cov$ wurde während der Tests zurückgesetzt (DBMS_SESSION.RESET_PACKAGE in einem Test?): die Coverage dieses Laufs ist unvollständig');
      await conn.execute(`begin cov$.flush(:r); end;`, { r: runId });
      await waitForJobs(conn, say);
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
      throw new Error('Laufsperre während des Laufs verloren (ein anderer Lauf oder die alte Sitzung hält sie): die Messung ist ungültig, instrumentierter Code bleibt im Journal; plgauge restore, sobald die Sperre frei ist');
    }
    const unrestored = await restoreOwn(restore);
    restore.length = 0;

    // Flaky: the result changed although our instrumentation was not involved (baseline runs and
    // the run with utPLSQL's own coverage). They are left out of the equivalence check.
    observed.push(utCov.run.tests);
    const key = (t: TestCase) => `${t.suite}::${t.name}`;
    const seen = new Map<string, Set<string>>();
    for (const run of observed) for (const t of run) seen.set(key(t), (seen.get(key(t)) ?? new Set()).add(t.status));
    const flaky = new Set([...seen].filter(([, st]) => st.size > 1).map(([k]) => k));
    const before = new Map(baseline.run.tests.map((t) => [key(t), t.status]));
    const differing = instrumentedRun.run.tests
      .filter((t) => !flaky.has(key(t)) && before.get(key(t)) !== t.status)
      .map((t) => `${key(t)}: ${before.get(key(t)) ?? 'fehlt'} → ${t.status}`);
    const equivalent = differing.length === 0 && baseline.run.tests.filter((t) => !flaky.has(key(t))).every((t) => instrumentedRun.run.tests.some((u) => key(u) === key(t)));
    for (const f of flaky) say(`  unzuverlässig (Ergebnis wechselt ohne Instrumentierung): ${f}`);
    for (const d of differing) say(`  abweichend mit Instrumentierung: ${d}`);
    const tests = await loadTestCatalog(conn, rtOwner, cfg.tests, baseline.run.tests, instrumentedRun.run.tests, hits);
    const testIndex = new Map(tests.map((t, k) => [t.path, k]));
    for (const t of tests) if (!t.setup && flaky.has(`${t.suite}::${t.description}`)) t.status = 'flaky';
    say(equivalent ? `Testergebnisse mit und ohne Instrumentierung identisch ✓${flaky.size ? ` (${flaky.size} unzuverlässige Tests ausgenommen)` : ''}` : 'ACHTUNG: Testergebnisse weichen ab!');

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
      const ut = utCov.sonar.get(r.key);
      return Object.assign(r, { sourceSha256: sha256(obj.processed), rawSha256: sha256(obj.original) }, ut ? { utplsql: ut } : {});
    });

    return {
      generated: new Date().toISOString(),
      database: banner,
      schema: multi ? schemas.join(',') : schema,
      sqlProbes,
      timings: { baselineMs: baseline.run.ms, utplsqlCoverageMs: utCov.run.ms, instrumentedMs: instrumentedRun.run.ms, instrumentMs, compileMs },
      baseline: baseline.run, utplsqlRun: utCov.run, instrumentedRun: instrumentedRun.run,
      equivalent, flakyTests: [...flaky].sort(), baselineRuns: repeat, differingTests: differing,
      tests, perTest, objects: objectsOut, log: messages,
      ...(unrestored ? { unrestored } : {}),
    };
  } finally {
    clearInterval(ping);
    // the main connection may be what failed (a test crashed its server process): the cleanup on
    // a fresh one then
    let fin = conn;
    if ((logoff || restore.length) && !(await conn.execute('select 1 from dual').then(() => true, () => false))) {
      fin = await connectHome().catch(() => conn);
    }
    await dropLogoff(fin).catch(() => {});
    if (logoff) say('FEHLER: Trigger cov$_logoff nicht entfernt: plgauge restore');
    try {
      if (restore.length && !(await confirmed())) {
        say(`FEHLER: ${restore.length} Objekte nicht wiederhergestellt (Laufsperre nicht bestätigt), ihr instrumentierter Code steht im Journal: plgauge restore`);
      } else if (restore.length) {
        await restoreOwn(restore, fin).catch((e: Error) => say(`FEHLER: Originale nicht wiederhergestellt (${firstLine(e)}), der instrumentierte Code steht im Journal: plgauge restore`));
      }
    } finally {
      if (fin !== conn) await fin.close().catch(() => {});
      await conn.close().catch(() => {});
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
  say(`  warte auf ${n} laufende Scheduler-Jobs …`);
  for (let i = 0; i < 120 && n > 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    n = await running().catch(() => 0);
  }
  await new Promise((r) => setTimeout(r, 1000)); // their logoff writes the hits
}

export async function installRuntime(conn: oracledb.Connection) {
  await tryExecute(conn, HITS_TABLE, 'ORA-00955');
  await tryExecute(conn, RUNS_TABLE, 'ORA-00955');
  await conn.execute(RUNTIME_SPEC);
  await conn.execute(RUNTIME_BODY.replace(/UT3_INFO/g, await utInfoContext(conn)));
  // Native compilation makes the probes cheaper; it does not affect the instrumented code itself.
  await conn.execute(`alter package cov$ compile body plsql_code_type = native plsql_optimize_level = 3`);
  const nativeErr = await conn.execute(`select 1 from user_errors where name = 'COV$'`);
  if (nativeErr.rows?.length) await conn.execute(`alter package cov$ compile body plsql_code_type = interpreted plsql_optimize_level = 3`);
  const err = await conn.execute<[number, string]>(`select line, text from user_errors where name = 'COV$' order by sequence`);
  if (err.rows?.length) throw new Error(`Runtime cov$ kompiliert nicht: ${err.rows.map((r) => `${r[0]}: ${r[1]}`).join('; ')}`);
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
      tests.push({
        path: full, suite, description, setup: false, status, baselineStatus: caseOf(baseline, suite, description)?.status ?? 'unknown', ms: (run?.time ?? 0) * 1000,
      });
    }
  }
  for (const name of hits.perTest.keys()) {
    if (name.startsWith('#') && !tests.some((t) => t.path === name)) {
      const description = name === '#background' ? 'Andere Sessions (Scheduler-Jobs, parallele Abfragen)' : `Setup außerhalb eines Tests (${name.slice(1) || 'ohne utPLSQL'})`;
      tests.push({ path: name, suite: name.slice(1), description, setup: true, status: 'unknown', baselineStatus: 'unknown', ms: 0 });
    }
  }
  return tests;
}


export { parseJunit, parseSonar } from '@plgauge/core';
