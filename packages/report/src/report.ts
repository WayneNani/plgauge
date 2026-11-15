/**
 * Self-contained HTML report (no external scripts; fonts from Google Fonts with fallbacks).
 * With the results of a mutation run on the same code it becomes the joint report: per
 * line the mutants and their verdicts beside the coverage, and as a finding every
 * surviving mutant on an executed line (the tests run the code but do not check it).
 */
import { tokenize } from '@plgauge/core';
import type { CondResult, Metric, ObjectResult } from '@plgauge/coverage';
import type { RunReport } from '@plgauge/coverage';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pctNum = (m: Metric) => (m.total ? (m.covered / m.total) * 100 : null);
const fmtPct = (v: number | null) => (v === null ? '–' : `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} %`);
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} s` : `${ms.toLocaleString('en-US', { maximumFractionDigits: ms < 10 ? 1 : 0 })} ms`);
const md = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const KEYWORDS = new Set(('and as begin between body by case close constant create cursor declare default delete else elsif end exception exit continue fetch for forall from function goto group having if in insert into is like loop merge not null of on open or order package pragma procedure raise replace return reverse rowtype select set then type update using values when where while with true false is_null raise_application_error commit rollback savepoint execute immediate bulk collect limit record table index varchar2 number boolean pls_integer date timestamp clob others no_data_found too_many_rows case_not_found deterministic pipelined authid definer current_user').split(' '));

const DARK = `  --bg: #0e1413; --surface: #151d1c; --sunk: #1b2524; --ink: #e2eae8; --muted: #93a3a0; --line: #283432;
  --accent: #52b6bf; --accent-ink: #062022;
  --ok: #52c486; --warn: #e3ab4f; --bad: #f08068; --null: #a898f2; --nf: #73807e;
  --ok-tint: #15291f; --warn-tint: #2c2414; --bad-tint: #321a16; --nf-tint: #1b2322; --target: #3a3413;
  --code-kw: #79c0e6; --code-str: #e6b17a; --code-com: #6f7f7c; --code-num: #c7a2ea;
  color-scheme: dark;`;

type MetricKey = 'stmt' | 'branch' | 'cond' | 'mcdc' | 'loop';
const METRICS: { key: MetricKey; label: string; help: string }[] = [
  { key: 'stmt', label: 'Statements', help: 'Every executable statement on its own, even when several share a line.' },
  { key: 'branch', label: 'Branches', help: 'Every branch of IF, CASE, loop conditions and exception handlers, implicit ELSE branches included.' },
  { key: 'cond', label: 'Conditions', help: 'Every sub-condition of AND/OR expressions at least once TRUE and once FALSE.' },
  { key: 'mcdc', label: 'MC/DC', help: 'Every sub-condition was shown to change the outcome of its decision on its own (PL/SQL only).' },
  { key: 'loop', label: 'Loops', help: 'Loops with 0, exactly 1 and several iterations (0 does not apply to a basic LOOP).' },
];

function sum(objs: ObjectResult[], k: MetricKey): Metric {
  return objs.reduce((a, o) => ({ covered: a.covered + o.metrics[k].covered, total: a.total + o.metrics[k].total }), { covered: 0, total: 0 });
}

function tone(v: number | null): string {
  if (v === null) return 'none';
  return v >= 90 ? 'ok' : v >= 70 ? 'warn' : 'bad';
}

function bar(m: Metric, cls = ''): string {
  const v = pctNum(m);
  return `<div class="bar ${cls} t-${tone(v)}" role="img" aria-label="${fmtPct(v)}"><span style="width:${v ?? 0}%"></span></div>`;
}

/** The parts of a mutation result (plgauge mutate run --json) the joint report reads. */
export interface MutationResultLite {
  unit: string;
  line: number;
  /** File line of the unit keyword; ALL_SOURCE line = line - unitLine + 1. */
  unitLine?: number;
  op: string;
  original: string;
  mutated: string;
  status: string;
  killedBy?: string;
  detail?: string;
}

const MUT_HELP = 'Share of deliberately injected faults that a test notices. Shows whether executed code is also checked.';
const DETECTED = new Set(['KILLED', 'TIMEOUT', 'MEMORY']);
const VALID = new Set(['KILLED', 'TIMEOUT', 'MEMORY', 'SURVIVED', 'NOT_COVERED']);
const mutScore = (rs: MutationResultLite[]): Metric => ({
  covered: rs.filter((x) => DETECTED.has(x.status)).length,
  total: rs.filter((x) => VALID.has(x.status)).length,
});
const STATUS_TEXT: Record<string, string> = {
  KILLED: 'killed', TIMEOUT: 'timeout', MEMORY: 'memory limit', SURVIVED: 'survived', NOT_COVERED: 'not reached',
  COMPILE_ERROR: 'does not compile', ERROR: 'error',
};

/** Mutation results per object key ("PACKAGE BODY NAME") and ALL_SOURCE line. */
function mutationIndex(results: MutationResultLite[]): Map<string, Map<number, MutationResultLite[]>> {
  const out = new Map<string, Map<number, MutationResultLite[]>>();
  for (const m of results) {
    const u = /^(PACKAGE BODY|TYPE BODY|PROCEDURE|FUNCTION|TRIGGER) (.+)$/.exec(m.unit);
    if (!u) continue;
    let name = u[2].slice(u[2].lastIndexOf('.') + 1);
    name = name.startsWith('"') ? name.replace(/"/g, '') : name.toUpperCase();
    const key = `${u[1]} ${name}`;
    const line = m.line - (m.unitLine ?? 1) + 1;
    let byLine = out.get(key);
    if (!byLine) out.set(key, (byLine = new Map()));
    byLine.set(line, [...(byLine.get(line) ?? []), m]);
  }
  return out;
}

export function renderHtml(r: RunReport, opts: { mutation?: { results: MutationResultLite[] } } = {}): string {
  const objs = r.objects;
  const muts = opts.mutation ? mutationIndex(opts.mutation.results) : undefined;
  const mutOf = (o: ObjectResult) => muts?.get(`${o.type} ${o.name}`);
  const mutAll = muts ? objs.flatMap((o) => [...(mutOf(o)?.values() ?? [])].flat()) : [];
  const ut = objs.reduce((a, o) => ({ covered: a.covered + (o.utplsql?.covered ?? 0), total: a.total + (o.utplsql?.total ?? 0) }), { covered: 0, total: 0 });
  const totals = Object.fromEntries(METRICS.map((m) => [m.key, sum(objs, m.key)])) as Record<MetricKey, Metric>;
  const tips: string[] = [];
  const tip = (html: string) => `t${tips.push(html) - 1}`;

  // ---------------------------------------------------------------- hero
  const utPct = pctNum(ut);
  const brPct = pctNum(totals.branch);
  const mcPct = pctNum(totals.mcdc);
  const headline = utPct !== null && brPct !== null
    ? `utPLSQL reports <em>${fmtPct(utPct)}</em> line coverage. <em class="t-${tone(brPct)}">${fmtPct(brPct)}</em> of the branches${mcPct !== null ? ` and <em class="t-${tone(mcPct)}">${fmtPct(mcPct)}</em> MC/DC` : ''} are tested.`
    : 'Coverage measured by source code instrumentation';

  const compareRows = [
    `<div class="cmp-row ref">
       <div class="cmp-label"><strong>Lines</strong><span>utPLSQL today (DBMS_PROFILER)</span></div>
       ${bar(ut, 'ref')}
       <div class="cmp-val"><b>${fmtPct(utPct)}</b><small>${ut.covered}/${ut.total}</small></div>
     </div>`,
    ...[...METRICS.map((m) => ({ ...m, v: totals[m.key] })), ...(muts ? [{ label: 'Mutation Score', help: MUT_HELP, v: mutScore(mutAll) }] : [])].map(({ label, help, v }) => `<div class="cmp-row">
        <div class="cmp-label"><strong>${label}</strong><span>${esc(help)}</span></div>
        ${bar(v)}
        <div class="cmp-val"><b>${fmtPct(pctNum(v))}</b><small>${v.covered}/${v.total}</small></div>
      </div>`),
  ].join('');

  // ---------------------------------------------------------------- run facts
  const nTests = r.baseline.tests.length;
  const passed = r.instrumentedRun.tests.filter((t) => t.status === 'passed').length;
  const slowest = [...r.baseline.tests].sort((a, b) => b.time - a.time)[0];
  const slowInstr = slowest && r.instrumentedRun.tests.find((t) => t.suite === slowest.suite && t.name === slowest.name);
  const slowUt = slowest && r.utplsqlRun?.tests.find((t) => t.suite === slowest.suite && t.name === slowest.name);
  const factor = slowest && slowInstr && slowest.time > 0 ? slowInstr.time / slowest.time : null;
  const nObj = objs.filter((o) => !o.instrumentError).length;
  const facts = `
    <div class="facts">
      <div class="fact ${r.equivalent ? 'f-ok' : 'f-bad'}">
        <span class="fact-k">Behaviour unchanged</span>
        <span class="fact-v">${r.equivalent ? `${nTests}/${nTests} tests identical` : 'Results differ'}</span>
        <span class="fact-d">${r.equivalent ? `Every test gives the same result with and without instrumentation (${passed} passed).` : `Differing: ${(r.differingTests ?? []).map(esc).join('; ') || 'see log'}.`}${r.flakyTests?.length ? ` ${r.flakyTests.length} flaky test${r.flakyTests.length === 1 ? '' : 's'} excluded (result changes even without instrumentation): ${r.flakyTests.map((t) => esc(t.split('::').pop()!)).join(', ')}.` : ''}</span>
      </div>
      <div class="fact">
        <span class="fact-k">Instrumentation (TypeScript)</span>
        <span class="fact-v">${fmtMs(r.timings.instrumentMs)}</span>
        <span class="fact-d">Parsing and placing probes for ${nObj} object${nObj === 1 ? '' : 's'}. Compiling in the database: ${fmtMs(r.timings.compileMs)}.</span>
      </div>
      ${slowest && slowInstr ? `<div class="fact">
        <span class="fact-k">Runtime overhead</span>
        <span class="fact-v">${factor !== null ? `× ${factor.toLocaleString('en-US', { maximumFractionDigits: 1 })}` : '–'}</span>
        <span class="fact-d">Slowest test “${esc(slowest.name)}”: ${fmtMs(slowest.time * 1000)} without coverage${slowUt ? `, ${fmtMs(slowUt.time * 1000)} with utPLSQL coverage` : ''}, ${fmtMs(slowInstr.time * 1000)} with plgauge.</span>
      </div>` : ''}
      <div class="fact">
        <span class="fact-k">Test runs total</span>
        <span class="fact-v">${fmtMs(r.timings.instrumentedMs)}</span>
        <span class="fact-d">Without coverage ${fmtMs(r.timings.baselineMs)}, with utPLSQL coverage ${fmtMs(r.timings.utplsqlCoverageMs)}.</span>
      </div>
    </div>`;

  // ---------------------------------------------------------------- object table
  const tableRows = objs.map((o, idx) => {
    const cell = (v: Metric, cls = 'mini') => `<td><div class="cell">${bar(v, cls)}<span class="num">${fmtPct(pctNum(v))}</span></div></td>`;
    return `<tr>
      <th scope="row"><a href="#o${idx}">${esc(o.name.toLowerCase())}</a><span class="otype">${esc(o.type.toLowerCase())}</span></th>
      ${cell(o.utplsql ?? { covered: 0, total: 0 }, 'mini ref')}
      ${o.instrumentError ? `<td colspan="${METRICS.length}" class="err">${esc(o.instrumentError)}</td>` : METRICS.map((m) => cell(o.metrics[m.key])).join('')}
      ${muts ? cell(mutScore([...(mutOf(o)?.values() ?? [])].flat())) : ''}
      <td class="num find">${o.findings.length + (muts ? unchecked(o, mutOf(o)).length : 0)}</td>
    </tr>`;
  }).join('');

  // ---------------------------------------------------------------- objects
  const testNames = (r.tests ?? []).map((t) => (t.setup ? t.description : `${t.description} <span style="opacity:.7">(${t.path.split('.').slice(1).join('.')})</span>`));
  const sections = objs.map((o, idx) => renderObject(o, idx, tip, testNames, muts ? mutOf(o) ?? new Map() : undefined)).join('');

  return `<title>plgauge ${esc(r.schema)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wdth,wght@75..100,400..700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
/* Layout: report spine; summary first (claim → evidence → objects), code views below with findings beside the code. */
:root {
  --bg: #f3f5f4; --surface: #ffffff; --sunk: #eaeeec; --ink: #17201e; --muted: #5a6866; --line: #d9e0de;
  --accent: #0d6b74; --accent-ink: #ffffff;
  --ok: #1d7f49; --warn: #a86a12; --bad: #b8402b; --null: #6652c4; --nf: #8a9593;
  --ok-tint: #e3f2e8; --warn-tint: #fbf0dc; --bad-tint: #f9e4df; --nf-tint: #eef0ef; --target: #fff3b0;
  --code-kw: #0d5f8a; --code-str: #8a4b12; --code-com: #7d8a88; --code-num: #7a3e9d;
  --font-ui: "Instrument Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-code: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --r: 10px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${DARK.replace(/^/gm, '  ')}
  }
}
:root[data-theme="dark"] {
${DARK}
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 var(--font-ui); margin: 0; }
.wrap { max-width: 1240px; margin: 0 auto; padding-block: 28px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; grid-template-columns: minmax(0, 1fr); gap: 40px; }
h1, h2, h3 { font-stretch: 85%; letter-spacing: -0.01em; text-wrap: balance; margin: 0; }
code { font-family: var(--font-code); font-size: 0.88em; background: var(--sunk); padding: 0.05em 0.35em; border-radius: 4px; }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.eyebrow { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; }

/* header */
.top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 8px 24px; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
.brand { font: 700 20px/1 var(--font-code); letter-spacing: -0.02em; }
.brand span { color: var(--accent); }
.meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 16px; font-variant-numeric: tabular-nums; }

/* hero */
.hero { display: grid; gap: 22px; }
.hero h1 { font-size: clamp(26px, 3.6vw, 40px); line-height: 1.15; font-weight: 600; max-width: 30ch; }
.hero h1 em { font-style: normal; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hero h1 em.t-ok { color: var(--ok); } .hero h1 em.t-warn { color: var(--warn); } .hero h1 em.t-bad { color: var(--bad); }
.compare { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 6px 20px; }
.cmp-row { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 2fr) 92px; gap: 18px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
.cmp-row:first-child { border-top: 0; }
.cmp-row.ref { border-bottom: 2px solid var(--line); }
.cmp-label { display: grid; min-width: 0; }
.cmp-label strong { font-weight: 600; }
.cmp-label span { color: var(--muted); font-size: 13px; line-height: 1.35; }
.cmp-val { text-align: right; display: grid; font-variant-numeric: tabular-nums; }
.cmp-val b { font: 600 17px var(--font-code); }
.cmp-val small { color: var(--muted); font-size: 12px; font-family: var(--font-code); }
.bar { height: 12px; border-radius: 99px; background: var(--sunk); overflow: hidden; }
.bar span { display: block; height: 100%; border-radius: 99px; background: var(--muted); }
.bar.t-ok span { background: var(--ok); } .bar.t-warn span { background: var(--warn); } .bar.t-bad span { background: var(--bad); }
.bar.ref span { background: repeating-linear-gradient(-45deg, var(--muted) 0 6px, transparent 6px 9px); }
.bar.mini { height: 6px; width: 64px; flex: none; }

/* facts */
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.fact { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px; display: grid; gap: 4px; align-content: start; }
.fact-k { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
.fact-v { font: 600 20px var(--font-code); font-variant-numeric: tabular-nums; }
.fact-d { font-size: 13px; color: var(--muted); }
.f-ok .fact-v { color: var(--ok); } .f-bad .fact-v { color: var(--bad); }

/* table */
section > header { display: grid; gap: 6px; margin-bottom: 14px; }
.tbl { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { padding: 10px 14px; text-align: left; border-top: 1px solid var(--line); white-space: nowrap; }
thead th { border-top: 0; font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
tbody th { font-weight: 600; }
tbody th a { text-decoration: none; font-family: var(--font-code); font-size: 13.5px; }
.otype { display: block; color: var(--muted); font-weight: 400; font-size: 12px; }
.cell { display: flex; align-items: center; gap: 8px; }
.num { font-family: var(--font-code); font-size: 13px; font-variant-numeric: tabular-nums; }
.find { text-align: right; }
td.err { color: var(--bad); white-space: normal; }

/* object sections */
.obj { display: grid; gap: 14px; scroll-margin-top: 16px; }
.obj-head > div:first-child { min-width: 0; }
.obj-head h3 { overflow-wrap: anywhere; }
.obj-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 18px; }
.obj-head h3 { font-family: var(--font-code); font-size: 19px; font-stretch: 100%; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 12.5px; border: 1px solid var(--line); background: var(--surface); border-radius: 99px; padding: 2px 10px; font-variant-numeric: tabular-nums; }
.chip b { font-family: var(--font-code); font-weight: 600; }
.chip.t-ok b { color: var(--ok); } .chip.t-warn b { color: var(--warn); } .chip.t-bad b { color: var(--bad); }
.chip.ref { border-style: dashed; }
.obj-body { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 14px; align-items: start; }
@media (max-width: 980px) { .obj-body { grid-template-columns: minmax(0, 1fr); } .cmp-row { grid-template-columns: minmax(0, 1fr) 80px; } .cmp-row .bar { grid-column: 1 / -1; grid-row: 2; } }

.code { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); overflow-x: auto; font: 13px/1.6 var(--font-code); }
.code table { font-size: inherit; width: max-content; min-width: 100%; }
.code td { border: 0; padding: 0; white-space: pre; vertical-align: top; }
.code tr:target td { background: var(--target); }
.ln { color: var(--muted); text-align: right; padding: 0 10px 0 12px !important; user-select: none; font-size: 12px; }
.ut { width: 14px; text-align: center; user-select: none; }
.ut i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid var(--muted); }
.ut i.y { background: var(--muted); }
.hits { color: var(--muted); text-align: right; padding: 0 8px !important; font-size: 11.5px; user-select: none; min-width: 52px; }
.hits span { cursor: help; border-bottom: 1px dotted var(--line); }
.src { padding: 0 16px 0 10px !important; border-left: 3px solid transparent; }
tr.s-covered .src { border-left-color: var(--ok); }
tr.s-partial .src { border-left-color: var(--warn); background: var(--warn-tint); }
tr.s-missed .src { border-left-color: var(--bad); background: var(--bad-tint); }
tr.s-nf .src { border-left-color: var(--nf); background: var(--nf-tint); }
.kw { color: var(--code-kw); font-weight: 600; }
.str { color: var(--code-str); }
.com { color: var(--code-com); font-style: italic; }
.nm { color: var(--code-num); }
.cond { border-bottom: 2px solid var(--ok); cursor: help; border-radius: 2px; }
.cond.c-partial { border-bottom-color: var(--warn); }
.cond.c-missed { border-bottom-color: var(--bad); border-bottom-style: dashed; }
.cond.c-nf { border-bottom-color: var(--nf); }
.tf { display: inline-flex; gap: 1px; vertical-align: 1px; margin: 0 2px 0 1px; cursor: help; }
.tf b { font: 600 9px/1 var(--font-ui); padding: 2px 3px; border-radius: 3px; background: var(--sunk); color: var(--muted); }
.tf b.on { color: var(--accent-ink); }
.tf b.on.T { background: var(--ok); } .tf b.on.F { background: var(--bad); } .tf b.on.N { background: var(--null); }
.tf b.mc { margin-left: 2px; }
.tf b.mc.yes { background: var(--ok-tint); color: var(--ok); } .tf b.mc.no { background: var(--bad-tint); color: var(--bad); }
.br { margin-left: 10px; font: 600 10.5px var(--font-ui); padding: 1px 7px; border-radius: 99px; background: var(--sunk); color: var(--muted); cursor: help; }
.br.t-ok { background: var(--ok-tint); color: var(--ok); } .br.t-warn, .br.t-bad { background: var(--warn-tint); color: var(--warn); }
.br.t-bad { background: var(--bad-tint); color: var(--bad); }

aside.findings { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 4px 0; position: sticky; top: max(12px, env(safe-area-inset-top, 0px)); max-height: calc(100vh - 24px); overflow: auto; }
.findings h4 { margin: 10px 16px 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.findings ol { list-style: none; margin: 0; padding: 0; }
.findings li a { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; padding: 8px 16px; text-decoration: none; color: inherit; border-top: 1px solid var(--line); }
.findings li a:hover { background: var(--sunk); }
.fl { font: 12px var(--font-code); color: var(--muted); padding-top: 2px; }
.ft { font-size: 13.5px; line-height: 1.4; min-width: 0; overflow-wrap: anywhere; }
.ft small { display: block; color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.kind { font: 600 10px var(--font-ui); text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 6px; border-radius: 4px; margin-right: 4px; background: var(--sunk); color: var(--muted); }
.kind.mcdc, .kind.cond { color: var(--null); }
.kind.branch, .kind.stmt { color: var(--bad); }
.kind.loop { color: var(--warn); }
.kind.mut { color: var(--accent); }
.br.mut { font-family: var(--font-code); }
.findings .none { padding: 12px 16px; color: var(--ok); font-size: 14px; border-top: 1px solid var(--line); }
.gaps li { padding: 8px 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; }

.legend { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 13px; color: var(--muted); align-items: center; }
.legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }

.method { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 28px; font-size: 14px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 20px; }
.method h4 { color: var(--ink); margin: 0 0 4px; font-size: 14px; }
.method p { margin: 0; max-width: 62ch; }

#tip { position: fixed; z-index: 20; max-width: min(380px, calc(100vw - 32px)); background: var(--ink); color: var(--bg); border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.45; pointer-events: none; box-shadow: 0 8px 24px rgb(0 0 0 / 0.18); }
#tip code { background: transparent; color: inherit; padding: 0; font-weight: 600; }
#tip .row { display: flex; justify-content: space-between; gap: 16px; font-variant-numeric: tabular-nums; }
#tip hr { border: 0; border-top: 1px solid currentColor; opacity: 0.25; margin: 6px 0; }
@media (prefers-reduced-motion: no-preference) { .bar span { transition: width 0.6s ease; } }
</style>

<div class="wrap">
  <div class="top">
    <div class="brand">pl<span>gauge</span></div>
    <div class="meta">
      <span>Schema <b>${esc(r.schema)}</b></span>
      <span>${esc(r.database.replace(/ - Develop.*$/, ''))}</span>
      <span>SQL probes ${r.sqlProbes ? 'on' : 'off'}</span>
      <span>${esc(new Date(r.generated).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }))} UTC</span>
    </div>
  </div>

  <section class="hero" aria-labelledby="h-hero">
    <div class="eyebrow">Measured with the same ${nTests} utPLSQL tests</div>
    <h1 id="h-hero">${headline}</h1>
    <div class="compare">${compareRows}</div>
    ${facts}
  </section>

  <section aria-labelledby="h-obj">
    <header><div class="eyebrow">Objects</div><h2 id="h-obj">Coverage per program unit</h2></header>
    <div class="tbl"><table>
      <thead><tr><th>Object</th><th>Lines (utPLSQL)</th>${METRICS.map((m) => `<th>${m.label}</th>`).join('')}${muts ? '<th>Mutation Score</th>' : ''}<th class="find">Gaps</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
  </section>

  <div class="legend" aria-label="Legend">
    <span><i class="sw" style="background:var(--ok)"></i>complete</span>
    <span><i class="sw" style="background:var(--warn)"></i>partial (branch or condition missing)</span>
    <span><i class="sw" style="background:var(--bad)"></i>never executed</span>
    <span><i class="sw" style="background:var(--nf)"></i>NOT_FEASIBLE</span>
    <span><span class="tf"><b class="on T">T</b><b class="on F">F</b><b class="on N">N</b></span>sub-condition was TRUE / FALSE / NULL</span>
    <span><span class="ut"><i class="y"></i></span> line counted by utPLSQL</span>
  </div>

  ${sections}

  <section class="method" aria-label="Method">
    <div><h4>How it is measured</h4><p>plgauge reads the compiled source, places probes on every statement, decision and sub-condition and recompiles the code. The probes add no lines, so error messages keep their line numbers. Then the utPLSQL tests run, and the original code is restored.</p></div>
    <div><h4>NULL and short-circuit</h4><p>Every sub-condition is counted as TRUE, FALSE or NULL. The probes return the value unchanged, so short-circuit evaluation and NULL semantics are preserved. MC/DC treats sub-conditions that were not evaluated as wildcards (unique cause with short-circuit).</p></div>
    <div><h4>Limits</h4><p>Conditions in WHERE, ON and HAVING clauses are deliberately not instrumented, because that would change the execution plan. Dynamic SQL and code obfuscated with wrap are not measured. Hits from sessions of other users, and from parallel query slaves that run fewer than 1000 statements, are lost.</p></div>
  </section>
</div>

<div id="tip" hidden></div>
<div hidden>${tips.map((t, k) => `<div id="t${k}">${t}</div>`).join('')}</div>
<script>
(() => {
  const tipEl = document.getElementById('tip');
  let current = null;
  const show = (el) => {
    const src = document.getElementById(el.dataset.tip);
    if (!src) return;
    current = el;
    tipEl.innerHTML = src.innerHTML;
    tipEl.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let y = r.bottom + 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 8);
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  };
  const hide = () => { tipEl.hidden = true; current = null; };
  document.addEventListener('mouseover', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); else if (current) hide(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
  document.addEventListener('focusout', hide);
  document.addEventListener('click', (e) => { const el = e.target.closest('[data-tip]'); if (el && el !== current) show(el); else if (!el) hide(); });
  window.addEventListener('scroll', hide, { passive: true });
})();
</script>`;
}

// -------------------------------------------------------------------- object

function testList(idx: number[] | undefined, names: string[], max = 10): string {
  if (!idx?.length) return '<div style="opacity:.75">reached by no test</div>';
  const items = idx.slice(0, max).map((k) => `<div>• ${names[k] ?? esc(String(k))}</div>`).join('');
  return items + (idx.length > max ? `<div style="opacity:.75">… and ${idx.length - max} more</div>` : '');
}

/** Surviving mutants on executed lines: the tests run this code but would not notice a fault in it. */
function unchecked(o: ObjectResult, byLine: Map<number, MutationResultLite[]> | undefined): { line: number; m: MutationResultLite }[] {
  if (!byLine) return [];
  const out: { line: number; m: MutationResultLite }[] = [];
  for (const [line, rs] of byLine) {
    // the statement around the mutant ran: the line itself or the nearest statement start above
    const st = o.statements.filter((s) => s.line <= line && s.endLine >= line).sort((a, b) => b.line - a.line)[0];
    if (st && st.hits > 0) out.push(...rs.filter((m) => m.status === 'SURVIVED').map((m) => ({ line, m })));
  }
  return out.sort((a, b) => a.line - b.line);
}

const one = (s: string, max = 48) => {
  const t = s.split(/\s+/).filter(Boolean).join(' ');
  return [...t].length > max ? [...t].slice(0, max - 1).join('') + '…' : t;
};

function renderObject(o: ObjectResult, idx: number, tip: (html: string) => string, names: string[], muts?: Map<number, MutationResultLite[]>): string {
  const chips = [
    o.utplsql ? `<span class="chip ref">Lines (utPLSQL) <b>${fmtPct(pctNum(o.utplsql))}</b></span>` : '',
    ...[...METRICS.map((m) => [m.label, o.metrics[m.key]] as const), ...(muts ? [['Mutation Score', mutScore([...muts.values()].flat())] as const] : [])]
      .map(([label, m]) => `<span class="chip t-${tone(pctNum(m))}">${label} <b>${fmtPct(pctNum(m))}</b></span>`),
  ].join('');

  const head = `<div class="obj-head"><div><div class="eyebrow">${esc(o.type.toLowerCase())}</div><h3>${esc(o.owner.toLowerCase())}.${esc(o.name.toLowerCase())}</h3></div><div class="chips">${chips}</div></div>`;
  if (o.instrumentError) {
    return `<section class="obj" id="o${idx}">${head}<p class="err">Not instrumented: ${esc(o.instrumentError)}</p></section>`;
  }

  // condition marks by source offset
  const conds: { c: CondResult; d: ObjectResult['decisions'][number] }[] = [];
  for (const d of o.decisions) for (const c of d.conds) conds.push({ c, d });
  conds.sort((a, b) => a.c.span.start - b.c.span.start);
  const condAt = new Map<number, (typeof conds)[number]>();
  let lastEnd = -1;
  for (const x of conds) {
    if (x.c.span.start >= lastEnd) {
      condAt.set(x.c.span.start, x);
      lastEnd = x.c.span.end;
    }
  }

  // branch badges per line
  const branchesByLine = new Map<number, ObjectResult['branches']>();
  for (const b of o.branches) branchesByLine.set(b.line, [...(branchesByLine.get(b.line) ?? []), b]);
  const loopByLine = new Map(o.loops.map((l) => [l.line, l]));

  // highlighted source → html per line
  const source = o.lines.join('\n');
  const htmlLines: string[] = [''];
  let open: { endOffset: number; cls: string; tipId: string; after: string } | null = null;
  const emit = (text: string, cls: string | null) => {
    const parts = text.split('\n');
    parts.forEach((p, k) => {
      if (k > 0) {
        if (open) htmlLines[htmlLines.length - 1] += '</span>';
        htmlLines.push(open ? `<span class="cond ${open.cls}" data-tip="${open.tipId}" tabindex="0">` : '');
      }
      if (p) htmlLines[htmlLines.length - 1] += cls ? `<span class="${cls}">${esc(p)}</span>` : esc(p);
    });
  };
  let tokens;
  try {
    tokens = tokenize(source);
  } catch {
    tokens = [{ kind: 'trivia' as const, text: source, up: source, start: 0, end: source.length, line: 1, col: 1 }];
  }
  for (const t of tokens) {
    const mark = condAt.get(t.start);
    if (mark && !open) {
      const { c, d } = mark;
      const seen = (c.t > 0 ? 1 : 0) + (c.f > 0 ? 1 : 0);
      const cls = d.nf ? 'c-nf' : seen === 2 && c.mcdc !== 'no' ? 'c-ok' : seen === 0 && c.n === 0 ? 'c-missed' : 'c-partial';
      const tipId = tip(condTip(c, d));
      const mc = c.mcdc === 'na' || d.conds.length < 2 ? '' : `<b class="mc ${c.mcdc}">MC/DC ${c.mcdc === 'yes' ? '✓' : '✗'}</b>`;
      const after = `<span class="tf" data-tip="${tipId}" aria-hidden="true"><b class="T${c.t ? ' on' : ''}">T</b><b class="F${c.f ? ' on' : ''}">F</b><b class="N${c.n ? ' on' : ''}">N</b>${mc}</span>`;
      open = { endOffset: c.span.end, cls, tipId, after };
      htmlLines[htmlLines.length - 1] += `<span class="cond ${cls}" data-tip="${tipId}" tabindex="0" aria-label="Sub-condition ${c.t ? 'seen TRUE' : 'never TRUE'}, ${c.f ? 'seen FALSE' : 'never FALSE'}">`;
    }
    const cls = t.kind === 'trivia' ? (t.text.trimStart().startsWith('--') || t.text.trimStart().startsWith('/*') ? 'com' : null)
      : t.kind === 'string' ? 'str' : t.kind === 'number' ? 'nm' : t.kind === 'ident' && KEYWORDS.has(t.text.toLowerCase()) ? 'kw' : null;
    emit(t.text, cls);
    if (open && t.end >= open.endOffset) {
      htmlLines[htmlLines.length - 1] += `</span>${open.after}`;
      open = null;
    }
  }

  const rows = o.lines.map((_, k) => {
    const line = k + 1;
    const st = o.lineStatus[line];
    const hits = o.lineHits[line];
    const utLine = o.utplsql?.lines[line];
    const utMark = utLine === undefined ? '' : `<i class="${utLine ? 'y' : 'n'}" title="utPLSQL: ${utLine ? 'executed' : 'not executed'}"></i>`;
    let badge = '';
    const brs = branchesByLine.get(line)?.filter((b) => !b.nf);
    if (brs?.length) {
      const cov = brs.filter((b) => b.hits > 0).length;
      const v = (cov / brs.length) * 100;
      const id = tip(`<b>Branches on line ${line}</b><hr>${brs.map((b) => `<div class="row"><span>${md(b.label)}</span><span>${b.hits}×${b.tests ? ` · ${b.tests.length} Test${b.tests.length === 1 ? '' : 's'}` : ''}</span></div>${b.hits === 0 && b.reason ? `<div style="opacity:.75">${md(b.reason)}</div>` : ''}`).join('')}`);
      badge += `<span class="br t-${tone(v)}" data-tip="${id}" tabindex="0">◆ ${cov}/${brs.length} branches</span>`;
    }
    const lp = loopByLine.get(line);
    if (lp && !lp.nf) {
      const goals = lp.kind === 'loop' ? 2 : 3;
      const cov = (lp.kind === 'loop' ? 0 : +(lp.zero > 0)) + +(lp.one > 0) + +(lp.many > 0);
      const id = tip(`<b>Loop (${lp.kind})</b><hr>${lp.kind === 'loop' ? '' : `<div class="row"><span>0 iterations</span><span>${lp.zero}×</span></div>`}<div class="row"><span>exactly 1 iteration</span><span>${lp.one}×</span></div><div class="row"><span>several iterations</span><span>${lp.many}×</span></div>`);
      badge += `<span class="br t-${tone((cov / goals) * 100)}" data-tip="${id}" tabindex="0">↻ ${cov}/${goals}</span>`;
    }
    const ms = muts?.get(line);
    if (ms?.length) {
      const v = mutScore(ms);
      const id = tip(`<b>Mutants on line ${line}</b><hr>${ms.map((m) => `<div class="row"><span><code>${esc(one(m.original))}</code> → <code>${esc(one(m.mutated))}</code> <span style="opacity:.7">${esc(m.op)}</span></span><span>${STATUS_TEXT[m.status] ?? esc(m.status)}</span></div>${m.status === 'KILLED' && m.killedBy ? `<div style="opacity:.75">by ${esc(m.killedBy)}</div>` : ''}`).join('')}`);
      badge += `<span class="br mut t-${tone(pctNum(v))}" data-tip="${id}" tabindex="0">✱ ${v.covered}/${v.total} mutants</span>`;
    }
    return `<tr id="o${idx}-L${line}" class="${st ? `s-${st}` : ''}"><td class="ln">${line}</td><td class="ut">${utMark}</td><td class="hits">${hits === undefined ? '' : o.lineTests?.[line]?.length || hits === 0
      ? `<span data-tip="${tip(`<b>Line ${line}: executed ${hits.toLocaleString('en-US')}×</b><hr>${testList(o.lineTests?.[line], names)}`)}" tabindex="0">${hits.toLocaleString('en-US')}×</span>`
      : `${hits.toLocaleString('en-US')}×`}</td><td class="src">${htmlLines[k] ?? ''}${badge}</td></tr>`;
  }).join('');

  const mutFindings = unchecked(o, muts).map(({ line, m }) => ({
    line, kind: 'mut', title: `Executed but unchecked: \`${one(m.original, 40)}\` → \`${one(m.mutated, 40)}\` goes unnoticed`,
    detail: `${m.op}: the tests execute the line, none of them fails on the change.`,
  }));
  const all = [...o.findings, ...mutFindings].sort((a, b) => a.line - b.line);
  const findings = all.length
    ? `<ol>${all.map((f) => `<li><a href="#o${idx}-L${f.line}"><span class="fl">L. ${f.line}</span><span class="ft"><span class="kind ${f.kind}">${KIND[f.kind]}</span>${md(f.title)}${f.detail ? `<small>${md(f.detail)}</small>` : ''}</span></a></li>`).join('')}</ol>`
    : `<div class="none">No gaps found.</div>`;
  const gaps = o.gaps.length
    ? `<h4>Not measured</h4><ol class="gaps">${o.gaps.map((g) => `<li><span class="fl">L. ${g.line}</span><span>${esc(g.reason)}</span></li>`).join('')}</ol>`
    : '';

  return `<section class="obj" id="o${idx}" aria-label="${esc(o.name)}">
    ${head}
    <div class="obj-body">
      <div class="code"><table>${rows}</table></div>
      <aside class="findings"><h4>Gaps (${all.length})</h4>${findings}${gaps}</aside>
    </div>
  </section>`;
}

const KIND: Record<string, string> = { stmt: 'Statement', branch: 'Branch', cond: 'Condition', mcdc: 'MC/DC', loop: 'Loop', mut: 'Mutant' };

function condTip(c: CondResult, d: ObjectResult['decisions'][number]): string {
  const lines = [
    `<b><code>${esc(c.text.replace(/\s+/g, ' '))}</code></b>`,
    `<div style="opacity:.75">Sub-condition ${c.i} of ${d.conds.length} · ${d.ctx === 'sql' ? 'SQL' : 'PL/SQL'}</div>`,
    '<hr>',
    ...([['TRUE', c.t], ['FALSE', c.f], ['NULL', c.n]] as const).map(([w, n]) => `<div class="row"><span>${w}</span><span>${n.toLocaleString('en-US')}×</span></div>`),
  ];
  if (c.mcdc !== 'na' && d.conds.length > 1) {
    lines.push('<hr>', c.mcdc === 'yes' ? '<div>MC/DC: independent effect shown ✓</div>' : `<div>MC/DC: independent effect not shown</div>${c.suggestion ? `<div style="margin-top:4px">Missing test case: ${md(c.suggestion)}</div>` : ''}`);
  } else if (c.mcdc === 'na') {
    lines.push('<hr>', '<div style="opacity:.75">In SQL the evaluation order is not defined, so no MC/DC.</div>');
  }
  return lines.join('');
}
