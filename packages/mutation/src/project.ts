/**
 * A project: the directory with pltest.json (or plmut.json from before the merge), its
 * install scripts, the files whose units are mutated and the utPLSQL tests. Coverage of a
 * project measures exactly these units with exactly these tests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, runScript, splitScript } from '@pltest/core';
import type { RunConfig } from '@pltest/coverage';
import { findPoints } from './find.js';
import { objectName } from './mutant.js';
import { loadConfig, mutateFiles } from './run.js';
import { parseDbUrl } from './session.js';

export async function projectCoverageConfig(dir: string, db: string, install: boolean, log: (m: string) => void = () => {}): Promise<RunConfig> {
  const c = parseDbUrl(db);
  const p = loadConfig(dir);
  const names = new Set<string>();
  for (const f of findPoints(mutateFiles(p, dir))) for (const u of f.units) names.add(objectName(u.name));
  if (install && p.install.length) {
    const conn = await connect(c);
    try {
      for (const s of p.install) {
        const path = join(dir, s);
        await runScript(conn, splitScript(readFileSync(path, 'utf8')), path);
      }
    } finally {
      await conn.close();
    }
    log(`${p.install.length} Skripte installiert`);
  }
  const esc = (n: string) => n.replace(/[$#]/g, '\\$&');
  return {
    ...c,
    schema: c.user.toUpperCase(),
    tests: p.tests.length ? p.tests : [c.user.toLowerCase()],
    include: names.size ? `^(${[...names].map(esc).join('|')})$` : undefined,
    sqlProbes: 'auto',
  };
}
