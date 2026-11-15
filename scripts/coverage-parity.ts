/**
 * Checks the instrumenter against the frozen results of plcov's token instrumenter on
 * every body of the corpus: SHA-256 of instrumented text and probe map, per unit
 * (baseline/plcov/corpus-instrumented.tsv). Usage: npm run parity:coverage
 * With --write (and scripts/legacy/instrument-legacy.ts from git history) it rebuilds the file
 * from the legacy instrumenter; with --accept it records the current instrumenter's results
 * after an intended change (listed in baseline/plmut/PARITY.md).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractUnits } from '../packages/coverage/src/corpus.ts';
import { instrument } from '../packages/coverage/src/instrument.ts';
import { newIds } from '../packages/coverage/src/model.ts';
import { preprocess } from '../packages/core/src/index.ts';

const BASE = 'baseline/plcov/corpus-instrumented.tsv';
const write = process.argv.includes('--write');
const accept = process.argv.includes('--accept');
const legacyPath = './legacy/instrument-legacy.ts'; // from git history (before phase 3)
const legacy: typeof instrument | null = write ? (await import(legacyPath)).instrument : null;
const want = new Map<string, string>(
  write ? [] : readFileSync(BASE, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string]),
);
const out: string[] = [];
// statement columns came after the freeze (phase 5): left out of the comparison
type MapLike = { statements: Record<string, unknown>[] };
const hash = (r: { instrumented: string; map: unknown }) => {
  const m = r.map as MapLike;
  const map = { ...m, statements: m.statements.map(({ col: _c, endCol: _e, ...st }) => st) };
  return createHash('sha256').update(r.instrumented).update('\0').update(JSON.stringify(map)).digest('hex');
};
// the corpus of the freeze; later additions (A5) are checked with plgauge corpus
const dirs = ['alexandria', 'console', 'logger', 'pljson', 'utplsql-3.1.14'].map((d) => join('corpus/.cache', d));
const EXT = /\.(sql|pks|pkb|pkg|tps|tpb|typ|prc|fnc|trg|bdy|spc|plb|pls)$/i;
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d)) {
    if (e === '.git') continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(e)) out.push(p);
  }
  return out;
};
let same = 0, diff = 0, newFail = 0, oldFail = 0;

const shown: string[] = [];
for (const dir of dirs) {
  for (const f of walk(dir)) {
    for (const u of extractUnits(f, '.')) {
      if (['package', 'type'].includes(u.kind)) continue;
      const src = preprocess(u.text);
      const id = `${u.file}:${u.line} ${u.kind} ${u.name}`;
      if (write) {
        try { out.push(`${id}\t${hash(legacy!(src, 'C', newIds(), { sqlProbes: true }))}`); } catch (e) { out.push(`${id}\tFEHLER ${(e as Error).message}`); }
        continue;
      }
      let got: string;
      try { got = hash(instrument(src, 'C', newIds(), { sqlProbes: true })); } catch (e) { got = `FEHLER ${(e as Error).message}`; }
      out.push(`${id}\t${got}`);
      const exp = want.get(id);
      if (exp === undefined) { shown.push(`neu im Korpus: ${id}`); continue; }
      if (exp === got) same++;
      else if (exp.startsWith('FEHLER')) { oldFail++; shown.push(`nur neu ok: ${id}`); }
      else if (got.startsWith('FEHLER')) { newFail++; shown.push(`nur alt ok: ${id}: ${got}`); }
      else { diff++; shown.push(`verschieden: ${id}`); }
    }
  }
}
if (write || accept) {
  writeFileSync(BASE, out.join('\n') + '\n');
  console.log(`${out.length} Einheiten nach ${BASE} geschrieben`);
  process.exit(0);
}
console.log(JSON.stringify({ same, diff, oldFail, newFail }));
for (const s of shown.slice(0, Number(process.env.SHOW ?? 15))) console.log(s);
