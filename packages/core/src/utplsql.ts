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
  const junit = await readAll(out.junit);
  const sonar = await readAll(out.sonar);
  return { run: { tests: parseJunit(junit), ms } as TestRun, sonar: parseSonar(sonar) };
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
