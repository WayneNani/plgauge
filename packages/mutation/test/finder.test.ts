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
  // clause points carry their statement (cursor FOR loop: the loop); the ordered cursor gets no block
  const ps = points(src)[0].points.filter((p) => p.kind === 'clause');
  assert.deepEqual([...new Set(ps.map((p) => `${p.op}${p.scope ? '*' : ''}`))].sort(), ['COL*', 'JOI*', 'ORD', 'ORD*', 'SEL', 'SEL*', 'UNI*']);
});

test('finder: a JOIN stays a LEFT JOIN candidate when WHERE lets the NULL rows through', () => {
  const q = (cond: string) => `CREATE OR REPLACE PROCEDURE j IS n NUMBER; BEGIN SELECT 1 INTO n FROM t JOIN u x ON x.id = t.id WHERE ${cond}; END;\n/\n`;
  const joi = (cond: string) => mutants(q(cond), ['JOI']);
  assert.deepEqual(joi('x.k = 1'), []);
  assert.deepEqual(joi('x.k IN (1, 2)'), []);
  assert.deepEqual(joi("x.k IS DISTINCT FROM 'N'"), ['JOI: JOIN → LEFT JOIN']);
  assert.deepEqual(joi('x.flag IS NOT TRUE'), ['JOI: JOIN → LEFT JOIN']);
  assert.deepEqual(joi('x.k IS NULL'), ['JOI: JOIN → LEFT JOIN']);
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

test('finder: views are units; blocks are the query, WITH elements and inline views; select lists switch in place', () => {
  const src = `create or replace force editionable view v (a, b) as
  with w as (select x, y from t where y > 0)
  select x + 1 as a, (select max(z) from u where u.x = w.x) as b
    from w
    left join (select x from s where s.k = 1) s2 on s2.x = w.x
   where exists (select 1 from r where r.x = w.x)
  with read only;
create table t2 (a number);
create or replace view v2 as select a from t2 where a < 3
/
`;
  const f = points(src, 'v.sql')[0];
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.units.map((u) => `${u.type} ${u.name}`), ['VIEW v', 'VIEW v2']);
  const text = f.src.toString();
  assert.ok(text.slice(f.units[0].start, f.units[0].end).endsWith('with read only'), 'the unit ends before the semicolon');
  const block = (p: (typeof f.points)[number]) => text.slice(p.scope![0], p.scope![1]).split('\n')[0];
  const got = expand([f]).map((m) => `${m.op} ${m.original} → ${m.mutated}${m.point.inline ? ' [inline]' : ''} @ ${block(m.point)}`);
  const has = (s: string) => assert.ok(got.includes(s), `${s}\n${got.join('\n')}`);
  has('ROR y > 0 → y >= 0 @ select x, y from t where y > 0');
  has('AOR x + 1 → x - 1 [inline] @ select x + 1 as a, (select max(z) from u where u.x = w.x) as b');
  // a scalar subquery in the select list is part of its block; its condition is not in a select list
  has('AGR max(z) → MIN(z) [inline] @ select x + 1 as a, (select max(z) from u where u.x = w.x) as b');
  has('ROR u.x = w.x → FALSE @ select x + 1 as a, (select max(z) from u where u.x = w.x) as b');
  has('ROR s.k = 1 → FALSE @ select x from s where s.k = 1');
  has('JOI left join → JOIN @ select x + 1 as a, (select max(z) from u where u.x = w.x) as b');
  has('SUB exists (select 1 from r where r.x = w.x) → NOT exists (select 1 from r where r.x = w.x) @ select x + 1 as a, (select max(z) from u where u.x = w.x) as b');
  has('ROR a < 3 → a <= 3 @ select a from t2 where a < 3');
});

test('finder: a recursive WITH element of a view is no block; its points are not switched', () => {
  const src = `create view r as
  with h (n) as (select 1 from dual union all select n + 1 from h where n < 3)
  select n from h where n > 1;
`;
  const ms = expand(points(src, 'r.sql'));
  const scoped = (o: string) => ms.filter((m) => m.original === o).every((m) => !!m.point.scope);
  assert.ok(!scoped('n < 3') && !scoped('n + 1'), 'recursive element: oracle rewriter');
  assert.ok(scoped('n > 1'), 'main query: switched');
});

test('finder: views get INLINE hints for WITH elements referenced once (copies must not materialize them)', () => {
  const src = `create view h as
  with a as (select 1 x from dual),
       m as (select /*+ materialize */ 2 x from dual),
       r (n) as (select 1 from dual union all select n + 1 from r where n < 3) cycle n set c to 'Y' default 'N',
       d as (select /*+ ordered */ x from a),
       e as (select x from dual)
  select d.x from d, m, r, e, e e2;
`;
  const f = points(src, 'h.sql')[0];
  const t = f.src.toString();
  const got = (f.units[0].inserts ?? []).map((i) => `${t.slice(i.block, i.at)}|${i.text}`);
  assert.deepEqual(got, ['select| /*+ INLINE */', 'select /*+| INLINE']);
});

test('finder: a view with WITH FUNCTION is reported, not cut at the semicolon of the function; the next unit stays', () => {
  const src = `create or replace view wf as
  with function f return number is begin return 1; end;
  select f() x from dual
/
create or replace view ok as select a from t where a < 3;
`;
  const f = points(src, 'wf.sql')[0];
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /WITH FUNCTION/);
  assert.deepEqual(f.units.map((u) => u.name), ['ok']);
});

test('finder: ordered queries of a view get no wrapper (their order must hold)', () => {
  const src = `create view top3 as
  select a from (select a, b from t where b > 0 order by b desc) where rownum <= 3 and a > 1 order by a;
`;
  const f = points(src, 'top3.sql')[0];
  assert.equal(f.units[0].ordered, true);
  const t = f.src.toString();
  const scopes = [...new Set(f.points.map((p) => p.scope && t.slice(p.scope[0], p.scope[1])))];
  // b > 0 belongs to the main block (the ordered inline view is none), which buildSchema leaves unwrapped
  assert.deepEqual(scopes, ['select a from (select a, b from t where b > 0 order by b desc) where rownum <= 3 and a > 1 order by a']);
});

test('finder: unordered cursor declarations are UNION ALL blocks; cursor FOR loops over a query are duplicated whole', () => {
  const src = `CREATE OR REPLACE PACKAGE BODY k AS
  PROCEDURE p(n NUMBER) IS
    CURSOR c1(x NUMBER := n + 1) IS SELECT a + 1 AS b FROM t WHERE a > x;
    CURSOR c2 IS SELECT a FROM t WHERE a > 2 ORDER BY a;
    CURSOR c3 IS SELECT a FROM t WHERE a > 3 FOR UPDATE;
    CURSOR c4 IS WITH w AS (SELECT a FROM t) SELECT a FROM w WHERE a > 4;
  BEGIN
    <<l>> FOR r IN (SELECT a FROM t WHERE a > 5) LOOP
      UPDATE t SET a = 0 WHERE a = r.a;
    END LOOP l;
  END;
END k;
/
`;
  const f = points(src)[0];
  const text = f.src.toString();
  const pt = (orig: string) => f.points.find((p) => p.orig === orig && p.op === 'ROR')!;
  const span = (r?: [number, number]) => (r ? text.slice(r[0], r[1]) : '-');
  assert.equal(span(pt('a > x').scope), 'SELECT a + 1 AS b FROM t WHERE a > x');
  assert.ok(pt('a > x').union);
  const aor = f.points.filter((p) => p.op === 'AOR');
  // the select list switches in place; the parameter default is PL/SQL outside the block
  assert.deepEqual(aor.map((p) => `${p.orig} ${p.ctx} ${p.inline ? 'inline' : ''} ${span(p.scope)}`), [
    'n + 1 plsql  -',
    'a + 1 sql inline SELECT a + 1 AS b FROM t WHERE a > x',
  ]);
  for (const o of ['a > 2', 'a > 3', 'a > 4']) assert.equal(pt(o).scope, undefined, o);
  const loop = pt('a > 5');
  assert.match(span(loop.scope), /^(<<l>> )?FOR r IN \(SELECT a FROM t WHERE a > 5\) LOOP[\s\S]*END LOOP l;$/);
  assert.ok(!loop.union);
  // statements in the body have their own scope
  assert.equal(span(pt('a = r.a').scope), 'UPDATE t SET a = 0 WHERE a = r.a;');
});

test('finder: dynamic SQL in literals that reach EXECUTE IMMEDIATE, OPEN FOR or DBMS_SQL.PARSE is mutated', () => {
  const src = `CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p IS
    l_sql CLOB := q'[
      delete from t where a > 1]';
    l_log VARCHAR2(100) := 'select x from y where z > 1';
    c SYS_REFCURSOR;
    h INTEGER;
  BEGIN
    EXECUTE IMMEDIATE l_sql;
    EXECUTE IMMEDIATE 'update t set b = ''x'' where c = ''it''''s'' and d < 2';
    OPEN c FOR 'select a from t where e >= 3';
    DBMS_SQL.PARSE(h, 'insert into t (a, b) select a, b from u where f = 4', DBMS_SQL.NATIVE);
    EXECUTE IMMEDIATE 'select a from t where g = ' || 5;
    DBMS_OUTPUT.PUT_LINE(l_log);
  END;
END d;
/
`;
  const f = points(src)[0];
  assert.deepEqual(f.errors, []);
  const text = f.src.toString();
  const dyn = expand([f]).filter((m) => m.point.dyn);
  const got = dyn.map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  const has = (s: string) => assert.ok(got.includes(s), `${s}\n${got.join('\n')}`);
  has('ROR a > 1 → a >= 1');
  has('WHR a > 1 → TRUE');
  // quotes stay doubled, in the original and in the mutant
  has("ROR c = ''it''''s'' → FALSE");
  has("LCR c = ''it''''s'' and d < 2 → c = ''it''''s''");
  has('ROR d < 2 → d <= 2');
  has('ROR e >= 3 → e > 3');
  has('WHR f = 4 → TRUE');
  has('ROR f = 4 → FALSE');
  // a literal for something else, or one concatenated with more, is not dynamic SQL
  assert.ok(!got.some((g) => g.includes('z > 1') || g.includes('g =')), got.join('\n'));
  for (const m of dyn) {
    // the mutant replaces the change inside its literal
    const [a, b] = m.point.dyn!;
    assert.ok(a < m.point.start && m.point.end < b);
    assert.equal(text.slice(m.point.start, m.point.end), m.original);
  }
});

test('finder: dynamic SQL through a variable only when it holds nothing but whole literals', () => {
  const src = `CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p(x BOOLEAN) IS
    l_a VARCHAR2(4000);
    l_b VARCHAR2(4000) := 'select a from t where b > 1';
    l_c VARCHAR2(4000) := 'select a from t where c > 1';
    l_d VARCHAR2(27) := 'select a from t where d > 1';
    l_e VARCHAR2(4000);
    l_f VARCHAR2(4000) := 'select a from t where f > 1';
    l_g VARCHAR2(4000);
    c SYS_REFCURSOR;
  BEGIN
    IF x THEN l_a := 'delete from t where a > 1'; ELSE l_a := 'delete from t where a < 9'; END IF;
    EXECUTE IMMEDIATE l_a;
    IF x THEN l_b := l_b || ' and e = 2'; END IF;
    EXECUTE IMMEDIATE l_b;
    log(l_c);
    EXECUTE IMMEDIATE l_c;
    EXECUTE IMMEDIATE l_d;
    l_e := 'delete from t where e > 1';
    EXECUTE IMMEDIATE (l_e);
    l_e := lower('drop table t');
    EXECUTE IMMEDIATE l_e;
    EXECUTE IMMEDIATE l_f;
    l_g := l_f || ' and h = 1';
    OPEN c FOR l_g;
  END;
END d;
/
`;
  const f = points(src)[0];
  assert.deepEqual(f.errors, []);
  const got = expand([f]).filter((m) => m.point.dyn).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  const has = (s: string) => assert.ok(got.includes(s), `${s}\n${got.join('\n')}`);
  // both assignments of l_a
  has('ROR a > 1 → a >= 1');
  has('ROR a < 9 → a <= 9');
  // l_e gets another statement later (a value of its own, not built from l_e); the sink may be in parentheses
  has('ROR e > 1 → e >= 1');
  // l_b is concatenated to, l_c passed to a procedure (perhaps OUT), l_f part of another statement: fragments
  assert.ok(!got.some((g) => g.includes('b > 1') || g.includes('c > 1') || g.includes('f > 1')), got.join('\n'));
  // l_d is exactly as long as its literal: a variant one character longer would fail with ORA-06502
  has('ROR d > 1 → FALSE');
  assert.ok(!got.includes('ROR d > 1 → d >= 1') && !got.includes('ROR d > 1 → d <> 1'), got.join('\n'));
});
