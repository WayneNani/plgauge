/**
 * Integration test against a real database (skipped unless PLCOV_DB is set):
 *   PLCOV_DB=demo/demo@localhost:1521/FREEPDB1 npm test
 * Compiles an instrumented package full of edge cases and checks that its
 * behaviour is identical to the original.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import oracledb from 'oracledb';
import { instrument } from '@pltest/coverage';
import { newIds } from '@pltest/coverage';
import { installRuntime } from '@pltest/coverage';

const db = process.env.PLCOV_DB;
const m = db ? /^([^/]+)\/([^@]+)@(.+)$/.exec(db) : null;

test('instrumented code behaves exactly like the original', { skip: !m && 'PLCOV_DB not set' }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  try {
    await installRuntime(conn);
    await conn.execute(`create or replace package plcov_torture is
      g_calls number := 0;
      function check_all return varchar2;
    end;`);
    const body = readFileSync(new URL('./fixtures/torture.pkb', import.meta.url), 'utf8');
    const check = async () => (await conn.execute<[string]>(`select plcov_torture.check_all from dual`)).rows![0][0];

    await conn.execute(`create or replace ${body}`);
    const expected = await check();

    const r = instrument(body, m![1].toUpperCase(), newIds(), { sqlProbes: true });
    await conn.execute(`create or replace ${r.instrumented}`);
    const errs = await conn.execute(`select line, text from user_errors where name = 'PLCOV_TORTURE'`);
    assert.deepEqual(errs.rows, [], 'instrumented package compiles');
    await conn.execute(`begin cov$.reset; cov$.per_test(true); end;`);
    const actual = await check();
    assert.equal(actual, expected);
    // golden value produced by the original (uninstrumented) package
    assert.equal(expected, 'Y2O3O3N3,D5A2D4A1D4D5,TFN,120,aCNF-6592,bigsmallZDT,midnullother,21:5');

    // the probes really recorded something: shortcircuit decision 1 saw (T,T)->T and (F,-)->F
    await conn.execute(`begin cov$.flush('torture'); end;`);
    const v = await conn.execute<[string]>(`select k from plcov_hits where run_id = 'torture' and kind = 'V' and k like '1|%'`);
    assert.ok(v.rows!.length >= 3, 'condition vectors recorded');
    // per-test mode outside utPLSQL: everything lands in the "#" setup bucket
    const pt = await conn.execute<[string, number]>(`select test, count(*) from plcov_hits where run_id = 'torture' and kind = 's' group by test`);
    assert.deepEqual(pt.rows!.map((r) => r[0]), ['#']);
    await conn.execute(`delete from plcov_hits where run_id = 'torture'`);
    await conn.commit();
  } finally {
    await conn.execute(`drop package plcov_torture`).catch(() => undefined);
    await conn.close();
  }
});

test('simple CASE expressions, FOR filters (21c) and compound triggers: measured, behaviour unchanged', { skip: !m && 'PLCOV_DB not set' }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  const body = `package body plcov_constructs is
  function word(n number) return varchar2 is
  begin
    return case n when 1 then 'eins' when 2 then 'zwei' else 'viel' end
        || case mod(n, 2) when 0 then '/gerade' end;
  end;
  function in_sql(n number) return varchar2 is
    r varchar2(20);
  begin
    select case n when 1 then 'a' when 2 then 'b' end into r from dual;
    return nvl(r, '-');
  end;
  function filtered return varchar2 is
    s varchar2(100);
  begin
    for i in 1 .. 10 when mod(i, 3) = 0 loop s := s || i; end loop;
    for i in 1 .. 10 while i < 4 loop s := s || '.' || i; end loop;
    return s;
  end;
  function check_all return varchar2 is
    l varchar2(400);
  begin
    for k in 1 .. 4 loop l := l || word(k) || ',' || in_sql(k) || ';'; end loop;
    delete from plcov_constructs_t;
    insert into plcov_constructs_t values (1);
    update plcov_constructs_t set n = 2;
    for r in (select n from plcov_constructs_t) loop l := l || r.n; end loop;
    return l || filtered;
  end;
end;`;
  const trigger = `trigger plcov_constructs_trg for insert or update on plcov_constructs_t compound trigger
  g_rows pls_integer := 0;
  before each row is
  begin
    if inserting then :new.n := :new.n * 10; else :new.n := :new.n + 1; end if;
    g_rows := g_rows + 1;
  end before each row;
  after statement is
  begin
    if g_rows > 5 then raise_application_error(-20001, 'zu viele'); end if;
  end after statement;
end plcov_constructs_trg;`;
  try {
    await installRuntime(conn);
    await conn.execute(`create table plcov_constructs_t (n number)`).catch(() => undefined);
    await conn.execute(`create or replace package plcov_constructs is function check_all return varchar2; end;`);
    // check_all changes a table: call it from PL/SQL, not from a query
    const check = async () => {
      const r = await conn.execute(`begin :r := plcov_constructs.check_all; end;`, { r: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 400 } });
      return (r.outBinds as { r: string }).r;
    };
    await conn.execute(`create or replace ${body}`);
    await conn.execute(`create or replace ${trigger}`);
    const expected = await check();
    // update fires the trigger: 1 inserted as 10, updated to 2 + 1 = 3; filters: 3 6 9, then 1 2 3
    assert.equal(expected, 'eins,a;zwei/gerade,b;viel,-;viel/gerade,-;3369.1.2.3');

    const ids = newIds();
    const rb = instrument(body, m![1].toUpperCase(), ids, { sqlProbes: true });
    const rt = instrument(trigger, m![1].toUpperCase(), ids, { sqlProbes: true });
    assert.deepEqual([...rb.map.gaps, ...rt.map.gaps], []);
    await conn.execute(`create or replace ${rb.instrumented}`);
    await conn.execute(`create or replace ${rt.instrumented}`);
    const errs = await conn.execute(`select name, line, text from user_errors where name in ('PLCOV_CONSTRUCTS', 'PLCOV_CONSTRUCTS_TRG')`);
    assert.deepEqual(errs.rows, [], 'instrumented code compiles');
    await conn.execute(`begin cov$.reset; end;`);
    assert.equal(await check(), expected);
    await conn.execute(`begin cov$.flush('constructs'); end;`);
    const hit = new Set((await conn.execute<[string]>(`select k from plcov_hits where run_id = 'constructs' and kind = 'B'`)).rows!.map((r) => Number(r[0])));
    // every branch of the three simple CASE expressions (3 + 2 + 3, implicit ELSE included) was taken
    const simple = rb.map.constructs.filter((c) => c.kind === 'case-expr').flatMap((c) => c.branches.map((b) => b.probe!));
    assert.equal(simple.length, 8);
    assert.deepEqual(simple.filter((p) => !hit.has(p)), []);
    // FOR WHEN / WHILE decisions and the compound trigger's statements were recorded
    assert.ok(rb.map.decisions.some((d) => d.kind === 'for-when') && rb.map.decisions.some((d) => d.kind === 'for-while'));
    const stmts = new Set((await conn.execute<[string]>(`select k from plcov_hits where run_id = 'constructs' and kind = 'S'`)).rows!.map((r) => Number(r[0])));
    // all statements of both timing points ran, except raise_application_error (never more than 5 rows)
    assert.deepEqual(rt.map.statements.filter((s) => !stmts.has(s.id)).map((s) => s.kind), ['call']);
    assert.equal(rt.map.statements.length, 6);
    await conn.execute(`delete from plcov_hits where run_id = 'constructs'`);
    await conn.commit();
  } finally {
    await conn.execute(`drop table plcov_constructs_t`).catch(() => undefined);
    await conn.execute(`drop package plcov_constructs`).catch(() => undefined);
    await conn.close();
  }
});
