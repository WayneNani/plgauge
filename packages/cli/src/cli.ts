#!/usr/bin/env -S npx tsx
/**
 * pltest – coverage and mutation testing for PL/SQL
 *
 *   pltest coverage --config plcov.json [--out report]  measure coverage, write report ("run" is the old name)
 *   pltest coverage [dir] --db oracle://…               same for a project with pltest.json/plmut.json (its units, its tests)
 *   pltest instrument <file.sql> [--no-sql]             print instrumented source (offline)
 *   pltest deploy <file.sql ...> --config plcov.json    run SQL*Plus-style scripts (demo setup)
 *   pltest report <coverage.json> [--mutation run.json] re-render HTML from saved JSON; with mutation results: joint report
 *   pltest export <coverage.json> [--format F] [--src dir] [--out file]
 *                                                       exchange format plcov-coverage/1 (json) or for CI:
 *                                                       cobertura, sonar, lcov, junit; --src maps objects to files
 *   pltest merge a.json b.json … --out merged.json      merge runs (plcov-coverage/1)
 *   pltest check <coverage.json|run.json> --min-stmt N --min-branch N --min-cond N --min-mcdc N --min-score N
 *                                                       CI thresholds; exit code 3 if one is missed
 *   pltest corpus <dir ...> [--db plcov.json]           robustness check on a corpus of PL/SQL files
 *   pltest restore --config plcov.json [--list]         put back code left changed by a killed run (journal)
 *   pltest mutate run [dir] [--mode schema|naive] …     mutation testing of a project with pltest.json
 *        --diff origin/main                             only mutants on lines changed since the merge base (also coverage, check)
 *   pltest mutate points|schema [dir]                   list mutants / print the schema rewrite (offline)
 *   pltest mutate compare a.json b.json                 compare two runs (also against the Go plmut)
 *   pltest crosscheck --coverage c.json --mutation m.json  recording run of the mutation against measured coverage
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { changedLines, connect, restoreJournal, dbIdent, ensureJournal, journalEntries, journalForget, lockRun, preprocess, RUN_LOCK, splitScript } from '@pltest/core';
import {
  checkQuotas, instrument, mergeExports, newIds, quotas, restrictToChanged, runCoverage, runCorpus, sourceMap, toCobertura,
  toCoverageExport, toJunit,
  toLcov, toSonar, type CoverageExport, type QuotaKey, type RunConfig, type RunReport,
} from '@pltest/coverage';
import { renderHtml } from '@pltest/report';
import {
  buildSchema, compare, CoverageIndex, crossCheck, crossCheckText, htmlReport, jsonReport, mutationTestingReport, parseDbUrl,
  loadConfig as loadProject, mutateFiles, projectCoverageConfig, projectMutants, runMutation, score, switchable, textReport,
  type LinkedResult, type Point,
} from '@pltest/mutation';

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
  return j.format === 'plcov-coverage/1' ? (j as CoverageExport) : toCoverageExport(j as RunReport);
}

const SQL_EXT = /\.(sql|pks|pkb|pkg|tps|tpb|typ|prc|fnc|trg|bdy|spc|plb|pls)$/i;
function sqlFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sqlFiles(p, out);
    else if (SQL_EXT.test(e)) out.push(p);
  }
  return out;
}

/** A numeric option: undefined if absent; a value that is no number stops with a message (NaN would pass every check). */
function numOpt(n: string): number | undefined {
  const v = opt(n);
  if (v === undefined) return undefined;
  const x = Number(v);
  if (v.trim() === '' || !Number.isFinite(x)) throw new Error(`--${n}: keine Zahl: ${v}`);
  return x;
}

/** --min-stmt/--min-branch/--min-cond/--min-mcdc (coverage) and --min-score (mutation). */
function thresholds() {
  const num = (n: string) => numOpt(n);
  return {
    cov: { stmt: num('min-stmt'), branch: num('min-branch'), cond: num('min-cond'), mcdc: num('min-mcdc') } as Partial<Record<QuotaKey, number>>,
    score: num('min-score'),
  };
}

function enforce(violations: string[]) {
  if (!violations.length) return;
  for (const v of violations) console.error(`Schwelle verfehlt: ${v}`);
  process.exitCode = 3;
}

function loadConfig(path: string | undefined): RunConfig {
  if (!path) throw new Error('--config fehlt');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as RunConfig;
  cfg.password = process.env.PLTEST_PASSWORD ?? process.env.PLCOV_PASSWORD ?? cfg.password;
  return cfg;
}

async function main() {
  switch (cmd) {
    case 'coverage':
    case 'run': {
      const configFile = opt('config');
      const db = opt('db') ?? process.env.PLMUT_DB?.split(',')[0];
      const skipInstall = flag('skip-install');
      const th = thresholds();
      const diffRef = opt('diff');
      const src = opt('src');
      const out = resolve(opt('out') ?? 'plcov-report');
      const project = configFile || !db ? undefined : args.shift() ?? '.';
      const cfg = project === undefined ? loadConfig(configFile) : await projectCoverageConfig(project, db!, !skipInstall, (m) => console.error(m));
      const report = await runCoverage(cfg);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'coverage.json'), JSON.stringify(report, null, 1));
      writeFileSync(join(out, 'plcov-coverage.json'), JSON.stringify(toCoverageExport(report), null, 1));
      writeFileSync(join(out, 'index.html'), renderHtml(report));
      console.error(`Bericht: ${join(out, 'index.html')}`);
      if (!report.equivalent) {
        console.error('Testergebnisse mit Instrumentierung weichen ab');
        process.exitCode = 4;
      }
      let exp = toCoverageExport(report);
      if (diffRef) {
        const files = project !== undefined ? mutateFiles(loadProject(project), project) : src ? sqlFiles(src) : [];
        if (!files.length) throw new Error('--diff braucht ein Projekt oder --src mit den Quelldateien');
        exp = restrictToChanged(exp, sourceMap(files), changedLines(diffRef));
        const q = quotas(exp);
        console.error(`Geänderter Code (seit ${diffRef}): Anweisungen ${q.stmt.covered}/${q.stmt.total} · Branches ${q.branch.covered}/${q.branch.total} · Bedingungen ${q.cond.covered}/${q.cond.total}`);
      }
      enforce(checkQuotas(exp, th.cov));
      break;
    }
    case 'report': {
      const file = args.shift();
      if (!file) throw new Error('coverage.json fehlt');
      const out = resolve(opt('out') ?? 'plcov-report');
      const mutation = opt('mutation');
      const report = JSON.parse(readFileSync(file, 'utf8')) as RunReport;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'index.html'), renderHtml(report, mutation ? { mutation: JSON.parse(readFileSync(mutation, 'utf8')) } : {}));
      console.error(`Bericht: ${join(out, 'index.html')}`);
      break;
    }
    case 'export': {
      const file = args.shift();
      if (!file) throw new Error('coverage.json fehlt');
      const format = opt('format') ?? 'json';
      const src = opt('src');
      const exp = loadExport(file);
      const map = src ? sourceMap(sqlFiles(src), (p) => relative(process.cwd(), p)) : undefined;
      const ext: Record<string, string> = { json: 'plcov-coverage.json', cobertura: 'cobertura.xml', sonar: 'sonar-coverage.xml', lcov: 'lcov.info', junit: 'junit.xml' };
      if (!ext[format]) throw new Error(`unbekanntes Format ${format}: ${Object.keys(ext).join(', ')}`);
      const out = resolve(opt('out') ?? ext[format]);
      const text = format === 'json' ? JSON.stringify(exp, null, 1) : format === 'cobertura' ? toCobertura(exp, map)
        : format === 'sonar' ? toSonar(exp, map) : format === 'lcov' ? toLcov(exp, map) : toJunit(exp);
      writeFileSync(out, text);
      if (map) {
        const missing = exp.objects.filter((o) => !map.has(`${o.type} ${o.name}`.toUpperCase())).map((o) => o.name);
        if (missing.length) console.error(`ohne Quelldatei (virtueller Pfad): ${missing.join(', ')}`);
      }
      console.error(`Export (${format}): ${out}`);
      break;
    }
    case 'merge': {
      const out = resolve(opt('out') ?? 'plcov-coverage.json');
      if (args.length < 2) throw new Error('merge braucht mindestens zwei Dateien');
      const m = mergeExports(args.splice(0).map(loadExport));
      writeFileSync(out, JSON.stringify(m, null, 1));
      const q = quotas(m);
      console.error(`${m.objects.length} Objekte, ${m.tests.length} Tests · Anweisungen ${q.stmt.covered}/${q.stmt.total} · Branches ${q.branch.covered}/${q.branch.total}`);
      console.error(`Zusammengeführt: ${out}`);
      break;
    }
    case 'check': {
      const file = args.shift();
      if (!file) throw new Error('Datei fehlt');
      const th = thresholds();
      const diffRef = opt('diff');
      const src = opt('src');
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(j.results)) {
        const valid = j.results.filter((r: { status: string }) => ['KILLED', 'TIMEOUT', 'MEMORY', 'SURVIVED', 'NOT_COVERED'].includes(r.status));
        const det = valid.filter((r: { status: string }) => ['KILLED', 'TIMEOUT', 'MEMORY'].includes(r.status)).length;
        const score = valid.length ? (100 * det) / valid.length : 100;
        console.error(`Mutation Score ${score.toFixed(1)} % (${det}/${valid.length})`);
        if (th.score !== undefined && score + 1e-9 < th.score) enforce([`Mutation Score: ${score.toFixed(1)} % < ${th.score} %`]);
      } else {
        let exp = loadExport(file);
        if (diffRef) {
          if (!src) throw new Error('--diff braucht --src mit den Quelldateien');
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
      console.log(`Dateien ${r.files} · Bodies ${r.units.body} · Spezifikationen ${r.units.spec} · Latin-1-Dateien ${r.latin1Files.length}`);
      console.log(`Geparst und instrumentiert: ${r.parsed}/${r.units.body} (${pct(r.parsed, r.units.body)}) in ${r.ms.toFixed(0)} ms`);
      console.log(`Anweisungen ${r.statements} · Entscheidungen ${r.decisions} · Teilbedingungen ${r.conditions} · nicht gemessen ${r.gaps}`);
      console.log(`Parser: ${r.opaque.regions} Ausdrucksbereiche nicht vollständig gelesen, ${pct(r.opaque.tokens, r.opaque.totalTokens)} der Tokens`);
      for (const f of r.failures) console.log(`  ✗ ${f.unit}: ${f.error}`);
      if (r.db) {
        console.log(`DB: Original kompiliert ${r.db.originalOk} · instrumentiert kompiliert ${r.db.instrumentedOk}/${r.db.originalOk} (${pct(r.db.instrumentedOk, r.db.originalOk)})`);
        for (const f of r.db.failures) console.log(`  ✗ ${f.unit}: ${f.error}`);
      }
      if (out) writeFileSync(out, JSON.stringify(r, null, 1));
      break;
    }
    case 'instrument': {
      const noSql = flag('no-sql');
      const file = args.shift();
      if (!file) throw new Error('Datei fehlt');
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
        if (inv.rows?.length) console.error(`Ungültige Objekte: ${inv.rows.map((r) => r.join(' ')).join(', ')}`);
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
      const db = opt('db') ?? process.env.PLMUT_DB ?? '';
      const mode = (opt('mode') ?? 'schema') as 'schema' | 'naive';
      const factor = numOpt('timeout-factor') ?? 5;
      if (factor <= 0) throw new Error('--timeout-factor muss größer als 0 sein');
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
        if (!a || !b) throw new Error('compare braucht zwei JSON-Dateien');
        console.log(compare(a, b).text);
        break;
      }
      const dir = args.shift() ?? '.';
      const diff = diffRef ? changedLines(diffRef, dir) : undefined;
      if (sub === 'points') {
        const { files, mutants } = projectMutants(dir, { ops: opSet, diff });
        for (const f of files) for (const e of f.errors) console.log(`${f.path}: Syntaxfehler ${e}`);
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
      if (sub !== 'run') throw new Error('Verwendung: pltest mutate run|points|schema|compare …');
      const rep = await runMutation({
        dir, dbUrls: db.split(',').filter(Boolean), ops: opSet, timeoutFactor: factor, mode, skipInstall, diff,
        resetCmd, sample: sampleN, seed, log: quiet ? undefined : (m) => console.error(m), confirm: !noConfirm,
        coverage: coverageFile ? (JSON.parse(readFileSync(coverageFile, 'utf8')) as CoverageExport) : undefined,
      });
      process.stdout.write(textReport(rep));
      if (rep.aborted) process.exitCode = 1;
      if (jsonOut) writeFileSync(jsonOut, jsonReport(rep));
      if (reportOut) writeFileSync(reportOut, reportOut.endsWith('.html') ? htmlReport(rep, dir) : mutationTestingReport(rep, dir));
      // nothing to score (no mutants in the diff, say): nothing fails the gate, as in pltest check
      const scored = rep.results.some((r) => ['KILLED', 'TIMEOUT', 'MEMORY', 'SURVIVED', 'NOT_COVERED'].includes(r.status));
      // an aborted run's partial score says nothing: its exit code (1) stands
      if (minScore !== undefined && scored && !rep.aborted && score(rep) + 1e-9 < minScore) enforce([`Mutation Score: ${score(rep).toFixed(1)} % < ${minScore} %`]);
      break;
    }
    case 'crosscheck': {
      const cov = opt('coverage');
      const mut = opt('mutation');
      if (!cov || !mut) throw new Error('Verwendung: pltest crosscheck --coverage plcov-coverage.json --mutation run.json');
      const idx = new CoverageIndex(JSON.parse(readFileSync(cov, 'utf8')) as CoverageExport);
      const res = (JSON.parse(readFileSync(mut, 'utf8')).results ?? []) as LinkedResult[];
      if (!res.some((r) => r.coveredBy)) throw new Error('Mutationslauf ohne aufgezeichnete Tests (Schema-Modus von pltest nötig)');
      const c = crossCheck(res, idx);
      process.stdout.write(crossCheckText(c));
      if (c.contradictions.length) process.exitCode = 1;
      break;
    }
    case 'restore': {
      const configFile = opt('config');
      const db = opt('db') ?? process.env.PLMUT_DB?.split(',')[0];
      const cfg = configFile || !db ? loadConfig(configFile) : parseDbUrl(db);
      const listOnly = flag('list');
      // entries that cannot be restored at all (their table is gone, say) would block every run
      const forget = flag('forget');
      if (!(cfg as { user?: string }).user) throw new Error('keine Datenbankangaben: --db oder eine Coverage-Konfiguration angeben');
      // journal and lock live where the runs keep them: the coverage config's runtime schema
      const c2 = cfg as { schema?: string; schemas?: string[]; runtimeSchema?: string; user: string };
      const home = (c2.schemas?.length ? c2.runtimeSchema ?? c2.user : c2.schema ?? c2.user).toUpperCase();
      const conn = await connect(cfg);
      try {
        await conn.execute(`alter session set current_schema = ${dbIdent(home)}`);
        await ensureJournal(conn);
        const entries = await journalEntries(conn);
        // a coverage run that died during its instrumented test run left its logoff trigger
        const logoff = (await conn.execute<[number]>(`select count(*) from all_triggers where owner = :o and trigger_name = 'COV$_LOGOFF'`, { o: home })).rows?.[0]?.[0] ?? 0;
        if (!entries.length && !logoff) {
          console.error('Journal leer: kein Objekt ist verändert.');
          break;
        }
        for (const e of entries) console.error(`  ${e.type} ${e.owner}.${e.name} (${e.tool}, seit ${e.createdAt.toISOString()})`);
        if (logoff) console.error(`  TRIGGER ${home}.COV$_LOGOFF (Coverage-Laufzeit eines abgebrochenen Laufs)`);
        if (!listOnly) {
          const lock = await connect(cfg);
          try {
            await lock.execute(`alter session set current_schema = ${dbIdent(home)}`);
            // a running run (of either tool) holds the lock: its objects are not leftovers
            await lockRun(lock, RUN_LOCK);
            if (logoff) {
              await conn.execute(`drop trigger ${dbIdent(home)}.cov$_logoff`).then(
                () => console.error('Logoff-Trigger der Coverage entfernt'),
                (e: Error) => { if (!e.message.includes('ORA-04080')) console.error(`  ✗ Logoff-Trigger nicht entfernt: ${e.message.split('\n')[0]}`); });
            }
            // read again under the lock: a run that finished meanwhile left other entries
            await restoreJournal(conn, await journalEntries(conn), (m) => console.error(m));
            const still = await journalEntries(conn);
            if (still.length && forget) {
              for (const e of still) await journalForget(conn, e.object);
              console.error(`${still.length} Einträge ohne Wiederherstellung aus dem Journal gelöscht: ${still.map((e) => e.name).join(', ')}`);
            } else if (still.length) {
              console.error(`${still.length} Einträge ließen sich nicht wiederherstellen; --forget löscht sie aus dem Journal`);
              process.exitCode = 1;
            }
          } finally {
            await lock.close().catch(() => {});
          }
        }
      } finally {
        await conn.close();
      }
      break;
    }
    default:
      console.error('Verwendung: pltest coverage|mutate|report|export|merge|check|crosscheck|instrument|deploy|corpus|restore …  (siehe README.md)');
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
