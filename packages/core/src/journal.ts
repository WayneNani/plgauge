/**
 * Restore journal (plan item A0): before pltest changes a code object for the first
 * time, it stores the original source and compiler settings in a table. The entry
 * is removed once the original is compiled back. If a run is killed in between,
 * `pltest restore` compiles every journaled original again.
 *
 * Entries are committed at once: the next CREATE OR REPLACE commits anyway, and an
 * entry must survive the process.
 */
import { createHash } from 'node:crypto';
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
  // settings as a CLOB (a view's comments outgrow VARCHAR2(4000)); the fingerprint of the code
  // pltest compiled last (see journalNote); journals of older versions get the columns
  // pending: a view note made before its compile, not yet replaced by what the dictionary holds
  for (const col of ['props clob', 'current_sha varchar2(64)', 'prev_sha varchar2(64)', 'pending number(1)']) {
    try {
      await conn.execute(`alter table pltest_journal add (${col})`);
    } catch (e) {
      if (!(e as Error).message.includes('ORA-01430')) throw e;
    }
  }
}

/** Undoes journalNote after a compile that did not change the object (rejected at once). */
export async function journalUnnote(conn: oracledb.Connection, obj: Pick<SourceObject, 'owner' | 'name' | 'type'>): Promise<void> {
  await conn.execute(`update pltest_journal set current_sha = prev_sha, pending = 0 where owner = :o and name = :n and type = :t`, { o: obj.owner, n: obj.name, t: obj.type });
  await conn.commit();
}

/**
 * A source's fingerprint, independent of whitespace, of the CREATE … keywords Oracle does not
 * keep, and of characters a database character set may not hold (they come back as ? or ¿):
 * printable ASCII only.
 */
export function fingerprint(source: string): string {
  const s = source.replace(/^\s*(CREATE\s+(OR\s+REPLACE\s+)?)?((NON)?EDITIONABLE\s+)?/i, '').replace(/[^\x21-\x3e\x40-\x7e]/g, '');
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * A view statement's query (what ALL_VIEWS.TEXT holds): the text after the first AS outside
 * parentheses, quotes and comments of "[FORCE] VIEW name (columns) … AS query".
 */
export function viewQuery(statement: string): string {
  let depth = 0;
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i];
    if (c === '"' || c === "'") {
      const e = statement.indexOf(c, i + 1);
      if (e < 0) break;
      i = e;
    } else if (c === '-' && statement[i + 1] === '-') {
      const e = statement.indexOf('\n', i);
      if (e < 0) break;
      i = e;
    } else if (c === '/' && statement[i + 1] === '*') {
      const e = statement.indexOf('*/', i + 2);
      if (e < 0) break;
      i = e + 1;
    } else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /[aA]/.test(c) && /[sS]/.test(statement[i + 1] ?? '') && !/[\w$#]/.test(statement[i - 1] ?? '') && !/[\w$#]/.test(statement[i + 2] ?? '')) {
      return statement.slice(i + 2);
    }
  }
  return statement;
}

/**
 * The fingerprint of code pltest compiles into an object (for a view: of its query, which is
 * all the dictionary keeps of the statement).
 */
export function codeFingerprint(type: string, source: string): string {
  return fingerprint(type === 'VIEW' ? viewQuery(source) : source);
}

/**
 * Notes what pltest is about to compile into an object (before it does: a run that dies during
 * the compile leaves either this text or the one before, prev_sha), so a later restore can tell
 * its code from newer work.
 */
export async function journalNote(conn: oracledb.Connection, obj: Pick<SourceObject, 'owner' | 'name' | 'type'>, source: string, before?: string): Promise<void> {
  // before: what the object holds now (its fingerprint, read from the database); without it the
  // previous note stands in for it
  // a view: the dictionary may hold its query differently (SELECT * expanded); until journalSettle
  // notes what it holds, a restore cannot tell and puts the original back
  const note = () => conn.execute(
    `update pltest_journal set prev_sha = nvl(:p, current_sha), current_sha = :h, pending = :w where owner = :o and name = :n and type = :t`,
    { p: before ?? null, h: codeFingerprint(obj.type, source), w: obj.type === 'VIEW' ? 1 : 0, o: obj.owner, n: obj.name, t: obj.type });
  try {
    await note();
  } catch (e) {
    // a journal of an older version without the column
    if (!(e as Error).message.includes('ORA-00904')) throw e;
    await ensureJournal(conn);
    await note();
  }
  await conn.commit();
}

/** After a view's compile: the fingerprint of what the dictionary holds now (see journalNote). */
export async function journalSettle(conn: oracledb.Connection, obj: Pick<SourceObject, 'owner' | 'name' | 'type'>, sha: string): Promise<void> {
  await conn.execute(`update pltest_journal set current_sha = :h, pending = 0 where owner = :o and name = :n and type = :t`, { h: sha, o: obj.owner, n: obj.name, t: obj.type });
  await conn.commit();
}

/** Records the original of an object unless an older entry exists (that one is the true original). */
export async function journalRemember(conn: oracledb.Connection, obj: SourceObject, tool: string): Promise<void> {
  // with the original's fingerprint from the start: a restore checks the unit even when no
  // compile of pltest ever got through (see restoreJournal)
  const merge = () => conn.execute(
    `merge into pltest_journal j
     using (select :o owner, :n name, :t type from dual) x
        on (j.owner = x.owner and j.name = x.name and j.type = x.type)
      when not matched then insert (owner, name, type, source, props, tool, current_sha, pending) values (:o, :n, :t, :src, :st, :tool, :h, 0)`,
    { o: obj.owner, n: obj.name, t: obj.type, src: { val: obj.original, type: oracledb.DB_TYPE_CLOB }, st: { val: JSON.stringify(obj.settings), type: oracledb.DB_TYPE_CLOB }, tool, h: codeFingerprint(obj.type, obj.original) },
  );
  try {
    await merge();
  } catch (e) {
    // a journal of an older version without the new columns
    if (!(e as Error).message.includes('ORA-00904')) throw e;
    await ensureJournal(conn);
    await merge();
  }
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
  /** Fingerprints of the code pltest compiled last and the one before (rows of older versions: none). */
  currentSha?: string;
  prevSha?: string;
  /** 1: a view's note before its compile (or a row of an older version: undefined). */
  pending?: number;
}

export async function journalEntries(conn: oracledb.Connection): Promise<JournalEntry[]> {
  const res = await conn.execute<[string, string, string, string, string | null, string | null, Date, string | null, string | null, number | null]>(
    `select owner, name, type, source, nvl(props, to_clob(settings)) settings, tool, created_at, current_sha, prev_sha, pending from pltest_journal order by created_at`,
    {},
    { fetchInfo: { SOURCE: { type: oracledb.STRING }, SETTINGS: { type: oracledb.STRING } } },
  );
  return (res.rows ?? []).map(([owner, name, type, source, settings, tool, createdAt, sha, prev, pending]) => ({
    owner, name, type, tool: tool ?? '', createdAt, currentSha: sha ?? undefined, prevSha: prev ?? undefined, pending: pending ?? undefined,
    object: { owner, name, type, original: source, processed: source, settings: settings ? JSON.parse(settings) : {} },
  }));
}

/** The lock both tools take: a coverage run and a mutation run must not share a schema either. */
export const RUN_LOCK = 'pltest';

/**
 * Holds a row lock for the rest of the session: a second run of the same tool on the same
 * schema fails at once instead of restoring the first run's changed objects from the journal
 * (they look like leftovers of a crashed run) and measuring against them. The connection must
 * stay open and never commit; the lock goes with the session, also when the process dies.
 */
export async function lockRun(conn: oracledb.Connection, tool: string): Promise<void> {
  try {
    await conn.execute(`create table pltest_lock (tool varchar2(30) primary key)`);
  } catch (e) {
    if (!(e as Error).message.includes('ORA-00955')) throw e;
  }
  try {
    await conn.execute(`insert into pltest_lock (tool) select :t from dual where not exists (select 1 from pltest_lock where tool = :t)`, { t: tool });
    await conn.commit();
  } catch (e) {
    if (!(e as Error).message.includes('ORA-00001')) throw e;
    await conn.rollback();
  }
  try {
    await conn.execute(`select tool from pltest_lock where tool = :t for update nowait`, { t: tool });
  } catch (e) {
    if ((e as Error).message.includes('ORA-00054')) {
      throw new Error('Auf diesem Schema läuft gerade ein anderer pltest-Lauf; zwei Läufe würden sich gegenseitig den Code zurücksetzen');
    }
    throw e;
  }
}
