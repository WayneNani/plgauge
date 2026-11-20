/**
 * Restore journal against a real database (skipped unless PLGAUGE_COV_DB is set):
 * a changed object whose run "died" (no restoreAll) is put back from the journal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracledb from 'oracledb';
import { ensureJournal, journalEntries, loadObject, replaceSource, replaceSourceDetailed, restoreAll, restoreJournal, viewFromDictionary, viewQuery } from '@plgauge/core';

const db = process.env.PLGAUGE_COV_DB;
const m = db ? /^([^/]+)\/([^@]+)@(.+)$/.exec(db) : null;

test('the journal restores code left changed by a killed run', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  try {
    const owner = m![1].toUpperCase();
    await conn.execute(`create or replace function plgauge_journal_probe return number is begin return 1; end;`);
    await ensureJournal(conn);
    const obj = await loadObject(conn, owner, 'PLGAUGE_JOURNAL_PROBE', 'FUNCTION');
    const value = async () => (await conn.execute<[number]>(`select plgauge_journal_probe from dual`)).rows![0][0];

    assert.equal(await replaceSource(conn, obj, 'function plgauge_journal_probe return number is begin return 2; end;', 'test'), null);
    // A second change must keep the first original in the journal.
    const changed = await loadObject(conn, owner, 'PLGAUGE_JOURNAL_PROBE', 'FUNCTION');
    await replaceSource(conn, changed, 'function plgauge_journal_probe return number is begin return 3; end;', 'test');
    assert.equal(await value(), 3);

    // The run "dies" here: no restoreAll. A later restore uses the journal.
    const entries = (await journalEntries(conn)).filter((e) => e.name === 'PLGAUGE_JOURNAL_PROBE');
    assert.equal(entries.length, 1);
    await restoreAll(conn, entries.map((e) => e.object), () => {});
    assert.equal(await value(), 1);
    assert.equal((await journalEntries(conn)).filter((e) => e.name === 'PLGAUGE_JOURNAL_PROBE').length, 0);
  } finally {
    await conn.execute(`drop function plgauge_journal_probe`).catch(() => {});
    await conn.close();
  }
});

test('a trigger body from DBMS_PREPROCESSOR gets the ALL_SOURCE header back', async () => {
  const { triggerSource } = await import('@plgauge/core');
  const src = 'trigger t\n  after insert on x\n  for each row\ndeclare\n  l number;\nbegin\n  l := 1;\nend;';
  assert.equal(triggerSource(src, 'declare\n  l number;\nbegin\n  l := 1;\nend;'), src);
  assert.equal(triggerSource(src, src), src); // already with its header
  const inline = 'trigger t before insert on x for each row begin\n  null; end;';
  assert.equal(triggerSource(inline, 'begin\n  null; end;'), inline);
  const cc = 'trigger t before insert on x for each row\nbegin\n  $if true $then null; $end\nend;';
  assert.equal(triggerSource(cc, 'begin\n    null; \nend;'), 'trigger t before insert on x for each row\nbegin\n    null; \nend;');
  // CALL: the preprocessor appends a ";" CREATE TRIGGER refuses
  const call = 'trigger t before insert on x for each row\n  call p(:new.n)\n';
  assert.equal(triggerSource(call, 'p(:new.n)\n;'), call);
  // a comment between CALL and the target, no trailing newline, all on one line: the body decides
  for (const c of ['trigger t before insert on x for each row\n  call /* x */ p(:new.n)\n', 'trigger t before insert on x for each row\n  call -- x\n  p(:new.n)\n',
    'trigger t before insert on x for each row\n  call p(:new.n)', 'trigger t before insert on x for each row call p(:new.n)', 'trigger t before insert on x for each row call compound(:new.n)']) {
    assert.equal(triggerSource(c, c.slice(c.search(/\b(p|compound)\(/)).trimEnd() + '\n;'), c);
  }
  // conditional compilation on the body's first line: header up to the keyword, then the body
  assert.equal(triggerSource('trigger t before insert on x for each row begin $if true $then null; $end end;', 'begin  null;  end;'),
    'trigger t before insert on x for each row begin  null;  end;');
  const d = 'trigger t\n  before insert on x for each row -- begin\ndeclare $if true $then l number; $end\nbegin\n  null;\nend;';
  assert.equal(triggerSource(d, 'declare   l number; \nbegin\n  null;\nend;'), 'trigger t\n  before insert on x for each row -- begin\ndeclare   l number; \nbegin\n  null;\nend;');
  const ct = 'trigger compound for insert on compound compound trigger $if true $then\n  before statement is begin null; end before statement; $end\nend;';
  const cb = 'compound trigger \n  before statement is begin null; end before statement; \nend;';
  assert.equal(triggerSource(ct, cb), 'trigger compound for insert on compound ' + cb);
  // the body's keyword is not on the line counted from the end: no alignment
  assert.equal(triggerSource('trigger t before insert on x for each row\nbegin\n  null;\nend;', 'begin\n  null; end;'), undefined);
});

test('fingerprint ignores whitespace and CREATE keywords, nothing else (marked x)', async () => {
  const { fingerprint } = await import('@plgauge/core');
  const a = `CREATE OR REPLACE EDITIONABLE function f return varchar2 is begin return 'Grüße'; end;`;
  assert.equal(fingerprint(a), fingerprint(`function f return varchar2 is\n begin return 'Grüße'; end;`));
  assert.notEqual(fingerprint(a), fingerprint(`function f return varchar2 is begin return 'Gräße'; end;`));
  assert.notEqual(fingerprint(a), fingerprint(`function f return varchar2 is begin return 'Gr?ße'; end;`));
  assert.match(fingerprint(a), /^x[0-9a-f]{63}$/);
});

test('viewQuery: the query after the first AS outside parentheses and quotes', () => {
  assert.equal(viewQuery(`FORCE EDITIONABLE VIEW "O"."AS" ("AS", "B", CONSTRAINT "C" CHECK (a as b) DISABLE) DEFAULT COLLATION "USING_NLS_COMP" AS\n  select 1 as a from dual`), '\n  select 1 as a from dual');
  assert.equal(viewQuery(`VIEW v /* as */ -- as\n AS select 1 a from dual`), ' select 1 a from dual');
});

const withConn = async (f: (conn: oracledb.Connection, owner: string) => Promise<void>) => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  try {
    await ensureJournal(conn);
    await f(conn, m![1].toUpperCase());
  } finally {
    await conn.close();
  }
};
const quiet = (out: string[]) => (s: string) => out.push(s);

test('a dead run\'s view is restored, a view changed since keeps the newer text', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const text = async () => (await conn.execute<[string]>(`select text from user_views where view_name = 'PLGAUGE_JV'`)).rows![0][0];
    const mine = async () => (await journalEntries(conn)).filter((e) => e.name === 'PLGAUGE_JV');
    try {
      await conn.execute(`create or replace view plgauge_jv as select 1 a from dual with read only`);
      const obj = await loadObject(conn, owner, 'PLGAUGE_JV', 'VIEW');
      // dies with the mutant in place: restored
      assert.equal(await replaceSource(conn, obj, obj.original.replace('select 1 a', 'select 2 a'), 'test'), null);
      const out: string[] = [];
      await restoreJournal(conn, await mine(), quiet(out));
      assert.match(await text(), /select 1 a/, out.join('\n'));
      assert.deepEqual(await mine(), []);
      // dies, then someone puts a newer view there: it stays
      assert.equal(await replaceSource(conn, obj, obj.original.replace('select 1 a', 'select 2 a'), 'test'), null);
      await conn.execute(`create or replace view plgauge_jv as select 3 a from dual`);
      out.length = 0;
      await restoreJournal(conn, await mine(), quiet(out));
      assert.match(await text(), /select 3 a/);
      assert.match(out.join('\n'), /was changed after the aborted run/);
      assert.deepEqual(await mine(), []);
    } finally {
      await conn.execute(`drop view plgauge_jv`).catch(() => {});
    }
  });
});

test('a unit dropped after the dead run is not created again', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    await conn.execute(`create or replace function plgauge_journal_gone return number is begin return 1; end;`);
    const obj = await loadObject(conn, owner, 'PLGAUGE_JOURNAL_GONE', 'FUNCTION');
    await replaceSource(conn, obj, 'function plgauge_journal_gone return number is begin return 2; end;', 'test');
    await conn.execute(`drop function plgauge_journal_gone`);
    const out: string[] = [];
    await restoreJournal(conn, (await journalEntries(conn)).filter((e) => e.name === 'PLGAUGE_JOURNAL_GONE'), quiet(out));
    assert.match(out.join('\n'), /no longer exists/);
    const n = (await conn.execute<[number]>(`select count(*) from user_objects where object_name = 'PLGAUGE_JOURNAL_GONE'`)).rows![0][0];
    assert.equal(n, 0);
    assert.equal((await journalEntries(conn)).filter((e) => e.name === 'PLGAUGE_JOURNAL_GONE').length, 0);
  });
});

test('a unit keeps its PLSQL_WARNINGS through change and restore', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const warnings = async () => (await conn.execute<[string]>(`select plsql_warnings from user_plsql_object_settings where name = 'PLGAUGE_JOURNAL_WARN'`)).rows![0][0];
    try {
      await conn.execute(`alter session set plsql_warnings = 'ENABLE:ALL'`);
      await conn.execute(`create or replace function plgauge_journal_warn return number is begin return 1; end;`);
      await conn.execute(`alter session set plsql_warnings = 'DISABLE:ALL'`);
      const obj = await loadObject(conn, owner, 'PLGAUGE_JOURNAL_WARN', 'FUNCTION');
      await replaceSource(conn, obj, 'function plgauge_journal_warn return number is begin return 2; end;', 'test');
      assert.equal(await warnings(), 'ENABLE:ALL');
      await restoreAll(conn, [obj], () => {});
      assert.equal(await warnings(), 'ENABLE:ALL');
    } finally {
      await conn.execute(`drop function plgauge_journal_warn`).catch(() => {});
    }
  });
});

test('viewFromDictionary rebuilds read-only, check-option and invoker-rights views as they were', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const views = {
      PLGAUGE_JV1: `select 1 a from dual with read only`,
      PLGAUGE_JV2: `select dummy from dual where dummy = 'X' with check option`,
    };
    try {
      for (const [n, q] of Object.entries(views)) await conn.execute(`create or replace view ${n} as ${q}`);
      await conn.execute(`create or replace view plgauge_jv3 bequeath current_user as select 1 a from dual`);
      for (const n of [...Object.keys(views), 'PLGAUGE_JV3']) {
        const before = (await conn.execute<[string, string]>(`select text, bequeath from user_views where view_name = :n`, { n })).rows![0];
        await conn.execute(`create or replace ${await viewFromDictionary(conn, owner, n)}`);
        const after = (await conn.execute<[string, string]>(`select text, bequeath from user_views where view_name = :n`, { n })).rows![0];
        assert.deepEqual(after, before, n);
      }
    } finally {
      for (const n of [...Object.keys(views), 'PLGAUGE_JV3']) await conn.execute(`drop view ${n}`).catch(() => {});
    }
  });
});

test('a dead run\'s view mutant written with SELECT * is restored (the dictionary expands it)', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const text = async () => (await conn.execute<[string]>(`select text from user_views where view_name = 'PLGAUGE_JS'`)).rows![0][0];
    const mine = async () => (await journalEntries(conn)).filter((e) => e.name === 'PLGAUGE_JS');
    try {
      await conn.execute(`create or replace view plgauge_js as select dummy from dual where 1 = 1`);
      const obj = await loadObject(conn, owner, 'PLGAUGE_JS', 'VIEW');
      assert.equal(await replaceSource(conn, obj, `view plgauge_js as select * from dual where 1 = 2`, 'test'), null);
      const out: string[] = [];
      await restoreJournal(conn, await mine(), quiet(out));
      assert.match(await text(), /1 = 1/, out.join('\n'));
      assert.deepEqual(await mine(), []);
      // the run died between its compile and the note of what the dictionary holds: restored too
      assert.equal(await replaceSource(conn, obj, `view plgauge_js as select * from dual where 1 = 2`, 'test'), null);
      await conn.execute(`update plgauge_journal set current_sha = 'x', prev_sha = 'y', pending = 1 where name = 'PLGAUGE_JS'`);
      await conn.commit();
      out.length = 0;
      await restoreJournal(conn, await mine(), quiet(out));
      assert.match(await text(), /1 = 1/, out.join('\n'));
    } finally {
      await conn.execute(`drop view plgauge_js`).catch(() => {});
    }
  });
});

test('a compile rejected at once leaves no journal entry when the object was never changed', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const mine = async () => (await journalEntries(conn)).filter((e) => e.name === 'PLGAUGE_JU');
    try {
      await conn.execute(`create or replace view plgauge_ju as select 1 a from dual`);
      const obj = await loadObject(conn, owner, 'PLGAUGE_JU', 'VIEW');
      const out = await replaceSourceDetailed(conn, obj, `view plgauge_ju as select no_such_column a from dual`, 'test');
      assert.ok(out.error && out.untouched, JSON.stringify(out));
      assert.deepEqual(await mine(), []);
      // changed before: the entry stays (the object holds plgauge's text)
      assert.equal(await replaceSource(conn, obj, `view plgauge_ju as select 2 a from dual`, 'test'), null);
      const again = await replaceSourceDetailed(conn, obj, `view plgauge_ju as select no_such_column a from dual`, 'test');
      assert.ok(again.error && !again.untouched);
      assert.equal((await mine()).length, 1);
      await restoreAll(conn, (await mine()).map((e) => e.object), () => {});
    } finally {
      await conn.execute(`drop view plgauge_ju`).catch(() => {});
    }
  });
});

test('a disabled trigger (DISABLE written in its file) stays disabled and valid, a dead run\'s mutant of it is restored', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const state = async () => (await conn.execute<[string, string]>(`select t.status, o.status from user_triggers t join user_objects o on o.object_name = t.trigger_name and o.object_type = 'TRIGGER' where t.trigger_name = 'PLGAUGE_JT'`)).rows![0];
    const mine = async () => (await journalEntries(conn)).filter((e) => e.name === 'PLGAUGE_JT');
    try {
      await conn.execute(`create table plgauge_jt_t (n number)`).catch(() => {});
      await conn.execute(`create or replace trigger plgauge_jt before insert on plgauge_jt_t for each row\nbegin :new.n := :new.n + 1; end;`);
      await conn.execute(`alter trigger plgauge_jt disable`);
      const obj = await loadObject(conn, owner, 'PLGAUGE_JT', 'TRIGGER');
      // a mutant as the file has it: with DISABLE in the header
      assert.equal(await replaceSource(conn, obj, `trigger plgauge_jt before insert on plgauge_jt_t for each row disable\nbegin :new.n := :new.n - 1; end;`, 'test'), null);
      assert.deepEqual(await state(), ['DISABLED', 'VALID']);
      const out: string[] = [];
      await restoreJournal(conn, await mine(), quiet(out));
      assert.deepEqual(await mine(), [], out.join('\n'));
      const src = (await conn.execute<[string]>(`select text from user_source where name = 'PLGAUGE_JT' order by line`)).rows!.map((r) => r[0]).join('');
      assert.match(src, /:new\.n \+ 1/, out.join('\n'));
      assert.deepEqual(await state(), ['DISABLED', 'VALID']);
    } finally {
      await conn.execute(`drop table plgauge_jt_t purge`).catch(() => {});
    }
  });
});

test('a view dropped after a run died mid-compile (pending) is not created again', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    await conn.execute(`create or replace view plgauge_jp as select 1 a from dual`);
    const obj = await loadObject(conn, owner, 'PLGAUGE_JP', 'VIEW');
    await replaceSource(conn, obj, `view plgauge_jp as select 2 a from dual`, 'test');
    await conn.execute(`update plgauge_journal set pending = 1 where name = 'PLGAUGE_JP'`);
    await conn.commit();
    await conn.execute(`drop view plgauge_jp`);
    const out: string[] = [];
    await restoreJournal(conn, (await journalEntries(conn)).filter((e) => e.name === 'PLGAUGE_JP'), quiet(out));
    assert.match(out.join('\n'), /no longer exists/);
    assert.equal((await conn.execute<[number]>(`select count(*) from user_views where view_name = 'PLGAUGE_JP'`)).rows![0][0], 0);
  });
});

test('a unit compiled for debugging stays so through change and restore', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const debug = async () => (await conn.execute<[string]>(`select plsql_debug from user_plsql_object_settings where name = 'PLGAUGE_JOURNAL_DBG'`)).rows![0][0];
    try {
      await conn.execute(`create or replace procedure plgauge_journal_dbg is begin null; end;`);
      await conn.execute(`alter procedure plgauge_journal_dbg compile debug`);
      const obj = await loadObject(conn, owner, 'PLGAUGE_JOURNAL_DBG', 'PROCEDURE');
      await replaceSource(conn, obj, 'procedure plgauge_journal_dbg is begin dbms_output.put_line(1); end;', 'test');
      assert.equal(await debug(), 'TRUE');
      await restoreAll(conn, [obj], () => {});
      assert.equal(await debug(), 'TRUE');
    } finally {
      await conn.execute(`drop procedure plgauge_journal_dbg`).catch(() => {});
      await conn.execute(`alter session set plsql_debug = false`).catch(() => {});
    }
  });
});

test('a unit compiled with implicit BOOLEAN conversion keeps it through change and restore', { skip: !m && 'PLGAUGE_COV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const state = async () => (await conn.execute<[string, string]>(`select s.plsql_implicit_conversion_bool, o.status from user_plsql_object_settings s join user_objects o on o.object_name = s.name and o.object_type = s.type where s.name = 'PLGAUGE_JOURNAL_ICB'`)).rows![0];
    try {
      await conn.execute(`alter session set plsql_implicit_conversion_bool = true`);
      await conn.execute(`create or replace procedure plgauge_journal_icb is b boolean; begin b := 1; end;`);
      await conn.execute(`alter session set plsql_implicit_conversion_bool = false`);
      const obj = await loadObject(conn, owner, 'PLGAUGE_JOURNAL_ICB', 'PROCEDURE');
      assert.equal(await replaceSource(conn, obj, 'procedure plgauge_journal_icb is b boolean; begin b := 0; end;', 'test'), null);
      await restoreAll(conn, [obj], () => {});
      assert.deepEqual(await state(), ['TRUE', 'VALID']);
    } finally {
      await conn.execute(`drop procedure plgauge_journal_icb`).catch(() => {});
      await conn.execute(`alter session set plsql_implicit_conversion_bool = false`).catch(() => {});
    }
  });
});
