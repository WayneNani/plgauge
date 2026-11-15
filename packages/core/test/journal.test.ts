/**
 * Restore journal against a real database (skipped unless PLCOV_DB is set):
 * a changed object whose run "died" (no restoreAll) is put back from the journal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracledb from 'oracledb';
import { ensureJournal, journalEntries, loadObject, replaceSource, replaceSourceDetailed, restoreAll, restoreJournal, viewFromDictionary, viewQuery } from '@pltest/core';

const db = process.env.PLCOV_DB;
const m = db ? /^([^/]+)\/([^@]+)@(.+)$/.exec(db) : null;

test('the journal restores code left changed by a killed run', { skip: !m && 'PLCOV_DB not set' }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  try {
    const owner = m![1].toUpperCase();
    await conn.execute(`create or replace function pltest_journal_probe return number is begin return 1; end;`);
    await ensureJournal(conn);
    const obj = await loadObject(conn, owner, 'PLTEST_JOURNAL_PROBE', 'FUNCTION');
    const value = async () => (await conn.execute<[number]>(`select pltest_journal_probe from dual`)).rows![0][0];

    assert.equal(await replaceSource(conn, obj, 'function pltest_journal_probe return number is begin return 2; end;', 'test'), null);
    // A second change must keep the first original in the journal.
    const changed = await loadObject(conn, owner, 'PLTEST_JOURNAL_PROBE', 'FUNCTION');
    await replaceSource(conn, changed, 'function pltest_journal_probe return number is begin return 3; end;', 'test');
    assert.equal(await value(), 3);

    // The run "dies" here: no restoreAll. A later restore uses the journal.
    const entries = (await journalEntries(conn)).filter((e) => e.name === 'PLTEST_JOURNAL_PROBE');
    assert.equal(entries.length, 1);
    await restoreAll(conn, entries.map((e) => e.object), () => {});
    assert.equal(await value(), 1);
    assert.equal((await journalEntries(conn)).filter((e) => e.name === 'PLTEST_JOURNAL_PROBE').length, 0);
  } finally {
    await conn.execute(`drop function pltest_journal_probe`).catch(() => {});
    await conn.close();
  }
});

test('fingerprint ignores whitespace, CREATE keywords and characters a character set may not hold', async () => {
  const { fingerprint } = await import('@pltest/core');
  const a = `CREATE OR REPLACE EDITIONABLE function f return varchar2 is begin return 'a → b'; end;`;
  assert.equal(fingerprint(a), fingerprint(`function f return varchar2 is\n begin return 'a ¿ b'; end;`));
  assert.equal(fingerprint(a), fingerprint(`function f return varchar2 is begin return 'a ? b'; end;`));
  assert.notEqual(fingerprint(a), fingerprint(`function f return varchar2 is begin return 'a c'; end;`));
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

test('a dead run\'s view is restored, a view changed since keeps the newer text', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const text = async () => (await conn.execute<[string]>(`select text from user_views where view_name = 'PLTEST_JV'`)).rows![0][0];
    const mine = async () => (await journalEntries(conn)).filter((e) => e.name === 'PLTEST_JV');
    try {
      await conn.execute(`create or replace view pltest_jv as select 1 a from dual with read only`);
      const obj = await loadObject(conn, owner, 'PLTEST_JV', 'VIEW');
      // dies with the mutant in place: restored
      assert.equal(await replaceSource(conn, obj, obj.original.replace('select 1 a', 'select 2 a'), 'test'), null);
      const out: string[] = [];
      await restoreJournal(conn, await mine(), quiet(out));
      assert.match(await text(), /select 1 a/, out.join('\n'));
      assert.deepEqual(await mine(), []);
      // dies, then someone puts a newer view there: it stays
      assert.equal(await replaceSource(conn, obj, obj.original.replace('select 1 a', 'select 2 a'), 'test'), null);
      await conn.execute(`create or replace view pltest_jv as select 3 a from dual`);
      out.length = 0;
      await restoreJournal(conn, await mine(), quiet(out));
      assert.match(await text(), /select 3 a/);
      assert.match(out.join('\n'), /geändert/);
      assert.deepEqual(await mine(), []);
    } finally {
      await conn.execute(`drop view pltest_jv`).catch(() => {});
    }
  });
});

test('a unit dropped after the dead run is not created again', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    await conn.execute(`create or replace function pltest_journal_gone return number is begin return 1; end;`);
    const obj = await loadObject(conn, owner, 'PLTEST_JOURNAL_GONE', 'FUNCTION');
    await replaceSource(conn, obj, 'function pltest_journal_gone return number is begin return 2; end;', 'test');
    await conn.execute(`drop function pltest_journal_gone`);
    const out: string[] = [];
    await restoreJournal(conn, (await journalEntries(conn)).filter((e) => e.name === 'PLTEST_JOURNAL_GONE'), quiet(out));
    assert.match(out.join('\n'), /existiert nicht mehr/);
    const n = (await conn.execute<[number]>(`select count(*) from user_objects where object_name = 'PLTEST_JOURNAL_GONE'`)).rows![0][0];
    assert.equal(n, 0);
    assert.equal((await journalEntries(conn)).filter((e) => e.name === 'PLTEST_JOURNAL_GONE').length, 0);
  });
});

test('a unit keeps its PLSQL_WARNINGS through change and restore', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const warnings = async () => (await conn.execute<[string]>(`select plsql_warnings from user_plsql_object_settings where name = 'PLTEST_JOURNAL_WARN'`)).rows![0][0];
    try {
      await conn.execute(`alter session set plsql_warnings = 'ENABLE:ALL'`);
      await conn.execute(`create or replace function pltest_journal_warn return number is begin return 1; end;`);
      await conn.execute(`alter session set plsql_warnings = 'DISABLE:ALL'`);
      const obj = await loadObject(conn, owner, 'PLTEST_JOURNAL_WARN', 'FUNCTION');
      await replaceSource(conn, obj, 'function pltest_journal_warn return number is begin return 2; end;', 'test');
      assert.equal(await warnings(), 'ENABLE:ALL');
      await restoreAll(conn, [obj], () => {});
      assert.equal(await warnings(), 'ENABLE:ALL');
    } finally {
      await conn.execute(`drop function pltest_journal_warn`).catch(() => {});
    }
  });
});

test('viewFromDictionary rebuilds read-only, check-option and invoker-rights views as they were', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const views = {
      PLTEST_JV1: `select 1 a from dual with read only`,
      PLTEST_JV2: `select dummy from dual where dummy = 'X' with check option`,
    };
    try {
      for (const [n, q] of Object.entries(views)) await conn.execute(`create or replace view ${n} as ${q}`);
      await conn.execute(`create or replace view pltest_jv3 bequeath current_user as select 1 a from dual`);
      for (const n of [...Object.keys(views), 'PLTEST_JV3']) {
        const before = (await conn.execute<[string, string]>(`select text, bequeath from user_views where view_name = :n`, { n })).rows![0];
        await conn.execute(`create or replace ${await viewFromDictionary(conn, owner, n)}`);
        const after = (await conn.execute<[string, string]>(`select text, bequeath from user_views where view_name = :n`, { n })).rows![0];
        assert.deepEqual(after, before, n);
      }
    } finally {
      for (const n of [...Object.keys(views), 'PLTEST_JV3']) await conn.execute(`drop view ${n}`).catch(() => {});
    }
  });
});

test('a dead run\'s view mutant written with SELECT * is restored (the dictionary expands it)', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const text = async () => (await conn.execute<[string]>(`select text from user_views where view_name = 'PLTEST_JS'`)).rows![0][0];
    const mine = async () => (await journalEntries(conn)).filter((e) => e.name === 'PLTEST_JS');
    try {
      await conn.execute(`create or replace view pltest_js as select dummy from dual where 1 = 1`);
      const obj = await loadObject(conn, owner, 'PLTEST_JS', 'VIEW');
      assert.equal(await replaceSource(conn, obj, `view pltest_js as select * from dual where 1 = 2`, 'test'), null);
      const out: string[] = [];
      await restoreJournal(conn, await mine(), quiet(out));
      assert.match(await text(), /1 = 1/, out.join('\n'));
      assert.deepEqual(await mine(), []);
      // the run died between its compile and the note of what the dictionary holds: restored too
      assert.equal(await replaceSource(conn, obj, `view pltest_js as select * from dual where 1 = 2`, 'test'), null);
      await conn.execute(`update pltest_journal set current_sha = 'x', prev_sha = 'y', pending = 1 where name = 'PLTEST_JS'`);
      await conn.commit();
      out.length = 0;
      await restoreJournal(conn, await mine(), quiet(out));
      assert.match(await text(), /1 = 1/, out.join('\n'));
    } finally {
      await conn.execute(`drop view pltest_js`).catch(() => {});
    }
  });
});

test('a compile rejected at once leaves no journal entry when the object was never changed', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const mine = async () => (await journalEntries(conn)).filter((e) => e.name === 'PLTEST_JU');
    try {
      await conn.execute(`create or replace view pltest_ju as select 1 a from dual`);
      const obj = await loadObject(conn, owner, 'PLTEST_JU', 'VIEW');
      const out = await replaceSourceDetailed(conn, obj, `view pltest_ju as select no_such_column a from dual`, 'test');
      assert.ok(out.error && out.untouched, JSON.stringify(out));
      assert.deepEqual(await mine(), []);
      // changed before: the entry stays (the object holds pltest's text)
      assert.equal(await replaceSource(conn, obj, `view pltest_ju as select 2 a from dual`, 'test'), null);
      const again = await replaceSourceDetailed(conn, obj, `view pltest_ju as select no_such_column a from dual`, 'test');
      assert.ok(again.error && !again.untouched);
      assert.equal((await mine()).length, 1);
      await restoreAll(conn, (await mine()).map((e) => e.object), () => {});
    } finally {
      await conn.execute(`drop view pltest_ju`).catch(() => {});
    }
  });
});

test('a disabled trigger (DISABLE written in its file) stays disabled and valid, a dead run\'s mutant of it is restored', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const state = async () => (await conn.execute<[string, string]>(`select t.status, o.status from user_triggers t join user_objects o on o.object_name = t.trigger_name and o.object_type = 'TRIGGER' where t.trigger_name = 'PLTEST_JT'`)).rows![0];
    const mine = async () => (await journalEntries(conn)).filter((e) => e.name === 'PLTEST_JT');
    try {
      await conn.execute(`create table pltest_jt_t (n number)`).catch(() => {});
      await conn.execute(`create or replace trigger pltest_jt before insert on pltest_jt_t for each row\nbegin :new.n := :new.n + 1; end;`);
      await conn.execute(`alter trigger pltest_jt disable`);
      const obj = await loadObject(conn, owner, 'PLTEST_JT', 'TRIGGER');
      // a mutant as the file has it: with DISABLE in the header
      assert.equal(await replaceSource(conn, obj, `trigger pltest_jt before insert on pltest_jt_t for each row disable\nbegin :new.n := :new.n - 1; end;`, 'test'), null);
      assert.deepEqual(await state(), ['DISABLED', 'VALID']);
      const out: string[] = [];
      await restoreJournal(conn, await mine(), quiet(out));
      assert.deepEqual(await mine(), [], out.join('\n'));
      const src = (await conn.execute<[string]>(`select text from user_source where name = 'PLTEST_JT' order by line`)).rows!.map((r) => r[0]).join('');
      assert.match(src, /:new\.n \+ 1/, out.join('\n'));
      assert.deepEqual(await state(), ['DISABLED', 'VALID']);
    } finally {
      await conn.execute(`drop table pltest_jt_t purge`).catch(() => {});
    }
  });
});

test('a view dropped after a run died mid-compile (pending) is not created again', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    await conn.execute(`create or replace view pltest_jp as select 1 a from dual`);
    const obj = await loadObject(conn, owner, 'PLTEST_JP', 'VIEW');
    await replaceSource(conn, obj, `view pltest_jp as select 2 a from dual`, 'test');
    await conn.execute(`update pltest_journal set pending = 1 where name = 'PLTEST_JP'`);
    await conn.commit();
    await conn.execute(`drop view pltest_jp`);
    const out: string[] = [];
    await restoreJournal(conn, (await journalEntries(conn)).filter((e) => e.name === 'PLTEST_JP'), quiet(out));
    assert.match(out.join('\n'), /existiert nicht mehr/);
    assert.equal((await conn.execute<[number]>(`select count(*) from user_views where view_name = 'PLTEST_JP'`)).rows![0][0], 0);
  });
});

test('a unit compiled for debugging stays so through change and restore', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const debug = async () => (await conn.execute<[string]>(`select plsql_debug from user_plsql_object_settings where name = 'PLTEST_JOURNAL_DBG'`)).rows![0][0];
    try {
      await conn.execute(`create or replace procedure pltest_journal_dbg is begin null; end;`);
      await conn.execute(`alter procedure pltest_journal_dbg compile debug`);
      const obj = await loadObject(conn, owner, 'PLTEST_JOURNAL_DBG', 'PROCEDURE');
      await replaceSource(conn, obj, 'procedure pltest_journal_dbg is begin dbms_output.put_line(1); end;', 'test');
      assert.equal(await debug(), 'TRUE');
      await restoreAll(conn, [obj], () => {});
      assert.equal(await debug(), 'TRUE');
    } finally {
      await conn.execute(`drop procedure pltest_journal_dbg`).catch(() => {});
      await conn.execute(`alter session set plsql_debug = false`).catch(() => {});
    }
  });
});

test('a unit compiled with implicit BOOLEAN conversion keeps it through change and restore', { skip: !m && 'PLCOV_DB not set' }, async () => {
  await withConn(async (conn, owner) => {
    const state = async () => (await conn.execute<[string, string]>(`select s.plsql_implicit_conversion_bool, o.status from user_plsql_object_settings s join user_objects o on o.object_name = s.name and o.object_type = s.type where s.name = 'PLTEST_JOURNAL_ICB'`)).rows![0];
    try {
      await conn.execute(`alter session set plsql_implicit_conversion_bool = true`);
      await conn.execute(`create or replace procedure pltest_journal_icb is b boolean; begin b := 1; end;`);
      await conn.execute(`alter session set plsql_implicit_conversion_bool = false`);
      const obj = await loadObject(conn, owner, 'PLTEST_JOURNAL_ICB', 'PROCEDURE');
      assert.equal(await replaceSource(conn, obj, 'procedure pltest_journal_icb is b boolean; begin b := 0; end;', 'test'), null);
      await restoreAll(conn, [obj], () => {});
      assert.deepEqual(await state(), ['TRUE', 'VALID']);
    } finally {
      await conn.execute(`drop procedure pltest_journal_icb`).catch(() => {});
      await conn.execute(`alter session set plsql_implicit_conversion_bool = false`).catch(() => {});
    }
  });
});
