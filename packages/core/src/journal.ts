/**
 * Restore journal (plan item A0): before pltest changes a code object for the first
 * time, it stores the original source and compiler settings in a table. The entry
 * is removed once the original is compiled back. If a run is killed in between,
 * `pltest restore` compiles every journaled original again.
 *
 * Entries are committed at once: the next CREATE OR REPLACE commits anyway, and an
 * entry must survive the process.
 */
import oracledb from 'oracledb';
import type { SourceObject } from './db.js';

export const JOURNAL_TABLE = `create table pltest_journal (
  owner      varchar2(128) not null,
  name       varchar2(128) not null,
  type       varchar2(30)  not null,
  source     clob          not null,
  settings   varchar2(4000),
  tool       varchar2(30),
  created_at timestamp default systimestamp,
  constraint pltest_journal_pk primary key (owner, name, type)
)`;

export async function ensureJournal(conn: oracledb.Connection): Promise<void> {
  try {
    await conn.execute(JOURNAL_TABLE);
  } catch (e) {
    if (!(e as Error).message.includes('ORA-00955')) throw e;
  }
}

/** Records the original of an object unless an older entry exists (that one is the true original). */
export async function journalRemember(conn: oracledb.Connection, obj: SourceObject, tool: string): Promise<void> {
  await conn.execute(
    `merge into pltest_journal j
     using (select :o owner, :n name, :t type from dual) x
        on (j.owner = x.owner and j.name = x.name and j.type = x.type)
      when not matched then insert (owner, name, type, source, settings, tool) values (:o, :n, :t, :src, :st, :tool)`,
    { o: obj.owner, n: obj.name, t: obj.type, src: { val: obj.original, type: oracledb.DB_TYPE_CLOB }, st: JSON.stringify(obj.settings), tool },
  );
  await conn.commit();
}

export async function journalForget(conn: oracledb.Connection, obj: Pick<SourceObject, 'owner' | 'name' | 'type'>): Promise<void> {
  await conn.execute(`delete from pltest_journal where owner = :o and name = :n and type = :t`, { o: obj.owner, n: obj.name, t: obj.type });
  await conn.commit();
}

export interface JournalEntry {
  owner: string;
  name: string;
  type: string;
  tool: string;
  createdAt: Date;
  object: SourceObject;
}

export async function journalEntries(conn: oracledb.Connection): Promise<JournalEntry[]> {
  const res = await conn.execute<[string, string, string, string, string | null, string | null, Date]>(
    `select owner, name, type, source, settings, tool, created_at from pltest_journal order by created_at`,
    {},
    { fetchInfo: { SOURCE: { type: oracledb.STRING } } },
  );
  return (res.rows ?? []).map(([owner, name, type, source, settings, tool, createdAt]) => ({
    owner, name, type, tool: tool ?? '', createdAt,
    object: { owner, name, type, original: source, processed: source, settings: settings ? JSON.parse(settings) : {} },
  }));
}
