/**
 * The report folder (offline): overview, one page per object, per-schema summary, file names; a run
 * without the utPLSQL comparison and without warm-up; tests red without instrumentation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyze, instrument, newIds, toCobertura, toCoverageExport, type Hits, type ObjectResult, type RunReport } from '@plgauge/coverage';
import { pageNames, renderReport, summaryLines, writeReport } from '@plgauge/report';

const hits = (stmts: number[]): Hits => ({
  stmt: new Map(stmts.map((s) => [s, 1])), branch: new Map(), cond: new Map(), dec: new Map(), vec: new Map(), loop: new Map(), perTest: new Map(),
});
const obj = (owner: string, src: string, ran: number[], name?: string) => {
  const r = analyze(instrument(src, owner, newIds(), { sqlProbes: true }).map, hits(ran));
  return { ...r, owner, ...(name ? { name } : {}), sourceSha256: '', rawSha256: '' };
};
const run = { tests: [], ms: 1 };
const report = (objects: RunReport['objects']): RunReport => ({
  generated: '2026-11-20T00:00:00Z', database: 'Oracle', schema: [...new Set(objects.map((o) => o.owner))].join(','), sqlProbes: true,
  timings: { baselineMs: 1, utplsqlCoverageMs: 1, instrumentedMs: 1, instrumentMs: 1, compileMs: 1 },
  baseline: run, utplsqlRun: run, instrumentedRun: run, equivalent: true, tests: [], perTest: false, objects, log: [],
});
const PRICING = 'package body pricing is\n  function net(a number) return number is\n  begin\n    if a > 0 then\n      return a;\n    end if;\n    return 0;\n  end;\nend;\n';
const LOG = 'procedure log(m varchar2) is\nbegin\n  null;\nend;\n';

test('report: overview links one page per object; shared CSS/JS once; per-schema row only with several schemas', () => {
  const r = report([obj('CORE', PRICING, [1, 3]), obj('UTIL', LOG, [])]);
  const files = renderReport(r);
  assert.deepEqual(Object.keys(files).sort(), ['index.html', 'objects/core.pricing.package_body.html', 'objects/util.log.procedure.html', 'report.css', 'report.js']);
  const index = files['index.html'];
  assert.match(index, /href="objects\/core\.pricing\.package_body\.html">core\.pricing</);
  assert.match(index, /<link rel="stylesheet" href="report\.css">/);
  assert.doesNotMatch(index, /class="src"/, 'no source in the overview');
  assert.doesNotMatch(index, /<style>/, 'no CSS repeated');
  // per schema: objects, objects without any hit, covered/total
  assert.match(index, /Coverage per schema/);
  assert.match(index, /<th scope="row">util<\/th>\s*<td class="num">1<\/td><td class="num">1<\/td>/);
  assert.match(index, /<th scope="row">core<\/th>\s*<td class="num">1<\/td><td class="num">0<\/td>/);
  const page = files['objects/core.pricing.package_body.html'];
  assert.match(page, /<tr id="o0-L9"/, 'the source, line by line');
  assert.match(page, /href="\.\.\/report\.css"/);
  assert.match(page, /<script src="\.\.\/report\.js"><\/script>/);
  assert.match(page, /href="\.\.\/index\.html"/);
  assert.doesNotMatch(page, /varchar2/, 'only its own object');

  const single = renderReport(report([obj('CORE', PRICING, [1])]))['index.html'];
  assert.doesNotMatch(single, /Coverage per schema/);
  assert.match(single, /href="objects\/core\.pricing\.package_body\.html">pricing</, 'single schema: names as before');
});

test('report: the terminal summary has a line per schema only with several schemas', () => {
  const two = summaryLines(report([obj('CORE', PRICING, [1, 3]), obj('UTIL', LOG, [])]));
  assert.equal(two.length, 3);
  assert.match(two[0], /^2 objects · Statements /);
  assert.match(two[2], /^ {2}UTIL {2}1 objects, 1 without hits · Statements 0 % \(0\/1\)/);
  assert.equal(summaryLines(report([obj('CORE', PRICING, [1])])).length, 1);
});

test('report: page file names are safe and unique', () => {
  const names = pageNames([
    { owner: 'CORE', name: 'PRICING', type: 'PACKAGE BODY' },
    { owner: 'CORE', name: 'Odd#Name/x', type: 'PROCEDURE' },
    { owner: 'CORE', name: 'LOG$', type: 'PROCEDURE' },
    { owner: 'CORE', name: 'Log$', type: 'PROCEDURE' },
  ]);
  assert.deepEqual(names, ['core.pricing.package_body.html', 'core.odd_name_x.procedure.html', 'core.log$.procedure.html', 'core.log$.procedure-2.html']);
});

/** The overview page. */
const index = (r: RunReport, opts?: Parameters<typeof renderReport>[1]) => renderReport(r, opts)['index.html'];

const met = (covered: number, total: number) => ({ covered, total });
const fixed = (utplsql?: ObjectResult['utplsql']): ObjectResult => ({
  key: 'package body s.p', owner: 'S', name: 'P', type: 'PACKAGE BODY',
  lines: ['package body p is', '  procedure q is begin', '    x := 1;', '  end;', 'end;'],
  metrics: { stmt: met(1, 1), branch: met(1, 2), cond: met(0, 0), mcdc: met(0, 0), loop: met(0, 0) },
  statements: [{ id: 1, line: 3, endLine: 3, hits: 2, nf: false, tests: [0] }],
  branches: [], decisions: [], loops: [], lineStatus: { 3: 'covered' }, lineHits: { 3: 2 }, lineTests: { 3: [0] },
  gaps: [], findings: [], rawSha256: 'x', ...(utplsql ? { utplsql } : {}),
});
const run1 = { tests: [{ suite: 's.t', name: 'a', status: 'passed' as const, time: 0.5 }], ms: 500 };
const fixedReport = (over: Partial<RunReport>): RunReport => ({
  generated: '2026-11-20T00:00:00Z', database: 'Oracle', schema: 'S', sqlProbes: true,
  timings: { baselineMs: 500, utplsqlCoverageMs: 900, instrumentedMs: 700, instrumentMs: 5, compileMs: 50 },
  baseline: run1, utplsqlRun: run1, instrumentedRun: run1, equivalent: true, perTest: true, baselineRuns: 2,
  tests: [{ path: 's.t.a', suite: 's.t', description: 'a', setup: false, status: 'passed', baselineStatus: 'passed', ms: 500 }],
  objects: [fixed({ covered: 1, total: 1, lines: { 3: true } })], log: [],
  ...over,
});

test('report: with the utPLSQL comparison its line rate shows as before', () => {
  const files = renderReport(fixedReport({}));
  const html = files['index.html'];
  assert.match(files['objects/s.p.package_body.html'], /line counted by utPLSQL/);
  assert.match(html, /utPLSQL reports <em>100 %<\/em> line coverage/);
  assert.match(html, /<th>Lines \(utPLSQL\)<\/th>/);
  assert.match(html, /with utPLSQL coverage 900 ms/);
  assert.match(html, /Runtime overhead/);
});

test('report: without the utPLSQL run and warm-up, utPLSQL is hidden and the skipped runs are named', () => {
  const r = fixedReport({
    timings: { instrumentedMs: 700, instrumentMs: 5, compileMs: 50 }, utplsqlRun: undefined, baselineRuns: 1,
    warmup: false, utplsqlCompare: false, objects: [fixed()],
  });
  const files = renderReport(r);
  const html = files['index.html'];
  // neither the overview nor the object page
  const pages = Object.entries(files).filter(([f]) => f.endsWith('.html')).map(([, t]) => t);
  assert.equal(pages.length, 2);
  for (const p of pages) assert.doesNotMatch(p, /utPLSQL reports|Lines \(utPLSQL\)|line counted by utPLSQL|with utPLSQL coverage|undefined|NaN/);
  assert.match(html, /<h1 id="h-hero"><em class="t-bad">50 %<\/em> of the branches are tested\.<\/h1>/);
  assert.match(html, /Without coverage not timed \(the only run also warmed up utPLSQL\)\. Skipped: warm-up run, utPLSQL coverage run\./);
  // the only baseline run was cold: its test times are no reference for the overhead
  assert.doesNotMatch(html, /Runtime overhead/);
  // object table: object, five metrics, gaps
  const row = /<tbody><tr>([\s\S]*?)<\/tr>/.exec(html)![1];
  assert.equal(row.match(/<td/g)!.length, 6);
  // joint report too
  assert.doesNotMatch(index(r, { mutation: { results: [] } }), /Lines \(utPLSQL\)/);
  // warm baseline (two runs without warm-up): timed, overhead shown
  const warm = index({ ...r, baselineRuns: 2, timings: { ...r.timings, baselineMs: 480 } });
  assert.match(warm, /Without coverage 480 ms\. Skipped/);
  assert.match(warm, /Runtime overhead/);
  // exports never carried utPLSQL data
  const exp = toCoverageExport(r);
  assert.equal(exp.objects[0].lines[3].hits, 2);
  assert.match(toCobertura(exp), /<line number="3" hits="2"/);
});

test('report: tests red without instrumentation get a card with the reasons on the overview, not on the object pages', () => {
  const red = { tests: [...run1.tests, { suite: 's.t', name: 'b', status: 'error' as const, time: 0.1, message: 'ORA-20073: setup <broken>' }], ms: 600 };
  const files = renderReport(fixedReport({ baseline: red }));
  assert.match(files['index.html'], /Red without instrumentation[\s\S]*?1 test<[\s\S]*?<li>test &quot;b&quot; of suite s\.t errors before instrumentation: ORA-20073: setup &lt;broken&gt;<\/li>/);
  assert.doesNotMatch(files['objects/s.p.package_body.html'], /Red without instrumentation/);
  assert.doesNotMatch(index(fixedReport({})), /Red without instrumentation/);
});

test('report: test descriptions, suite paths and test names are escaped on the object pages and the overview', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const files = renderReport(fixedReport({
    tests: [{ path: `s.t${evil}.a`, suite: 's.t', description: evil, setup: false, status: 'passed', baselineStatus: 'passed', ms: 500 }],
    baseline: { tests: [{ suite: 's.t', name: evil, status: 'passed', time: 0.5 }], ms: 500 },
    instrumentedRun: { tests: [{ suite: 's.t', name: evil, status: 'passed', time: 0.5 }], ms: 500 },
  }));
  for (const html of [files['index.html'], files['objects/s.p.package_body.html']]) {
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /&amp;lt;/, 'escaped once');
  }
  assert.match(files['objects/s.p.package_body.html'], /<div>• &lt;img src=x onerror=alert\(1\)&gt; <span style="opacity:\.7">\(t&lt;img src=x onerror=alert\(1\)&gt;\.a\)<\/span><\/div>/);
  assert.doesNotMatch(files['report.js'], /innerHTML/);
});

test('report: joint report with the same unit in two schemas puts each mutant on its own object only', () => {
  const two = fixedReport({ schema: 'A,B', objects: [{ ...fixed(), owner: 'A' }, { ...fixed(), owner: 'B' }] });
  const mut = (unit: string, status: string) => ({ unit, line: 3, op: 'ROR', original: '1', mutated: '2', status });
  const files = renderReport(two, { mutation: { results: [mut('PACKAGE BODY a.p', 'SURVIVED'), mut('PACKAGE BODY p', 'KILLED')] } });
  assert.match(files['objects/a.p.package_body.html'], /✱ 0\/1 mutants/);
  assert.doesNotMatch(files['objects/b.p.package_body.html'], /mutants/, 'no owner and two candidates: no object');
  assert.match(files['index.html'], /<strong>Mutation Score<\/strong>[\s\S]*?<small>0\/1<\/small>/, 'counted once');
  // one schema: a unit without owner is that object's
  const one = renderReport(fixedReport({}), { mutation: { results: [mut('PACKAGE BODY p', 'KILLED')] } });
  assert.match(one['objects/s.p.package_body.html'], /✱ 1\/1 mutants/);
});

test('report: a new render removes object pages of earlier ones, nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plgauge-report-'));
  mkdirSync(join(dir, 'objects'));
  writeFileSync(join(dir, 'objects/s.gone.procedure.html'), 'stale');
  writeFileSync(join(dir, 'objects/notes.txt'), 'mine');
  writeFileSync(join(dir, 'README.md'), 'mine');
  writeReport(dir, fixedReport({}));
  assert.ok(!existsSync(join(dir, 'objects/s.gone.procedure.html')));
  assert.ok(existsSync(join(dir, 'objects/s.p.package_body.html')));
  assert.ok(existsSync(join(dir, 'objects/notes.txt')) && existsSync(join(dir, 'README.md')));
});
