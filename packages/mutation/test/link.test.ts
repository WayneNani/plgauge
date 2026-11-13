/** Linking mutation results with coverage: coordinates, statement lookup, cross-check. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoverageExport } from '@pltest/coverage';
import { CoverageIndex, crossCheck, expand, findPoints, splitUnit, unitLineOf, type LinkedResult } from '@pltest/mutation';

const exp = (statements: { line: number; endLine: number; col?: number; endCol?: number; tests: number[] }[]): CoverageExport => ({
  format: 'plcov-coverage/1', generated: '', database: '', schema: 'S', coordinates: 'all_source',
  tests: [
    { path: 's.t.a', setup: false, status: 'passed', ms: 1, baselineRuns: 1 },
    { path: 's.t.b', setup: false, status: 'passed', ms: 1, baselineRuns: 1 },
    { path: '#s.t', setup: true, status: 'unknown', ms: 0, baselineRuns: 1 },
  ],
  objects: [{
    owner: 'S', name: 'P', type: 'PACKAGE BODY', instrumented: true, lines: {},
    statements: statements.map((s) => ({ ...s, hits: s.tests.length })), branches: [], conditions: [], notMeasured: [],
  }],
});

test('link: ALL_SOURCE line 1 is the line of the unit keyword, not of CREATE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pltest-'));
  const path = join(dir, 'p.sql');
  writeFileSync(path, `-- header\n\nCREATE OR REPLACE\n  PACKAGE BODY p AS\n  FUNCTION f(a NUMBER) RETURN NUMBER IS\n  BEGIN\n    RETURN a + 1;\n  END;\nEND;\n/\n`);
  const m = expand(findPoints([path])).find((x) => x.op === 'AOR')!;
  assert.equal(unitLineOf(m), 4);
  assert.equal(m.line - unitLineOf(m) + 1, 4); // "RETURN a + 1" is line 4 of ALL_SOURCE
  assert.deepEqual(splitUnit('PACKAGE BODY "Mixed"'), { type: 'PACKAGE BODY', name: 'Mixed' });
  assert.deepEqual(splitUnit('PACKAGE BODY s.p'), { type: 'PACKAGE BODY', name: 'P' });
});

test('link: innermost statement around the position; declarations and setup give no selection', () => {
  const idx = new CoverageIndex(exp([
    { line: 3, endLine: 9, col: 5, endCol: 12, tests: [0, 1] }, // CASE ... END CASE;
    { line: 5, endLine: 5, col: 25, endCol: 40, tests: [1] }, //   WHEN x = 1 THEN y := 2; (statement at col 25)
    { line: 12, endLine: 12, col: 5, endCol: 9, tests: [0, 2] }, // reached in setup code
  ]));
  const o = idx.object('PACKAGE BODY p')!;
  assert.deepEqual(idx.testsAt(o, 4, 7), ['s.t.a', 's.t.b']);
  assert.deepEqual(idx.testsAt(o, 5, 10), ['s.t.a', 's.t.b']); // the WHEN condition: runs with the CASE
  assert.deepEqual(idx.testsAt(o, 5, 30), ['s.t.b']); // inside the branch statement
  assert.deepEqual(idx.testsAt(o, 5), ['s.t.a', 's.t.b']); // no column: the safe, outer statement
  assert.equal(idx.testsAt(o, 1, 3), null); // declaration
  assert.equal(idx.testsAt(o, 12, 6), null); // setup involved: cannot tell
});

test('link: cross-check finds a test the coverage did not see', () => {
  const idx = new CoverageIndex(exp([{ line: 5, endLine: 5, tests: [1] }]));
  const r = (coveredBy: string[] | undefined, status = 'KILLED'): LinkedResult => ({
    unit: 'PACKAGE BODY p', file: 'p.pkb', line: 5, unitLine: 1, op: 'ROR', original: 'a < b', mutated: 'a <= b', status, coveredBy,
  });
  const c = crossCheck([r(['s.t.b']), r(['s.t.a', 's.t.b']), r(undefined, 'NOT_COVERED'), { ...r(['s.t.a']), line: 1 }], idx);
  assert.equal(c.checked, 2);
  assert.equal(c.consistent, 1);
  assert.deepEqual(c.contradictions.map((x) => x.test), ['s.t.a']);
  assert.equal(c.executedNotReached, 1);
  assert.equal(c.unknown, 1);
});
