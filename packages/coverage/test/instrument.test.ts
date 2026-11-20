import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrument } from '@plgauge/coverage';
import { analyze } from '@plgauge/coverage';
import { newIds, type Hits } from '@plgauge/coverage';

const run = (src: string, sqlProbes = true) => instrument(src, 'S', newIds(), { sqlProbes });
const proc = (body: string, decl = '') => `procedure p(a number, b number, c boolean) is\n${decl}begin\n${body}\nend p;\n`;

test('keeps line count and never inserts line breaks', () => {
  const src = proc('  if a > 1\n     and b > 2 then\n    null;\n  end if;');
  const r = run(src);
  assert.equal(r.instrumented.split('\n').length, src.split('\n').length);
  assert.match(r.instrumented, /cov\$\.d\(1,cov\$\.o\(1\) and \(cov\$\.c\(1,1,a > 1\)\n\s+and cov\$\.c\(1,2,b > 2\)\)\) then/);
});

test('BETWEEN ... AND stays one condition', () => {
  const r = run(proc('  if a between 1 and 5 and b = 2 then null; end if;'));
  assert.deepEqual(r.map.decisions[0].conds.map((c) => c.text), ['a between 1 and 5', 'b = 2']);
});

test('parentheses and NOT build the boolean tree', () => {
  const r = run(proc('  if not (a > 1 or b > 1) and c then null; end if;'));
  const d = r.map.decisions[0];
  assert.deepEqual(d.tree, { t: 'and', c: [{ t: 'not', c: [{ t: 'or', c: [{ t: 'cond', i: 1 }, { t: 'cond', i: 2 }] }] }, { t: 'cond', i: 3 }] });
  // under NOT the probes use negative polarity (n) so NULL short-circuits like in the original
  assert.match(r.instrumented, /not \(cov\$\.n\(1,1,a > 1\) or cov\$\.n\(1,2,b > 1\)\) and cov\$\.c\(1,3,c\)/);
});

test('parenthesised comparison and function calls are atoms', () => {
  const r = run(proc("  if (a > 1) and nvl(b, 0) in (1, 2) and f(a and c) then null; end if;"));
  assert.deepEqual(r.map.decisions[0].conds.map((c) => c.text), ['(a > 1)', 'nvl(b, 0) in (1, 2)', 'f(a and c)']);
});

test('keywords in strings and comments are ignored', () => {
  const r = run(proc("  if a = 1 /* then if */ then -- if b then\n    dbms_output.put_line('end if; then and');\n    x := q'[ end; ]';\n  end if;"));
  assert.equal(r.map.decisions.length, 1);
  assert.equal(r.map.statements.length, 3);
});

test('simple CASE statement gets branch probes and keeps CASE_NOT_FOUND semantics', () => {
  const r = run(proc("  case a\n    when 1 then null;\n    when 2 then null;\n  end case;"));
  assert.match(r.instrumented, /else cov\$\.b\(3\); raise case_not_found; end case;/);
  assert.equal(r.map.constructs[0].branches.length, 3);
});

test('searched CASE statement derives branches from decisions', () => {
  const r = run(proc('  case\n    when a > 1 then null;\n    else null;\n  end case;'));
  const c = r.map.constructs[0];
  assert.deepEqual(c.branches.map((b) => b.derived?.outcome), ['T', 'notT']);
});

test('labels, loops and EXIT label WHEN', () => {
  const r = run(proc('  <<outer>>\n  for i in 1 .. 3 loop\n    exit outer when i = 2;\n  end loop outer;'));
  assert.match(r.instrumented, /cov\$\.s\(1\);cov\$\.le\(1\);<<outer>>/);
  assert.match(r.instrumented, /exit outer when cov\$\.d\(1,/);
  assert.match(r.instrumented, /end loop outer; cov\$\.lx\(1\);/);
  assert.equal(r.map.loops[0].kind, 'for');
});

test('probe goes in front of PRAGMA INLINE', () => {
  const r = run(proc("  pragma inline(f, 'YES');\n  x := f(1);"));
  assert.match(r.instrumented, /cov\$\.s\(1\);pragma inline\(f, 'YES'\);\n  x := f\(1\);/);
});

test('PRAGMA COVERAGE NOT_FEASIBLE marks the rest of the block', () => {
  const r = run(proc("  null;\nexception\n  when others then\n    pragma coverage('NOT_FEASIBLE');\n    log(1);\n    raise;"));
  assert.deepEqual(r.map.statements.map((s) => s.nf), [false, true, true]);
  assert.equal(r.map.constructs[0].branches[0].nf, true);
});

test('package body with nested and forward-declared subprograms', () => {
  const src = `package body pk is
  g number := case when sysdate > date '2000-01-01' then 1 else 0 end;
  procedure fwd;
  function f(x number) return number deterministic is
    function inner(y number) return number is begin return y; end;
  begin
    return inner(x);
  end f;
  procedure fwd is begin null; end;
begin
  g := 2;
end pk;
`;
  const r = run(src);
  assert.equal(r.map.type, 'PACKAGE BODY');
  assert.equal(r.map.name, 'PK');
  assert.equal(r.map.statements.length, 4);
  assert.equal(r.map.decisions[0].kind, 'case-expr-when');
});

test('type body constructor with RETURN SELF AS RESULT', () => {
  const src = `type body t is
  constructor function t(p number) return self as result is
  begin
    self.v := p;
    return;
  end;
  member function get return number is begin return self.v; end;
end;
`;
  const r = run(src);
  assert.equal(r.map.type, 'TYPE BODY');
  assert.equal(r.map.statements.length, 3);
});

test('trigger body is instrumented, WHEN clause reported as gap', () => {
  const src = `trigger trg before insert on t for each row when (new.x > 0)
declare
  v number;
begin
  if :new.x > 10 then :new.x := 10; end if;
end;
`;
  const r = run(src);
  assert.equal(r.map.type, 'TRIGGER');
  assert.equal(r.map.decisions.length, 1);
  assert.equal(r.map.gaps.length, 1);
});

test('SQL: CASE in select list and SET is instrumented, WHERE and GROUP BY are not', () => {
  const r = run(proc(`  select case when a > 1 then 1 end into x from dual where case when b > 1 then 1 end = 1;
  select case when a > 1 then 1 end, count(*) into x, y from dual group by case when a > 1 then 1 end;
  update t set v = case when c then 1 else 0 end where id = 1;`));
  assert.equal(r.map.decisions.filter((d) => d.ctx === 'sql').length, 2);
  assert.ok(r.map.gaps.some((g) => g.reason.includes('WHERE')));
  assert.ok(r.map.gaps.some((g) => g.reason.includes('GROUP BY')));
});

test('SQL probes can be switched off for databases before 23ai', () => {
  const r = run(proc('  select case when a > 1 then 1 end into x from dual;'), false);
  assert.equal(r.map.decisions.length, 0);
  assert.match(r.map.gaps[0].reason, /23ai/);
});

test('SQL: CASE with IN / ANY / ALL (subquery) is left alone, EXISTS and scalar subqueries are measured', () => {
  // Oracle refuses these as BOOLEAN arguments in SQL (PLS-00306 on cov$.qc / qd)
  const refused = [
    'a in (select column_value from table(ids))',
    'a not in (select 1 from dual)',
    '(a, b) in (select 1, 2 from dual)',
    'a in ((select 1 from dual))',
    'a > any (select 1 from dual)',
    'a = some (select 1 from dual)',
    'a > all (select 1 from dual)',
    'b > 1 and (a in (with w as (select 1 c from dual) select c from w))',
  ];
  for (const cond of refused) {
    const r = run(proc(`  select case when b = 0 then 0 when ${cond} then 1 else case when b > 2 then 2 end end into x from dual;
  update t set v = case when ${cond} then 1 end, w = case when c then 1 end;`));
    // neither qd nor qc around them; only the nested CASE and the other CASE in SET remain
    assert.ok(!r.instrumented.includes('cov$.qd(1,b = 0') && r.instrumented.includes(`when ${cond} then`), cond);
    assert.deepEqual(r.map.decisions.map((d) => d.text), ['b > 2', 'c'], cond);
    assert.deepEqual(r.map.constructs.map((c) => c.branches.map((b) => b.derived!.decision)), [[1, 1], [2, 2]], cond);
    assert.deepEqual(r.map.gaps.map((g) => [g.line, g.reason]), [3, 4].map((l) => [l, 'CASE with IN, ANY or ALL (subquery) in its condition in SQL is not measured']), cond);
  }
  const measured = [
    'exists (select 1 from dual where a in (select 1 from dual))',
    'not exists (select 1 from dual)',
    'a = (select 1 from dual)',
    '(select count(*) from dual) > 0',
    'a in (1, (select 2 from dual))',
    '(case when a in (select 1 from dual) then 1 end) = 1',
  ];
  for (const cond of measured) {
    const r = run(proc(`  select case when ${cond} then 1 end into x from dual;`));
    assert.equal(r.map.decisions.length, 1, cond);
    assert.ok(r.instrumented.includes('cov$.qd(1,'), cond);
    assert.ok(!r.map.gaps.some((g) => g.reason.includes('subquery')), cond);
  }
});

test('MC/DC: detects independence pairs and proposes the missing vector', () => {
  const r = run(proc('  if a > 1 and b > 1 then null; end if;'));
  const hits: Hits = { stmt: new Map(), branch: new Map(), cond: new Map(), dec: new Map(), vec: new Map(), loop: new Map(), perTest: new Map() };
  // observed: (T,T)->T and (F,-)->F
  hits.vec.set(`1|TT|T`, 3);
  hits.vec.set(`1|F-|F`, 2);
  for (const k of ['1:1:T', '1:1:F', '1:2:T']) hits.cond.set(k, 1);
  hits.dec.set('1:T', 3);
  hits.dec.set('1:F', 2);
  const res = analyze(r.map, hits);
  const [c1, c2] = res.decisions[0].conds;
  assert.equal(c1.mcdc, 'yes');
  assert.equal(c2.mcdc, 'no');
  assert.match(c2.suggestion!, /`a > 1` = TRUE, `b > 1` = FALSE → result FALSE/);
  assert.deepEqual(res.metrics.mcdc, { covered: 1, total: 2 });
  assert.deepEqual(res.metrics.branch, { covered: 2, total: 2 });
});

// Constructs that IslandSQL 0.26 nests wrongly (reported by plmut); the instrumenter must split them correctly.
test('regression corpus: tricky boolean structures', () => {
  const cases: [string, string[]][] = [
    ['x between a and b and y', ['x between a and b', 'y']],
    ['x is not null and y is of (t)', ['x is not null', 'y is of (t)']],
    ['x and y is null', ['x', 'y is null']],
    ['c%found and c%rowcount > 1', ['c%found', 'c%rowcount > 1']],
    ['a - b + c > 0 and a / b * c < 1', ['a - b + c > 0', 'a / b * c < 1']],
    ["a || b = 'x' or a + 1 || b = c", ["a || b = 'x'", 'a + 1 || b = c']],
    ['not x between 1 and 2 or y not between 3 and 4', ['x between 1 and 2', 'y not between 3 and 4']],
    ["x in ('and', 'or') and y like '%and%'", ["x in ('and', 'or')", "y like '%and%'"]],
  ];
  for (const [cond, expected] of cases) {
    const r = run(proc(`  if ${cond} then null; end if;`));
    assert.deepEqual(r.map.decisions[0].conds.map((c) => c.text), expected, cond);
  }
});

test('offline preprocessor keeps the last $IF branch and every line break', async () => {
  const { preprocess } = await import('@plgauge/core');
  const src = "begin\n  $if dbms_db_version.version < 12 $then\n  old;\n  $elsif x $then mid;\n  $else\n  new($$plsql_line);\n  $end\n  $error 'nope' $end\nend;\n";
  const out = preprocess(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.doesNotMatch(out, /old|mid|\$if|\$else|\$end|nope/);
  assert.match(out, /new\(\$\$plsql_line\);/);
});

test('keywords glued to parentheses stay separate tokens (found by the corpus compile check)', () => {
  const r = run(proc('  if(a = 1)then null; elsif(b = 2) then null; end if;\n  while(a > 0) loop a := a - 1; end loop;\n  if not(c) then null; end if;'));
  assert.match(r.instrumented, /if cov\$\.d\(1,/);
  assert.match(r.instrumented, /elsif cov\$\.d\(2,/);
  assert.match(r.instrumented, /while cov\$\.d\(3,/);
  assert.match(r.instrumented, /not cov\$\.n\(4,1,\(c\)\)/);
  assert.doesNotMatch(r.instrumented, /[a-z]cov\$/);
});

test('instrument: a GOTO target keeps its statement probe; a loop label stays on the loop; dead ELSE keeps tokens together', () => {
  const r = run(proc(`  IF a = 1 THEN GOTO done; END IF;
  <<done>> NULL;
  <<outer>> LOOP EXIT outer; END LOOP outer;`));
  // the probe of NULL; comes after its label: the GOTO reaches it
  assert.match(r.instrumented, /<<done>>\s*cov\$\.s\(\d+\);\s*NULL;/i);
  assert.match(r.instrumented, /cov\$\.s\(\d+\);(cov\$\.le\(\d+\);)?\s*<<outer>>\s*LOOP/i);
});

test('instrument: a labelled block or CASE statement keeps its label (qualified names, END label)', () => {
  const r = run(proc(`  <<blk>> DECLARE x NUMBER := 2; BEGIN dbms_output.put_line(blk.x); END blk;
  <<l2>> CASE a WHEN 1 THEN NULL; ELSE NULL; END CASE l2;`));
  assert.match(r.instrumented, /cov\$\.s\(\d+\);\s*<<blk>>\s*DECLARE/i);
  assert.match(r.instrumented, /cov\$\.s\(\d+\);\s*<<l2>>\s*CASE/i);
});
