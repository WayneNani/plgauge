/**
 * Running utPLSQL tests through ut_runner.run (not ut.run: that one runs the tests
 * in an autonomous transaction, where commits of a test are invisible).
 */
import oracledb from 'oracledb';
import { sqlLit } from './db.js';

export interface TestCase {
  suite: string;
  name: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  time: number;
  /** Why a failed or erroring test failed: the first meaningful line of utPLSQL's report. */
  message?: string;
}

export interface TestRun {
  tests: TestCase[];
  ms: number;
}

export interface LineCoverage {
  covered: number;
  total: number;
  lines: Record<number, boolean>;
}

/**
 * Runs the given paths with a JUnit reporter; with coverageSchema also with utPLSQL's
 * own coverage (Sonar format) for comparison.
 */
export async function runTestsJunit(conn: oracledb.Connection, paths: string[], coverageSchema: string | string[] | null) {
  const pathList = paths.map(sqlLit).join(', ');
  const schemes = coverageSchema === null ? [] : Array.isArray(coverageSchema) ? coverageSchema : [coverageSchema];
  const schemeList = schemes.length ? schemes.map(sqlLit).join(', ') : "''";
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
         a_coverage_schemes => case when :with_cov = 1 then ut_varchar2_list(${schemeList}) end
       );
       :junit := l_junit.get_lines_cursor(a_initial_timeout => 1, a_timeout_sec => 1);
       if :with_cov = 1 then
         :sonar := l_cov.get_lines_cursor(a_initial_timeout => 1, a_timeout_sec => 1);
       else
         open :sonar for select null as text from dual where 1 = 0;
       end if;
     end;`,
    {
      with_cov: schemes.length ? 1 : 0,
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
  return { run: { tests: parseJunit(await readAll(out.junit)), ms } as TestRun, sonar: parseSonar(await readAll(out.sonar)) };
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, x, n) => String.fromCodePoint(parseInt(n, x ? 16 : 10))).replace(/&amp;/g, '&');
}

/** Text content of XML: CDATA as is (utPLSQL splits "]]>" over two sections), tags dropped, the rest unescaped. */
const xmlText = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|<[^>]*>|[^<]+/g, (m, cd?: string) => cd ?? (m[0] === '<' ? '' : unescapeXml(m)));

/**
 * The first line of a failure that says something: utPLSQL's error stack starts with the error
 * (ORA-04063: package body … has errors), a failed expectation with "Actual: … expected …";
 * its TeamCity reporter puts the generic "Error occured" / "Test exception:" in front (all a
 * failing beforeall gets there: then that line).
 */
export function failureMessage(text: string, max = 300): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !/^(error occured|failure|test exception:)$/i.test(l)) ?? lines[0];
  return line && line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function parseJunit(xml: string): TestCase[] {
  const out: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m; (m = re.exec(xml)); ) {
    const attr = (n: string, a = m![1]) => unescapeXml(new RegExp(`\\b${n}="([^"]*)"`).exec(a)?.[1] ?? '');
    // (a message in CDATA may well contain "<error")
    const body = (m[3] ?? '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    const status = /<error\b/.test(body) ? 'error' : /<failure\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    const t: TestCase = { suite: attr('classname'), name: attr('name'), status, time: Number(attr('time')) || 0 };
    if (status === 'error' || status === 'failed') {
      // utPLSQL writes the stack as CDATA body, other tools a message attribute
      const el = /<(error|failure)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(m[3] ?? '');
      const message = el && failureMessage(`${xmlText(el[3] ?? '')}\n${attr('message', el[2])}`);
      if (message) t.message = message;
    }
    out.push(t);
  }
  return out;
}

/**
 * Tests that fail or error, grouped by suite, status and message: a whole suite usually fails
 * for one reason (a beforeall that raises, a test package that does not compile). At most max lines.
 */
export function failureSummary(tests: Pick<TestCase, 'suite' | 'name' | 'status' | 'message'>[], when: string, max = 10): string[] {
  const groups = new Map<string, { suite: string; status: string; message: string; names: string[] }>();
  for (const t of tests) {
    if (t.status !== 'failed' && t.status !== 'error') continue;
    const message = t.message ?? 'no message';
    const k = `${t.suite}\0${t.status}\0${message}`;
    (groups.get(k) ?? groups.set(k, { suite: t.suite, status: t.status, message, names: [] }).get(k)!).names.push(t.name);
  }
  const all = [...groups.values()].sort((a, b) => b.names.length - a.names.length);
  const lines = all.slice(0, max).map((g) => {
    const verb = g.status === 'error' ? 'error' : 'fail';
    const who = g.names.length === 1 ? `test "${g.names[0]}" of suite ${g.suite} ${verb}s` : `${g.names.length} tests of suite ${g.suite} ${verb}`;
    return `WARNING: ${who} ${when}: ${g.message}`;
  });
  const rest = all.slice(max);
  if (rest.length) lines.push(`WARNING: … and ${rest.reduce((n, g) => n + g.names.length, 0)} more tests in ${rest.length} more groups`);
  return lines;
}

export function parseSonar(xml: string): Map<string, LineCoverage> {
  const out = new Map<string, LineCoverage>();
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

export interface SuiteTest {
  owner: string;
  object: string;
  item: string;
  description: string;
  /** utPLSQL suite path of the test. */
  path: string;
}

/** All utPLSQL tests of an owner (ut_runner.get_suites_info). */
export async function suiteTests(conn: oracledb.Connection, owner: string): Promise<SuiteTest[]> {
  const res = await conn.execute<[string, string, string, string, string]>(
    `select object_owner, object_name, item_name, item_description, path
       from table(ut_runner.get_suites_info(:o)) where item_type = 'UT_TEST' order by path`, { o: owner },
  );
  return (res.rows ?? []).map(([o, obj, item, desc, path]) => ({ owner: o, object: obj, item, description: desc, path }));
}
