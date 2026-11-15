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
import { tryExecute, type SourceObject } from './db.js';

const JOURNAL_TABLE = `create table pltest_journal (
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
  await tryExecute(conn, JOURNAL_TABLE, 'ORA-00955');
  // settings as a CLOB (a view's comments outgrow VARCHAR2(4000)); the fingerprint of the code
  // pltest compiled last (see journalNote); journals of older versions get the columns
  // pending: a view note made before its compile, not yet replaced by what the dictionary holds
  for (const col of ['props clob', 'current_sha varchar2(64)', 'prev_sha varchar2(64)', 'pending number(1)']) {
    await tryExecute(conn, `alter table pltest_journal add (${col})`, 'ORA-01430');
  }
}

type ObjKey = Pick<SourceObject, 'owner' | 'name' | 'type'>;

/** A statement on the object's journal entry, committed. */
async function onEntry(conn: oracledb.Connection, obj: ObjKey, stmt: string, binds: Record<string, unknown> = {}): Promise<void> {
  await conn.execute(`${stmt} where owner = :o and name = :n and type = :t`, { ...binds, o: obj.owner, n: obj.name, t: obj.type });
  await conn.commit();
}

/** fn, run again after ensureJournal when a journal of an older version lacks a column (ORA-00904). */
async function upgrading<T>(conn: oracledb.Connection, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e as Error).message.includes('ORA-00904')) throw e;
    await ensureJournal(conn);
    return fn();
  }
}

/** Undoes journalNote after a compile that did not change the object (rejected at once). */
export async function journalUnnote(conn: oracledb.Connection, obj: ObjKey): Promise<void> {
  await onEntry(conn, obj, `update pltest_journal set current_sha = prev_sha, pending = 0`);
}

/**
 * A source's fingerprint, independent of whitespace (a view's DDL and its dictionary text lay
 * out differently) and of the CREATE … keywords Oracle does not keep; every other character
 * counts (the fingerprints a restore compares all come from the same database's dictionary).
 * Marked "x" (no hex digit): fingerprints of older versions, which ignored more, are told apart
 * and never compared.
 */
export function fingerprint(source: string): string {
  const s = source.replace(/^\s*(CREATE\s+(OR\s+REPLACE\s+)?)?((NON)?EDITIONABLE\s+)?/i, '').replace(/\s+/g, '');
  return 'x' + createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 63);
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
export async function journalNote(conn: oracledb.Connection, obj: ObjKey, source: string, before?: string): Promise<void> {
  // before: what the object holds now (its fingerprint, read from the database); without it the
  // previous note stands in for it
  // the dictionary may hold it differently (a view's SELECT * expanded, a trigger's ENABLE/DISABLE
  // or comments after CREATE left out); until journalSettle notes what it holds, a restore
  // cannot tell and puts the original back
  await upgrading(conn, () => onEntry(conn, obj, `update pltest_journal set prev_sha = nvl(:p, current_sha), current_sha = :h, pending = :w`,
    { p: before ?? null, h: codeFingerprint(obj.type, source), w: 1 }));
}

/** After a view's compile: the fingerprint of what the dictionary holds now (see journalNote). */
export async function journalSettle(conn: oracledb.Connection, obj: ObjKey, sha: string): Promise<void> {
  await onEntry(conn, obj, `update pltest_journal set current_sha = :h, pending = 0`, { h: sha });
}

/**
 * Records the original of an object unless an older entry exists (that one is the true original).
 * Returns whether this call made the entry.
 */
export async function journalRemember(conn: oracledb.Connection, obj: SourceObject, tool: string): Promise<boolean> {
  // with the original's fingerprint from the start: a restore checks the unit even when no
  // compile of pltest ever got through (see restoreJournal)
  const r = await upgrading(conn, () => conn.execute(
    `merge into pltest_journal j
     using (select :o owner, :n name, :t type from dual) x
        on (j.owner = x.owner and j.name = x.name and j.type = x.type)
      when not matched then insert (owner, name, type, source, props, tool, current_sha, pending) values (:o, :n, :t, :src, :st, :tool, :h, 0)`,
    { o: obj.owner, n: obj.name, t: obj.type, src: { val: obj.original, type: oracledb.DB_TYPE_CLOB }, st: { val: JSON.stringify(obj.settings), type: oracledb.DB_TYPE_CLOB }, tool, h: codeFingerprint(obj.type, obj.original) },
  ));
  await conn.commit();
  return (r.rowsAffected ?? 0) > 0;
}

export async function journalForget(conn: oracledb.Connection, obj: ObjKey): Promise<void> {
  await onEntry(conn, obj, `delete from pltest_journal`);
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
  await tryExecute(conn, `create table pltest_lock (tool varchar2(30) primary key)`, 'ORA-00955');
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
