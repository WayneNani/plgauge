/**
 * Restore journal against a real database (skipped unless PLCOV_DB is set):
 * a changed object whose run "died" (no restoreAll) is put back from the journal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracledb from 'oracledb';
import { ensureJournal, journalEntries, loadObject, replaceSource, restoreAll } from '@pltest/core';

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
