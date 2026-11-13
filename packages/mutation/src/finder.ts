/**
 * Adapter to the Java finder (IslandSQL) carried over from plmut. It parses the source
 * files and prints units, mutation points and loop positions as JSON. The adapter
 * goes away in plan phase 4, when the core parser finds the points itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceFile } from './mutant.js';

/** packages/mutation/finder-java, or PLTEST_FINDER. */
export function finderDir(): string {
  if (process.env.PLTEST_FINDER) return process.env.PLTEST_FINDER;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'finder-java');
}

export function findPoints(paths: string[], dir = finderDir()): SourceFile[] {
  if (!existsSync(join(dir, 'classes'))) {
    throw new Error(`Finder nicht gebaut: ${join(dir, 'build.sh')} ausführen`);
  }
  const cp = [join(dir, 'lib', '*'), join(dir, 'classes')].join(delimiter);
  const out = execFileSync('java', ['-Xlog:disable', '-Xss64m', '-cp', cp, 'plmut.finder.Finder', ...paths], {
    maxBuffer: 1 << 30,
    encoding: 'utf8',
  });
  const res = JSON.parse(out) as { files: Omit<SourceFile, 'src'>[] };
  return res.files.map((f) => ({ ...f, skipped: f.skipped ?? 0, loops: f.loops ?? [], src: readFileSync(f.path) }));
}
