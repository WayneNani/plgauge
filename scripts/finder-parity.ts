/**
 * Compares the TypeScript finder with the frozen output of plmut's Java finder (IslandSQL)
 * on the corpus (corpus/fetch.sh). Differences are grouped; known improvements are
 * counted apart (names of type methods, RET in standalone units, SELECT INTO as SBR).
 * Usage: npm run parity:finder -- [reference.json[.gz]] [path filter] [samples]
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { findPoints, STAGE1_OPERATORS } from '../packages/mutation/src/find.ts';

const ref = process.argv[2] || 'baseline/plmut/finder-corpus.json.gz';
const filter = process.argv[3] ?? '';
const raw = readFileSync(ref);
const samples = Number(process.argv[4] ?? 3);
const root = 'corpus/.cache';
type P = { unit: number; op: string; kind: string; sub: string; ctx: string; cat: string; start: number; end: number; orig: string; mutants: string[] };
type F = { path: string; errors: string[]; units: { type: string; name: string; start: number; end: number; decl: number }[]; points: P[]; loops: { unit: number; at: number }[]; skipped: number };
const java = (JSON.parse((ref.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')).files as F[]).filter((f) => f.path.includes(filter));
const t0 = Date.now();
// the Java finder knows only stage 1
const stage1 = new Set(STAGE1_OPERATORS);
// the Java finder knows neither stage 2 nor views nor dynamic SQL: leave them out, renumber the units
const ts = findPoints(java.map((f) => join(root, f.path))).map((f) => {
  const idx = new Map<number, number>();
  const units = f.units.filter((u, i) => u.type !== 'VIEW' && idx.set(i, idx.size));
  return {
    ...f, units,
    points: f.points.filter((p) => stage1.has(p.op) && !p.dyn && idx.has(p.unit)).map((p) => ({ ...p, unit: idx.get(p.unit)! })),
    loops: f.loops.filter((l) => idx.has(l.unit)).map((l) => ({ ...l, unit: idx.get(l.unit)! })),
  };
});
const ms = Date.now() - t0;
/** Java left methods of type bodies and standalone subprograms unnamed, and restarted names below them. */
const subImproved = (j: string, t: string) => j === '' || t.endsWith('.' + j);
// the frozen output still carries the old tool name in the RET message
const key = (p: P) => `${p.start}|${p.end}|${p.op}|${p.mutants.join('§').replaceAll("'plmut: RET'", "'plgauge: RET'")}`;
const stats = { same: 0, subNamed: 0, attr: 0, javaOnly: 0, tsOnly: 0, unitsDiff: 0, loopsDiff: 0, errJ: 0, errT: 0, skippedJ: 0, skippedT: 0 };
const byCat = new Map<string, { n: number; ex: string[] }>();
const note = (cat: string, ex: string) => {
  const e = byCat.get(cat) ?? { n: 0, ex: [] };
  e.n++;
  if (e.ex.length < samples) e.ex.push(ex);
  byCat.set(cat, e);
};
const short = (s: string) => JSON.stringify(s.length > 140 ? s.slice(0, 140) + '…' : s);
for (let i = 0; i < java.length; i++) {
  const j = java[i];
  const t = ts[i];
  stats.skippedJ += j.skipped ?? 0;
  stats.skippedT += t.skipped;
  if (j.errors.length) stats.errJ++;
  if (t.errors.length) {
    stats.errT++;
    note('TS-Fehler', `${j.path}: ${t.errors[0]}`);
  }
  const uj = j.units.map((u) => `${u.type}|${u.name}|${u.start}|${u.end}|${u.decl}`).join('\n');
  const ut = t.units.map((u) => `${u.type}|${u.name}|${u.start}|${u.end}|${u.decl}`).join('\n');
  if (uj !== ut && !j.errors.length) {
    stats.unitsDiff++;
    note('Units', `${j.path}\n    J ${uj.replace(/\n/g, ' / ')}\n    T ${ut.replace(/\n/g, ' / ')}`);
  }
  const lj = new Set(j.loops.map((l) => l.at));
  const lt = new Set(t.loops.map((l) => l.at));
  if ([...lj].some((x) => !lt.has(x)) || [...lt].some((x) => !lj.has(x))) stats.loopsDiff++;
  if (j.errors.length) continue; // Java found nothing: everything TS finds is new
  const mj = new Map(j.points.map((p) => [key(p), p]));
  const mt = new Map(t.points.map((p) => [key(p), p]));
  const src = readFileSync(join(root, j.path));
  const line = (b: number) => src.subarray(0, b).toString('utf8').split('\n').length;
  for (const [k, p] of mj) {
    const q = mt.get(k);
    if (!q) {
      stats.javaOnly++;
      const u = j.units[p.unit];
      const outside = p.start < u.start || p.start >= u.end;
      note(outside ? 'nur Java, außerhalb der Unit (Skript)' : `nur Java ${p.op}`, `${j.path}:${line(p.start)} ${short(p.orig)} → ${short(p.mutants.join(' | '))}`);
    } else if (p.ctx !== q.ctx || p.cat !== q.cat || p.kind !== q.kind || (p.sub !== q.sub && !subImproved(p.sub, q.sub))) {
      stats.attr++;
      note(`Attribute ${p.op}`, `${j.path}:${line(p.start)} ${short(p.orig)} J ${p.sub}/${p.ctx}/${p.cat} T ${q.sub}/${q.ctx}/${q.cat}`);
    } else if (p.sub !== q.sub) {
      stats.subNamed++;
    } else stats.same++;
  }
  for (const [k, p] of mt) {
    if (!mj.has(k)) {
      stats.tsOnly++;
      const typeMethod = p.op === 'RET' && (t.units[p.unit].type === 'TYPE BODY' || ['PROCEDURE', 'FUNCTION'].includes(t.units[p.unit].type));
      const selectInto = p.op === 'SBR' && /^select\b/i.test(p.orig);
      note(typeMethod ? 'nur TS RET (Methode/eigenständig)' : selectInto ? 'nur TS SBR (SELECT INTO)' : `nur TS ${p.op}`, `${j.path}:${line(p.start)} ${short(p.orig)} → ${short(p.mutants.join(' | '))}`);
    }
  }
}
console.log(JSON.stringify(stats), `${ms} ms`);
for (const [cat, e] of [...byCat].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`\n${cat}: ${e.n}`);
  for (const x of e.ex) console.log('  ' + x);
}
