/**
 * Orchestrates a coverage run against a database:
 *
 *  1. baseline test run without coverage (timing)
 *  2. baseline test run with utPLSQL's own coverage (line coverage for comparison)
 *  3. instrument + compile all code objects of the schema
 *  4. test run on instrumented code, flush probes
 *  5. restore original code (always, also on failure)
 *  6. compare test results of 1 and 4 (instrumentation must not change behaviour)
 */
import oracledb from 'oracledb';
import { createHash, randomUUID } from 'node:crypto';
import { instrument } from './instrument.js';
import { analyze, type ObjectResult } from './analyze.js';
import { newIds, type Hits, type ObjectMap, type TestHits, type TestInfo } from './model.js';
import { HITS_TABLE, RUNTIME_BODY, RUNTIME_SPEC } from './runtime.js';

export interface RunConfig {
  user: string;
  password: string;
  connectString: string;
  /** Schema whose code is measured. */
  schema: string;
  /** utPLSQL suite paths to run, e.g. ["demo"]. */
  tests: string[];
  /** Optional regular expression of object names to include / exclude. */
  include?: string;
  exclude?: string;
  /** "auto" enables SQL probes on 23ai and later. */
  sqlProbes?: 'auto' | boolean;
  /** Record which test reaches which probe (default true). */
  perTest?: boolean;
}

export interface TestCase {
  suite: string;
  name: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  time: number;
}

export interface TestRun {
  tests: TestCase[];
  ms: number;
}

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
  equivalent: boolean;
  /** Tests of the run; per-test coverage refers to indices into this list. */
  tests: TestInfo[];
  perTest: boolean;
  objects: ObjectResult[];
  log: string[];
}

interface SourceObject {
  name: string;
  type: string;
  original: string;
  processed: string;
  settings: Record<string, string>;
}

export async function runCoverage(cfg: RunConfig, log: (m: string) => void = console.error): Promise<RunReport> {
  const messages: string[] = [];
  const say = (m: string) => { messages.push(m); log(m); };
  const conn = await oracledb.getConnection({ user: cfg.user, password: cfg.password, connectString: cfg.connectString });
  const schema = cfg.schema.toUpperCase();
  const restore: SourceObject[] = [];
  try {
    await conn.execute(`alter session set current_schema = ${dbIdent(schema)}`);
    const ver = await conn.execute<[string]>(`select banner_full from v$version where rownum = 1`);
    const banner = ver.rows?.[0]?.[0]?.split('\n')[0] ?? 'Oracle Database';
    const major = Number((await conn.execute<[number]>(`select to_number(regexp_substr(version_full, '^\\d+')) from product_component_version where rownum = 1`)).rows?.[0]?.[0] ?? 19);
    const sqlProbes = cfg.sqlProbes === 'auto' || cfg.sqlProbes === undefined ? major >= 23 : cfg.sqlProbes;
    say(`Datenbank: ${banner} · SQL-Sonden ${sqlProbes ? 'aktiv' : 'aus'}`);

    await installRuntime(conn);
    const objects = await loadObjects(conn, schema, cfg);
    say(`${objects.length} Objekte gefunden: ${objects.map((o) => o.name).join(', ')}`);

    await runTests(conn, cfg.tests, null); // warm-up: utPLSQL builds its annotation cache on the first run
    say('1/4 Testlauf ohne Coverage …');
    const baseline = await runTests(conn, cfg.tests, null);
    say('2/4 Testlauf mit utPLSQL-Coverage (DBMS_PROFILER) …');
    const utCov = await runTests(conn, cfg.tests, schema);

    say('3/4 Instrumentieren und kompilieren …');
    const ids = newIds();
    const maps: (ObjectMap | { error: string; obj: SourceObject })[] = [];
    let instrumentMs = 0;
    let compileMs = 0;
    for (const obj of objects) {
      const t0 = performance.now();
      let res;
      try {
        res = instrument(obj.processed, schema, ids, { sqlProbes });
      } catch (e) {
        maps.push({ error: `Parser: ${(e as Error).message}`, obj });
        say(`  ✗ ${obj.name}: ${(e as Error).message}`);
        continue;
      } finally {
        instrumentMs += performance.now() - t0;
      }
      const t1 = performance.now();
      restore.push(obj);
      const errors = await compile(conn, schema, obj, res.instrumented);
      compileMs += performance.now() - t1;
      if (errors) {
        say(`  ✗ ${obj.name}: instrumentierter Code kompiliert nicht (${errors}) – Original bleibt aktiv`);
        await compile(conn, schema, obj, obj.original);
        restore.pop();
        maps.push({ error: `Kompilierung: ${errors}`, obj });
        continue;
      }
      maps.push(res.map);
      say(`  ✓ ${obj.type.toLowerCase()} ${obj.name}`);
    }

    say('4/4 Testlauf auf instrumentiertem Code …');
    const runId = randomUUID();
    const perTest = cfg.perTest !== false;
    await conn.execute(`begin cov$.reset; cov$.per_test(:p = 1); end;`, { p: perTest ? 1 : 0 });
    const instrumentedRun = await runTests(conn, cfg.tests, null);
    await conn.execute(`begin cov$.flush(:r); end;`, { r: runId });
    const hits = await loadHits(conn, runId);
    await conn.execute(`delete from plcov_hits where run_id = :r`, { r: runId });
    await conn.commit();

    await restoreAll(conn, schema, restore, say);
    restore.length = 0;

    const equivalent = sameResults(baseline.run.tests, instrumentedRun.run.tests);
    const tests = await loadTestCatalog(conn, schema, cfg.tests, baseline.run.tests, instrumentedRun.run.tests, hits);
    const testIndex = new Map(tests.map((t, k) => [t.path, k]));
    say(equivalent ? 'Testergebnisse mit und ohne Instrumentierung identisch ✓' : 'ACHTUNG: Testergebnisse weichen ab!');

    const objectsOut: ObjectResult[] = maps.map((m) => {
      if ('error' in m) {
        const lines = m.obj.processed.replace(/\n$/, '').split('\n');
        const empty = { covered: 0, total: 0 };
        return {
          key: `${m.obj.type} ${schema}.${m.obj.name}`.toLowerCase(), owner: schema, name: m.obj.name, type: m.obj.type, lines,
          metrics: { stmt: empty, branch: empty, cond: empty, mcdc: empty, loop: empty },
          statements: [], branches: [], decisions: [], loops: [], lineStatus: {}, lineHits: {}, lineTests: {}, gaps: [], findings: [],
          instrumentError: m.error, sourceSha256: sha256(m.obj.processed), rawSha256: sha256(m.obj.original),
        };
      }
      const obj = objects.find((o) => o.name === m.name && o.type === m.type)!;
      const r = analyze(m, hits, testIndex);
      r.sourceSha256 = sha256(obj.processed);
      r.rawSha256 = sha256(obj.original);
      const ut = utCov.sonar.get(r.key);
      if (ut) r.utplsql = ut;
      return r;
    });

    return {
      generated: new Date().toISOString(),
      database: banner,
      schema,
      sqlProbes,
      timings: { baselineMs: baseline.run.ms, utplsqlCoverageMs: utCov.run.ms, instrumentedMs: instrumentedRun.run.ms, instrumentMs, compileMs },
      baseline: baseline.run,
      utplsqlRun: utCov.run,
      instrumentedRun: instrumentedRun.run,
      equivalent,
      tests,
      perTest,
      objects: objectsOut,
      log: messages,
    };
  } finally {
    if (restore.length) await restoreAll(conn, schema, restore, say);
    await conn.close();
  }
}

function dbIdent(s: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(s)) throw new Error(`Ungültiger Bezeichner: ${s}`);
  return s.toUpperCase();
}

export async function installRuntime(conn: oracledb.Connection) {
  try {
    await conn.execute(HITS_TABLE);
  } catch (e) {
    if (!(e as Error).message.includes('ORA-00955')) throw e;
    try {
      await conn.execute(`alter table plcov_hits add (test varchar2(400))`); // table from an older plcov version
    } catch (e2) {
      if (!(e2 as Error).message.includes('ORA-01430')) throw e2;
    }
  }
  await conn.execute(RUNTIME_SPEC);
  await conn.execute(RUNTIME_BODY);
  // Native compilation makes the probes cheaper; it does not affect the instrumented code itself.
  await conn.execute(`alter package cov$ compile body plsql_code_type = native plsql_optimize_level = 3`);
  const nativeErr = await conn.execute(`select 1 from user_errors where name = 'COV$'`);
  if (nativeErr.rows?.length) await conn.execute(`alter package cov$ compile body plsql_code_type = interpreted plsql_optimize_level = 3`);
  const err = await conn.execute<[number, string]>(`select line, text from user_errors where name = 'COV$' order by sequence`);
  if (err.rows?.length) throw new Error(`Runtime cov$ kompiliert nicht: ${err.rows.map((r) => `${r[0]}: ${r[1]}`).join('; ')}`);
}

async function loadObjects(conn: oracledb.Connection, schema: string, cfg: RunConfig): Promise<SourceObject[]> {
  const res = await conn.execute<[string, string]>(
    `select o.object_name, o.object_type
       from all_objects o
      where o.owner = :s
        and o.object_type in ('PACKAGE BODY', 'PROCEDURE', 'FUNCTION', 'TYPE BODY', 'TRIGGER')
        and o.object_name not in ('COV$')
        and not exists (
              select 1 from all_source s
               where s.owner = o.owner and s.name = o.object_name and s.type = 'PACKAGE'
                 and regexp_like(s.text, '--\\s*%suite', 'i'))
      order by o.object_name, o.object_type`,
    { s: schema },
  );
  const out: SourceObject[] = [];
  for (const [name, type] of res.rows ?? []) {
    if (cfg.include && !new RegExp(cfg.include, 'i').test(name)) continue;
    if (cfg.exclude && new RegExp(cfg.exclude, 'i').test(name)) continue;
    const src = await conn.execute<[string]>(
      `select text from all_source where owner = :o and name = :n and type = :t order by line`, { o: schema, n: name, t: type },
    );
    const original = (src.rows ?? []).map((r) => r[0]).join('');
    const pp = await conn.execute(
      `declare l dbms_preprocessor.source_lines_t; s clob; begin
         l := dbms_preprocessor.get_post_processed_source(:t, :o, :n);
         for i in 1 .. l.count loop s := s || l(i); end loop;
         :x := s;
       end;`,
      { t: type, o: schema, n: name, x: { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_CLOB } },
    );
    const lob = (pp.outBinds as { x: oracledb.Lob | null }).x;
    const processed = lob ? String(await lob.getData()) : original;
    const st = await conn.execute<[number, string, string, string]>(
      `select plsql_optimize_level, plsql_code_type, plsql_ccflags, nls_length_semantics
         from all_plsql_object_settings where owner = :o and name = :n and type = :t`, { o: schema, n: name, t: type },
    );
    const s = st.rows?.[0];
    out.push({
      name, type, original, processed,
      settings: s ? { plsql_optimize_level: String(s[0]), plsql_code_type: s[1], plsql_ccflags: s[2] ?? '', nls_length_semantics: s[3] } : {},
    });
  }
  return out;
}

/** Compiles source with the object's original settings. Returns error text or null. */
async function compile(conn: oracledb.Connection, schema: string, obj: SourceObject, source: string): Promise<string | null> {
  const st = obj.settings;
  if (st.plsql_optimize_level) await conn.execute(`alter session set plsql_optimize_level = ${Number(st.plsql_optimize_level)}`);
  if (st.plsql_code_type) await conn.execute(`alter session set plsql_code_type = '${st.plsql_code_type.replace(/'/g, '')}'`);
  await conn.execute(`alter session set plsql_ccflags = '${(st.plsql_ccflags ?? '').replace(/'/g, "''")}'`);
  if (st.nls_length_semantics) await conn.execute(`alter session set nls_length_semantics = ${st.nls_length_semantics === 'CHAR' ? 'CHAR' : 'BYTE'}`);
  try {
    await conn.execute(`create or replace ${source.replace(/\s*$/, '')}`);
  } catch (e) {
    // ORA-24344: success with compilation error -> read user errors below
    if (!(e as Error).message.includes('ORA-24344')) return (e as Error).message.split('\n')[0];
  }
  const err = await conn.execute<[number, string]>(
    `select line, text from all_errors where owner = :o and name = :n and type = :t and attribute = 'ERROR' order by sequence`,
    { o: schema, n: obj.name, t: obj.type },
  );
  if (err.rows?.length) return err.rows.slice(0, 3).map((r) => `Zeile ${r[0]}: ${r[1].trim()}`).join('; ');
  return null;
}

async function restoreAll(conn: oracledb.Connection, schema: string, objs: SourceObject[], say: (m: string) => void) {
  for (const obj of objs) {
    const err = await compile(conn, schema, obj, obj.original);
    if (err) say(`  ✗ Wiederherstellung von ${obj.name} fehlgeschlagen: ${err}`);
  }
  await conn.execute(`begin dbms_utility.compile_schema(:s, compile_all => false); end;`, { s: schema });
  say(`Originalcode von ${objs.length} Objekten wiederhergestellt`);
}

async function runTests(conn: oracledb.Connection, paths: string[], coverageSchema: string | null) {
  const pathList = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
  const t0 = performance.now();
  const res = await conn.execute(
    `declare
       l_junit ut_junit_reporter := ut_junit_reporter();
       l_cov   ut_coverage_sonar_reporter := ut_coverage_sonar_reporter();
       l_reporters ut_reporters := ut_reporters(l_junit);
     begin
       if :with_cov = 1 then
         l_reporters.extend;
         l_reporters(2) := l_cov;
       end if;
       ut_runner.run(
         a_paths => ut_varchar2_list(${pathList}),
         a_reporters => l_reporters,
         a_coverage_schemes => case when :with_cov = 1 then ut_varchar2_list(:schema) end
       );
       :junit := l_junit.get_lines_cursor(a_initial_timeout => 1, a_timeout_sec => 1);
       if :with_cov = 1 then
         :sonar := l_cov.get_lines_cursor(a_initial_timeout => 1, a_timeout_sec => 1);
       else
         open :sonar for select null as text from dual where 1 = 0;
       end if;
     end;`,
    {
      with_cov: coverageSchema ? 1 : 0,
      schema: coverageSchema ?? '',
      junit: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR },
      sonar: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR },
    },
  );
  const ms = performance.now() - t0;
  const out = res.outBinds as { junit: oracledb.ResultSet<unknown[]>; sonar: oracledb.ResultSet<unknown[]> };
  const readAll = async (rs: oracledb.ResultSet<unknown[]>) => {
    const rows = await rs.getRows();
    await rs.close();
    return rows.map((r) => String(r[0] ?? '')).join('\n');
  };
  const junit = await readAll(out.junit);
  const sonar = await readAll(out.sonar);
  return { run: { tests: parseJunit(junit), ms }, sonar: parseSonar(sonar) };
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function parseJunit(xml: string): TestCase[] {
  const out: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m; (m = re.exec(xml)); ) {
    const attr = (n: string) => unescapeXml(new RegExp(`\\b${n}="([^"]*)"`).exec(m![1])?.[1] ?? '');
    const body = m[3] ?? '';
    const status = /<error\b/.test(body) ? 'error' : /<failure\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    out.push({ suite: attr('classname'), name: attr('name'), status, time: Number(attr('time')) || 0 });
  }
  return out;
}

export function parseSonar(xml: string): Map<string, { covered: number; total: number; lines: Record<number, boolean> }> {
  const out = new Map<string, { covered: number; total: number; lines: Record<number, boolean> }>();
  const fileRe = /<file path="([^"]*)">([\s\S]*?)<\/file>/g;
  for (let m; (m = fileRe.exec(xml)); ) {
    const lines: Record<number, boolean> = {};
    let covered = 0;
    let total = 0;
    const lineRe = /<lineToCover lineNumber="(\d+)" covered="(true|false)"/g;
    for (let l; (l = lineRe.exec(m[2])); ) {
      lines[Number(l[1])] = l[2] === 'true';
      total++;
      if (l[2] === 'true') covered++;
    }
    out.set(unescapeXml(m[1]).toLowerCase(), { covered, total, lines });
  }
  return out;
}

async function loadHits(conn: oracledb.Connection, runId: string): Promise<Hits> {
  const res = await conn.execute<[string, string, number, string | null]>(
    `select kind, k, sum(hits), test from plcov_hits where run_id = :r group by kind, k, test`, { r: runId },
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
      case 's': forTest(test!).s.add(Number(k)); break;
      case 'b': forTest(test!).b.add(Number(k)); break;
      case 'c': forTest(test!).c.add(k); break;
      case 'd': forTest(test!).d.add(k); break;
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

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
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
  const statusOf = (list: TestCase[], suite: string, desc: string) =>
    list.find((t) => t.suite.toLowerCase() === suite && t.name === desc)?.status ?? 'unknown';
  const timeOf = (suite: string, desc: string) => instrumented.find((t) => t.suite.toLowerCase() === suite && t.name === desc)?.time ?? 0;
  for (const owner of owners) {
    const res = await conn.execute<[string, string, string, string, string]>(
      `select object_owner, object_name, item_name, item_description, path
         from table(ut_runner.get_suites_info(:o)) where item_type = 'UT_TEST' order by path`, { o: owner },
    );
    for (const [o, obj, item, desc, path] of res.rows ?? []) {
      const full = `${o}.${obj}.${item}`.toLowerCase();
      const inScope = paths.some((p) => {
        const q = p.toLowerCase();
        return q === o.toLowerCase() || full === q || full.startsWith(q + '.') || (q.startsWith(':') && path.toLowerCase().startsWith(q.slice(1)));
      });
      if (!inScope) continue;
      const suite = path.toLowerCase().split('.').slice(0, -1).join('.');
      const description = desc || item.toLowerCase();
      const status = statusOf(instrumented, suite, description);
      if (status === 'unknown' && !hits.perTest.has(full)) continue; // not part of this run
      tests.push({
        path: full, suite, description, setup: false, status, baselineStatus: statusOf(baseline, suite, description), ms: timeOf(suite, description) * 1000,
      });
    }
  }
  for (const name of hits.perTest.keys()) {
    if (name.startsWith('#') && !tests.some((t) => t.path === name)) {
      tests.push({ path: name, suite: name.slice(1), description: `Setup außerhalb eines Tests (${name.slice(1) || 'ohne utPLSQL'})`, setup: true, status: 'unknown', baselineStatus: 'unknown', ms: 0 });
    }
  }
  return tests;
}

function sameResults(a: TestCase[], b: TestCase[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: TestCase) => `${t.suite}::${t.name}`;
  const m = new Map(a.map((t) => [key(t), t.status]));
  return b.every((t) => m.get(key(t)) === t.status);
}
