/** Java finder through the adapter: newest operators and equivalence heuristics (ported from finder_test.go). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expand, findPoints, finderDir } from '@pltest/mutation';

test('finder: operators and equivalence heuristics', { skip: !existsSync(join(finderDir(), 'classes')) && 'Finder nicht gebaut' }, () => {
  const src = `CREATE OR REPLACE PACKAGE BODY h AS
  FUNCTION f(s VARCHAR2, k VARCHAR2, n NUMBER) RETURN VARCHAR2 IS
  BEGIN
    IF LENGTH(s) > 0 THEN NULL; END IF;
    IF k = 'A' OR k = 'B' THEN NULL; END IF;
    IF k = 'X' THEN NULL; END IF;
    IF 1 = 1 THEN NULL; END IF;
    RETURN 'N-' || MOD(n, 7);
  END;
END h;
/
`;
  const path = join(mkdtempSync(join(tmpdir(), 'pltest-')), 'h.pkb');
  writeFileSync(path, src);
  const files = findPoints([path]);
  const got = expand(files).map((m) => `${m.op}: ${m.original} → ${m.mutated.trim()}`).sort();
  assert.deepEqual(got, [
    "AOR: 'N-' || MOD(n, 7) → 'N-'",
    'AOR: MOD(n, 7) → (n) * (7)',
    "LCR: k = 'A' OR k = 'B' → TRUE",
    "LCR: k = 'A' OR k = 'B' → k = 'A'",
    "LCR: k = 'A' OR k = 'B' → k = 'B'",
    "RET:  → RAISE_APPLICATION_ERROR(-20998, 'plmut: RET');",
    'RET:  → RETURN NULL;',
    'ROR: LENGTH(s) > 0 → FALSE',
    'ROR: LENGTH(s) > 0 → LENGTH(s) >= 0',
    "ROR: k = 'A' → FALSE",
    "ROR: k = 'A' → TRUE",
    "ROR: k = 'B' → FALSE",
    "ROR: k = 'B' → TRUE",
    "ROR: k = 'X' → FALSE",
    "ROR: k = 'X' → TRUE",
  ].sort());
  assert.ok(files[0].skipped > 0);
});
