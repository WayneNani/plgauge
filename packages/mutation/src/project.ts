/**
 * A project: the directory with pltest.json (or plmut.json from before the merge), its
 * install scripts, the files whose units are mutated and the utPLSQL tests. Coverage of a
 * project measures exactly these units with exactly these tests.
 */
import { join } from 'node:path';
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
  // runCoverage installs them, under the run lock and after restoring what a crashed run left
  const installScripts = install ? p.install.map((s) => join(dir, s)) : [];
  if (installScripts.length) log(`${installScripts.length} Installationsskripte`);
  const esc = (n: string) => n.replace(/[$#]/g, '\\$&');
  return {
    ...c,
    schema: c.user.toUpperCase(),
    tests: p.tests.length ? p.tests : [c.user.toLowerCase()],
    include: names.size ? `^(${[...names].map(esc).join('|')})$` : undefined,
    sqlProbes: 'auto',
    installScripts,
  };
}
