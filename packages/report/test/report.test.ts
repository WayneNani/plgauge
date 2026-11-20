/** The report folder (offline): overview, one page per object, per-schema summary, file names. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, instrument, newIds, type Hits, type RunReport } from '@plgauge/coverage';
import { pageNames, renderReport, summaryLines } from '@plgauge/report';

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
