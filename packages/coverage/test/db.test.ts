/**
 * Integration test against a real database (skipped unless PLGAUGE_COV_DB is set):
 *   PLGAUGE_COV_DB=demo/demo@localhost:1521/FREEPDB1 npm test
 * Compiles an instrumented package full of edge cases and checks that its
 * behaviour is identical to the original.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import oracledb from 'oracledb';
import { instrument } from '@plgauge/coverage';
import { newIds } from '@plgauge/coverage';
import { installRuntime } from '@plgauge/coverage';

const db = process.env.PLGAUGE_COV_DB;
const m = db ? /^([^/]+)\/([^@]+)@(.+)$/.exec(db) : null;

test('instrumented code behaves exactly like the original', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  try {
    await installRuntime(conn);
    await conn.execute(`create or replace package plgauge_torture is
      g_calls number := 0;
      function check_all return varchar2;
    end;`);
    const body = readFileSync(new URL('./fixtures/torture.pkb', import.meta.url), 'utf8');
    const check = async () => (await conn.execute<[string]>(`select plgauge_torture.check_all from dual`)).rows![0][0];

    await conn.execute(`create or replace ${body}`);
    const expected = await check();

    const r = instrument(body, m![1].toUpperCase(), newIds(), { sqlProbes: true });
    await conn.execute(`create or replace ${r.instrumented}`);
    const errs = await conn.execute(`select line, text from user_errors where name = 'PLGAUGE_TORTURE'`);
    assert.deepEqual(errs.rows, [], 'instrumented package compiles');
    await conn.execute(`begin cov$.reset; cov$.per_test(true); end;`);
    const actual = await check();
    assert.equal(actual, expected);
    // golden value produced by the original (uninstrumented) package
    assert.equal(expected, 'Y2O3O3N3,D5A2D4A1D4D5,TFN,120,aCNF-6592,bigsmallZDT,midnullother,21:5');

    // the probes really recorded something: shortcircuit decision 1 saw (T,T)->T and (F,-)->F
    await conn.execute(`begin cov$.flush('torture'); end;`);
    const v = await conn.execute<[string]>(`select k from plgauge_hits where run_id = 'torture' and kind = 'V' and k like '1|%'`);
    assert.ok(v.rows!.length >= 3, 'condition vectors recorded');
    // per-test mode outside utPLSQL: everything lands in the "#" setup bucket
    const pt = await conn.execute<[string, number]>(`select test, count(*) from plgauge_hits where run_id = 'torture' and kind = 's' group by test`);
    assert.deepEqual(pt.rows!.map((r) => r[0]), ['#']);
    await conn.execute(`delete from plgauge_hits where run_id = 'torture'`);
    await conn.commit();
  } finally {
    await conn.execute(`drop package plgauge_torture`).catch(() => undefined);
    await conn.close();
  }
});

test('simple CASE expressions, FOR filters (21c) and compound triggers: measured, behaviour unchanged', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  const body = `package body plgauge_constructs is
  function word(n number) return varchar2 is
  begin
    return case n when 1 then 'one' when 2 then 'two' else 'many' end
        || case mod(n, 2) when 0 then '/even' end;
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
    delete from plgauge_constructs_t;
    insert into plgauge_constructs_t values (1);
    update plgauge_constructs_t set n = 2;
    for r in (select n from plgauge_constructs_t) loop l := l || r.n; end loop;
    return l || filtered;
  end;
end;`;
  const trigger = `trigger plgauge_constructs_trg for insert or update on plgauge_constructs_t compound trigger
  g_rows pls_integer := 0;
  before each row is
  begin
    if inserting then :new.n := :new.n * 10; else :new.n := :new.n + 1; end if;
    g_rows := g_rows + 1;
  end before each row;
  after statement is
  begin
    if g_rows > 5 then raise_application_error(-20001, 'too many'); end if;
  end after statement;
end plgauge_constructs_trg;`;
  try {
    await installRuntime(conn);
    await conn.execute(`create table plgauge_constructs_t (n number)`).catch(() => undefined);
    await conn.execute(`create or replace package plgauge_constructs is function check_all return varchar2; end;`);
    // check_all changes a table: call it from PL/SQL, not from a query
    const check = async () => {
      const r = await conn.execute(`begin :r := plgauge_constructs.check_all; end;`, { r: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 400 } });
      return (r.outBinds as { r: string }).r;
    };
    await conn.execute(`create or replace ${body}`);
    await conn.execute(`create or replace ${trigger}`);
    const expected = await check();
    // update fires the trigger: 1 inserted as 10, updated to 2 + 1 = 3; filters: 3 6 9, then 1 2 3
    assert.equal(expected, 'one,a;two/even,b;many,-;many/even,-;3369.1.2.3');

    const ids = newIds();
    const rb = instrument(body, m![1].toUpperCase(), ids, { sqlProbes: true });
    const rt = instrument(trigger, m![1].toUpperCase(), ids, { sqlProbes: true });
    assert.deepEqual([...rb.map.gaps, ...rt.map.gaps], []);
    await conn.execute(`create or replace ${rb.instrumented}`);
    await conn.execute(`create or replace ${rt.instrumented}`);
    const errs = await conn.execute(`select name, line, text from user_errors where name in ('PLGAUGE_CONSTRUCTS', 'PLGAUGE_CONSTRUCTS_TRG')`);
    assert.deepEqual(errs.rows, [], 'instrumented code compiles');
    await conn.execute(`begin cov$.reset; end;`);
    assert.equal(await check(), expected);
    await conn.execute(`begin cov$.flush('constructs'); end;`);
    const hit = new Set((await conn.execute<[string]>(`select k from plgauge_hits where run_id = 'constructs' and kind = 'B'`)).rows!.map((r) => Number(r[0])));
    // every branch of the three simple CASE expressions (3 + 2 + 3, implicit ELSE included) was taken
    const simple = rb.map.constructs.filter((c) => c.kind === 'case-expr').flatMap((c) => c.branches.map((b) => b.probe!));
    assert.equal(simple.length, 8);
    assert.deepEqual(simple.filter((p) => !hit.has(p)), []);
    // FOR WHEN / WHILE decisions and the compound trigger's statements were recorded
    assert.ok(rb.map.decisions.some((d) => d.kind === 'for-when') && rb.map.decisions.some((d) => d.kind === 'for-while'));
    const stmts = new Set((await conn.execute<[string]>(`select k from plgauge_hits where run_id = 'constructs' and kind = 'S'`)).rows!.map((r) => Number(r[0])));
    // all statements of both timing points ran, except raise_application_error (never more than 5 rows)
    assert.deepEqual(rt.map.statements.filter((s) => !stmts.has(s.id)).map((s) => s.kind), ['call']);
    assert.equal(rt.map.statements.length, 6);
    await conn.execute(`delete from plgauge_hits where run_id = 'constructs'`);
    await conn.commit();
  } finally {
    await conn.execute(`drop table plgauge_constructs_t`).catch(() => undefined);
    await conn.execute(`drop package plgauge_constructs`).catch(() => undefined);
    await conn.close();
  }
});

test('subqueries in SQL CASE conditions: IN / ANY / ALL left alone, EXISTS and scalar ones measured, behaviour unchanged', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  const body = `package body plgauge_subq is
  function check_all return varchar2 is
    ids sys.odcivarchar2list := sys.odcivarchar2list(' 1', '3 ');
    l varchar2(400);
  begin
    delete from plgauge_subq_t;
    insert into plgauge_subq_t (id, n)
      select level, case when to_char(level) in (select trim(column_value) from table(ids)) then 1 else 0 end from dual connect by level <= 4;
    insert into plgauge_subq_t (id, n) values (5, case when 5 > all (select to_number(column_value) from table(ids)) then 1 end);
    update plgauge_subq_t set n = n + case when id not in (select 2 from dual) then 10 else 20 end,
      s = case when exists (select 1 from dual where id = 3) then 'e' when id = (select 4 from dual) then 's' else '-' end;
    merge into plgauge_subq_t t using (
      select id, case when (id, 1) in (select level, 1 from dual connect by level <= 2) then true else false end as b,
        case when (select count(*) from dual where id > 1) > 0 then 'y' else 'n' end as c
      from plgauge_subq_t) s on (t.id = s.id) when matched then update set t.b = s.b, t.s = t.s || s.c;
    for r in (select id, n, s, case when b then 'T' else 'F' end b, case when id = any (select 2 from dual) then '!' end x
              from plgauge_subq_t order by id) loop
      l := l || r.id || r.n || r.s || r.b || r.x || ';';
    end loop;
    return l;
  end;
end;`;
  try {
    await installRuntime(conn);
    await conn.execute(`create table plgauge_subq_t (id number, n number, s varchar2(10), b boolean)`).catch(() => undefined);
    await conn.execute(`create or replace package plgauge_subq is function check_all return varchar2; end;`);
    const check = async () => {
      const r = await conn.execute(`begin :r := plgauge_subq.check_all; end;`, { r: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 400 } });
      return (r.outBinds as { r: string }).r;
    };
    await conn.execute(`create or replace ${body}`);
    const expected = await check();
    assert.equal(expected, '111-nT;220-yT!;311eyF;410syF;511-yF;');

    const r = instrument(body, m![1].toUpperCase(), newIds(), { sqlProbes: true });
    await conn.execute(`create or replace ${r.instrumented}`);
    const errs = await conn.execute(`select line, text from user_errors where name = 'PLGAUGE_SUBQ'`);
    assert.deepEqual(errs.rows, [], 'instrumented package compiles');
    // the five CASEs with IN / ANY / ALL are gaps; EXISTS, the scalar subqueries and CASE WHEN b stay measured
    assert.equal(r.map.gaps.length, 5);
    assert.deepEqual(r.map.decisions.filter((d) => d.ctx === 'sql').map((d) => d.text),
      ['exists (select 1 from dual where id = 3)', 'id = (select 4 from dual)', '(select count(*) from dual where id > 1) > 0', 'b']);
    await conn.execute(`begin cov$.reset; end;`);
    assert.equal(await check(), expected);
  } finally {
    await conn.execute(`drop table plgauge_subq_t`).catch(() => undefined);
    await conn.execute(`drop package plgauge_subq`).catch(() => undefined);
    await conn.close();
  }
});

// Several schemas (A4): needs a second schema and CREATE ANY PROCEDURE, EXECUTE ANY PROCEDURE for the
// connected user, e.g. PLGAUGE_LIB_SCHEMA=DEMO_LIB (ci/setup-db.sh creates it as APP_LIB).
const lib = process.env.PLGAUGE_LIB_SCHEMA;
test('several schemas: code of another schema is measured, the runtime stays with the user', { skip: (!m || !lib) && 'PLGAUGE_COV_DB / PLGAUGE_LIB_SCHEMA not set', timeout: 300_000 }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  const L = lib!.toUpperCase();
  try {
    await conn.execute(`create or replace package ${L}.plgauge_calc is function grade(n number) return varchar2; end;`);
    await conn.execute(`create or replace package body ${L}.plgauge_calc is
      function grade(n number) return varchar2 is
      begin
        if n >= 90 then return 'A'; elsif n >= 50 then return 'B'; end if;
        return 'C';
      end;
    end;`);
    await conn.execute(`create or replace package plgauge_multi_test is
      --%suite

      --%test
      procedure top;
      --%test
      procedure middle;
    end;`);
    await conn.execute(`create or replace package body plgauge_multi_test is
      procedure top is begin ut.expect(${L}.plgauge_calc.grade(95)).to_equal('A'); end;
      procedure middle is begin ut.expect(${L}.plgauge_calc.grade(60)).to_equal('B'); end;
    end;`);
    const { runCoverage } = await import('@plgauge/coverage');
    const r = await runCoverage({
      user: m![1], password: m![2], connectString: m![3], schema: m![1], schemas: [L], include: '^PLGAUGE_CALC$',
      tests: ['plgauge_multi_test'], baselineRuns: 1,
    }, () => {});
    assert.ok(r.equivalent, 'same results with instrumentation');
    const o = r.objects.find((x) => x.name === 'PLGAUGE_CALC')!;
    assert.equal(o.owner, L);
    assert.equal(o.instrumentError, undefined);
    assert.deepEqual(o.metrics.stmt, { covered: 3, total: 4 }); // IF and two RETURNs ran, RETURN 'C' never
    assert.equal(o.lineTests[4]?.length, 2, 'both tests reach the IF');
    // the original code is back
    const src = await conn.execute<[string]>(`select text from all_source where owner = :o and name = 'PLGAUGE_CALC' and type = 'PACKAGE BODY' and text like '%cov$%'`, { o: L });
    assert.equal(src.rows!.length, 0);
  } finally {
    await conn.execute(`drop package plgauge_multi_test`).catch(() => undefined);
    await conn.execute(`drop package ${L}.plgauge_calc`).catch(() => undefined);
    await conn.close();
  }
});

// Other sessions (A8): a scheduler job started by a test. Needs CREATE JOB.
test('hits of a scheduler job started by a test are collected under #background', { skip: !m && 'PLGAUGE_COV_DB not set', timeout: 300_000 }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  const canJob = (await conn.execute<[number]>(`select count(*) from session_privs where privilege = 'CREATE JOB'`)).rows![0][0] > 0;
  if (!canJob) {
    await conn.close();
    return; // nothing to check without the privilege
  }
  try {
    await conn.execute(`create or replace procedure plgauge_bg_work(n number) is
      s number := 0;
    begin
      for i in 1 .. n loop
        s := s + i;
      end loop;
      if s > 10 then
        dbms_output.put_line(s);
      end if;
    end;`);
    await conn.execute(`create or replace package plgauge_bg_test is
      --%suite

      --%test
      procedure job_runs;
    end;`);
    await conn.execute(`create or replace package body plgauge_bg_test is
      procedure job_runs is
        n number;
      begin
        dbms_scheduler.create_job(job_name => 'PLGAUGE_BG_JOB', job_type => 'PLSQL_BLOCK',
          job_action => 'begin plgauge_bg_work(5); end;', enabled => true, auto_drop => true);
        for i in 1 .. 60 loop
          select count(*) into n from user_scheduler_jobs where job_name = 'PLGAUGE_BG_JOB';
          exit when n = 0;
          dbms_session.sleep(0.5);
        end loop;
        ut.expect(n).to_equal(0);
      end;
    end;`);
    const { runCoverage } = await import('@plgauge/coverage');
    const r = await runCoverage({
      user: m![1], password: m![2], connectString: m![3], schema: m![1], include: '^PLGAUGE_BG_WORK$', tests: ['plgauge_bg_test'], baselineRuns: 1,
    }, () => {});
    const o = r.objects.find((x) => x.name === 'PLGAUGE_BG_WORK')!;
    assert.equal(o.instrumentError, undefined);
    assert.deepEqual(o.metrics.stmt, { covered: 4, total: 4 }, 'the job ran every statement');
    const bg = r.tests.findIndex((t) => t.path === '#background');
    assert.ok(bg >= 0, 'background bucket');
    assert.ok(o.statements.every((s) => s.tests?.includes(bg)));
    const left = await conn.execute<[number]>(`select count(*) from user_triggers where trigger_name = 'COV$_LOGOFF'`);
    assert.equal(left.rows![0][0], 0, 'logoff trigger removed after the run');
  } finally {
    await conn.execute(`begin dbms_scheduler.drop_job('PLGAUGE_BG_JOB', force => true); end;`).catch(() => undefined);
    await conn.execute(`drop package plgauge_bg_test`).catch(() => undefined);
    await conn.execute(`drop procedure plgauge_bg_work`).catch(() => undefined);
    await conn.close();
  }
});
