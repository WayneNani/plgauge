import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitScript } from '../src/script.js';

test('splitScript: a header comment before CREATE PACKAGE keeps the package whole; SQL*Plus commands drop out', () => {
  const parts = splitScript(`prompt Paket
set define off
-- Paket pricing
create or replace package pricing is
  c_vat constant number := 0.19;
  function net(p number) return number;
end;
/
-- Tabelle
create table t (x number);
insert into t values (1);
`);
  assert.equal(parts.length, 3);
  assert.ok(parts[0].includes('c_vat constant number := 0.19;') && parts[0].includes('function net'), parts[0]);
  assert.equal(parts[1], '-- Tabelle\ncreate table t (x number)');
  assert.equal(parts[2], 'insert into t values (1)');
});

test('splitScript: block comment headers, @includes, REM, EXEC, CREATE OR REPLACE on its own line, trailing comments, SET TRANSACTION', () => {
  const parts = splitScript(`/*
 * License
 */
create or replace package p is
  x number;
end;
/
@install_more.sql
@@relative.sql
rem a remark
exec dbms_output.put_line('hi');
create or replace
package body p is
  procedure q is begin null; end;
end;
/
create table t (a number); -- the table
set transaction read only;
insert into t values (';');
`);
  assert.equal(parts.length, 6, JSON.stringify(parts, null, 1));
  assert.ok(parts[0].startsWith('/*') && parts[0].includes('x number;') && parts[0].trimEnd().endsWith('end;'), parts[0]);
  assert.equal(parts[1], "BEGIN dbms_output.put_line('hi'); END;");
  assert.ok(parts[2].startsWith('create or replace\npackage body p') && parts[2].includes('procedure q'), parts[2]);
  assert.equal(parts[3], 'create table t (a number) -- the table');
  assert.equal(parts[4], 'set transaction read only');
  assert.equal(parts[5], "insert into t values (';')");
});

test('splitScript: q-quotes and quoted names with odd quotes, comment-only parts, EXEC with comments and continuation', () => {
  const parts = splitScript(`insert into t values (q'[it's]');
create index " foo'bar" on t (a);
-- before exec
exec p; -- run it
exec dbms_output.put_line( -
  'x');
insert into t values ('b');
-- trailing comment
`);
  assert.deepEqual(parts, [
    "insert into t values (q'[it's]')",
    `create index " foo'bar" on t (a)`,
    'BEGIN p; END;',
    "BEGIN dbms_output.put_line(\n  'x'); END;",
    "insert into t values ('b')",
  ]);
});

test('splitScript: a block comment after the semicolon does not join the next statement', () => {
  assert.deepEqual(splitScript(`CREATE TABLE t (n NUMBER); /* demo
 table */
INSERT INTO t VALUES (1);
`), ['CREATE TABLE t (n NUMBER) /* demo\n table */', 'INSERT INTO t VALUES (1)']);
});

test('splitScript: lone semicolons, exit; and continued SQL*Plus commands drop out', () => {
  assert.deepEqual(splitScript(`commit;
;
column x format a20 -
  heading 'X'
desc t
select 1 from dual;
exit;
`), ['commit', 'select 1 from dual']);
});

test('splitScript: code after the block comment that follows a semicolon starts the next statement', () => {
  assert.deepEqual(splitScript(`select 1 from dual; /* c
*/ insert into t values ('a;
b');
select 3 from dual;
`), ['select 1 from dual /* c\n*/', " insert into t values ('a;\nb')", 'select 3 from dual']);
});

test('splitScript: a blank line ends a continued SQL*Plus command, the next statement stays', () => {
  assert.deepEqual(splitScript(`column x format a20 -

select 1 from dual;
`), ['select 1 from dual']);
});

test('splitScript: WITH FUNCTION queries and views, inline MLE modules and Java sources end at the slash', () => {
  assert.deepEqual(splitScript(`with function f return number is begin return 1; end;
select f() from dual
/
create or replace view v as
with function f return number is begin return 1; end;
select f() x from dual
/
create or replace mle module m language javascript as
export function f() { return 1; }
/
create or replace and compile java source named "J" as public class J { static String f() { return "x"; } }
/
create mle module m2 language javascript using bfile(d, 'm.js');
select 1 from dual;
`), [
    'with function f return number is begin return 1; end;\nselect f() from dual',
    'create or replace view v as\nwith function f return number is begin return 1; end;\nselect f() x from dual',
    'create or replace mle module m language javascript as\nexport function f() { return 1; }',
    'create or replace and compile java source named "J" as public class J { static String f() { return "x"; } }',
    "create mle module m2 language javascript using bfile(d, 'm.js')",
    'select 1 from dual',
  ]);
});

test('splitScript: Java/MLE code is not read with SQL quoting, a column named FUNCTION is no WITH FUNCTION', () => {
  assert.deepEqual(splitScript(`create or replace mle module m language javascript as
// don't touch
export function f() { return 1; }
/
insert into menu_flat
select id from menu start with function is null connect by prior id = parent_id;
create java source named "S" using clob (select src as s from t);
create table t2 (x number);
`), [
    "create or replace mle module m language javascript as\n// don't touch\nexport function f() { return 1; }",
    'insert into menu_flat\nselect id from menu start with function is null connect by prior id = parent_id',
    'create java source named "S" using clob (select src as s from t)',
    'create table t2 (x number)',
  ]);
});

test('splitScript: an MLE call spec with JavaScript inline ends at the slash', () => {
  assert.deepEqual(splitScript(`create or replace function js_f return varchar2 as mle language javascript {{ // don't
  return 'x'; }};
/
select 1 from dual;
`), ["create or replace function js_f return varchar2 as mle language javascript {{ // don't\n  return 'x'; }};", 'select 1 from dual']);
});

test('withDisable puts DISABLE in front of WHEN or the trigger body', async () => {
  const { withDisable } = await import('@pltest/core');
  assert.equal(withDisable(`trigger t before insert on x for each row when (new.n > 0) begin null; end;`),
    `trigger t before insert on x for each row DISABLE when (new.n > 0) begin null; end;`);
  assert.equal(withDisable(`trigger t after update of a on x referencing new as n for each row declare v number; begin null; end;`),
    `trigger t after update of a on x referencing new as n for each row DISABLE declare v number; begin null; end;`);
  assert.equal(withDisable(`trigger t for insert on x compound trigger before statement is begin null; end before statement; end;`),
    `trigger t for insert on x DISABLE compound trigger before statement is begin null; end before statement; end;`);
  assert.equal(withDisable(`trigger t before insert on x enable begin null; end;`), `trigger t before insert on x DISABLE begin null; end;`);
});

test('splitScript: a blank line drops unfinished SQL as SQL*Plus does, unless "/" follows; PL/SQL keeps its blank lines', () => {
  assert.deepEqual(splitScript(`select 1 from dual

create or replace procedure p is

begin
  null;
end;
/
insert into t
values (1)

/
select 2 from dual

`), ['create or replace procedure p is\n\nbegin\n  null;\nend;', 'insert into t\nvalues (1)']);
});
