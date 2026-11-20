/** The HTML report and the exports of a run without the utPLSQL comparison and without warm-up. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCobertura, toCoverageExport, type ObjectResult, type RunReport } from '@plgauge/coverage';
import { renderHtml } from '@plgauge/report';

const m = (covered: number, total: number) => ({ covered, total });
const obj = (utplsql?: ObjectResult['utplsql']): ObjectResult => ({
  key: 'package body s.p', owner: 'S', name: 'P', type: 'PACKAGE BODY',
  lines: ['package body p is', '  procedure q is begin', '    x := 1;', '  end;', 'end;'],
  metrics: { stmt: m(1, 1), branch: m(1, 2), cond: m(0, 0), mcdc: m(0, 0), loop: m(0, 0) },
  statements: [{ id: 1, line: 3, endLine: 3, hits: 2, nf: false, tests: [0] }],
  branches: [], decisions: [], loops: [], lineStatus: { 3: 'covered' }, lineHits: { 3: 2 }, lineTests: { 3: [0] },
  gaps: [], findings: [], rawSha256: 'x', ...(utplsql ? { utplsql } : {}),
});
const run = { tests: [{ suite: 's.t', name: 'a', status: 'passed' as const, time: 0.5 }], ms: 500 };
const report = (over: Partial<RunReport>): RunReport => ({
  generated: '2026-11-20T00:00:00Z', database: 'Oracle', schema: 'S', sqlProbes: true,
  timings: { baselineMs: 500, utplsqlCoverageMs: 900, instrumentedMs: 700, instrumentMs: 5, compileMs: 50 },
  baseline: run, utplsqlRun: run, instrumentedRun: run, equivalent: true, perTest: true, baselineRuns: 2,
  tests: [{ path: 's.t.a', suite: 's.t', description: 'a', setup: false, status: 'passed', baselineStatus: 'passed', ms: 500 }],
  objects: [obj({ covered: 1, total: 1, lines: { 3: true } })], log: [],
  ...over,
});

test('report: with the utPLSQL comparison its line rate shows as before', () => {
  const html = renderHtml(report({}));
  assert.match(html, /utPLSQL reports <em>100 %<\/em> line coverage/);
  assert.match(html, /<th>Lines \(utPLSQL\)<\/th>/);
  assert.match(html, /with utPLSQL coverage 900 ms/);
  assert.match(html, /Runtime overhead/);
});

test('report: without the utPLSQL run and warm-up, utPLSQL is hidden and the skipped runs are named', () => {
  const r = report({
    timings: { instrumentedMs: 700, instrumentMs: 5, compileMs: 50 }, utplsqlRun: undefined, baselineRuns: 1,
    warmup: false, utplsqlCompare: false, objects: [obj()],
  });
  const html = renderHtml(r);
  assert.doesNotMatch(html, /utPLSQL reports|Lines \(utPLSQL\)|line counted by utPLSQL|with utPLSQL coverage|undefined|NaN/);
  assert.match(html, /<h1 id="h-hero"><em class="t-bad">50 %<\/em> of the branches are tested\.<\/h1>/);
  assert.match(html, /Without coverage not timed \(the only run also warmed up utPLSQL\)\. Skipped: warm-up run, utPLSQL coverage run\./);
  // the only baseline run was cold: its test times are no reference for the overhead
  assert.doesNotMatch(html, /Runtime overhead/);
  // object table: object, five metrics, gaps
  const row = /<tbody><tr>([\s\S]*?)<\/tr>/.exec(html)![1];
  assert.equal(row.match(/<td/g)!.length, 6);
  // joint report too
  assert.doesNotMatch(renderHtml(r, { mutation: { results: [] } }), /Lines \(utPLSQL\)/);
  // warm baseline (two runs without warm-up): timed, overhead shown
  const warm = renderHtml({ ...r, baselineRuns: 2, timings: { ...r.timings, baselineMs: 480 } });
  assert.match(warm, /Without coverage 480 ms\. Skipped/);
  assert.match(warm, /Runtime overhead/);
  // exports never carried utPLSQL data
  const exp = toCoverageExport(r);
  assert.equal(exp.objects[0].lines[3].hits, 2);
  assert.match(toCobertura(exp), /<line number="3" hits="2"/);
});
