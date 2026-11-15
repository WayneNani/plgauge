/** Schema rewriter and oracle rewriter, offline (ported from plmut's schema_test.go). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSchema, expand, findPoints, livePlan, locate, mutatedUnit, planDiff, positionOf, type PlanRow, type SourceFile } from '@plgauge/mutation';

function testFile(): SourceFile {
  const src =
    'CREATE OR REPLACE PACKAGE BODY p AS\n' +
    '  FUNCTION f(a NUMBER, b NUMBER, c NUMBER) RETURN NUMBER IS\n' +
    '    n NUMBER;\n' +
    '  BEGIN\n' +
    '    SELECT COUNT(*) INTO n FROM t WHERE x > a;\n' +
    '    LOOP EXIT; END LOOP;\n' +
    '    RETURN a - b + c;\n' +
    '  END;\n' +
    'END p;';
  const at = (s: string) => Buffer.byteLength(src.slice(0, src.indexOf(s)));
  const sel = 'SELECT COUNT(*) INTO n FROM t WHERE x > a;';
  const p = (o: object) => ({ unit: 0, sub: 'f', ctx: 'plsql', cat: '', orig: '', ...o }) as SourceFile['points'][number];
  return {
    path: 'p.pkb', errors: [], skipped: 0, src: Buffer.from(src),
    units: [{ type: 'PACKAGE BODY', name: 'p', start: 0, end: Buffer.byteLength(src), decl: at(' AS\n') + 3 }],
    points: [
      p({ op: 'RET', kind: 'insert', start: at('BEGIN') + 5, end: at('BEGIN') + 5, mutants: [' RETURN NULL;', " RAISE_APPLICATION_ERROR(-20998, 'plgauge: RET');"] }),
      p({ op: 'SBR', kind: 'stmt', start: at(sel), end: at(sel) + sel.length, orig: sel, mutants: ['NULL;'] }),
      p({ op: 'ROR', kind: 'bool', ctx: 'sql', start: at('x > a'), end: at('x > a') + 5, orig: 'x > a', mutants: ['x >= a'], scope: [at(sel), at(sel) + sel.length] }),
      p({ op: 'AOR', kind: 'value', start: at('a - b'), end: at('a - b') + 5, orig: 'a - b', mutants: ['a + b'] }),
      p({ op: 'AOR', kind: 'value', start: at('a - b + c'), end: at('a - b + c') + 9, orig: 'a - b + c', mutants: ['a - b - c'] }),
    ],
    loops: [{ unit: 0, at: at('LOOP') + 4 }],
  };
}

test('schema: switches for every kind, nested and left-associative', () => {
  const ms = expand([testFile()]);
  assert.equal(ms.length, 6);
  const sus = buildSchema(ms);
  assert.equal(sus.length, 1);
  const got = sus[0].text;
  assert.ok(got.startsWith('PACKAGE BODY p AS'), 'without CREATE OR REPLACE');
  for (const want of [
    'plgauge$a CONSTANT PLS_INTEGER := plgauge_ctl.active;',
    "BEGIN IF plgauge$a = -1 THEN plgauge_ctl.reach(1, 2); END IF; IF plgauge$a = 1 THEN RETURN NULL; END IF; IF plgauge$a = 2 THEN RAISE_APPLICATION_ERROR(-20998, 'plgauge: RET'); END IF;",
    // SQL: the statement once per variant, the original (with the SBR switch) untouched
    'IF plgauge$a = -1 THEN plgauge_ctl.reach(4, 1); END IF; IF plgauge$a = 4 THEN SELECT COUNT(*) INTO n FROM t WHERE x >= a; ELSE IF plgauge$a = -1 THEN plgauge_ctl.reach(3, 1); END IF; IF plgauge$a <> 3 THEN SELECT COUNT(*) INTO n FROM t WHERE x > a; END IF; END IF;',
    'LOOP IF plgauge$a <> 0 THEN plgauge_ctl.tick(1); END IF; EXIT;',
    'RETURN (CASE CASE plgauge$a WHEN -1 THEN plgauge_ctl.hit(6, 1) ELSE plgauge$a END WHEN 6 THEN (a - b - c) ELSE ((CASE CASE plgauge$a WHEN -1 THEN plgauge_ctl.hit(5, 1) ELSE plgauge$a END WHEN 5 THEN (a + b) ELSE (a - b) END) + c) END);',
  ]) assert.ok(got.includes(want), `fehlt: ${want}\nin:\n${got}`);
  assert.equal(sus[0].loops, 1);
});

test('schema: dropped variants disappear and errors are charged to their branch', () => {
  const ms = expand([testFile()]);
  const su = buildSchema(ms, new Set([5]))[0];
  assert.ok(!su.text.includes('WHEN 5 THEN'));
  const i = su.text.indexOf('(a - b - c)');
  const line = 1 + (su.text.slice(0, i).match(/\n/g)?.length ?? 0);
  const col = i - su.text.lastIndexOf('\n', i - 1);
  const rg = locate(su, line, col + 1);
  assert.equal(rg?.mutantId, 6);
});

test('schema: switches do not fuse with neighbouring names', () => {
  const src = 'CREATE OR REPLACE PROCEDURE p IS x NUMBER; BEGIN IF x>0 THEN x:=1;ELSE x:=2;END IF; END;';
  const at = (s: string) => src.indexOf(s);
  const f: SourceFile = {
    path: 'p.prc', errors: [], skipped: 0, src: Buffer.from(src), loops: [],
    units: [{ type: 'PROCEDURE', name: 'p', start: 0, end: src.length, decl: -1 }],
    points: [
      { unit: 0, op: 'SBR', kind: 'stmt', sub: 'p', ctx: 'plsql', cat: '', start: at('x:=2;'), end: at('x:=2;') + 5, orig: 'x:=2;', mutants: ['NULL;'] },
      { unit: 0, op: 'ROR', kind: 'bool', sub: 'p', ctx: 'plsql', cat: '', start: at('x>0'), end: at('x>0') + 3, orig: 'x>0', mutants: ['x>=0'] },
    ],
  };
  const got = buildSchema(expand([f]))[0].text;
  assert.ok(!got.includes('ELSEIF'), got);
  assert.ok(got.includes('ELSE IF plgauge_ctl.active() = -1'), got);
});

test('oracle rewriter applies exactly one mutant', () => {
  const ms = expand([testFile()]);
  assert.ok(mutatedUnit(ms[5]).includes('RETURN a - b - c;'));
  assert.ok(mutatedUnit(ms[0]).includes('BEGIN RETURN NULL;\n'));
});

test('schema: SQL points duplicate their statement; errors in a copy drop that variant', () => {
  const src =
    'CREATE OR REPLACE PROCEDURE q IS\n' +
    'BEGIN\n' +
    '  UPDATE t SET a = 1, b = 2 WHERE id = 3;\n' +
    'END;';
  const stmt = 'UPDATE t SET a = 1, b = 2 WHERE id = 3;';
  const s = src.indexOf(stmt);
  const pt = (o: object) => ({ unit: 0, sub: 'q', ctx: 'sql', cat: '', ...o }) as SourceFile['points'][number];
  const f: SourceFile = {
    path: 'q.prc', errors: [], skipped: 0, src: Buffer.from(src), loops: [],
    units: [{ type: 'PROCEDURE', name: 'q', start: 0, end: src.length, decl: -1 }],
    points: [
      pt({ op: 'SBR', kind: 'stmt', ctx: 'plsql', start: s, end: s + stmt.length, orig: stmt, mutants: ['NULL;'] }),
      pt({ op: 'COL', kind: 'clause', start: src.indexOf('a = 1'), end: src.indexOf(' WHERE'), orig: 'a = 1, b = 2', mutants: ['b = 2', 'a = 1'], scope: [s, s + stmt.length] }),
      pt({ op: 'ROR', kind: 'bool', start: src.indexOf('id = 3'), end: src.indexOf('id = 3') + 6, orig: 'id = 3', mutants: ['FALSE'], scope: [s, s + stmt.length] }),
    ],
  };
  const su = buildSchema(expand([f]))[0];
  assert.match(su.text, /IF plgauge_ctl\.active\(\) = -1 THEN plgauge_ctl\.reach\(2, 2\); plgauge_ctl\.reach\(4, 1\); END IF; IF plgauge_ctl\.active\(\) = 2 THEN UPDATE t SET b = 2 WHERE id = 3; ELSIF plgauge_ctl\.active\(\) = 3 THEN UPDATE t SET a = 1 WHERE id = 3; ELSIF plgauge_ctl\.active\(\) = 4 THEN UPDATE t SET a = 1, b = 2 WHERE FALSE; ELSE IF .*reach\(1, 1\).* <> 1 THEN UPDATE t SET a = 1, b = 2 WHERE id = 3; END IF; END IF;/);
  const i = su.text.indexOf('SET a = 1 WHERE');
  const line = 1 + (su.text.slice(0, i).match(/\n/g)?.length ?? 0);
  assert.equal(locate(su, line, i - su.text.lastIndexOf('\n', i - 1) + 1)?.mutantId, 3);
  delete f.points[1].scope;
  // without a statement (cursor, FOR loop) SQL points are left to the oracle rewriter
  delete f.points[2].scope;
  const plain = buildSchema(expand([f]))[0].text;
  assert.ok(!plain.includes('ELSIF') && plain.includes('THEN UPDATE t SET a = 1, b = 2 WHERE id = 3; END IF;'));
});

test('schema: a view block gets one UNION ALL branch per variant; select lists switch in place', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'plgauge-')), 'v.sql');
  writeFileSync(path, 'create or replace view v as\n  select a + 1 as b from t where a < 3;\n');
  const ms = expand(findPoints([path]));
  assert.deepEqual(ms.map((m) => `${m.id} ${m.op} ${m.mutated}`), ['1 AOR a - 1', '2 ROR a <= 3', '3 ROR a <> 3', '4 ROR FALSE', '5 WHR TRUE']);
  const su = buildSchema(ms, new Set(), new Set(), 'DEMO')[0];
  const V = "SYS_CONTEXT('PLGAUGE_CTX_", c = (s: string) => s.replaceAll("SYS_CONTEXT('PLGAUGE_CTX_4FF006CA6B88', 'ACTIVE')", 'V');
  assert.ok(su.text.includes(V), su.text);
  assert.equal(c(su.text), 'view v as\n  SELECT * FROM (select (CASE V WHEN \'1\' THEN (a - 1) ELSE (a + 1) END) as b from t where a < 3)' +
    " WHERE NVL(V, '0') NOT IN ('2', '3', '4', '5') AND (NVL(V, '0') <> '-1' OR (SELECT plgauge_ctl.hit_sql(1, 5) FROM dual) = 0)" +
    " UNION ALL SELECT * FROM (select a + 1 as b from t where a <= 3) WHERE V = '2'" +
    " UNION ALL SELECT * FROM (select a + 1 as b from t where a <> 3) WHERE V = '3'" +
    " UNION ALL SELECT * FROM (select a + 1 as b from t where FALSE) WHERE V = '4'" +
    " UNION ALL SELECT * FROM (select a + 1 as b from t where TRUE) WHERE V = '5'");
  // an error in a branch drops that variant; one in the wrapper takes the whole block out of the schema
  const pos = (s: string) => {
    const i = su.text.indexOf(s);
    return [1 + (su.text.slice(0, i).match(/\n/g)?.length ?? 0), i - su.text.lastIndexOf('\n', i - 1)] as const;
  };
  assert.equal(locate(su, ...pos('a <> 3'))?.mutantId, 3);
  const w = locate(su, ...pos('SELECT * FROM (select ('));
  assert.equal(w?.mutantId, 0);
  assert.equal(w?.points?.length, 3);
  // dropped and unswitched points are not switched; the block still records the unswitched ones
  const part = buildSchema(ms, new Set([2, 3, 4]), new Set([ms[0].point]), 'DEMO')[0];
  const rest = c(part.text);
  assert.ok(rest.startsWith("view v as\n  SELECT * FROM (select a + 1 as b from t where a < 3) WHERE NVL(V, '0') NOT IN ('5') AND (NVL(V, '0') <> '-1' OR (SELECT plgauge_ctl.hit_sql(1, 1) + plgauge_ctl.hit_sql(5, 1) FROM dual) = 0) UNION ALL"), rest);
  assert.deepEqual(part.recorded, [1]);
});

test('schema: view points without a block are recorded by the main block (no test that skips it queries the view)', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'plgauge-')), 'r.sql');
  writeFileSync(path, 'create view r as\n  with h (n) as (select 1 from dual union all select n + 1 from h where n < 3)\n  select n from h where n > 1;\n');
  const ms = expand(findPoints([path]));
  const loose = ms.filter((m) => !m.point.scope);
  assert.ok(loose.length > 0);
  const su = buildSchema(ms, new Set(), new Set(loose.map((m) => m.point)), 'DEMO')[0];
  assert.deepEqual(su.recorded, loose.map((m) => m.id));
  assert.ok(su.text.includes(`plgauge_ctl.hit_sql(${Math.min(...ms.map((m) => m.id))}`), su.text);
});

test('schema: an ordered view keeps its main query unwrapped; a failing wrapper marks its block broken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plgauge-'));
  writeFileSync(join(dir, 'o.sql'), 'create view o as\n  with w as (select a from t where a > 1)\n  select a from w where a < 9 order by a;\n');
  const ms = expand(findPoints([join(dir, 'o.sql')]));
  const su = buildSchema(ms, new Set(), new Set(), 'DEMO')[0];
  assert.ok(su.text.includes('select a from w where a < 9 order by a;') || su.text.endsWith('select a from w where a < 9 order by a'), su.text);
  assert.equal((su.text.match(/UNION ALL/g) ?? []).length, 4, 'only the WITH element is switched');
  const wrapper = su.regions.find((r) => r.mutantId === 0 && r.block);
  assert.ok(wrapper && wrapper.points!.length > 0);
  // the WITH element's wrapper failed: no wrapper next time, its points with the oracle rewriter
  const again = buildSchema(ms, new Set(), new Set(wrapper.points), 'DEMO', new Set([wrapper.block!]))[0];
  assert.ok(!again.text.includes('UNION ALL'), again.text);
});

test('schema: a duplicated PL/SQL statement charges an error in its scaffold to all its points', () => {
  const src = 'CREATE OR REPLACE PROCEDURE q IS\nBEGIN\n  UPDATE t SET a = 1, b = 2 WHERE id = 3;\nEND;';
  const stmt = 'UPDATE t SET a = 1, b = 2 WHERE id = 3;';
  const s = src.indexOf(stmt);
  const pt = (o: object) => ({ unit: 0, sub: 'q', ctx: 'sql', cat: '', ...o }) as SourceFile['points'][number];
  const f: SourceFile = {
    path: 'q.prc', errors: [], skipped: 0, src: Buffer.from(src), loops: [],
    units: [{ type: 'PROCEDURE', name: 'q', start: 0, end: src.length, decl: -1 }],
    points: [
      pt({ op: 'COL', kind: 'clause', start: src.indexOf('a = 1'), end: src.indexOf(' WHERE'), orig: 'a = 1, b = 2', mutants: ['b = 2'], scope: [s, s + stmt.length] }),
      pt({ op: 'ROR', kind: 'bool', start: src.indexOf('id = 3'), end: src.indexOf('id = 3') + 6, orig: 'id = 3', mutants: ['FALSE'], scope: [s, s + stmt.length] }),
    ],
  };
  const su = buildSchema(expand([f]))[0];
  const i = su.text.indexOf('IF plgauge_ctl.active() = -1');
  const line = 1 + (su.text.slice(0, i).match(/\n/g)?.length ?? 0);
  const rg = locate(su, line, i - su.text.lastIndexOf('\n', i - 1) + 1);
  assert.equal(rg?.mutantId, 0);
  assert.equal(rg?.points?.length, 2);
});

test('positionOf: offset to line and column in code points', () => {
  assert.deepEqual(positionOf('ab\ncä€d', 6), { line: 2, col: 4 });
  assert.deepEqual(positionOf('abc', 0), { line: 1, col: 1 });
});

test('schema: cursor declarations get UNION ALL branches, cursor FOR loops are duplicated, dynamic SQL literals switch in place', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'plgauge-')), 'k.pkb');
  writeFileSync(path, `CREATE OR REPLACE PACKAGE BODY k AS
  PROCEDURE p IS
    CURSOR c IS SELECT a + 1 AS b FROM t WHERE a > 2;
    l_sql VARCHAR2(100) := 'delete from t where x = ''y''';
  BEGIN
    FOR r IN (SELECT a FROM t WHERE a < 5) LOOP
      NULL;
    END LOOP;
    EXECUTE IMMEDIATE l_sql;
  END;
END k;
/
`);
  const ms = expand(findPoints([path]));
  assert.deepEqual(ms.map((m) => `${m.id} ${m.op} ${m.mutated.trim()}`), [
    '1 AOR a - 1', '2 ROR a >= 2', '3 ROR a <> 2', '4 ROR FALSE', '5 WHR TRUE', "6 ROR TRUE", "7 ROR FALSE",
    '8 RET RETURN;', "9 RET RAISE_APPLICATION_ERROR(-20998, 'plgauge: RET');", '10 ROR a <= 5', '11 ROR a <> 5', '12 ROR FALSE', '13 WHR TRUE',
  ]);
  const su = buildSchema(ms, new Set(), new Set(), 'DEMO')[0];
  const t = su.text.replaceAll("SYS_CONTEXT('PLGAUGE_CTX_4FF006CA6B88', 'ACTIVE')", 'V');
  assert.ok(t.includes("CURSOR c IS SELECT * FROM (SELECT (CASE V WHEN '1' THEN (a - 1) ELSE (a + 1) END) AS b FROM t WHERE a > 2)" +
    " WHERE NVL(V, '0') NOT IN ('2', '3', '4', '5') AND (NVL(V, '0') <> '-1' OR (SELECT plgauge_ctl.hit(1, 5) FROM dual) = 0)" +
    " UNION ALL SELECT * FROM (SELECT a + 1 AS b FROM t WHERE a >= 2) WHERE V = '2'"), t);
  assert.ok(t.includes("UNION ALL SELECT * FROM (SELECT a + 1 AS b FROM t WHERE TRUE) WHERE V = '5';"), t);
  assert.ok(t.includes("l_sql VARCHAR2(100) := (CASE CASE plgauge$a WHEN -1 THEN plgauge_ctl.hit(6, 2) ELSE plgauge$a END" +
    " WHEN 6 THEN 'delete from t where TRUE' WHEN 7 THEN 'delete from t where FALSE' ELSE 'delete from t where x = ''y''' END);"), t);
  // the copies keep the loop guard: a mutant must not make a copied loop run away
  assert.match(t, /IF plgauge\$a = -1 THEN plgauge_ctl\.reach\(10, 3\); plgauge_ctl\.reach\(13, 1\); END IF; IF plgauge\$a = 10 THEN FOR r IN \(SELECT a FROM t WHERE a <= 5\) LOOP IF plgauge\$a <> 0 THEN plgauge_ctl\.tick\(1\); END IF;\s+NULL;\s+END LOOP; ELSIF/);
  assert.match(t, /ELSE FOR r IN \(SELECT a FROM t WHERE a < 5\) LOOP IF plgauge\$a <> 0 THEN plgauge_ctl\.tick\(1\); END IF;\s+NULL;\s+END LOOP; END IF;/);
  // the oracle rewriter changes only the inside of the literal
  assert.ok(mutatedUnit(ms[5]).includes("l_sql VARCHAR2(100) := 'delete from t where TRUE';"));
  // a failing cursor wrapper takes its block out (oracle rewriter), the rest stays switched
  const wrapper = su.regions.find((r) => r.block)!;
  const again = buildSchema(ms, new Set(), new Set(wrapper.points), 'DEMO', new Set([wrapper.block!]))[0];
  assert.ok(again.text.includes('CURSOR c IS SELECT a + 1 AS b FROM t WHERE a > 2;') && again.text.includes('WHEN 6 THEN'), again.text);
  // only branches need the warm-up before the baseline
  assert.equal(su.branched, true);
  assert.equal(again.branched, undefined);
});

test('livePlan: dead branches and the schema scaffold drop out; a changed plan shows', () => {
  // EXPLAIN PLAN of a view wrapped with two branches (23ai expands the recording OR into a second copy)
  const r = (id: number, parent: number | null, op: string, filter: string | null = null): PlanRow => ({ id, parent, op, filter });
  const V = "SYS_CONTEXT('PLGAUGE_CTX_X','ACTIVE')";
  const join = (base: number, parent: number, x = '"A"."X">3') => [
    r(base, parent, 'HASH JOIN'), r(base + 1, base, 'TABLE ACCESS FULL PT_B'), r(base + 2, base, 'TABLE ACCESS FULL PT_A', x),
  ];
  const orig = livePlan([r(0, null, 'SELECT STATEMENT'), ...join(1, 0)]);
  const switched = [
    r(0, null, 'SELECT STATEMENT'), r(1, 0, 'VIEW PT_V'), r(2, 1, 'UNION-ALL'), r(3, 2, 'VIEW VW_ORE_A8A72A4B'), r(4, 3, 'UNION-ALL'),
    r(5, 4, 'FILTER', `NVL(${V},'0')<>'-1' AND NVL(${V},'0')<>'3' AND NVL(${V},'0')<>'2'`), ...join(6, 5),
    r(10, 4, 'FILTER', `NVL(${V},'0')<>'3' AND NVL(${V},'0')<>'2' AND LNNVL(NVL(${V},'0')<>'-1') AND  (SELECT 0 FROM "SYS"."DUAL" "DUAL")=0`), ...join(11, 10), r(14, 10, 'FAST DUAL'),
    r(15, 2, 'FILTER', `${V}='2'`), ...join(16, 15, '"A"."X">=3'),
    r(19, 2, 'FILTER', `${V}='3'`), r(20, 19, 'NESTED LOOPS'), r(21, 20, 'TABLE ACCESS FULL PT_A'), r(22, 20, 'TABLE ACCESS FULL PT_B'),
  ];
  assert.deepEqual(livePlan(switched), orig);
  assert.equal(planDiff(orig, livePlan(switched)), undefined);
  // without OR expansion the recording subquery hangs under the original branch's filter
  const plain = [r(0, null, 'SELECT STATEMENT'), r(1, 0, 'UNION-ALL'),
    r(2, 1, 'FILTER', `NVL(${V},'0')<>'2' AND (NVL(${V},'0')<>'-1' OR  (SELECT 0 FROM "SYS"."DUAL" "DUAL")=0)`), ...join(3, 2), r(6, 2, 'FAST DUAL'),
    r(7, 1, 'FILTER', `${V}='2'`), ...join(8, 7)];
  assert.deepEqual(livePlan(plain), orig);
  // a WITH clause materialized for the copies, a branch filter pushed into a scan: different
  const worse = [r(0, null, 'SELECT STATEMENT'), r(1, 0, 'TEMP TABLE TRANSFORMATION'), r(2, 1, 'LOAD AS SELECT SYS_TEMP_0FD9D6604_2B3C'), ...join(3, 1),
    r(6, 1, 'TABLE ACCESS FULL PT_C', `${V}='4' AND "C"."Y">1`)];
  assert.equal(planDiff(orig, livePlan(worse)),
    '+1 HASH JOIN ← TEMP TABLE TRANSFORMATION, +1 LOAD AS SELECT SYS_TEMP ← TEMP TABLE TRANSFORMATION, +1 TABLE ACCESS FULL PT_A ← HASH JOIN, +1 TABLE ACCESS FULL PT_B ← HASH JOIN, …');
  // (A ⋈ B) ⋈ C against (A ⋈ C) ⋈ B: the same operations and parents, another tree
  const t3 = (x: string, y: string, z: string, base = 1, parent = 0) => [r(base, parent, 'HASH JOIN'), r(base + 1, base, 'HASH JOIN'),
    r(base + 2, base + 1, `TABLE ACCESS FULL ${x}`), r(base + 3, base + 1, `TABLE ACCESS FULL ${y}`), r(base + 4, base, `TABLE ACCESS FULL ${z}`)];
  const abc = livePlan([r(0, null, 'SELECT STATEMENT'), ...t3('A', 'B', 'C')]);
  const acb = livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'UNION-ALL'), r(2, 1, 'FILTER', `NVL(${V},'0')<>'2'`), ...t3('A', 'C', 'B', 3, 2),
    r(8, 1, 'FILTER', `${V}='2'`), ...t3('A', 'B', 'C', 9, 8)]);
  assert.notEqual(planDiff(abc, acb), undefined);
  // a filter of the original that took the wrapper's terms stays; a dead branch with an OR of its own stays dead
  const ne = (f: string) => [r(0, null, 'SELECT STATEMENT'), r(1, 0, 'FILTER', f), r(2, 1, 'TABLE ACCESS FULL T'), r(3, 1, 'TABLE ACCESS FULL U')];
  const plainNe = livePlan(ne('NOT EXISTS (SELECT 0 FROM "U" "U" WHERE "U"."X"=:B1)'));
  assert.equal(planDiff(plainNe, livePlan(ne(`NOT EXISTS (SELECT 0 FROM "U" "U" WHERE "U"."X"=:B1) AND NVL(${V},'0')<>'2'`))), undefined);
  // a view's own FROM dual stays; only the recording's dual (last child of a filter that reads DUAL) goes
  const rec = `(NVL(${V},'0')<>'-1' OR  (SELECT "PLGAUGE_CTL"."HIT"(1,5) FROM "SYS"."DUAL" "DUAL")=0)`;
  const dual = livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'FAST DUAL')]);
  assert.equal(planDiff(dual, livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'FILTER', `NVL(${V},'0')<>'2' AND ${rec}`), r(2, 1, 'FAST DUAL'), r(3, 1, 'FAST DUAL')])), undefined);
  // a kept filter of the original with the recording folded in loses only the recording dual
  assert.equal(planDiff(plainNe, livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'FILTER', `NOT EXISTS (SELECT 0 FROM "U" "U" WHERE "U"."X"=:B1) AND ${rec}`),
    r(2, 1, 'TABLE ACCESS FULL T'), r(3, 1, 'TABLE ACCESS FULL U'), r(4, 1, 'FAST DUAL')])), undefined);
  // a dead branch's condition pushed below an aggregate kills the whole branch
  const agg = (base: number, parent: number, f: string) => [r(base, parent, 'HASH GROUP BY'), r(base + 1, base, 'FILTER', f), r(base + 2, base + 1, 'TABLE ACCESS FULL T')];
  const grouped = livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'HASH GROUP BY'), r(2, 1, 'TABLE ACCESS FULL T')]);
  assert.equal(planDiff(grouped, livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'UNION-ALL'), r(2, 1, 'HASH GROUP BY'), r(3, 2, 'TABLE ACCESS FULL T'),
    ...agg(4, 1, `${V}='3'`)])), undefined);
  // terms in parentheses as a whole, and quoted identifiers with odd characters, still split
  assert.equal(planDiff(grouped, livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'UNION-ALL'), r(2, 1, 'HASH GROUP BY'), r(3, 2, 'TABLE ACCESS FULL T'),
    ...agg(4, 1, `("T"."A(B"=1 AND ${V}='3')`)])), undefined);
  // join predicate pushdown into the switched block: UNION ALL PUSHED PREDICATE is the wrapper's UNION ALL
  const nl = livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'NESTED LOOPS'), r(2, 1, 'TABLE ACCESS FULL A'), r(3, 1, 'TABLE ACCESS BY INDEX ROWID B')]);
  assert.equal(planDiff(nl, livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'NESTED LOOPS'), r(2, 1, 'TABLE ACCESS FULL A'), r(3, 1, 'VIEW V'),
    r(4, 3, 'UNION ALL PUSHED PREDICATE'), r(5, 4, 'FILTER', `NVL(${V},'0')<>'2'`), r(6, 5, 'TABLE ACCESS BY INDEX ROWID B'),
    r(7, 4, 'FILTER', `${V}='2'`), r(8, 7, 'TABLE ACCESS BY INDEX ROWID B')])), undefined);
  // a dead branch's scalar subquery (printed before the branch's top row) goes with it
  const sq = (base: number) => [r(base, 1, 'TABLE ACCESS BY INDEX ROWID S'), r(base + 1, base, 'INDEX UNIQUE SCAN S_PK')];
  const withSq = livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'UNION-ALL'), ...sq(2), r(4, 1, 'FILTER', `NVL(${V},'0')<>'2'`), r(5, 4, 'TABLE ACCESS FULL T'),
    ...sq(6), r(8, 1, 'FILTER', `${V}='2'`), r(9, 8, 'TABLE ACCESS FULL T')]);
  assert.deepEqual(withSq, livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'UNION-ALL'), ...sq(2), r(4, 1, 'FILTER', `NVL(${V},'0')<>'2'`),
    r(5, 4, 'TABLE ACCESS FULL T')]));
  // the recording dual need not be the last child; a filter without the recording keeps its own dual
  const ex = livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'FILTER', 'EXISTS (SELECT 0 FROM "SYS"."DUAL" "DUAL")'), r(2, 1, 'FAST DUAL')]);
  assert.equal(planDiff(ex, livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'FILTER', `${rec} AND EXISTS (SELECT 0 FROM "SYS"."DUAL" "DUAL")`),
    r(2, 1, 'FAST DUAL'), r(3, 1, 'FAST DUAL')])), undefined);
  assert.equal(planDiff(ex, livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'FILTER', `EXISTS (SELECT 0 FROM "SYS"."DUAL" "DUAL") AND NVL(${V},'0')<>'5'`),
    r(2, 1, 'FAST DUAL')])), undefined);
  // a scalar subquery with a startup FILTER of its own; the live branch's head without one
  const sqf = (base: number) => [r(base, 1, 'FILTER', '"T"."KIND"=\'A\''), r(base + 1, base, 'TABLE ACCESS BY INDEX ROWID S'), r(base + 2, base + 1, 'INDEX UNIQUE SCAN S_PK')];
  const liveHead = [r(5, 1, 'HASH GROUP BY'), r(6, 5, 'FILTER', `NVL(${V},'0')<>'2'`), r(7, 6, 'TABLE ACCESS FULL T')];
  const base5 = livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'UNION-ALL'), ...sqf(2), ...liveHead]);
  assert.deepEqual(livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'UNION-ALL'), ...sqf(2), ...liveHead,
    ...sqf(8), r(11, 1, 'FILTER', `${V}='2'`), r(12, 11, 'TABLE ACCESS FULL T')]), base5);
  assert.equal(planDiff(plainNe, livePlan([...ne('NOT EXISTS (SELECT 0 FROM "U" "U" WHERE "U"."X"=:B1)'),
    r(4, 0, 'FILTER', `${V}='2' AND (NOT EXISTS (SELECT 0 FROM "U" "U" WHERE "U"."X"=:B1) OR "T"."X"=1)`), r(5, 4, 'TABLE ACCESS FULL T')])), undefined);
  // the same operations in another shape (join order, build and probe side) are a different plan
  const a = livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'NESTED LOOPS'), r(2, 1, 'HASH JOIN'), r(3, 2, 'TABLE ACCESS FULL A'),
    r(4, 2, 'TABLE ACCESS FULL B'), r(5, 1, 'INDEX RANGE SCAN IX_C')]);
  const b = livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'UNION-ALL'), r(2, 1, 'FILTER', `NVL(${V},'0')<>'2'`), r(3, 2, 'HASH JOIN'),
    r(4, 3, 'NESTED LOOPS'), r(5, 4, 'TABLE ACCESS FULL B'), r(6, 4, 'INDEX RANGE SCAN IX_C'), r(7, 3, 'TABLE ACCESS FULL A'),
    r(8, 1, 'FILTER', `${V}='2'`), r(9, 8, 'TABLE ACCESS FULL A')]);
  assert.notEqual(planDiff(a, b), undefined);
  // VIEW PUSHED PREDICATE is a choice of the optimizer, not wrapping
  assert.notEqual(planDiff(a, livePlan([r(0, null, 'SELECT STATEMENT'), r(1, 0, 'NESTED LOOPS'), r(2, 1, 'HASH JOIN'), r(3, 2, 'TABLE ACCESS FULL A'),
    r(4, 2, 'TABLE ACCESS FULL B'), r(5, 1, 'VIEW PUSHED PREDICATE V'), r(6, 5, 'INDEX RANGE SCAN IX_C')])), undefined);
});

test('schema: a view whose points all run one by one keeps a recording wrapper; a plain view goes in as written', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'plgauge-')), 'w.sql');
  writeFileSync(path, 'create or replace view w as\n  with x as (select a from t where a > 0)\n  select a from x where a < 3;\n');
  const ms = expand(findPoints([path]));
  const all = new Set(ms.map((m) => m.point));
  const su = buildSchema(ms, new Set(), all, 'DEMO')[0];
  assert.deepEqual(su.mutants, []);
  assert.deepEqual(su.recorded, ms.map((m) => m.id));
  assert.equal((su.text.match(/UNION ALL/g) ?? []).length, 0);
  assert.ok(su.text.includes(`(SELECT plgauge_ctl.hit_sql(1, ${ms.length}) FROM dual) = 0`), su.text);
  const plain = buildSchema(ms, new Set(), all, 'DEMO', new Set(), new Set([su.key]))[0];
  assert.equal(plain.text, plain.original);
  assert.deepEqual(plain.recorded, []);
});
