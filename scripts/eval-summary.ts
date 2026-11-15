/**
 * Summary of a mutation run for an evaluation (A11): score per operator, survivors
 * grouped by subprogram, and the list of survivors with their source line for the
 * manual classification. Usage: tsx scripts/eval-summary.ts run.json [survivors.tsv]
 */
import { readFileSync, writeFileSync } from 'node:fs';

type R = { id: number; op: string; file: string; line: number; sub: string; category: string; original: string; mutated: string; status: string; ctx: string };
const rep = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rs = rep.results as R[];
const det = new Set(['KILLED', 'TIMEOUT', 'MEMORY']);
const valid = new Set([...det, 'SURVIVED', 'NOT_COVERED']);
const by = new Map<string, R[]>();
for (const r of rs) by.set(r.op, [...(by.get(r.op) ?? []), r]);
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : '–');
console.log('| Operator | Mutants | killed | survived | not covered | Score |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const [op, list] of [...by].sort()) {
  const v = list.filter((r) => valid.has(r.status));
  const d = v.filter((r) => det.has(r.status)).length;
  console.log(`| ${op} | ${list.length} | ${d} | ${v.filter((r) => r.status === 'SURVIVED').length} | ${v.filter((r) => r.status === 'NOT_COVERED').length} | ${pct(d, v.length)} % |`);
}
const v = rs.filter((r) => valid.has(r.status));
const d = v.filter((r) => det.has(r.status)).length;
console.log(`| total | ${rs.length} | ${d} | ${v.filter((r) => r.status === 'SURVIVED').length} | ${v.filter((r) => r.status === 'NOT_COVERED').length} | ${pct(d, v.length)} % |`);
const st = new Map<string, number>();
for (const r of rs) st.set(r.status, (st.get(r.status) ?? 0) + 1);
console.log('\nStatus:', [...st].map(([k, n]) => `${k} ${n}`).join(', '));
console.log(`Runtime ${Math.round(rep.elapsedMs / 1000)} s, Baseline ${Math.round(rep.baselineMs)} ms, ${rep.tests} Tests`);
const surv = rs.filter((r) => r.status === 'SURVIVED');
const subs = new Map<string, number>();
for (const r of surv) subs.set(r.sub, (subs.get(r.sub) ?? 0) + 1);
console.log('\nSurvivors by subprogram (top 15):');
for (const [s, n] of [...subs].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n}  ${s}`);
if (process.argv[3]) {
  const one = (s: string) => s.replace(/\s+/g, ' ').slice(0, 90);
  writeFileSync(process.argv[3], ['id\tline\top\tsub\toriginal\tmutated\tclass\treason', ...surv.map((r) => `${r.id}\t${r.line}\t${r.op}\t${r.sub}\t${one(r.original)}\t${one(r.mutated)}\t\t`)].join('\n') + '\n');
}
