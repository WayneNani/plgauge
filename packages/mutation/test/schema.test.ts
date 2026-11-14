/** Schema rewriter and oracle rewriter, offline (ported from plmut's schema_test.go). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSchema, expand, findPoints, locate, mutatedUnit, positionOf, type SourceFile } from '@pltest/mutation';

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
      p({ op: 'RET', kind: 'insert', start: at('BEGIN') + 5, end: at('BEGIN') + 5, mutants: [' RETURN NULL;', " RAISE_APPLICATION_ERROR(-20998, 'plmut: RET');"] }),
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
    'plmut$a CONSTANT PLS_INTEGER := plmut_ctl.active;',
    "BEGIN IF plmut$a = -1 THEN plmut_ctl.reach(1, 2); END IF; IF plmut$a = 1 THEN RETURN NULL; END IF; IF plmut$a = 2 THEN RAISE_APPLICATION_ERROR(-20998, 'plmut: RET'); END IF;",
    // SQL: the statement once per variant, the original (with the SBR switch) untouched
    'IF plmut$a = -1 THEN plmut_ctl.reach(4, 1); END IF; IF plmut$a = 4 THEN SELECT COUNT(*) INTO n FROM t WHERE x >= a; ELSE IF plmut$a = -1 THEN plmut_ctl.reach(3, 1); END IF; IF plmut$a <> 3 THEN SELECT COUNT(*) INTO n FROM t WHERE x > a; END IF; END IF;',
    'LOOP IF plmut$a <> 0 THEN plmut_ctl.tick(1); END IF; EXIT;',
    'RETURN (CASE CASE plmut$a WHEN -1 THEN plmut_ctl.hit(6, 1) ELSE plmut$a END WHEN 6 THEN (a - b - c) ELSE ((CASE CASE plmut$a WHEN -1 THEN plmut_ctl.hit(5, 1) ELSE plmut$a END WHEN 5 THEN (a + b) ELSE (a - b) END) + c) END);',
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
  assert.ok(got.includes('ELSE IF plmut_ctl.active() = -1'), got);
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
  assert.match(su.text, /IF plmut_ctl\.active\(\) = -1 THEN plmut_ctl\.reach\(2, 2\); plmut_ctl\.reach\(4, 1\); END IF; IF plmut_ctl\.active\(\) = 2 THEN UPDATE t SET b = 2 WHERE id = 3; ELSIF plmut_ctl\.active\(\) = 3 THEN UPDATE t SET a = 1 WHERE id = 3; ELSIF plmut_ctl\.active\(\) = 4 THEN UPDATE t SET a = 1, b = 2 WHERE FALSE; ELSE IF .*reach\(1, 1\).* <> 1 THEN UPDATE t SET a = 1, b = 2 WHERE id = 3; END IF; END IF;/);
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
  const path = join(mkdtempSync(join(tmpdir(), 'pltest-')), 'v.sql');
  writeFileSync(path, 'create or replace view v as\n  select a + 1 as b from t where a < 3;\n');
  const ms = expand(findPoints([path]));
  assert.deepEqual(ms.map((m) => `${m.id} ${m.op} ${m.mutated}`), ['1 AOR a - 1', '2 ROR a <= 3', '3 ROR a <> 3', '4 ROR FALSE', '5 WHR TRUE']);
  const su = buildSchema(ms, new Set(), new Set(), 'DEMO')[0];
  const V = "SYS_CONTEXT('PLMUT_CTX_", c = (s: string) => s.replaceAll("SYS_CONTEXT('PLMUT_CTX_4FF006CA6B88', 'ACTIVE')", 'V');
  assert.ok(su.text.includes(V), su.text);
  assert.equal(c(su.text), 'view v as\n  SELECT * FROM (select (CASE V WHEN \'1\' THEN (a - 1) ELSE (a + 1) END) as b from t where a < 3)' +
    " WHERE NVL(V, '0') NOT IN ('2', '3', '4', '5') AND (NVL(V, '0') <> '-1' OR (SELECT plmut_ctl.hit(1, 5) FROM dual) = 0)" +
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
  assert.ok(rest.startsWith("view v as\n  SELECT * FROM (select a + 1 as b from t where a < 3) WHERE NVL(V, '0') NOT IN ('5') AND (NVL(V, '0') <> '-1' OR (SELECT plmut_ctl.hit(1, 1) + plmut_ctl.hit(5, 1) FROM dual) = 0) UNION ALL"), rest);
  assert.deepEqual(part.recorded, [1]);
});

test('schema: view points without a block are recorded by the main block (no test that skips it queries the view)', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pltest-')), 'r.sql');
  writeFileSync(path, 'create view r as\n  with h (n) as (select 1 from dual union all select n + 1 from h where n < 3)\n  select n from h where n > 1;\n');
  const ms = expand(findPoints([path]));
  const loose = ms.filter((m) => !m.point.scope);
  assert.ok(loose.length > 0);
  const su = buildSchema(ms, new Set(), new Set(loose.map((m) => m.point)), 'DEMO')[0];
  assert.deepEqual(su.recorded, loose.map((m) => m.id));
  assert.ok(su.text.includes(`plmut_ctl.hit(${Math.min(...ms.map((m) => m.id))}`), su.text);
});

test('schema: an ordered view keeps its main query unwrapped; a failing wrapper marks its block broken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pltest-'));
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
  const i = su.text.indexOf('IF plmut_ctl.active() = -1');
  const line = 1 + (su.text.slice(0, i).match(/\n/g)?.length ?? 0);
  const rg = locate(su, line, i - su.text.lastIndexOf('\n', i - 1) + 1);
  assert.equal(rg?.mutantId, 0);
  assert.equal(rg?.points?.length, 2);
});

test('positionOf: offset to line and column in code points', () => {
  assert.deepEqual(positionOf('ab\ncä€d', 6), { line: 2, col: 4 });
  assert.deepEqual(positionOf('abc', 0), { line: 1, col: 1 });
});
