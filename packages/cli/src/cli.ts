#!/usr/bin/env -S npx tsx
/**
 * plgauge – coverage and mutation testing for PL/SQL
 *
 *   plgauge coverage --config coverage-config.json [--out report]  measure coverage, write report ("run" is the old name)
 *   plgauge coverage [dir] --db oracle://…               same for a project with plgauge.json (its units, its tests)
 *        --no-warmup --no-utplsql-compare               skip the warm-up run / the run with utPLSQL's own coverage
 *        --fail-on-test-errors                          exit code 5 if tests fail or error already without instrumentation
 *   plgauge instrument <file.sql> [--no-sql]             print instrumented source (offline)
 *   plgauge deploy <file.sql ...> --config coverage-config.json    run SQL*Plus-style scripts (demo setup)
 *   plgauge report <coverage.json> [--mutation run.json] re-render HTML from saved JSON; with mutation results: joint report
 *   plgauge export <coverage.json> [--format F] [--src dir] [--out file]
 *                                                       exchange format plgauge-coverage/1 (json) or for CI:
 *                                                       cobertura, sonar, lcov, junit; --src maps objects to files
 *   plgauge merge a.json b.json … --out merged.json      merge runs (plgauge-coverage/1)
 *   plgauge check <coverage.json|run.json> --min-stmt N --min-branch N --min-cond N --min-mcdc N --min-score N
 *                                                       CI thresholds; exit code 3 if one is missed
 *   plgauge corpus <dir ...> [--db coverage-config.json]           robustness check on a corpus of PL/SQL files
 *   plgauge restore --config coverage-config.json [--list]         put back code left changed by a killed run (journal)
 *   plgauge mutate run [dir] [--mode schema|naive] …     mutation testing of a project with plgauge.json
 *        --diff origin/main                             only mutants on lines changed since the merge base (also coverage, check)
 *   plgauge mutate points|schema [dir]                   list mutants / print the schema rewrite (offline)
 *   plgauge mutate compare a.json b.json                 compare two runs (also against the Go plmut)
 *   plgauge crosscheck --coverage c.json --mutation m.json  recording run of the mutation against measured coverage
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  changedLines, connect, currentSchema, restoreJournal, ensureJournal, firstLine, journalEntries, journalForget, lockRun, preprocess, quoteIdent as qi, RUN_LOCK, splitScript,
  type ConnectConfig,
} from '@plgauge/core';
import {
  checkQuotas, instrument, mergeExports, newIds, quotas, restrictToChanged, runCoverage, runCorpus, sourceMap, sqlFiles, toCobertura,
  toCoverageExport, toJunit,
  toLcov, toSonar, type CoverageExport, type QuotaKey, type RunConfig, type RunReport,
} from '@plgauge/coverage';
import { renderHtml } from '@plgauge/report';
import {
  buildSchema, compare, CoverageIndex, crossCheck, crossCheckText, htmlReport, jsonReport, mutationTestingReport, parseDbUrl,
  loadConfig as loadProject, mutateFiles, projectCoverageConfig, projectMutants, runMutation, switchable, textReport,
  type LinkedResult, type Point,
} from '@plgauge/mutation';

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name: string) => {
  const k = args.indexOf(`--${name}`);
  if (k < 0) return undefined;
  const v = args[k + 1];
  args.splice(k, 2);
  return v;
};
const flag = (name: string) => {
  let k = args.indexOf(`--${name}`);
  if (k < 0 && name.length === 1) k = args.indexOf(`-${name}`);
  if (k < 0) return false;
  args.splice(k, 1);
  return true;
};

/** A coverage JSON of either kind as exchange format. */
function loadExport(file: string): CoverageExport {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return j.format === 'plgauge-coverage/1' ? (j as CoverageExport) : toCoverageExport(j as RunReport);
}

/** A numeric option: undefined if absent; a value that is no number stops with a message (NaN would pass every check). */
function numOpt(n: string): number | undefined {
  const v = opt(n);
  if (v === undefined) return undefined;
  const x = Number(v);
  if (v.trim() === '' || !Number.isFinite(x)) throw new Error(`--${n}: not a number: ${v}`);
  return x;
}

/** --min-stmt/--min-branch/--min-cond/--min-mcdc (coverage) and --min-score (mutation). */
function thresholds() {
  return {
    cov: { stmt: numOpt('min-stmt'), branch: numOpt('min-branch'), cond: numOpt('min-cond'), mcdc: numOpt('min-mcdc') } as Partial<Record<QuotaKey, number>>,
    score: numOpt('min-score'),
  };
}

function enforce(violations: string[]) {
  if (!violations.length) return;
  for (const v of violations) console.error(`Threshold missed: ${v}`);
  process.exitCode = 3;
}

/** --min-score on mutation results (check, mutate run): only ERRORs is no pass, no mutants fail nothing; an aborted run's partial score gates nothing. */
function scoreGate(results: { status: string }[], min: number | undefined, aborted: boolean, print = false): void {
  const valid = results.filter((r) => ['KILLED', 'TIMEOUT', 'MEMORY', 'SURVIVED', 'NOT_COVERED'].includes(r.status));
  const det = valid.filter((r) => ['KILLED', 'TIMEOUT', 'MEMORY'].includes(r.status)).length;
  const score = valid.length ? (100 * det) / valid.length : 100;
  if (print) console.error(`Mutation Score ${score.toFixed(1)} % (${det}/${valid.length})`);
  if (min === undefined) return;
  if (!valid.length && results.some((r) => r.status === 'ERROR')) {
    console.error('No mutant can be scored (errors only): the threshold cannot be checked');
    process.exitCode = 1;
  } else if (!aborted && score + 1e-9 < min) enforce([`Mutation Score: ${score.toFixed(1)} % < ${min} %`]);
}

function loadConfig(path: string | undefined): RunConfig {
  if (!path) throw new Error('missing --config');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as RunConfig;
  cfg.password = process.env.PLGAUGE_PASSWORD ?? cfg.password;
  // script paths are relative to the config file
  cfg.beforeTests = cfg.beforeTests?.map((s) => resolve(dirname(path), s));
  cfg.afterTests = cfg.afterTests?.map((s) => resolve(dirname(path), s));
  return cfg;
}

async function main() {
  switch (cmd) {
    case 'coverage':
    case 'run': {
      const configFile = opt('config');
      const db = opt('db') ?? process.env.PLGAUGE_DB?.split(',')[0];
      const skipInstall = flag('skip-install');
      const noWarmup = flag('no-warmup');
      const noUtCompare = flag('no-utplsql-compare');
      const failOnTestErrors = flag('fail-on-test-errors');
      const th = thresholds();
      const diffRef = opt('diff');
      const src = opt('src');
      const out = resolve(opt('out') ?? 'plgauge-report');
      const project = configFile || !db ? undefined : args.shift() ?? '.';
      const cfg = project === undefined ? loadConfig(configFile) : await projectCoverageConfig(project, db!, !skipInstall, (m) => console.error(m));
      if (noWarmup) cfg.warmup = false;
      if (noUtCompare) cfg.utplsqlCompare = false;
      const report = await runCoverage(cfg);
      let exp = toCoverageExport(report);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'coverage.json'), JSON.stringify(report, null, 1));
      writeFileSync(join(out, 'plgauge-coverage.json'), JSON.stringify(exp, null, 1));
      writeFileSync(join(out, 'index.html'), renderHtml(report));
      console.error(`Report: ${join(out, 'index.html')}`);
      if (!report.equivalent) {
        console.error('Test results differ with instrumentation');
        process.exitCode = 4;
      }
      if (diffRef) {
        const files = project !== undefined ? mutateFiles(loadProject(project), project) : src ? sqlFiles(src) : [];
        if (!files.length) throw new Error('--diff needs a project or --src with the source files');
        exp = restrictToChanged(exp, sourceMap(files), changedLines(diffRef));
        const q = quotas(exp);
        console.error(`Changed code (since ${diffRef}): statements ${q.stmt.covered}/${q.stmt.total} · branches ${q.branch.covered}/${q.branch.total} · conditions ${q.cond.covered}/${q.cond.total}`);
      }
      enforce(checkQuotas(exp, th.cov));
      // tests red without instrumentation (the run printed why): the coverage of their code says little
      const red = report.baseline.tests.filter((t) => t.status === 'failed' || t.status === 'error').length;
      if (red && (failOnTestErrors || cfg.failOnTestErrors)) {
        console.error(`${red} tests fail or error without instrumentation`);
        process.exitCode = 5;
      }
      // changed code left in the schema: always a failure (set after the gate above)
      if (report.unrestored) {
        console.error(`ERROR: ${report.unrestored} objects not restored: plgauge restore`);
        process.exitCode = 1;
      }
      if (report.afterTestsFailed) process.exitCode = 1;
      break;
    }
    case 'report': {
      const file = args.shift();
      if (!file) throw new Error('missing coverage.json');
      const out = resolve(opt('out') ?? 'plgauge-report');
      const mutation = opt('mutation');
      const report = JSON.parse(readFileSync(file, 'utf8')) as RunReport;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'index.html'), renderHtml(report, mutation ? { mutation: JSON.parse(readFileSync(mutation, 'utf8')) } : {}));
      console.error(`Report: ${join(out, 'index.html')}`);
      break;
    }
    case 'export': {
      const file = args.shift();
      if (!file) throw new Error('missing coverage.json');
      const format = opt('format') ?? 'json';
      const src = opt('src');
      const exp = loadExport(file);
      const map = src ? sourceMap(sqlFiles(src), (p) => relative(process.cwd(), p)) : undefined;
      const ext: Record<string, string> = { json: 'plgauge-coverage.json', cobertura: 'cobertura.xml', sonar: 'sonar-coverage.xml', lcov: 'lcov.info', junit: 'junit.xml' };
      if (!ext[format]) throw new Error(`unknown format ${format}: ${Object.keys(ext).join(', ')}`);
      const out = resolve(opt('out') ?? ext[format]);
      const text = format === 'json' ? JSON.stringify(exp, null, 1) : format === 'cobertura' ? toCobertura(exp, map)
        : format === 'sonar' ? toSonar(exp, map) : format === 'lcov' ? toLcov(exp, map) : toJunit(exp);
      writeFileSync(out, text);
      if (map) {
        const missing = exp.objects.filter((o) => !map.has(`${o.type} ${o.name}`.toUpperCase())).map((o) => o.name);
        if (missing.length) console.error(`no source file (virtual path): ${missing.join(', ')}`);
      }
      console.error(`Export (${format}): ${out}`);
      break;
    }
    case 'merge': {
      const out = resolve(opt('out') ?? 'plgauge-coverage.json');
      if (args.length < 2) throw new Error('merge needs at least two files');
      const m = mergeExports(args.splice(0).map(loadExport));
      writeFileSync(out, JSON.stringify(m, null, 1));
      const q = quotas(m);
      console.error(`${m.objects.length} objects, ${m.tests.length} tests · statements ${q.stmt.covered}/${q.stmt.total} · branches ${q.branch.covered}/${q.branch.total}`);
      console.error(`Merged: ${out}`);
      break;
    }
    case 'check': {
      const file = args.shift();
      if (!file) throw new Error('missing file');
      const th = thresholds();
      const diffRef = opt('diff');
      const src = opt('src');
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(j.results)) {
        // an aborted run's partial score says nothing (as in mutate run)
        scoreGate(j.results, j.aborted ? undefined : th.score, false, true);
        if (j.aborted) {
          console.error(`Run aborted: ${j.aborted}`);
          process.exitCode = 1;
        }
      } else {
        let exp = loadExport(file);
        if (diffRef) {
          if (!src) throw new Error('--diff needs --src with the source files');
          exp = restrictToChanged(exp, sourceMap(sqlFiles(src)), changedLines(diffRef));
        }
        const q = quotas(exp);
        console.error((Object.keys(q) as QuotaKey[]).map((k) => `${k} ${q[k].total ? ((100 * q[k].covered) / q[k].total).toFixed(1) : '–'} %`).join(' · '));
        enforce(checkQuotas(exp, th.cov));
      }
      break;
    }
    case 'corpus': {
      const dbCfg = opt('db');
      const out = opt('out');
      const cfg = dbCfg ? loadConfig(dbCfg) : undefined;
      const r = await runCorpus(args, cfg && { user: cfg.user, password: cfg.password, connectString: cfg.connectString });
      const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)} %` : '–');
      console.log(`Files ${r.files} · bodies ${r.units.body} · specs ${r.units.spec} · Latin-1 files ${r.latin1Files.length}`);
      console.log(`Parsed and instrumented: ${r.parsed}/${r.units.body} (${pct(r.parsed, r.units.body)}) in ${r.ms.toFixed(0)} ms`);
      console.log(`Statements ${r.statements} · decisions ${r.decisions} · conditions ${r.conditions} · not measured ${r.gaps}`);
      console.log(`Parser: ${r.opaque.regions} expression regions not fully read, ${pct(r.opaque.tokens, r.opaque.totalTokens)} of the tokens`);
      for (const f of r.failures) console.log(`  ✗ ${f.unit}: ${f.error}`);
      if (r.db) {
        console.log(`DB: original compiled ${r.db.originalOk} · instrumented compiled ${r.db.instrumentedOk}/${r.db.originalOk} (${pct(r.db.instrumentedOk, r.db.originalOk)})`);
        for (const f of r.db.failures) console.log(`  ✗ ${f.unit}: ${f.error}`);
      }
      if (out) writeFileSync(out, JSON.stringify(r, null, 1));
      break;
    }
    case 'instrument': {
      const noSql = flag('no-sql');
      const file = args.shift();
      if (!file) throw new Error('missing file');
      for (const stmt of splitScript(readFileSync(file, 'utf8'))) {
        const r = instrument(preprocess(stmt + '\n'), 'SCHEMA', newIds(), { sqlProbes: !noSql });
        process.stdout.write(r.instrumented + '/\n');
      }
      break;
    }
    case 'deploy': {
      const cfg = loadConfig(opt('config'));
      const conn = await connect(cfg);
      try {
        for (const file of args) {
          for (const stmt of splitScript(readFileSync(file, 'utf8'))) {
            try {
              await conn.execute(stmt);
            } catch (e) {
              const msg = (e as Error).message;
              if (/ORA-00955|ORA-02260|ORA-02275/.test(msg)) continue; // already exists
              throw new Error(`${file}: ${msg}`);
            }
          }
          console.error(`✓ ${file}`);
        }
        const inv = await conn.execute<[string, string]>(`select object_name, object_type from user_objects where status = 'INVALID'`);
        if (inv.rows?.length) console.error(`Invalid objects: ${inv.rows.map((r) => r.join(' ')).join(', ')}`);
      } finally {
        await conn.close();
      }
      break;
    }
    case 'mutate': {
      const sub = args.shift();
      const ops = opt('ops');
      const opSet = ops && ops !== 'all' ? new Set(ops.split(',').map((o) => o.trim().toUpperCase())) : undefined;
      const sampleN = numOpt('sample') ?? 0;
      const seed = numOpt('seed') ?? 1;
      const db = opt('db') ?? process.env.PLGAUGE_DB ?? '';
      const mode = (opt('mode') ?? 'schema') as 'schema' | 'naive';
      const factor = numOpt('timeout-factor') ?? 5;
      if (factor <= 0) throw new Error('--timeout-factor must be greater than 0');
      const jsonOut = opt('json');
      const reportOut = opt('report');
      const resetCmd = opt('reset-cmd');
      const coverageFile = opt('coverage');
      const minScore = thresholds().score;
      const diffRef = opt('diff');
      const skipInstall = flag('skip-install');
      const quiet = flag('q');
      const noConfirm = flag('no-confirm');
      if (sub === 'compare') {
        const [a, b] = args;
        if (!a || !b) throw new Error('compare needs two JSON files');
        console.log(compare(a, b).text);
        break;
      }
      const dir = args.shift() ?? '.';
      const diff = diffRef ? changedLines(diffRef, dir) : undefined;
      if (sub === 'points') {
        const { files, mutants } = projectMutants(dir, { ops: opSet, diff });
        for (const f of files) for (const e of f.errors) console.log(`${f.path}: syntax error ${e}`);
        const one = (s: string) => s.split(/\s+/).filter(Boolean).join(' ');
        for (const m of mutants) console.log(`${String(m.id).padStart(4)} ${m.file}:${m.line}:${m.col} ${m.op} ${m.sub} ${one(m.original)} → ${one(m.mutated)}`);
        break;
      }
      if (sub === 'schema') {
        const { mutants } = projectMutants(dir, { ops: opSet });
        const naive = new Set<Point>(mutants.filter((m) => !switchable(m.point)).map((m) => m.point));
        for (const su of buildSchema(mutants, new Set(), naive)) process.stdout.write(`-- ${su.key}\n${su.text}\n/\n`);
        break;
      }
      if (sub !== 'run') throw new Error('Usage: plgauge mutate run|points|schema|compare …');
      const rep = await runMutation({
        dir, dbUrls: db.split(',').filter(Boolean), ops: opSet, timeoutFactor: factor, mode, skipInstall, diff,
        resetCmd, sample: sampleN, seed, log: quiet ? undefined : (m) => console.error(m), confirm: !noConfirm,
        coverage: coverageFile ? (JSON.parse(readFileSync(coverageFile, 'utf8')) as CoverageExport) : undefined,
      });
      process.stdout.write(textReport(rep));
      if (rep.aborted) process.exitCode = 1;
      if (jsonOut) writeFileSync(jsonOut, jsonReport(rep));
      if (reportOut) writeFileSync(reportOut, reportOut.endsWith('.html') ? htmlReport(rep, dir) : mutationTestingReport(rep, dir));
      // (an aborted run's exit code (1) stands)
      scoreGate(rep.results, minScore, !!rep.aborted);
      // changed code left in the schema outranks the score gate
      if (rep.unrestored?.length || rep.afterTestsFailed?.length) process.exitCode = 1;
      break;
    }
    case 'crosscheck': {
      const cov = opt('coverage');
      const mut = opt('mutation');
      if (!cov || !mut) throw new Error('Usage: plgauge crosscheck --coverage plgauge-coverage.json --mutation run.json');
      const idx = new CoverageIndex(JSON.parse(readFileSync(cov, 'utf8')) as CoverageExport);
      const res = (JSON.parse(readFileSync(mut, 'utf8')).results ?? []) as LinkedResult[];
      if (!res.some((r) => r.coveredBy)) throw new Error('Mutation run without recorded tests (needs the schema mode of plgauge)');
      const c = crossCheck(res, idx);
      process.stdout.write(crossCheckText(c));
      if (c.contradictions.length) process.exitCode = 1;
      break;
    }
    case 'restore': {
      const configFile = opt('config');
      // every database of a mutation run with several workers (each keeps its own journal)
      const dbs = (opt('db') ?? process.env.PLGAUGE_DB ?? '').split(',').map((u) => u.trim()).filter(Boolean);
      const fromUrls = !configFile && dbs.length > 0;
      const cfgs: (ConnectConfig & Partial<RunConfig>)[] = fromUrls ? dbs.map((u) => parseDbUrl(u)) : [loadConfig(configFile)];
      const listOnly = flag('list');
      // entries that cannot be restored at all (their table is gone, say) would block every run
      const forget = flag('forget');
      // a database URL: the journal of a mutation run (the session's CURRENT_SCHEMA) and of a
      // coverage run of a project (the user's own schema); they differ only with a logon trigger
      const targets = cfgs.flatMap((c) => (fromUrls ? [[c, false], [c, true]] : [[c, false]]) as [typeof c, boolean][]);
      const seen = new Set<string>();
      for (const [cfg, own] of targets) {
        if (!cfg.user) throw new Error('no database given: pass --db or a coverage configuration');
        // one database that fails (gone, locked by a run) must not keep the others from their restore
        try {
          if (cfgs.length > 1 && !own) console.error(`${cfg.user}@${cfg.connectString ?? ''}:`);
          const conn = await connect(cfg);
          try {
            const session = await currentSchema(conn);
            // a mutation run (a database URL) works in its session's CURRENT_SCHEMA, which a logon
            // trigger may set; a coverage run in its runtime schema
            const home = fromUrls
              ? own ? cfg.user.toUpperCase() : session
              : (cfg.schemas?.length ? cfg.runtimeSchema ?? cfg.user : cfg.schema ?? cfg.user).toUpperCase();
            const where = `${cfg.connectString ?? ''}|${home}`;
            if (seen.has(where)) continue;
            seen.add(where);
            if (own) console.error(`(schema ${home}:)`);
            await conn.execute(`alter session set current_schema = ${qi(home)}`);
            await ensureJournal(conn);
            const entries = await journalEntries(conn);
            // a coverage run that died during its instrumented test run left its logoff trigger
            const logoff = (await conn.execute<[number]>(`select count(*) from all_triggers where owner = :o and trigger_name = 'COV$_LOGOFF'`, { o: home })).rows?.[0]?.[0] ?? 0;
            if (!entries.length && !logoff) {
              console.error('Journal empty: no object is changed.');
              // a coverage run of another schema keeps its journal there (plgauge restore --config …)
              if (fromUrls) {
                const other = await conn.execute<[string]>(`select owner from all_tables where table_name = 'PLGAUGE_JOURNAL' and owner not in (user, :h, :s)`, { h: home, s: session }).catch(() => ({ rows: [] as [string][] }));
                for (const [o] of other.rows ?? []) console.error(`  Note: schema ${o} has a journal too (a coverage run there: plgauge restore --config …)`);
              }
              continue;
            }
            for (const e of entries) console.error(`  ${e.type} ${e.owner}.${e.name} (${e.tool}, since ${e.createdAt.toISOString()})`);
            if (logoff) console.error(`  TRIGGER ${home}.COV$_LOGOFF (coverage runtime of an aborted run)`);
            if (!listOnly) {
              const lock = await connect(cfg);
              try {
                await lock.execute(`alter session set current_schema = ${qi(home)}`);
                // a running run (of either tool) holds the lock: its objects are not leftovers
                await lockRun(lock, RUN_LOCK);
                if (logoff) await conn.execute(`drop trigger ${qi(home)}.cov$_logoff`).then(
                  () => console.error('Coverage logoff trigger dropped'),
                  (e: Error) => { if (!e.message.includes('ORA-04080')) console.error(`  ✗ Logoff trigger not dropped: ${firstLine(e)}`); });
                // read again under the lock: a run that finished meanwhile left other entries
                await restoreJournal(conn, await journalEntries(conn), (m) => console.error(m));
                const still = await journalEntries(conn);
                if (still.length && forget) {
                  for (const e of still) await journalForget(conn, e.object);
                  console.error(`${still.length} entries deleted from the journal without restore: ${still.map((e) => e.name).join(', ')}`);
                } else if (still.length) {
                  console.error(`${still.length} entries could not be restored; --forget deletes them from the journal`);
                  process.exitCode = 1;
                }
              } finally {
                await lock.close().catch(() => {});
              }
            }
          } finally {
            await conn.close();
          }
        } catch (e) {
          console.error(`  ✗ ${firstLine(e)}`);
          process.exitCode = 1;
        }
      }
      break;
    }
    default:
      console.error('Usage: plgauge coverage|mutate|report|export|merge|check|crosscheck|instrument|deploy|corpus|restore …  (see README.md)');
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
