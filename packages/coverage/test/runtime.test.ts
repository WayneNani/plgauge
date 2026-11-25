import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeBody } from '@plgauge/coverage';

test('runtimeBody puts context and program in as literals, also with $ and quotes', () => {
  const body = runtimeBody({ context: 'PLGAUGE_COV_ABC', program: "^Oracle REST Data Services$|it's", utInfo: 'UT3_INFO_X' });
  assert.ok(body.includes(`gc_ctx     constant varchar2(128)  := 'PLGAUGE_COV_ABC';`));
  // "$'" must not act as a replacement pattern, a quote is doubled
  assert.ok(body.includes(`gc_program constant varchar2(4000) := '^Oracle REST Data Services$|it''s';`));
  assert.ok(body.includes(`sys_context('UT3_INFO_X', 'TEST_NAME')`));
  assert.equal(body.split('create or replace package body cov$').length, 2, 'the body appears once');
});

test('runtimeBody without options: no context, every other session counts', () => {
  const body = runtimeBody();
  assert.ok(body.includes(`gc_ctx     constant varchar2(128)  := '';`));
  assert.ok(body.includes(`gc_program constant varchar2(4000) := '';`));
});
