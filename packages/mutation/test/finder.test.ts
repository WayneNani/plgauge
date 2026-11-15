/**
 * Mutation points from the core parser: operators and equivalence heuristics (ported from
 * plmut's finder_test.go), and the constructs IslandSQL 0.26 misread, as regression tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expand, findPoints, mutatedUnit, switchable, withoutCreate } from '@pltest/mutation';

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
    CURSOR c5 IS SELECT a FROM t WHERE a > 7 CONNECT BY PRIOR a = b;
    CURSOR c6 IS SELECT a FROM t WHERE a IN (SELECT b + 1 FROM u);
  BEGIN
    FOR r IN (SELECT a FROM t WHERE a > 5) LOOP
      UPDATE t SET a = 0 WHERE a = r.a;
    END LOOP;
    <<l>> FOR r IN (SELECT a FROM t WHERE a > 6) LOOP
      EXIT l WHEN r.a = 9;
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
    // the select list of an IN subquery feeds a semi-join: a branch, not a switch in place
    'b + 1 sql  SELECT a FROM t WHERE a IN (SELECT b + 1 FROM u)',
  ]);
  for (const o of ['a > 2', 'a > 3', 'a > 4', 'a > 7']) assert.equal(pt(o).scope, undefined, o);
  const loop = pt('a > 5');
  assert.match(span(loop.scope), /^FOR r IN \(SELECT a FROM t WHERE a > 5\) LOOP[\s\S]*END LOOP;$/);
  assert.ok(!loop.union);
  // a labelled loop is not duplicated: neither copies without the label (PLS-00373) nor with it (PLS-00371) compile
  assert.equal(pt('a > 6').scope, undefined);
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

test('finder: dynamic SQL variables are resolved by scope and by every mention (review cases)', () => {
  const src = `CREATE OR REPLACE PACKAGE BODY d AS
  g_sql VARCHAR2(200);
  PROCEDURE add_filter IS BEGIN g_sql := g_sql || ' where b = 1'; END;
  PROCEDURE p(x BOOLEAN) IS
    l_a VARCHAR2(200) := 'select a from t where a > 1';
    l_c VARCHAR2(200) := 'select a from t where c > 1';
    l2 VARCHAR2(400);
    "L_Q" VARCHAR2(200) := 'select a from t where q > 1';
    l_d VARCHAR2(200) := 'insert into t (a, b) values (:1, :2)';
    l_l VARCHAR2(200) := 'select a from t where l > 1';
    c SYS_REFCURSOR;
    h INTEGER;
  BEGIN
    IF x THEN OPEN c FOR l_a || ' and c = 2'; ELSE OPEN c FOR l_a; END IF;
    l2 := CASE WHEN x THEN l_c || ' and c = 3' ELSE 'select 1 from dual' END;
    OPEN c FOR l_c;
    "L_Q" := "L_Q" || ' and c = 4';
    OPEN c FOR "L_Q";
    DECLARE
      g_sql VARCHAR2(200) := 'delete from log where id > 7';
    BEGIN NULL; END;
    g_sql := 'select a from t where d > 0';
    add_filter;
    OPEN c FOR g_sql;
    DBMS_SQL.PARSE(h, l_d, DBMS_SQL.NATIVE);
    DBMS_OUTPUT.PUT_LINE('sql: ' || l_l);
    logger.log(l_l);
    OPEN c FOR l_l;
  END;
END d;
/
`;
  const f = points(src)[0];
  assert.deepEqual(f.errors, []);
  const got = expand([f]).filter((m) => m.point.dyn).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  // a fragment in a sink, in a CASE branch, a quoted name built from itself, package and block variables: none
  for (const s of ['a > 1', 'c > 1', 'q > 1', 'id > 7', 'd > 0']) assert.ok(!got.some((g) => g.includes(s)), `${s}\n${got.join('\n')}`);
  // logging calls do not change the statement
  assert.ok(got.includes('ROR l > 1 → l >= 1'), got.join('\n'));
  // no variant loses a bind placeholder (USING / BIND_VARIABLE would fail with ORA-01006)
  for (const m of expand([f]).filter((x) => x.point.dyn && x.mutated.includes('values'))) {
    assert.ok(m.mutated.includes(':1') && m.mutated.includes(':2'), m.mutated);
  }
  assert.ok(!got.some((g) => g.startsWith('COL')), got.join('\n'));
});

test('finder: dynamic SQL variables: qualified mentions, $IF branches, logging calls, declared lengths (review round 2)', () => {
  const src = `CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p IS
    v VARCHAR2(100) := 'select a from t where v > 1';
    w VARCHAR2(100) := 'delete from t where w > 1';
    x VARCHAR2(100) := 'delete from t where x > 1';
    y VARCHAR2(100) := 'delete from t where y > 1';
    z STRING(25) := 'DELETE FROM t WHERE z > 1';
    c SYS_REFCURSOR;
  BEGIN
    p.v := p.v || ' and b = 2';
    OPEN c FOR v;
    $IF $$debug $THEN w := w || ' and b = 2'; $ELSE NULL; $END
    EXECUTE IMMEDIATE w;
    log_and_fix(x);
    EXECUTE IMMEDIATE x;
    log_it('sql: ' || y);
    DBMS_OUTPUT.PUT_LINE(y);
    EXECUTE IMMEDIATE y;
    EXECUTE IMMEDIATE z;
  END;
END d;
/
`;
  const f = points(src)[0];
  assert.deepEqual(f.errors, []);
  const got = expand([f]).filter((m) => m.point.dyn).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  // p.v is v; a $IF branch may change w; log_and_fix(x) may take it IN OUT
  for (const s of ['v > 1', 'w > 1', 'x > 1']) assert.ok(!got.some((g) => g.includes(s)), `${s}\n${got.join('\n')}`);
  // concatenated into a logging call, or DBMS_OUTPUT: only read
  assert.ok(got.includes('ROR y > 1 → y >= 1'), got.join('\n'));
  // STRING(25) holds the literal exactly: one character more would raise ORA-06502
  assert.ok(!got.includes('ROR z > 1 → z >= 1') && got.includes('ROR z > 1 → FALSE'), got.join('\n'));
});

test('finder: dynamic SQL, review round 3: odd quoted names, quoted $IF mentions, nested calls in logging, numbered binds', () => {
  const src = `CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p IS
    "A(B" VARCHAR2(100) := 'delete from t where a > 3';
    v VARCHAR2(100) := 'delete from t where v > 1';
    w VARCHAR2(100) := 'delete from t where w > 1';
  BEGIN
    EXECUTE IMMEDIATE "A(B";
    $IF $$extra $THEN "V" := "V" || ' and b = 2'; $ELSE NULL; $END
    EXECUTE IMMEDIATE v;
    DBMS_OUTPUT.PUT_LINE(add_filter(w));
    EXECUTE IMMEDIATE w;
    EXECUTE IMMEDIATE 'delete from t where n = :1 and m > 2' USING 1;
  END;
END d;
/
`;
  const f = points(src)[0];
  assert.deepEqual(f.errors, []);
  const got = expand([f]).filter((m) => m.point.dyn).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  const has = (s: string) => assert.ok(got.includes(s), `${s}\n${got.join('\n')}`);
  has('ROR a > 3 → a >= 3');
  // "V" in a dropped $IF branch is v; add_filter(w) may take w IN OUT
  for (const s of ['v > 1', 'w > 1']) assert.ok(!got.some((g) => g.includes(s)), `${s}\n${got.join('\n')}`);
  // :1 is a bind, not a stop: the rest of the statement is mutated, the bind stays
  has('ROR m > 2 → m >= 2');
  assert.ok(!got.some((g) => g.includes(':1') && !g.split('→')[1].includes(':1')), got.join('\n'));
});

test('finder: a subquery predicate inside a select-list expression is no projection', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY k AS
  PROCEDURE p IS
    CURSOR c1 IS SELECT CASE WHEN a IN (SELECT b + 1 FROM u) THEN 1 END x, a + 2 y FROM t;
  BEGIN NULL; END;
END k;
/
`)[0];
  const aor = f.points.filter((p) => p.op === 'AOR').map((p) => `${p.orig} ${p.inline ? 'inline' : 'branch'}`);
  assert.deepEqual(aor.sort(), ['a + 2 inline', 'b + 1 branch']);
});

test('finder: dynamic SQL and cursor rules, branches named by review round 4', () => {
  const src = `CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p IS
    a1 VARCHAR2(100) := 'delete from t where a1 > 1';
    a2 VARCHAR2(100) := 'delete from t where a2 > 1';
    a3 VARCHAR2(100) := 'delete from t where a3 > 1';
    a4 VARCHAR2(25 CHAR) := 'delete from t where ä > 1';
    a5 VARCHAR2(100) := 'delete from t where a5 > 1';
    a6 VARCHAR2(100) := 'delete from t where a6 > 1';
    a7 VARCHAR2(100) := 'delete from t where a7 > :b and c = 1';
    mäx VARCHAR2(100) := 'delete from t where m > 1';
    h INTEGER;
  BEGIN
    DBMS_OUTPUT.PUT_LINE(a => a1);
    EXECUTE IMMEDIATE a1;
    log_it(p_msg => a2);
    EXECUTE IMMEDIATE a2;
    DEBUG.print('sql ' || a3);
    SYS.DBMS_SQL.PARSE(h, a3, DBMS_SQL.NATIVE);
    EXECUTE IMMEDIATE a4;
    $IF $$x $THEN "a5" := 'x'; $END
    EXECUTE IMMEDIATE a5;
    DECLARE a6 VARCHAR2(10); BEGIN a6 := 'x'; END;
    EXECUTE IMMEDIATE a6;
    EXECUTE IMMEDIATE a7 USING 1;
    $IF $$x $THEN mäx := mäx || ' and z = 1'; $ELSE NULL; $END
    EXECUTE IMMEDIATE mäx;
  END;
END d;
/
`;
  const f = points(src)[0];
  assert.deepEqual(f.errors, []);
  const got = expand([f]).filter((m) => m.point.dyn).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  const has = (x: string) => assert.ok(got.includes(x), `${x}\n${got.join('\n')}`);
  const none = (x: string) => assert.ok(!got.some((g) => g.includes(x)), `${x}\n${got.join('\n')}`);
  has('ROR a1 > 1 → a1 >= 1'); // named argument of DBMS_OUTPUT: read only
  none('a2 > 1'); // named argument of another logging procedure: may be IN OUT
  has('ROR a3 > 1 → a3 >= 1'); // DEBUG package inside a concatenation; SYS.DBMS_SQL.PARSE is a sink
  // 25 characters (CHAR): ä is one character, two bytes; one more character does not fit
  has('ROR ä > 1 → FALSE');
  none('ä > 1 → ä >= 1');
  has('ROR a5 > 1 → a5 >= 1'); // "a5" is another variable than a5
  none('a6 > 1'); // a nested block declares a6 again
  // a named bind must not get lost
  assert.ok(!got.some((g) => g.includes('a7') && !g.split('→')[1].includes(':b')), got.join('\n'));
  none('m > 1'); // a $IF branch builds mäx from itself
});

test('finder: cursor blocks refuse implied orders anywhere; a scalar subquery in an expression stays a projection', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY k AS
  PROCEDURE p IS
    CURSOR c1 IS SELECT a FROM (SELECT a FROM t START WITH a = 1 CONNECT BY PRIOR a = b) WHERE a > 1;
    CURSOR c2 IS SELECT a FROM (SELECT a FROM t ORDER BY a DESC) WHERE ROWNUM <= 5 AND a > 2;
    CURSOR c3 IS SELECT a, ROW_NUMBER() OVER (ORDER BY a) r FROM t WHERE a > 3;
    CURSOR c4 IS SELECT CASE (SELECT count(*) FROM u) WHEN 0 THEN a + 4 END x, (SELECT max(b) + 1 FROM u) + 2 y FROM t;
    CURSOR c5 IS SELECT v.a + 5 x FROM (SELECT a + 6 a FROM t) v WHERE v.a > 7;
  BEGIN NULL; END;
END k;
/
`)[0];
  const text = f.src.toString();
  const pt = (orig: string) => f.points.find((p) => p.orig === orig)!;
  for (const o of ['a > 1', 'a > 2']) assert.equal(pt(o).scope, undefined, o);
  assert.ok(pt('a > 3').union, 'an analytic ORDER BY decides no row order');
  for (const o of ['a + 4', 'max(b) + 1', 'v.a + 5']) assert.ok(pt(o).inline, o);
  // an inline view's select list in a cursor is a join key, not the block's projection
  assert.ok(!pt('a + 6').inline);
  assert.ok(text.length > 0);
});

test('finder: review round 5: # and ß in variable names, MATCH_RECOGNIZE order, labels in a cursor loop body', () => {
  const src = `CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p IS
    l#s VARCHAR2(100) := 'delete from t where a > 1';
    straße VARCHAR2(100) := 'delete from t where b > 2';
    n NUMBER;
  BEGIN
    EXECUTE IMMEDIATE l#s;
    $IF $$x $THEN straße := straße || ' or 1 = 1'; $ELSE NULL; $END
    EXECUTE IMMEDIATE straße;
    SELECT count(*) INTO n FROM t MATCH_RECOGNIZE (PARTITION BY a ORDER BY b MEASURES FIRST(b) AS fb ONE ROW PER MATCH PATTERN (x+) DEFINE x AS b > 4);
    FOR r IN (SELECT a FROM t WHERE a > 5) LOOP
      <<inner>> NULL;
    END LOOP;
  END;
END d;
/
`;
  const f = points(src)[0];
  assert.deepEqual(f.errors, []);
  const got = expand([f]).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  assert.ok(got.includes('ROR a > 1 → a >= 1'), got.join('\n'));
  assert.ok(!got.some((g) => g.includes('b > 2')), got.join('\n'));
  // the ORDER BY of MATCH_RECOGNIZE ends before MEASURES
  assert.ok(got.includes('ORD b → b DESC'), got.join('\n'));
  assert.ok(!got.some((g) => g.startsWith('ORD') && g.includes('MEASURES')), got.join('\n'));
  assert.equal(f.points.find((p) => p.orig === 'a > 5')!.scope, undefined);
});

test('finder: review round 6: ORDER BY stop words only where they end it; $IF labels in a cursor loop', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p IS
    n NUMBER;
  BEGIN
    SELECT count(*) INTO n FROM (SELECT a FROM t ORDER BY t.pattern, t.rows);
    SELECT count(*) INTO n FROM (SELECT a FROM t ORDER BY pattern);
    SELECT count(*) INTO n FROM t MATCH_RECOGNIZE (PARTITION BY a ORDER BY c ONE ROW PER MATCH PATTERN (x+) DEFINE x AS c > 4);
    FOR r IN (SELECT a FROM t WHERE a > 5) LOOP
      $IF $$dbg $THEN <<dbg>> NULL; $ELSE NULL; $END
    END LOOP;
  END;
END d;
/
`)[0];
  assert.deepEqual(f.errors, []);
  const ord = expand([f]).filter((m) => m.op === 'ORD').map((m) => `${m.original} → ${m.mutated}`);
  assert.ok(ord.includes('t.pattern, t.rows → t.pattern DESC, t.rows DESC'), ord.join('\n'));
  assert.ok(ord.includes('pattern → pattern DESC'), ord.join('\n'));
  assert.ok(ord.includes('c → c DESC'), ord.join('\n'));
  assert.ok(!ord.some((o) => o.includes('ONE ROW') || o.endsWith('t. DESC')), ord.join('\n'));
  assert.equal(f.points.find((p) => p.orig === 'a > 5')!.scope, undefined);
});

test('finder: review round 7: list items ending in a subquery, clauses after ORDER BY, spans over $IF directives', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p(n NUMBER) IS
    v VARCHAR2(10);
    j CLOB;
  BEGIN
    UPDATE t SET a = 1, b = (SELECT max(x) FROM u) WHERE d = 1;
    SELECT JSON_ARRAYAGG(a ORDER BY b RETURNING CLOB) INTO j FROM t;
    IF n > 1 $IF $$x $THEN AND n < 5 $END THEN NULL; END IF;
  END;
END d;
/
`)[0];
  assert.deepEqual(f.errors, []);
  const text = f.src.toString();
  const got = expand([f]).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  // every point's original is its bytes in the source
  for (const p of f.points) assert.equal(text.slice(p.start, p.end), p.orig, p.op);
  assert.ok(got.includes('COL a = 1, b = (SELECT max(x) FROM u) → a = 1'), got.join('\n'));
  assert.ok(got.includes('ORD b → b DESC'), got.join('\n'));
  assert.ok(!got.some((g) => g.includes('$IF')), got.join('\n'));
});

test('finder: review round 8: items starting with a subquery, partitioned outer joins, STRICT, $IF inside a statement', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p(n NUMBER) IS
    x NUMBER;
    j CLOB;
  BEGIN
    INSERT INTO t (a, b, c) VALUES ((SELECT 1 FROM dual) + 1, 2, 3);
    SELECT count(*) INTO x FROM a LEFT JOIN b PARTITION BY (b.k) ON a.id = b.id;
    SELECT JSON_ARRAYAGG(v ORDER BY v STRICT) INTO j FROM t;
    SELECT count(*) INTO x FROM t WHERE y IN (SELECT y FROM s ORDER BY y FETCH FIRST 3 ROWS ONLY);
    x := 1 $IF $$d $THEN + 2; $ELSE + 3; $END
  END;
END d;
/
`)[0];
  assert.deepEqual(f.errors, []);
  const text = f.src.toString();
  const got = expand([f]).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  for (const p of f.points) if (p.kind !== 'stmt') assert.equal(text.slice(p.start, p.end), p.orig, p.op);
  assert.ok(got.includes('COL (a, b, c) VALUES ((SELECT 1 FROM dual) + 1, 2, 3) → (b, c) VALUES (2, 3)') || got.some((g) => g.startsWith('COL') && g.includes('(SELECT 1 FROM dual) + 1, 2')), got.join('\n'));
  assert.ok(!got.some((g) => g.includes('VALUES ()')), got.join('\n'));
  assert.ok(!got.some((g) => g.startsWith('JOI') && g.includes('LEFT JOIN')), got.join('\n'));
  assert.ok(got.includes('ORD v → v DESC'), got.join('\n'));
  // with FETCH FIRST the order of an IN subquery decides which rows count
  assert.ok(got.includes('ORD y → y DESC'), got.join('\n'));
  assert.ok(!got.some((g) => g.startsWith('SBR') && g.includes('x := 1')), got.join('\n'));
});

test('finder: review round 9: CASE in SET lists, partitioned joins with several keys, FORALL bulk binds, GROUP BY keys, constant order keys', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p(n NUMBER) IS
    x NUMBER;
    s VARCHAR2(4000);
    TYPE ids_t IS TABLE OF NUMBER;
    ids ids_t;
  BEGIN
    UPDATE t SET c = 3, a = CASE WHEN b > 1 THEN 1 ELSE 2 END WHERE id = n;
    SELECT count(*) INTO x FROM a PARTITION BY (a.k, a.j) RIGHT JOIN b ON a.id = b.id;
    FORALL i IN 1 .. ids.count DELETE FROM t WHERE id = ids(i);
    FORALL i IN 1 .. ids.count INSERT INTO t (a, b) VALUES (ids(i), 1);
    SELECT max(c) INTO x FROM (SELECT nvl(dept, 0) dd, e + 1 ee, count(*) c FROM t GROUP BY nvl(dept, 0), e + 1);
    SELECT LISTAGG(v, ',') WITHIN GROUP (ORDER BY NULL) INTO s FROM t;
  END;
END d;
/
`)[0];
  assert.deepEqual(f.errors, []);
  const got = expand([f]).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  const no = (x: string) => assert.ok(!got.some((g) => g.includes(x)), `${x}\n${got.join('\n')}`);
  assert.ok(got.some((g) => g.startsWith('COL c = 3, a = CASE WHEN b > 1 THEN 1 ELSE 2 END →')), got.join('\n'));
  no('a = CASE →');
  assert.ok(!got.some((g) => g.startsWith('JOI') && g.includes('RIGHT JOIN')), got.join('\n'));
  // the only bulk bind of a FORALL DML stays
  no('id = ids(i) → FALSE');
  no('(a, b) VALUES (ids(i), 1) → (b) VALUES (1)');
  // GROUP BY keys and the select items equal to them are not mutated (ORA-00979)
  no('nvl(dept, 0) → dept');
  no('e + 1 → e - 1');
  assert.ok(!got.some((g) => g.startsWith('ORD NULL')), got.join('\n'));
});

test('finder: review round 10: every occurrence of a composite GROUP BY key, DISTINCT with ORDER BY', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p IS
    x NUMBER;
  BEGIN
    SELECT max(v) INTO x FROM (SELECT nvl(a, 0) + 1 v, count(*) c FROM t GROUP BY nvl(a, 0) HAVING nvl(a, 0) > 3 ORDER BY nvl(a, 0) + 1);
    SELECT max(v) INTO x FROM (SELECT (e + 1) * 2 v FROM t GROUP BY ROLLUP (e + 1, b));
    SELECT max(v) INTO x FROM (SELECT t.f + 1 v FROM t GROUP BY f + 1 UNION ALL SELECT nvl(g, 0) FROM u GROUP BY nvl(g, 0));
    SELECT max(v) INTO x FROM (SELECT DISTINCT nvl(h, 0) v FROM t ORDER BY nvl(h, 0));
    SELECT max(v) INTO x FROM (SELECT sum(k + 1) v FROM t GROUP BY m);
  END;
END d;
/
`)[0];
  assert.deepEqual(f.errors, []);
  const got = expand([f]).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  const no = (x: string) => assert.ok(!got.some((g) => g.includes(x)), `${x}\n${got.join('\n')}`);
  for (const k of ['NUL nvl(a, 0) →', 'e + 1 → e - 1', 't.f + 1 →', 'NUL nvl(g, 0) →', 'NUL nvl(h, 0) →']) no(k);
  // an expression around a key and one outside any key stay
  assert.ok(got.includes('AOR nvl(a, 0) + 1 → nvl(a, 0) - 1'), got.join('\n'));
  assert.ok(got.includes('AOR k + 1 → k - 1'), got.join('\n'));
});

test('finder: review round 11: GROUP BY keys before LOG ERRORS, GROUP BY alias, quoted names, a column named like the FORALL index', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p IS
    x NUMBER;
    TYPE ids_t IS TABLE OF NUMBER;
    ids ids_t;
  BEGIN
    INSERT INTO s (k, c) SELECT nvl(a, 0), count(*) FROM t GROUP BY nvl(a, 0) LOG ERRORS INTO err$_s ('x') REJECT LIMIT 10;
    SELECT max(w) INTO x FROM (SELECT nvl(b, 0) k, nvl(b, 0) + 1 w, count(*) c FROM t GROUP BY k HAVING nvl(b, 0) > 3);
    SELECT max(v) INTO x FROM (SELECT nvl("C", 0) v FROM t GROUP BY nvl(c, 0));
    SELECT max(v) INTO x FROM (SELECT t.e + 1 v FROM t GROUP BY t.e);
    FORALL i IN 1 .. ids.count DELETE FROM t WHERE x.i = 0 AND id = ids(i);
  END;
END d;
/
`)[0];
  assert.deepEqual(f.errors, []);
  const got = expand([f]).map((m) => `${m.op} ${m.original} → ${m.mutated}`);
  const no = (x: string) => assert.ok(!got.some((g) => g.includes(x)), `${x}\n${got.join('\n')}`);
  for (const k of ['NUL nvl(a, 0) →', 'NUL nvl(b, 0) →', 'NUL nvl("C", 0) →']) no(k);
  // a single column key: the expression around it stays derivable
  assert.ok(got.includes('AOR t.e + 1 → t.e - 1'), got.join('\n'));
  // x.i is a column: the DML's bulk bind ids(i) must stay
  no('x.i = 0 AND id = ids(i) → x.i = 0');
});

test('finder: points inside a RESULT_CACHE function are not switchable', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY pk IS
  FUNCTION f(a NUMBER) RETURN NUMBER RESULT_CACHE IS BEGIN RETURN a + 1; END;
  FUNCTION g(a NUMBER) RETURN NUMBER IS BEGIN RETURN a + 2; END;
END;
/
`)[0];
  const aor = (o: string) => f.points.find((p) => p.op === 'AOR' && p.orig === o)!;
  assert.equal(switchable(aor('a + 1')), false);
  assert.equal(switchable(aor('a + 2')), true);
});

test('finder: review round 12: RET in pipelined functions and constructors, trigger WHEN, non-negative differences, NULL comparisons, CALL triggers', () => {
  const pk = points(`CREATE OR REPLACE PACKAGE BODY pk IS
  FUNCTION pf RETURN t_tab PIPELINED IS BEGIN PIPE ROW (1); RETURN; END;
  FUNCTION f(a VARCHAR2, b VARCHAR2) RETURN NUMBER IS BEGIN
    IF LENGTH(a) - LENGTH(b) > 0 THEN RETURN 1; END IF;
    IF a = NULL THEN RETURN 2; END IF;
    IF a = 'x' OR a = 'X' THEN RETURN 3; END IF;
    RETURN 0;
  END;
END;
/
CREATE OR REPLACE TYPE BODY ty AS
  CONSTRUCTOR FUNCTION ty(a NUMBER) RETURN SELF AS RESULT IS BEGIN SELF.a := a; RETURN; END;
END;
/
CREATE OR REPLACE TRIGGER tc BEFORE INSERT ON t FOR EACH ROW WHEN (new.a + 1 > old.b)
BEGIN NULL; END;
/
CREATE OR REPLACE TRIGGER tcall BEFORE INSERT ON t FOR EACH ROW CALL p_log(1)
/
CREATE OR REPLACE PROCEDURE after_call IS BEGIN NULL; END;
/
`);
  const all = pk.flatMap((f) => expand([f]));
  const got = all.map((m) => `${m.sub} ${m.op} ${m.original} → ${m.mutated.trim()}`);
  assert.ok(!got.some((g) => g.startsWith('pf RET') && g.includes('RETURN NULL')), got.join('\n'));
  assert.ok(!got.some((g) => g.startsWith('ty RET') && g.includes('RETURN NULL')), got.join('\n'));
  // trigger WHEN: mutated, but only one by one
  const when = pk.flatMap((f) => f.points).filter((p) => p.orig === 'new.a + 1');
  assert.ok(when.length && when.every((p) => !switchable(p)));
  // LENGTH(a) - LENGTH(b) can be negative: <> stays
  assert.ok(got.some((g) => g.includes('LENGTH(a) - LENGTH(b) > 0 → LENGTH(a) - LENGTH(b) <> 0')), got.join('\n'));
  // with NULL only TRUE and FALSE differ from the original
  const nul = got.filter((g) => g.includes('ROR a = NULL →')).map((g) => g.split('→ ')[1]).sort();
  assert.deepEqual(nul, ['FALSE'], got.join('\n'));
  // 'x' and 'X' are different literals: the exclusive-equals shortcut does not apply... and the OR keeps (l) = (r)? no: case counts
  assert.ok(got.some((g) => g.startsWith('f LCR')), got.join('\n'));
  // the unit after a CALL trigger without semicolon is still found
  assert.ok(pk.some((f) => f.units.some((u) => u.name.toUpperCase() === 'AFTER_CALL')));
});

test('finder: review round 13: RESULT_CACHE covers RET and dynamic SQL; anonymous blocks and GRANT CREATE do not hide units', () => {
  const f = points(`CREATE OR REPLACE FUNCTION dc(n NUMBER) RETURN NUMBER RESULT_CACHE IS r NUMBER;
BEGIN EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM t WHERE a > 1' INTO r; RETURN r; END;
/
begin
  execute immediate '
    drop table t';
end;
/
GRANT CREATE SESSION,
      CREATE TRIGGER,
      CREATE PROCEDURE TO app_user;
CREATE OR REPLACE PROCEDURE p1 IS BEGIN IF x > 1 THEN NULL; END IF; END;
/
`, 'x.sql');
  const all = f.flatMap((x) => x.points);
  for (const p of all.filter((x) => x.sub === 'dc')) assert.equal(switchable(p), false, `${p.op} ${p.orig}`);
  const names = f.flatMap((x) => x.units.map((u) => u.name.toUpperCase()));
  assert.ok(names.includes('P1') && names.includes('DC'), names.join(','));
  assert.ok(!names.some((n) => n === 'TO' || n === ','), names.join(','));
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
    fill(l_c);
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

test('finder: blankSqlPlus keeps unit code when CREATE OR REPLACE stands alone and after @ includes with paths', () => {
  const f = points(`@./setup.sql
@../other.sql
create or replace
package body p as
  g number;
  procedure x(a number) is begin
    g := 1;
    execute immediate
      'begin null; end;';
    g := 2;
  end;
end;
/
`, 'b.sql')[0];
  assert.deepEqual(f.errors, []);
  // the EXECUTE IMMEDIATE line is code, not a blanked SQL*Plus EXECUTE: no statement deletion
  // that starts in the middle of it (EXECUTE IMMEDIATE itself gets no SBR, by design)
  const sbr = f.points.filter((p) => p.op === 'SBR').map((p) => p.orig.replace(/\s+/g, ' '));
  assert.deepEqual(sbr, ['g := 1;', 'g := 2;']);
  assert.ok(f.units.some((u) => u.name.toLowerCase() === 'p'));
});

test('finder: an inline Java/MLE source is skipped up to its slash, the units after it keep their mutants', () => {
  const f = points(`create or replace mle module m language javascript as
// don't touch
export function f() { return 1; }
/
create or replace and compile java source named "J" as
public class J { static char q() { return '\\''; } }
/
create or replace procedure p(a number) is begin if a > 1 then null; end if; end;
/
`, 'f.sql')[0];
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.units.map((u) => u.name.toLowerCase()), ['p']);
  assert.ok(f.points.some((p) => p.op === 'ROR'));
});

test('finder: ROR between column lists keeps only TRUE/FALSE', () => {
  const got = mutants(body(`DELETE FROM t WHERE (x, y) = (SELECT a1, b1 FROM u WHERE u.id = a);
    IF (a) + (b) > c THEN NULL; END IF;`), ['ROR']);
  assert.ok(got.some((g) => /\(x, y\) = \(SELECT .* → FALSE/.test(g)), got.join('\n'));
  assert.ok(!got.some((g) => /\(x, y\) (<=|>=)/.test(g)), got.join('\n'));
  assert.ok(got.some((g) => g.includes('(a) + (b) >= c')), got.join('\n'));
});

test('finder: the value of a constant that gives a size runs only one by one', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY k AS
  c_len CONSTANT PLS_INTEGER := 10 * 2;
  c_other CONSTANT PLS_INTEGER := 3 * 2;
  PROCEDURE p IS v VARCHAR2(c_len); BEGIN v := 'x'; END;
END k;
/
`)[0];
  const aor = f.points.filter((p) => p.op === 'AOR');
  assert.equal(aor.find((p) => p.orig.includes('10'))?.naiveOnly, 'static');
  assert.equal(aor.find((p) => p.orig.includes('3'))?.naiveOnly, undefined);
});

test('finder: a Java source with AS on its own line and an MLE call spec are skipped, later units keep their mutants', () => {
  const f = points(`create or replace and compile java source named "Foo"
as
public class Foo {
  // don't
}
/
create or replace function js_f return varchar2 as mle language javascript {{ // don't
  return 'x'; }};
/
create procedure if not exists p(a number) is begin if a > 1 then null; end if; end;
/
`, 'g.sql')[0];
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.units.map((u) => u.name.toLowerCase()), ['p']);
  const m = expand([f]).find((x) => x.op === 'ROR')!;
  assert.match(withoutCreate(mutatedUnit(m)), /^procedure p\(a number\)/);
});

test('finder: a constant used in a size expression, and the constants its value names, stay static', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY k AS
  c_a CONSTANT PLS_INTEGER := 5 + 5;
  c_len CONSTANT PLS_INTEGER := c_a * 2;
  c_free CONSTANT PLS_INTEGER := 3 * 2;
  PROCEDURE p IS v VARCHAR2(c_len + 1); BEGIN v := 'x'; END;
END k;
/
`)[0];
  const aor = f.points.filter((p) => p.op === 'AOR');
  assert.equal(aor.find((p) => p.orig.includes('5 + 5'))?.naiveOnly, 'static');
  assert.equal(aor.find((p) => p.orig.includes('c_a * 2'))?.naiveOnly, 'static');
  assert.equal(aor.find((p) => p.orig.includes('3 * 2'))?.naiveOnly, undefined);
});

test('finder: no mutants in parameter defaults of package body subprograms (they must match the spec)', () => {
  const got = mutants(`CREATE OR REPLACE PACKAGE BODY d AS
  PROCEDURE p(a DATE DEFAULT SYSDATE - 500) IS BEGIN IF a > SYSDATE THEN NULL; END IF; END;
END d;
/
`);
  assert.ok(!got.some((g) => g.includes('SYSDATE - 500')), got.join('\n'));
  assert.ok(got.some((g) => g.startsWith('ROR')), got.join('\n'));
});

test('finder: an MLE call spec whose AS MLE LANGUAGE comes on a later line is skipped', () => {
  const f = points(`create or replace function f(a number)
return number
as mle language javascript
{{ // don't touch
   return a; }};
/
create or replace procedure p(x number) is begin if 1 < x then null; end if; end;
/
`, 'm.sql')[0];
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.units.map((u) => u.name.toLowerCase()), ['p']);
});

test('withoutCreate drops IF NOT EXISTS also after FORCE', () => {
  assert.equal(withoutCreate('create force view if not exists v as select 1 a from dual'), 'force view v as select 1 a from dual');
  assert.equal(withoutCreate('create procedure if not exists p is begin null; end;'), 'procedure p is begin null; end;');
});

test('finder: a size in a $IF branch the preprocessing leaves out still keeps its constant static', () => {
  const f = points(`CREATE OR REPLACE PACKAGE BODY k AS
  c_len CONSTANT PLS_INTEGER := 100 * 2;
  PROCEDURE p IS
  $IF dbms_db_version.version >= 12 $THEN
    v VARCHAR2(c_len);
  $ELSE
    v VARCHAR2(4000);
  $END
  BEGIN NULL; END;
END k;
/
`)[0];
  assert.equal(f.points.find((p) => p.op === 'AOR' && p.orig.includes('100'))?.naiveOnly, 'static');
});

test('finder: no mutants in parameter defaults inside a trigger (forward declarations)', () => {
  const got = mutants(`CREATE OR REPLACE TRIGGER ct FOR INSERT ON t COMPOUND TRIGGER
  PROCEDURE log_it(p_lvl NUMBER := 1 + 1);
  PROCEDURE log_it(p_lvl NUMBER := 1 + 1) IS BEGIN NULL; END;
  BEFORE STATEMENT IS BEGIN log_it; END BEFORE STATEMENT;
END ct;
/
`, ['AOR']);
  assert.deepEqual(got, []);
});

test('withoutCreate drops IF NOT EXISTS after NO FORCE', () => {
  assert.equal(withoutCreate('create no force view if not exists v as select 1 a from dual'), 'no force view v as select 1 a from dual');
});

test('finder: no ORD mutant for a dynamic single-row EXECUTE IMMEDIATE … INTO without row limit', () => {
  const got = mutants(body(`EXECUTE IMMEDIATE 'select count(*) from t where a = 1 order by 1' INTO x;
    OPEN cur FOR 'select a from t order by b';`), ['ORD']);
  assert.ok(!got.some((g) => g.includes('order by 1') || g.startsWith('ORD: 1 ')), got.join('\n'));
  assert.ok(got.some((g) => g.includes('b DESC')), got.join('\n'));
});

test('finder: ORD in OVER / WITHIN GROUP of a dynamic single-row query stays', () => {
  const got = mutants(body(`EXECUTE IMMEDIATE 'SELECT LISTAGG(n, '','') WITHIN GROUP (ORDER BY n) FROM t' INTO s;
    EXECUTE IMMEDIATE 'SELECT FIRST_VALUE(n) OVER (ORDER BY m) FROM t WHERE id = 1' INTO x;`), ['ORD']);
  assert.ok(got.some((g) => g.includes('n DESC')) && got.some((g) => g.includes('m DESC')), got.join('\n'));
});
