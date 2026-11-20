/** CI formats, merging, thresholds and the diff mode, on a small hand-made coverage export. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJunit, parseUnifiedDiff } from '@plgauge/core';
import {
  checkQuotas, mergeExports, quotas, restrictToChanged, sourceMap, toCobertura, toJunit, toLcov, toSonar, type CoverageExport,
} from '@plgauge/coverage';

// "CREATE OR REPLACE" on line 2 of the file, the unit keyword on line 3: ALL_SOURCE line 1 = file line 3
const SRC = `-- Header
CREATE OR REPLACE
PACKAGE BODY p AS
  PROCEDURE q(a NUMBER) IS
  BEGIN
    IF a > 0 THEN
      x := 1;
    END IF;
  END;
END;
/
`;

const exp = (hitsThen: number, tests: number[]): CoverageExport => ({
  format: 'plgauge-coverage/1', generated: '2026-11-13T00:00:00Z', database: '', schema: 'S', coordinates: 'all_source',
  tests: [
    { path: 's.t.a', setup: false, status: 'passed', ms: 3, baselineRuns: 1 },
    { path: 's.t.b', setup: false, status: 'failed', ms: 4, baselineRuns: 1 },
  ],
  objects: [{
    owner: 'S', name: 'P', type: 'PACKAGE BODY', rawSha256: 'x', instrumented: true,
    lines: { 4: { hits: 2, tests }, 5: { hits: hitsThen, tests: hitsThen ? tests : [] } },
    statements: [{ line: 4, endLine: 6, hits: 2, tests }, { line: 5, endLine: 5, hits: hitsThen, tests: hitsThen ? tests : [] }],
    branches: [
      { line: 4, col: 5, label: 'THEN', kind: 'if', hits: hitsThen, tests: hitsThen ? tests : [], construct: 1, condition: { line: 4, col: 8, endLine: 4, endCol: 13 } },
      { line: 6, col: 5, label: 'ELSE (implicit)', kind: 'if', hits: 2 - hitsThen, tests, construct: 1, condition: { line: 4, col: 8, endLine: 4, endCol: 13 } },
    ],
    conditions: [{ decision: 1, index: 1, text: 'a > 0', context: 'plsql', range: { line: 4, col: 8, endLine: 4, endCol: 13 }, tests: { T: [], F: tests, N: [] }, t: hitsThen, f: 2 - hitsThen, n: 0, mcdc: 'na' }],
    notMeasured: [],
  }],
});

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'plgauge-'));
  const f = join(dir, 'p.pkb');
  writeFileSync(f, SRC);
  return { dir, f, map: sourceMap([f]) };
}

test('ci: Sonar, Cobertura and LCOV use file lines and put derived branches on the condition line', () => {
  const { f, map } = files();
  assert.deepEqual(map.get('PACKAGE BODY P'), { path: f, firstLine: 3 });
  const e = exp(0, [0]);
  const sonar = toSonar(e, map);
  assert.match(sonar, /<lineToCover lineNumber="6" covered="true" branchesToCover="2" coveredBranches="1"\/>/);
  assert.match(sonar, /<lineToCover lineNumber="7" covered="false"\/>/);
  assert.doesNotMatch(sonar, /lineNumber="8"/); // END IF is no line of its own
  const cob = toCobertura(e, map);
  assert.match(cob, /<line number="6" hits="2" branch="true" condition-coverage="50% \(1\/2\)"\/>/);
  assert.match(cob, /lines-covered="1" lines-valid="2"/);
  const lcov = toLcov(e, map);
  assert.match(lcov, /BRDA:6,1,0,0\nBRDA:6,1,1,2\nBRF:2\nBRH:1\nDA:6,2\nDA:7,0\nLF:2\nLH:1/);
  // without a source map: virtual path, ALL_SOURCE lines
  assert.match(toSonar(e), /<file path="s\/package_body\/p.sql">\n {4}<lineToCover lineNumber="4"/);
});

test('ci: JUnit lists the tests per package', () => {
  const j = toJunit(exp(1, [0]));
  assert.match(j, /<testsuite name="s.t" tests="2" failures="1" errors="0" skipped="0" time="0.007">/);
  assert.match(j, /<testcase classname="s.t" name="b" time="0.004"><failure message="failed"\/><\/testcase>/);
});

test('ci: JUnit carries the failure message (escaped) and the reason of an exclusion', () => {
  const e = exp(1, [0]);
  e.tests[1].message = `Actual: 'a<b>&"c"' (varchar2) was expected to equal: 'x' (varchar2)`;
  e.tests.push({ path: 's.t.c', setup: false, status: 'excluded', ms: 0, baselineRuns: 1, message: 'ORA-04063: package body "S.T" has errors' });
  const j = toJunit(e);
  assert.match(j, /<failure message="Actual: 'a&lt;b&gt;&amp;&quot;c&quot;' \(varchar2\)/);
  assert.match(j, /<skipped message="excluded: ORA-04063: package body &quot;S.T&quot; has errors"\/>/);
  // round trip through the parser
  const back = parseJunit(j);
  assert.equal(back.find((t) => t.name === 'b')!.message, e.tests[1].message);
});

test('ci: characters XML 1.0 forbids are dropped from JUnit, Sonar and Cobertura', () => {
  const e = exp(1, [0]);
  e.tests[1].message = 'bell \u0007 nul \u0000 lone \uD800 \uFFFE kept 😀\ttab';
  e.objects[0].name = 'P\u0001';
  const bad = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF\uD800-\uDFFF]/u;
  for (const x of [toJunit(e), toSonar(e), toCobertura(e)]) assert.ok(!bad.test(x), x);
  // (minimal well-formedness: the parser reads it back)
  assert.equal(parseJunit(toJunit(e)).find((t) => t.name === 'b')!.message, 'bell  nul  lone   kept 😀\ttab');
});

test('ci: merging adds hits and joins test lists; thresholds read the merged hits', () => {
  const a = exp(0, [0]);
  const b = { ...exp(1, [0]), tests: [exp(1, [0]).tests[1], exp(1, [0]).tests[0]] }; // other order
  const m = mergeExports([a, b]);
  assert.equal(m.tests.length, 2);
  const o = m.objects[0];
  assert.equal(o.statements![1].hits, 1);
  assert.deepEqual(o.statements![1].tests, [1]); // s.t.b in the merged list
  assert.deepEqual(quotas(m).branch, { covered: 2, total: 2 });
  assert.deepEqual(checkQuotas(m, { stmt: 100, branch: 100 }), []);
  assert.deepEqual(checkQuotas(a, { branch: 80 }), ['Branches: 50.0 % < 80 % (1/2)']);
  assert.throws(() => mergeExports([a, { ...b, objects: [{ ...b.objects[0], rawSha256: 'y' }] }]), /different source/);
});

test('ci: diff mode keeps what touches changed lines', () => {
  const { dir, f, map } = files();
  const diff = parseUnifiedDiff(`diff --git a/p.pkb b/p.pkb\n--- a/p.pkb\n+++ b/p.pkb\n@@ -7 +7 @@\n-      x := 0;\n+      x := 1;\n@@ -20,0 +21,2 @@\n`, dir);
  assert.deepEqual([...diff.get(resolve(f))!], [7, 21, 22]);
  const r = restrictToChanged(exp(0, [0]), map, diff);
  assert.deepEqual(r.objects[0].statements!.map((s) => s.line), [5]); // x := 1 (file line 7)
  assert.equal(r.objects[0].branches.length, 0);
  assert.deepEqual(checkQuotas(r, { stmt: 100 }), ['Statements: 0.0 % < 100 % (0/1)']);
});
