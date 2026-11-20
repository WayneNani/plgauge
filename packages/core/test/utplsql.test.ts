/** JUnit parsing: status and failure message, on output of utPLSQL 3.2.2 (ut_junit_reporter). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureMessage, failureSummary, parseJunit } from '@plgauge/core';

// a beforeall that raises (every test of the suite errors), a failed expectation whose text holds
// "<", "&" and "]]>" (utPLSQL splits the CDATA), a division by zero, a passing test and a test
// package whose body does not compile
const JUNIT = `<?xml version="1.0"?>
<testsuites tests="6" disabled="0" errors="4" failures="1" name="" time=".05549" >
<testsuite tests="2" id="1" package="plg_msg_ba"  disabled="0" errors="2" failures="0" name="Before all raises" time=".005546" >
<testcase classname="plg_msg_ba" assertions="0" name="first" time="0"  status="Error">
<error>
<![CDATA[
ORA-20073: setup <broken> & "gone"
ORA-06512: at "PR5.PLG_MSG_BA", line 2
ORA-06512: at "PR5.PLG_MSG_BA", line 2
ORA-06512: at line 6
]]>
</error>
<system-out/>
<system-err/>
</testcase>
<testcase classname="plg_msg_ba" assertions="0" name="second" time="0"  status="Error">
<error>
<![CDATA[
ORA-20073: setup <broken> & "gone"
ORA-06512: at "PR5.PLG_MSG_BA", line 2
ORA-06512: at line 6
]]>
</error>
<system-out/>
<system-err/>
</testcase>
<system-out/>
<system-err>
<![CDATA[
ORA-20073: setup <broken> & "gone"
]]>
</system-err>
</testsuite>
<testsuite tests="3" id="2" package="plg_msg_fail"  disabled="0" errors="1" failures="1" name="plg_msg_fail" time=".046536" >
<testcase classname="plg_msg_fail" assertions="1" name="compares &lt;a&gt; &amp; b" time=".044152"  status="Failure">
<failure>
<![CDATA[
Actual: 'a<b>&c' (varchar2) was expected to equal: 'x]]]]><![CDATA[>y' (varchar2)
at "PR5.PLG_MSG_FAIL.T_FAIL", line 2 procedure t_fail is begin ut.expect('a<b>&c').to_equal('x]]]]><![CDATA[>y'); end;
]]>
</failure>
<system-out/>
<system-err/>
</testcase>
<testcase classname="plg_msg_fail" assertions="0" name="t_err" time=".001386"  status="Error">
<error>
<![CDATA[
ORA-01476: divisor is equal to zero
ORA-06512: at "PR5.PLG_MSG_FAIL", line 3
]]>
</error>
<system-out/>
<system-err/>
</testcase>
<testcase classname="plg_msg_fail" assertions="0" name="t_ok" time=".000789" >
<system-out/>
<system-err/>
</testcase>
<system-out/>
<system-err/>
</testsuite>
<testsuite tests="1" id="3" package="plg_msg_nc"  disabled="0" errors="1" failures="0" name="plg_msg_nc" time=".003201" >
<testcase classname="plg_msg_nc" assertions="0" name="t1" time=".003069"  status="Error">
<error>
<![CDATA[
ORA-04063: package body "PR5.PLG_MSG_NC" has errors
ORA-06508: PL/SQL: could not find program unit being called: "PR5.PLG_MSG_NC"
ORA-06512: at line 6
]]>
</error>
<system-out/>
<system-err/>
</testcase>
<system-out/>
<system-err/>
</testsuite>
</testsuites>`;

test('junit: status and the first line of the error stack or the failed expectation', () => {
  const t = parseJunit(JUNIT);
  assert.deepEqual(t.map((x) => [x.suite, x.name, x.status, x.message]), [
    ['plg_msg_ba', 'first', 'error', 'ORA-20073: setup <broken> & "gone"'],
    ['plg_msg_ba', 'second', 'error', 'ORA-20073: setup <broken> & "gone"'],
    ['plg_msg_fail', 'compares <a> & b', 'failed', "Actual: 'a<b>&c' (varchar2) was expected to equal: 'x]]>y' (varchar2)"],
    ['plg_msg_fail', 't_err', 'error', 'ORA-01476: divisor is equal to zero'],
    ['plg_msg_fail', 't_ok', 'passed', undefined],
    ['plg_msg_nc', 't1', 'error', 'ORA-04063: package body "PR5.PLG_MSG_NC" has errors'],
  ]);
});

test('junit: message attribute (escaped, numeric entities), status not fooled by "<error" in CDATA, length capped', () => {
  const xml = `<testcase classname="a.b" name="x" time="1"><failure message="expected &lt;1&gt;&#10;second line"/></testcase>
<testcase classname="a.b" name="y" time="1"><failure><![CDATA[Actual: '<error>' (varchar2) was expected to be null]]></failure></testcase>
<testcase classname="a.b" name="z" time="1"><error><![CDATA[${'ORA-20000: ' + 'x'.repeat(500)}]]></error></testcase>
<testcase classname="a.b" name="w" time="1"><failure/></testcase>`;
  const t = parseJunit(xml);
  assert.equal(t[0].message, 'expected <1>');
  assert.equal(t[1].status, 'failed');
  assert.equal(t[1].message, "Actual: '<error>' (varchar2) was expected to be null");
  assert.equal(t[2].message!.length, 300);
  assert.ok(t[2].message!.endsWith('…'));
  assert.equal(t[3].status, 'failed');
  assert.equal(t[3].message, undefined);
});

test('failureMessage skips the generic lines of the TeamCity reporter', () => {
  assert.equal(failureMessage('Error occured\nTest exception:\nORA-01476: divisor is equal to zero\nORA-06512: at line 6\n'), 'ORA-01476: divisor is equal to zero');
  assert.equal(failureMessage('Error occured\n'), 'Error occured');
  assert.equal(failureMessage(' \n'), undefined);
});

test('failureSummary groups by suite and message, the largest first, capped', () => {
  const t = parseJunit(JUNIT);
  assert.deepEqual(failureSummary(t, 'before instrumentation'), [
    'WARNING: 2 tests of suite plg_msg_ba error before instrumentation: ORA-20073: setup <broken> & "gone"',
    `WARNING: test "compares <a> & b" of suite plg_msg_fail fails before instrumentation: Actual: 'a<b>&c' (varchar2) was expected to equal: 'x]]>y' (varchar2)`,
    'WARNING: test "t_err" of suite plg_msg_fail errors before instrumentation: ORA-01476: divisor is equal to zero',
    'WARNING: test "t1" of suite plg_msg_nc errors before instrumentation: ORA-04063: package body "PR5.PLG_MSG_NC" has errors',
  ]);
  const many = Array.from({ length: 86 }, (_, i) => ({ suite: 'x.y', name: `t${i}`, status: 'error' as const, message: 'ORA-04063: package body "X.TEST_Y" has errors' }));
  const other = Array.from({ length: 12 }, (_, i) => ({ suite: `s${i}`, name: 't', status: 'failed' as const, message: 'm' }));
  const s = failureSummary([...other, ...many], 'before instrumentation', 3);
  assert.equal(s.length, 4);
  assert.equal(s[0], 'WARNING: 86 tests of suite x.y error before instrumentation: ORA-04063: package body "X.TEST_Y" has errors');
  assert.equal(s[3], 'WARNING: … and 10 more tests in 10 more groups');
  assert.deepEqual(failureSummary(t.filter((x) => x.status === 'passed'), 'x'), []);
});
