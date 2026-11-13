/** TeamCity parsing and sampling (ported from plmut's tests_test.go). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDbUrl, parseTeamCity, sample } from '@pltest/mutation';

test('TeamCity messages are parsed with escapes', () => {
  const out = `##teamcity[testSuiteStarted timestamp='2026-11-13T10:00:00.000' name='Preise im Shop']
##teamcity[testStarted timestamp='2026-11-13T10:00:00.001' captureStandardOutput='true' name='plmut.test_shop_pricing.rabatt']
##teamcity[testFinished timestamp='2026-11-13T10:00:00.004' duration='3' name='plmut.test_shop_pricing.rabatt']
##teamcity[testStarted timestamp='2026-11-13T10:00:00.005' captureStandardOutput='true' name='plmut.test_shop_pricing.express']
##teamcity[testFailed timestamp='2026-11-13T10:00:00.006' details='Actual: 0 (number) was expected to equal: 15 (number)|n  at |'x|'' message='Failure' name='plmut.test_shop_pricing.express']
##teamcity[testFinished timestamp='2026-11-13T10:00:00.007' duration='2' name='plmut.test_shop_pricing.express']
`;
  const t = parseTeamCity(out);
  assert.equal(t.length, 2);
  assert.deepEqual([t[0].name, t[0].failed, t[0].durationMs], ['plmut.test_shop_pricing.rabatt', false, 3]);
  assert.equal(t[1].failed, true);
  assert.equal(t[1].message, "Failure Actual: 0 (number) was expected to equal: 15 (number)\n  at 'x'");
});

test('oracle:// URLs become connect data', () => {
  assert.deepEqual(parseDbUrl('oracle://plmut:p%40ss@127.0.0.1:15210/FREEPDB1'),
    { user: 'plmut', password: 'p@ss', connectString: '127.0.0.1:15210/FREEPDB1' });
});

test('samples are deterministic per seed', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(sample(xs, 10, 7), sample(xs, 10, 7));
  assert.notDeepEqual(sample(xs, 10, 7), sample(xs, 10, 8));
  assert.equal(new Set(sample(xs, 10, 7)).size, 10);
});
