/**
 * Changed lines against a git revision, for the diff mode: mutation testing and coverage
 * thresholds on the code of a merge request only.
 *
 * Compares the merge base of the revision and HEAD with the working tree, so local edits
 * count as well, and in CI (clean checkout) it is exactly the merge request's change.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Absolute path → changed (added or modified) line numbers of the new version. */
export type ChangedLines = Map<string, Set<number>>;

export function changedLines(ref: string, cwd = process.cwd()): ChangedLines {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const root = git('rev-parse', '--show-toplevel').trim();
  let base: string;
  try {
    base = git('merge-base', ref, 'HEAD').trim();
  } catch {
    throw new Error(`git: keine gemeinsame Basis mit ${ref} (fetch-depth 0 im CI-Checkout?)`);
  }
  return parseUnifiedDiff(git('diff', '--unified=0', '--no-color', '--no-ext-diff', base), root);
}

/** Reads `git diff --unified=0` output: the "+" side of every hunk. */
export function parseUnifiedDiff(text: string, root: string): ChangedLines {
  const out: ChangedLines = new Map();
  let cur: Set<number> | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') {
        cur = null;
        continue;
      }
      const file = resolve(root, p.replace(/^b\//, ''));
      cur = out.get(file) ?? new Set();
      out.set(file, cur);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && cur) {
      const start = Number(m[1]);
      const n = m[2] === undefined ? 1 : Number(m[2]);
      for (let k = 0; k < n; k++) cur.add(start + k);
    }
  }
  return out;
}

/** Whether any line in [from, to] changed in the file. */
export function touches(changed: ChangedLines, file: string, from: number, to = from): boolean {
  const s = changed.get(resolve(file));
  if (!s) return false;
  for (let l = from; l <= to; l++) if (s.has(l)) return true;
  return false;
}
