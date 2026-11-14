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
