/**
 * Coverage for CI systems, built from the exchange format plgauge-coverage/1 (so merged
 * runs work the same): Cobertura XML, SonarQube Generic Coverage, LCOV and JUnit.
 *
 * Cobertura, Sonar and LCOV know lines and branches only. Statement lines become lines,
 * the branches of IF, CASE, loops and handlers become branches of their line. Conditions
 * and MC/DC stay in the JSON and the HTML report.
 *
 * Paths: coverage is measured on database objects. A source map ties an object to the
 * repository file it comes from (and the file line of ALL_SOURCE line 1); without one,
 * objects get virtual paths like "schema/package_body/name.sql".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { parse, touches, type ChangedLines } from '@plgauge/core';
import type { CoverageExport } from './export.js';

type Obj = CoverageExport['objects'][number];

export interface SourceLocation {
  path: string;
  /** File line of ALL_SOURCE line 1 (the line of the unit keyword). */
  firstLine: number;
}

export type SourceMap = Map<string, SourceLocation>;

const keyOf = (type: string, name: string) => `${type} ${name}`.toUpperCase();

/**
 * Finds the units in source files: key "TYPE NAME" → file and line. Names are matched
 * without schema, like the data dictionary (quoted names keep their case).
 */
export function sourceMap(files: string[], rel: (p: string) => string = (p) => p): SourceMap {
  const map: SourceMap = new Map();
  for (const f of files) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(f));
    } catch {
      continue;
    }
    const p = parse(text);
    for (const u of p.units) {
      let k = u.a;
      while (['CREATE', 'OR', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING'].includes(p.tokens[k].up)) k++;
      const last = u.name!.slice(u.name!.lastIndexOf('.') + 1);
      const name = last.startsWith('"') ? last.replace(/"/g, '') : last.toUpperCase();
      map.set(`${u.op} ${name}`.toUpperCase(), { path: rel(f), firstLine: p.tokens[k].line });
    }
  }
  return map;
}

interface FileCov {
  path: string;
  /** file line → hits (statement lines) */
  lines: Map<number, number>;
  /** file line → branches: [construct, hits] */
  branches: Map<number, [number, number][]>;
}

function files(exp: CoverageExport, map?: SourceMap): FileCov[] {
  const out = new Map<string, FileCov>();
  for (const o of exp.objects) {
    if (!o.instrumented) continue;
    const loc = map?.get(keyOf(o.type, o.name));
    const path = loc?.path ?? `${o.owner.toLowerCase()}/${o.type.toLowerCase().replace(/ /g, '_')}/${o.name.toLowerCase()}.sql`;
    const off = (loc?.firstLine ?? 1) - 1;
    let f = out.get(path);
    if (!f) out.set(path, (f = { path, lines: new Map(), branches: new Map() }));
    const stmts = o.statements ?? Object.entries(o.lines).map(([l, v]) => ({ line: Number(l), endLine: Number(l), hits: v.hits, tests: v.tests }));
    for (const s of stmts) f.lines.set(s.line + off, Math.max(f.lines.get(s.line + off) ?? 0, s.hits));
    // A branch derived from a decision belongs to the line of its condition (THEN and the
    // implicit ELSE of an IF both on the IF line); a probed branch (handler, simple CASE)
    // to its WHEN line. A line without a statement counts as run when one of its branches ran.
    const own = new Set(stmts.map((s) => s.line + off));
    for (const b of o.branches) {
      if (b.nf) continue;
      const l = (b.condition?.line ?? b.line) + off;
      if (!own.has(l)) f.lines.set(l, Math.max(f.lines.get(l) ?? 0, b.hits));
      f.branches.set(l, [...(f.branches.get(l) ?? []), [b.construct ?? 0, b.hits]]);
    }
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** SonarQube Generic Test Coverage (sonar.coverageReportPaths). */
export function toSonar(exp: CoverageExport, map?: SourceMap): string {
  const out = ['<coverage version="1">'];
  for (const f of files(exp, map)) {
    out.push(`  <file path="${xml(f.path)}">`);
    for (const [l, hits] of [...f.lines].sort((a, b) => a[0] - b[0])) {
      const br = f.branches.get(l);
      const brAttr = br ? ` branchesToCover="${br.length}" coveredBranches="${br.filter((b) => b[1] > 0).length}"` : '';
      out.push(`    <lineToCover lineNumber="${l}" covered="${hits > 0}"${brAttr}/>`);
    }
    out.push('  </file>');
  }
  out.push('</coverage>');
  return out.join('\n') + '\n';
}

/** LCOV tracefile (genhtml, Codecov, GitLab via lcov-to-cobertura). */
export function toLcov(exp: CoverageExport, map?: SourceMap): string {
  const out: string[] = [];
  for (const f of files(exp, map)) {
    out.push('TN:', `SF:${f.path}`);
    const lines = [...f.lines].sort((a, b) => a[0] - b[0]);
    let brf = 0;
    let brh = 0;
    for (const [l, brs] of [...f.branches].sort((a, b) => a[0] - b[0])) {
      brs.forEach(([c, hits], i) => {
        out.push(`BRDA:${l},${c},${i},${hits > 0 ? hits : (f.lines.get(l) ?? 0) > 0 ? 0 : '-'}`);
        brf++;
        if (hits > 0) brh++;
      });
    }
    out.push(`BRF:${brf}`, `BRH:${brh}`);
    for (const [l, hits] of lines) out.push(`DA:${l},${hits}`);
    out.push(`LF:${lines.length}`, `LH:${lines.filter((x) => x[1] > 0).length}`, 'end_of_record');
  }
  return out.join('\n') + '\n';
}

/** Cobertura XML (GitLab coverage visualization, Jenkins, Azure DevOps). */
export function toCobertura(exp: CoverageExport, map?: SourceMap): string {
  const fs = files(exp, map);
  const count = (hits: number[]): [number, number] => [hits.filter((h) => h > 0).length, hits.length];
  const lineCount = (list: FileCov[]) => count(list.flatMap((f) => [...f.lines.values()]));
  const brCount = (list: FileCov[]) => count(list.flatMap((f) => [...f.branches.values()].flat().map((b) => b[1])));
  const rate = ([c, t]: [number, number]) => (t ? (c / t).toFixed(4) : '1');
  const [lc, lt] = lineCount(fs);
  const [bc, bt] = brCount(fs);
  const ts = Math.floor(Date.parse(exp.generated || new Date().toISOString()) / 1000) || 0;
  const out = [
    '<?xml version="1.0" ?>',
    '<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">',
    `<coverage line-rate="${rate([lc, lt])}" branch-rate="${rate([bc, bt])}" lines-covered="${lc}" lines-valid="${lt}" branches-covered="${bc}" branches-valid="${bt}" complexity="0" version="plgauge" timestamp="${ts}">`,
    '  <sources><source>.</source></sources>',
    '  <packages>',
  ];
  const byDir = new Map<string, FileCov[]>();
  for (const f of fs) {
    const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  for (const [dir, list] of byDir) {
    out.push(`    <package name="${xml(dir.replace(/\//g, '.'))}" line-rate="${rate(lineCount(list))}" branch-rate="${rate(brCount(list))}" complexity="0">`, '      <classes>');
    for (const f of list) {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
      out.push(`        <class name="${xml(name)}" filename="${xml(f.path)}" line-rate="${rate(lineCount([f]))}" branch-rate="${rate(brCount([f]))}" complexity="0">`, '          <methods/>', '          <lines>');
      for (const [l, hits] of [...f.lines].sort((a, b) => a[0] - b[0])) {
        const [c, t] = count((f.branches.get(l) ?? []).map((b) => b[1]));
        out.push(`            <line number="${l}" hits="${hits}" branch="${t > 0}"${t ? ` condition-coverage="${Math.round((c / t) * 100)}% (${c}/${t})"` : ''}/>`);
      }
      out.push('          </lines>', '        </class>');
    }
    out.push('      </classes>', '    </package>');
  }
  out.push('  </packages>', '</coverage>');
  return out.join('\n') + '\n';
}

const SKIPPED = new Set(['skipped', 'excluded', 'flaky']);

/** JUnit XML of the tests of the run (instrumented run; excluded tests are reported as skipped). */
export function toJunit(exp: CoverageExport): string {
  const suites = new Map<string, CoverageExport['tests']>();
  for (const t of exp.tests) {
    if (t.setup) continue;
    const s = t.path.split('.').slice(0, -1).join('.');
    suites.set(s, [...(suites.get(s) ?? []), t]);
  }
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites name="plgauge">'];
  for (const [suite, ts] of suites) {
    const fail = ts.filter((t) => t.status === 'failed').length;
    const err = ts.filter((t) => t.status === 'error').length;
    const skip = ts.filter((t) => SKIPPED.has(t.status)).length;
    const time = ts.reduce((a, t) => a + t.ms, 0) / 1000;
    out.push(`  <testsuite name="${xml(suite)}" tests="${ts.length}" failures="${fail}" errors="${err}" skipped="${skip}" time="${time.toFixed(3)}">`);
    for (const t of ts) {
      const name = t.path.split('.').pop()!;
      const body = t.status === 'failed' ? '<failure message="failed"/>' : t.status === 'error' ? '<error message="error"/>'
        : SKIPPED.has(t.status) ? `<skipped message="${t.status}"/>` : '';
      out.push(`    <testcase classname="${xml(suite)}" name="${xml(name)}" time="${(t.ms / 1000).toFixed(3)}"${body ? `>${body}</testcase>` : '/>'}`);
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>');
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------- merging

/**
 * Merges runs (e.g. unit and integration tests, or several databases). Objects are
 * matched by owner, type and name and must have the same source (rawSha256); hits add
 * up, test lists are re-indexed into one test list. Quotas are dropped and recomputed
 * by the consumers from the hits.
 */
export function mergeExports(list: CoverageExport[]): CoverageExport {
  if (!list.length) throw new Error('nothing to merge');
  const tests: CoverageExport['tests'] = [];
  const testIdx = new Map<string, number>();
  const remap = (e: CoverageExport) => e.tests.map((t) => {
    let k = testIdx.get(t.path);
    if (k === undefined) {
      k = tests.length;
      testIdx.set(t.path, k);
      tests.push({ ...t });
    } else if (t.status === 'failed' || t.status === 'error') tests[k].status = t.status;
    return k;
  });
  const objs = new Map<string, Obj>();
  const uniq = (a: number[]) => [...new Set(a)].sort((x, y) => x - y);
  type Hit = { hits: number; tests: number[] };
  const add = (prev: Hit[] | undefined, cur: Hit[] | undefined) => prev?.forEach((p, i) => {
    if (cur?.[i]) Object.assign(p, { hits: p.hits + cur[i].hits, tests: uniq([...p.tests, ...cur[i].tests]) });
  });
  for (const e of list) {
    if (e.format !== 'plgauge-coverage/1') throw new Error(`unknown format ${e.format}`);
    const m = remap(e);
    const mi = (ix: number[]) => ix.map((k) => m[k]);
    for (const o of e.objects) {
      const key = `${o.owner}|${o.type}|${o.name}`;
      const prev = objs.get(key);
      const cur: Obj = {
        ...o,
        lines: Object.fromEntries(Object.entries(o.lines).map(([l, v]) => [l, { hits: v.hits, tests: mi(v.tests) }])),
        statements: o.statements?.map((s) => ({ ...s, tests: mi(s.tests) })),
        branches: o.branches.map((b) => ({ ...b, tests: mi(b.tests) })),
        conditions: o.conditions.map((c) => ({ ...c, tests: { T: mi(c.tests.T), F: mi(c.tests.F), N: mi(c.tests.N) } })),
        metrics: undefined,
      };
      if (!prev) {
        objs.set(key, cur);
        continue;
      }
      if (prev.rawSha256 && cur.rawSha256 && prev.rawSha256 !== cur.rawSha256) {
        throw new Error(`${o.type} ${o.owner}.${o.name}: different source in the runs, cannot be merged`);
      }
      for (const [l, v] of Object.entries(cur.lines)) {
        const p = prev.lines[l];
        prev.lines[l] = p ? { hits: p.hits + v.hits, tests: uniq([...p.tests, ...v.tests]) } : v;
      }
      add(prev.statements, cur.statements);
      add(prev.branches, cur.branches);
      prev.conditions.forEach((x, i) => {
        const c = cur.conditions[i];
        if (!c) return;
        x.tests = { T: uniq([...x.tests.T, ...c.tests.T]), F: uniq([...x.tests.F, ...c.tests.F]), N: uniq([...x.tests.N, ...c.tests.N]) };
        for (const k of ['t', 'f', 'n'] as const) x[k] = (x[k] ?? 0) + (c[k] ?? 0);
        if (x.mcdc !== c.mcdc) x.mcdc = x.mcdc === 'yes' || c.mcdc === 'yes' ? 'yes' : x.mcdc;
      });
      prev.instrumented = prev.instrumented && cur.instrumented;
    }
  }
  return { ...list[0], generated: new Date().toISOString(), tests, objects: [...objs.values()] };
}

// ----------------------------------------------------------------- diff mode

/**
 * Coverage of the changed lines only ("new code"): statements, branches and conditions
 * that touch a changed line of their file. Objects without a source file are dropped.
 */
export function restrictToChanged(exp: CoverageExport, map: SourceMap, changed: ChangedLines): CoverageExport {
  const objects: Obj[] = [];
  for (const o of exp.objects) {
    const loc = map.get(keyOf(o.type, o.name));
    if (!loc) continue;
    const off = loc.firstLine - 1;
    const hit = (a: number, b = a) => touches(changed, loc.path, a + off, b + off);
    // a changed line belongs to the innermost statement around it (not to the IF around that)
    const all = o.statements ?? [];
    const mine = new Set<(typeof all)[number]>();
    const set = changed.get(resolve(loc.path));
    for (const fl of set ?? []) {
      const l = fl - off;
      let best: (typeof all)[number] | undefined;
      for (const s of all) if (s.line <= l && l <= s.endLine && (!best || s.line > best.line)) best = s;
      if (best) mine.add(best);
    }
    const statements = all.filter((s) => mine.has(s));
    const branches = o.branches.filter((b) => hit(b.condition?.line ?? b.line, b.condition?.endLine ?? b.line));
    const conditions = o.conditions.filter((c) => hit(c.range.line, c.range.endLine));
    if (!statements.length && !branches.length && !conditions.length) continue;
    const lines = Object.fromEntries(Object.entries(o.lines).filter(([l]) => hit(Number(l))));
    objects.push({ ...o, statements, branches, conditions, lines, metrics: undefined });
  }
  return { ...exp, objects };
}

// ---------------------------------------------------------------- thresholds

export type QuotaKey = 'stmt' | 'branch' | 'cond' | 'mcdc';

/** Quotas over all objects; from the measured metrics, or from the hits after a merge. */
export function quotas(exp: CoverageExport): Record<QuotaKey, { covered: number; total: number }> {
  const q = { stmt: { covered: 0, total: 0 }, branch: { covered: 0, total: 0 }, cond: { covered: 0, total: 0 }, mcdc: { covered: 0, total: 0 } };
  for (const o of exp.objects) {
    if (!o.instrumented) continue;
    if (o.metrics) {
      for (const k of Object.keys(q) as QuotaKey[]) {
        q[k].covered += o.metrics[k].covered;
        q[k].total += o.metrics[k].total;
      }
      continue;
    }
    const stmts = o.statements ?? [];
    q.stmt.total += stmts.length;
    q.stmt.covered += stmts.filter((s) => s.hits > 0).length;
    const brs = o.branches.filter((b) => !b.nf);
    q.branch.total += brs.length;
    q.branch.covered += brs.filter((b) => b.hits > 0).length;
    for (const c of o.conditions.filter((x) => !x.nf)) {
      q.cond.total += 2;
      q.cond.covered += +((c.t ?? c.tests.T.length) > 0) + +((c.f ?? c.tests.F.length) > 0);
      if (c.mcdc && c.mcdc !== 'na') { q.mcdc.total++; q.mcdc.covered += +(c.mcdc === 'yes'); }
    }
  }
  return q;
}

const LABEL: Record<QuotaKey, string> = { stmt: 'Statements', branch: 'Branches', cond: 'Conditions', mcdc: 'MC/DC' };

/** Checks minimum quotas (percent). Returns the violations as text; empty if all hold. */
export function checkQuotas(exp: CoverageExport, min: Partial<Record<QuotaKey, number>>): string[] {
  const q = quotas(exp);
  const out: string[] = [];
  for (const [k, v] of Object.entries(min) as [QuotaKey, number][]) {
    if (v === undefined || Number.isNaN(v)) continue;
    const m = q[k];
    const pct = m.total ? (100 * m.covered) / m.total : 100;
    if (pct + 1e-9 < v) out.push(`${LABEL[k]}: ${pct.toFixed(1)} % < ${v} % (${m.covered}/${m.total})`);
  }
  return out;
}
