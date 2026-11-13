/**
 * The example project against a real database, in both modes: every verdict must
 * match examples/shop_pricing/expected.tsv, written by hand before the first run of
 * plmut. Needs PLMUT_DB (oracle://user:pw@host:port/service); skipped otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMutation } from '@pltest/mutation';

const db = process.env.PLMUT_DB?.split(',')[0];
const dir = fileURLToPath(new URL('../../../examples/shop_pricing', import.meta.url));

function expected(): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(`${dir}/expected.tsv`, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    m.set(`${f[0]}|${f[1]}|${f[2].replaceAll('\\n', '\n')}|${f[3]}`, f[4]);
  }
  return m;
}

for (const mode of ['naive', 'schema'] as const) {
  test(`example verdicts as expected (${mode})`, { skip: !db && 'PLMUT_DB nicht gesetzt', timeout: 600_000 }, async () => {
    const want = expected();
    const rep = await runMutation({ dir, dbUrls: [db!], mode });
    assert.equal(rep.results.length, want.size, 'Zahl der Mutanten');
    const wrong: string[] = [];
    for (const r of rep.results) {
      const key = `${r.sub}|${r.op}|${r.original}|${r.mutated}`;
      const w = want.get(key);
      const got = r.status === 'NOT_COVERED' ? 'SURVIVED' : r.status; // no test reaches it: survives every run
      if (w === undefined) wrong.push(`unerwartet: ${key}`);
      else if (got !== w) wrong.push(`${r.line} ${r.op} ${r.original} → ${r.mutated}: ${r.status}, erwartet ${w} (${r.detail ?? ''})`);
      const side = r.sub === 'storniere' && r.original === "p_modus = 'final'" && r.mutated === 'TRUE';
      if (!!r.sideEffect !== side) wrong.push(`${r.line} ${r.mutated}: Nebenwirkung ${!!r.sideEffect}, erwartet ${side}`);
    }
    assert.deepEqual(wrong, []);
  });
}
