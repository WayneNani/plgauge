/**
 * Mutation points from the core parser: operators and equivalence heuristics (ported from
 * plmut's finder_test.go), and the constructs IslandSQL 0.26 misread, as regression tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expand, findPoints } from '@pltest/mutation';

function points(src: string, name = 'h.pkb') {
  const path = join(mkdtempSync(join(tmpdir(), 'pltest-')), name);
  writeFileSync(path, src);
  return findPoints([path]);
}

const mutants = (src: string, ops?: string[]) =>
  expand(points(src), ops ? new Set(ops) : undefined).map((m) => `${m.op}: ${m.original} → ${m.mutated.trim()}`).sort();

test('finder: operators and equivalence heuristics', () => {
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
  const files = points(src);
  assert.deepEqual(mutants(src), [
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

const body = (stmts: string) => `CREATE OR REPLACE PACKAGE BODY r AS
  PROCEDURE p(a NUMBER, b NUMBER, c NUMBER, x NUMBER, y NUMBER, o t_obj, s VARCHAR2) IS
    CURSOR cur IS SELECT 1 FROM dual;
  BEGIN
    ${stmts}
  END;
END r;
/
`;

test('finder: arithmetic is left-associative (IslandSQL nested a - b + c as a - (b + c))', () => {
  assert.deepEqual(mutants(body('x := a - b + c;'), ['AOR']), [
    'AOR: a - b + c → a - b - c',
    'AOR: a - b → a + b',
  ]);
  assert.deepEqual(mutants(body('x := a / b * c;'), ['AOR']), [
    'AOR: a / b * c → a / b / c',
    'AOR: a / b → a * b',
  ]);
});

test('finder: BETWEEN ... AND and IS OF keep their AND (IslandSQL swallowed the logical AND)', () => {
  assert.deepEqual(mutants(body('IF x BETWEEN 1 AND 5 AND y > 0 THEN NULL; END IF;'), ['LCR']), [
    'LCR: x BETWEEN 1 AND 5 AND y > 0 → (x BETWEEN 1 AND 5) = (y > 0)',
    'LCR: x BETWEEN 1 AND 5 AND y > 0 → FALSE',
    'LCR: x BETWEEN 1 AND 5 AND y > 0 → x BETWEEN 1 AND 5',
    'LCR: x BETWEEN 1 AND 5 AND y > 0 → y > 0',
  ]);
  assert.deepEqual(mutants(body('IF o IS NOT NULL AND o IS OF (t_sub) THEN NULL; END IF;'), ['LCR', 'NUL']), [
    'LCR: o IS NOT NULL AND o IS OF (t_sub) → (o IS NOT NULL) = (o IS OF (t_sub))',
    'LCR: o IS NOT NULL AND o IS OF (t_sub) → FALSE',
    'LCR: o IS NOT NULL AND o IS OF (t_sub) → o IS NOT NULL',
    'LCR: o IS NOT NULL AND o IS OF (t_sub) → o IS OF (t_sub)',
    'NUL: o IS NOT NULL → o IS NULL',
  ]);
});

test('finder: IS NULL binds tighter than AND (IslandSQL read x > 0 AND y IS NULL as (x > 0 AND y) IS NULL)', () => {
  assert.deepEqual(mutants(body('IF x > 0 AND y IS NULL THEN NULL; END IF;'), ['NUL']), ['NUL: y IS NULL → y IS NOT NULL']);
});

test('finder: cursor attributes and || mixed with + (IslandSQL read c%FOUND as modulo)', () => {
  assert.deepEqual(mutants(body('IF cur%FOUND OR SQL%NOTFOUND THEN NULL; END IF;'), ['CUR']), [
    'CUR: SQL%NOTFOUND → SQL%FOUND',
    'CUR: cur%FOUND → cur%NOTFOUND',
  ]);
  // Oracle evaluates 'n' || a + b as ('n' || a) + b: no || mutant in a mixed chain
  assert.deepEqual(mutants(body("s := 'n' || a + b;"), ['AOR']), ["AOR: 'n' || a + b → 'n' || a - b"]);
});

test('finder: SELECT INTO, assert calls and methods of parenthesised objects are statements', () => {
  const got = mutants(body(`SELECT COUNT(*) INTO x FROM dual WHERE a = b;
    assert(a > 0, 'positiv');
    s := (o AS t_obj).name(a + 1);`), ['SBR', 'AOR']);
  assert.deepEqual(got, [
    'AOR: a + 1 → a - 1',
    'SBR: SELECT COUNT(*) INTO x FROM dual WHERE a = b; → NULL;',
    "SBR: assert(a > 0, 'positiv'); → NULL;",
    'SBR: s := (o AS t_obj).name(a + 1); → NULL;',
  ]);
});

test('finder: standalone units and type methods get names and RET; conditional compilation stays', () => {
  const src = `CREATE OR REPLACE PROCEDURE solo(n NUMBER) IS
BEGIN
  $IF dbms_db_version.version < 12 $THEN
    dbms_output.put_line(n - 1);
  $ELSE
    dbms_output.put_line(n + 1);
  $END
END;
/
CREATE OR REPLACE TYPE BODY t_obj AS
  MEMBER FUNCTION name(i NUMBER) RETURN VARCHAR2 IS
    FUNCTION inner RETURN NUMBER IS BEGIN RETURN i * 2; END;
  BEGIN
    RETURN TO_CHAR(inner);
  END;
END;
/
`;
  const files = points(src, 'mixed.sql');
  const pts = files[0].points.map((p) => `${p.op} ${p.sub} ${p.orig}`.trim());
  assert.deepEqual(pts.sort(), ['AOR name.inner i * 2', 'RET name', 'RET name.inner', 'RET solo'].sort());
  assert.deepEqual(files[0].units.map((u) => `${u.type} ${u.name}`), ['PROCEDURE solo', 'TYPE BODY t_obj']);
});

test('finder: SQL operators (stage 2) and their equivalence heuristics', () => {
  const src = `CREATE OR REPLACE PACKAGE BODY s AS
  PROCEDURE p IS
    CURSOR c IS SELECT DISTINCT a FROM t WHERE x NOT IN (SELECT DISTINCT y FROM u ORDER BY y) ORDER BY a DESC NULLS LAST, b;
  BEGIN
    SELECT COUNT(DISTINCT a), MAX(b) OVER (ORDER BY d) INTO n, m FROM t LEFT OUTER JOIN u ON t.id = u.id CROSS JOIN w
     WHERE NOT EXISTS (SELECT 1 FROM v WHERE v.z = t.z(+)) ORDER BY 1;
    UPDATE t SET a = 1, b = NULL WHERE 1 = 1;
    SELECT 1 INTO n FROM t JOIN u x ON x.id = t.id WHERE x.k = 1;
    SELECT 1 INTO n FROM t JOIN u ON u.id = t.id;
    INSERT INTO t (a, b) VALUES (1, SYSDATE);
    FOR r IN (SELECT COUNT(e) FROM t UNION SELECT SUM(f) FROM u INTERSECT SELECT 1 FROM w FETCH FIRST 3 ROWS ONLY) LOOP NULL; END LOOP;
  END;
END s;
/
`;
  const sql = ['SEL', 'JOI', 'ORD', 'UNI', 'AGR', 'SUB', 'WHR', 'COL'];
  assert.deepEqual(mutants(src, sql), [
    'AGR: COUNT(DISTINCT a) → COUNT(a)',
    'AGR: COUNT(e) → COUNT(*)',
    'AGR: MAX(b) OVER (ORDER BY d) → MIN(b) OVER (ORDER BY d)',
    'AGR: SUM(f) → AVG(f)',
    'COL: (a, b) VALUES (1, SYSDATE) → (a) VALUES (1)',
    'COL: (a, b) VALUES (1, SYSDATE) → (b) VALUES (SYSDATE)',
    'COL: a = 1, b = NULL → a = 1',
    'COL: a = 1, b = NULL → b = NULL',
    'JOI: (+) → ',
    'JOI: JOIN → LEFT JOIN',
    'JOI: LEFT OUTER JOIN → JOIN',
    'ORD: a DESC NULLS LAST, b → a ASC NULLS LAST, b DESC',
    'ORD: d → d DESC',
    'SEL: DISTINCT → ',
    'SEL: FETCH FIRST 3 ROWS ONLY → ',
    'SUB: NOT EXISTS (SELECT 1 FROM v WHERE v.z = t.z(+)) → EXISTS (SELECT 1 FROM v WHERE v.z = t.z(+))',
    'SUB: x NOT IN (SELECT DISTINCT y FROM u ORDER BY y) → x IN (SELECT DISTINCT y FROM u ORDER BY y)',
    'UNI: INTERSECT → MINUS',
    'UNI: UNION → UNION ALL',
    'WHR: NOT EXISTS (SELECT 1 FROM v WHERE v.z = t.z(+)) → TRUE',
    'WHR: v.z = t.z(+) → TRUE',
    'WHR: x NOT IN (SELECT DISTINCT y FROM u ORDER BY y) → TRUE',
    'WHR: x.k = 1 → TRUE',
  ]);
  // clause points in PL/SQL statements carry the statement, cursors and loops do not
  const ps = points(src)[0].points.filter((p) => p.kind === 'clause');
  assert.deepEqual([...new Set(ps.map((p) => `${p.op}${p.scope ? '*' : ''}`))].sort(), ['COL*', 'JOI*', 'ORD', 'ORD*', 'SEL', 'UNI']);
});

test('finder: SQL operators leave out what Oracle rejects (bulk bind in FORALL, recursive WITH)', () => {
  const src = `CREATE OR REPLACE PROCEDURE r(ids sys.odcinumberlist) IS
  BEGIN
    FORALL i IN 1 .. ids.count DELETE FROM t WHERE id = ids(i);
    FORALL j IN 1 .. ids.count DELETE FROM t WHERE id = ids(j) AND k > 0;
    FOR x IN (WITH h (n) AS (SELECT 1 FROM dual UNION ALL SELECT n + 1 FROM h WHERE n < 3) SELECT n FROM h) LOOP NULL; END LOOP;
    FOR y IN (WITH g AS (SELECT 1 a FROM dual UNION ALL SELECT 2 FROM dual) SELECT a FROM g) LOOP NULL; END LOOP;
  END;
/
`;
  assert.deepEqual(mutants(src, ['WHR', 'UNI']), ['UNI: UNION ALL → UNION', 'WHR: n < 3 → TRUE']);
});
