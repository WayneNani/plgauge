/**
 * Database access shared by coverage and mutation: loading code objects with their
 * compiler settings, compiling with those settings, restoring the original.
 *
 * Every change to a code object goes through `replaceSource`, which records the
 * original in the restore journal first (see journal.ts). A run that dies leaves
 * the journal behind, and `pltest restore` puts the originals back.
 */
import oracledb from 'oracledb';
import { createHash } from 'node:crypto';
import { tokenize } from './lexer.js';
import { codeFingerprint, fingerprint, journalForget, journalNote, journalRemember, journalSettle, journalUnnote, type JournalEntry } from './journal.js';

export interface ConnectConfig {
  user: string;
  password: string;
  connectString: string;
}

/** A PL/SQL unit (or a view: original from DBMS_METADATA, no settings) as stored in the database. */
export interface SourceObject {
  owner: string;
  name: string;
  type: string;
  /** ALL_SOURCE text, lines joined. */
  original: string;
  /** DBMS_PREPROCESSOR output: conditional compilation resolved, line numbers kept. */
  processed: string;
  /** Compiler settings from ALL_PLSQL_OBJECT_SETTINGS. */
  settings: Record<string, string>;
}

export function connect(cfg: ConnectConfig): Promise<oracledb.Connection> {
  return oracledb.getConnection({ user: cfg.user, password: cfg.password, connectString: cfg.connectString });
}

export function dbIdent(s: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(s)) throw new Error(`Ungültiger Bezeichner: ${s}`);
  return s.toUpperCase();
}

/**
 * The application context in which utPLSQL names the running test: <utPLSQL owner>_INFO
 * (UT3_INFO for the usual installation in UT3).
 */
export async function utInfoContext(conn: oracledb.Connection): Promise<string> {
  try {
    const r = await conn.execute(`begin :o := ut_utils.ut_owner(); end;`, { o: { dir: oracledb.BIND_OUT, type: oracledb.STRING } });
    const o = (r.outBinds as { o: string | null }).o;
    if (o && /^[A-Za-z][A-Za-z0-9_$#]*$/.test(o)) return `${o.toUpperCase()}_INFO`;
  } catch {
    // an older utPLSQL without ut_owner: the usual name
  }
  return 'UT3_INFO';
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export interface DatabaseInfo {
  banner: string;
  major: number;
}

export async function databaseInfo(conn: oracledb.Connection): Promise<DatabaseInfo> {
  const ver = await conn.execute<[string]>(`select banner_full from v$version where rownum = 1`);
  const banner = ver.rows?.[0]?.[0]?.split('\n')[0] ?? 'Oracle Database';
  const major = Number(
    (await conn.execute<[number]>(`select to_number(regexp_substr(version_full, '^\\d+')) from product_component_version where rownum = 1`)).rows?.[0]?.[0] ?? 19,
  );
  return { banner, major };
}

export interface ObjectFilter {
  /** Regular expressions on object names. */
  include?: string;
  exclude?: string;
  /** Object names never loaded (runtime packages). */
  skip?: string[];
}

/**
 * Loads the code objects of a schema that tests can exercise: package and type
 * bodies, procedures, functions, triggers. utPLSQL test packages are left out.
 */
export async function loadObjects(conn: oracledb.Connection, schema: string, filter: ObjectFilter = {}): Promise<SourceObject[]> {
  const res = await conn.execute<[string, string]>(
    `select o.object_name, o.object_type
       from all_objects o
      where o.owner = :s
        and o.object_type in ('PACKAGE BODY', 'PROCEDURE', 'FUNCTION', 'TYPE BODY', 'TRIGGER')
        and not exists (
              select 1 from all_source s
               where s.owner = o.owner and s.name = o.object_name and s.type = 'PACKAGE'
                 and regexp_like(s.text, '--\\s*%suite', 'i'))
      order by o.object_name, o.object_type`,
    { s: schema },
  );
  const skip = new Set((filter.skip ?? []).map((s) => s.toUpperCase()));
  const out: SourceObject[] = [];
  for (const [name, type] of res.rows ?? []) {
    if (skip.has(name)) continue;
    if (filter.include && !new RegExp(filter.include, 'i').test(name)) continue;
    if (filter.exclude && new RegExp(filter.exclude, 'i').test(name)) continue;
    out.push(await loadObject(conn, schema, name, type));
  }
  return out;
}

export async function loadObject(conn: oracledb.Connection, owner: string, name: string, type: string): Promise<SourceObject> {
  if (type === 'VIEW') {
    // a view the ALL_* views do not show (DBMS_METADATA may, with SELECT_CATALOG_ROLE): its
    // comments, triggers and text could be neither read nor checked, not even after a crash
    const seen = (await conn.execute<[number]>(`select count(*) from all_views where owner = :o and view_name = :n`, { o: owner, n: name })).rows?.[0]?.[0] ?? 0;
    if (!seen) throw new Error(`View ${owner}.${name} ist ohne SELECT- oder READ-Recht nicht sichtbar: nicht verändert`);
    const original = await viewDdl(conn, owner, name);
    // CREATE OR REPLACE VIEW drops the comments: compile puts them back
    const t = await conn.execute<[string | null]>(`select comments from all_tab_comments where owner = :o and table_name = :n`, { o: owner, n: name });
    const c = await conn.execute<[string, string]>(
      `select column_name, comments from all_col_comments where owner = :o and table_name = :n and comments is not null`, { o: owner, n: name });
    const table = t.rows?.[0]?.[0] ?? null;
    const cols = Object.fromEntries(c.rows ?? []);
    const settings: Record<string, string> = table || Object.keys(cols).length ? { comments: JSON.stringify({ table, cols }) } : {};
    // mixed length semantics and a length without BYTE/CHAR (CAST(x AS VARCHAR2(10))): which one
    // the view was created with cannot be told, a recompile could change its column
    const raw = (await conn.execute<[string]>(`select text from all_views where owner = :o and view_name = :n`, { o: owner, n: name })).rows?.[0]?.[0] ?? '';
    const lengths = await conn.execute<[string]>(`select distinct char_used from all_tab_columns where owner = :o and table_name = :n and char_used in ('B', 'C')`, { o: owner, n: name });
    if ((lengths.rows ?? []).length > 1 && /\b(N?VARCHAR2?|N?CHAR|CHARACTER)\s*\(\s*\d+\s*\)/i.test(raw)) {
      throw new Error(`View ${owner}.${name} mischt BYTE- und CHAR-Spalten und hat Längen ohne BYTE/CHAR: nicht verändert`);
    }
    if (settings.comments) {
      // another schema's view: COMMENT ON needs COMMENT ANY TABLE, or the comments are lost for good
      const user = (await conn.execute<[string]>(`select user from dual`)).rows![0][0];
      const may = owner === user || ((await conn.execute<[number]>(`select count(*) from session_privs where privilege = 'COMMENT ANY TABLE'`)).rows?.[0]?.[0] ?? 0) > 0;
      if (!may) throw new Error(`View ${owner}.${name} hat Kommentare, die ohne COMMENT ANY TABLE verloren gingen: nicht verändert`);
    }
    // CAST(… AS VARCHAR2(n)) without BYTE/CHAR takes the session's length semantics at CREATE:
    // compile the view with what its columns have (mixed: the default BYTE)
    const u = await conn.execute<[string]>(
      `select distinct char_used from all_tab_columns where owner = :o and table_name = :n and char_used in ('B', 'C')`, { o: owner, n: name });
    const used = (u.rows ?? []).map((r) => r[0]);
    settings.nls_length_semantics = used.length === 1 && used[0] === 'C' ? 'CHAR' : 'BYTE';
    return { owner, name, type, original, processed: original, settings };
  }
  const src = await conn.execute<[string]>(
    `select text from all_source where owner = :o and name = :n and type = :t order by line`, { o: owner, n: name, t: type },
  );
  const original = (src.rows ?? []).map((r) => r[0]).join('');
  const pp = await conn.execute(
    `declare l dbms_preprocessor.source_lines_t; s clob; begin
       l := dbms_preprocessor.get_post_processed_source(:t, :o, :n);
       for i in 1 .. l.count loop s := s || l(i); end loop;
       :x := s;
     end;`,
    { t: type, o: owner, n: name, x: { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_CLOB } },
  );
  const lob = (pp.outBinds as { x: oracledb.Lob | null }).x;
  const processed = lob ? String(await lob.getData()) : original;
  const st = await conn.execute<[number, string, string, string, string, string | null, string | null]>(
    `select plsql_optimize_level, plsql_code_type, plsql_ccflags, nls_length_semantics, plscope_settings, plsql_warnings, plsql_debug
       from all_plsql_object_settings where owner = :o and name = :n and type = :t`, { o: owner, n: name, t: type },
  );
  const s = st.rows?.[0];
  // implicit BOOLEAN conversion (23.26+, kept per unit): its own query, older versions lack it
  const icb = s
    ? await conn.execute<[string]>(`select plsql_implicit_conversion_bool from all_plsql_object_settings where owner = :o and name = :n and type = :t`, { o: owner, n: name, t: type })
      .then((r) => r.rows?.[0]?.[0], () => undefined)
    : undefined;
  // CREATE OR REPLACE TRIGGER enables a disabled trigger: compile disables it again
  const status = type === 'TRIGGER'
    ? (await conn.execute<[string]>(`select status from all_triggers where owner = :o and trigger_name = :n`, { o: owner, n: name })).rows?.[0]?.[0]
    : undefined;
  return {
    owner, name, type, original, processed,
    settings: {
      ...(s ? { plsql_optimize_level: String(s[0]), plsql_code_type: s[1], plsql_ccflags: s[2] ?? '', nls_length_semantics: s[3], plscope_settings: s[4] ?? '', ...(s[5] ? { plsql_warnings: s[5] } : {}), ...(s[6] === 'TRUE' ? { plsql_debug: 'TRUE' } : {}), ...(icb === 'TRUE' ? { plsql_implicit_conversion_bool: 'TRUE' } : {}) } : {}),
      ...(status === 'DISABLED' ? { trigger_status: 'DISABLED' } : {}),
    },
  };
}

/**
 * A view's statement without CREATE OR REPLACE. DBMS_METADATA keeps everything (FORCE, BEQUEATH,
 * collation), but shows other schemas' objects only with SELECT_CATALOG_ROLE (ORA-31603);
 * then the dictionary gives column list, query and read-only/check constraint.
 */
async function viewDdl(conn: oracledb.Connection, owner: string, name: string): Promise<string> {
  try {
    const r = await conn.execute<[string]>(`select dbms_metadata.get_ddl('VIEW', :n, :o) ddl from dual`, { n: name, o: owner }, { fetchInfo: { DDL: { type: oracledb.STRING } } });
    const ddl = String(r.rows?.[0]?.[0] ?? '').replace(/^\s*create\s+or\s+replace\s+/i, '').trim();
    if (ddl) return ddl;
  } catch (e) {
    if (!/ORA-31603/.test((e as Error).message)) throw e;
  }
  return viewFromDictionary(conn, owner, name);
}

/** A view's statement from ALL_VIEWS, ALL_TAB_COLUMNS and ALL_CONSTRAINTS (FORCE VIEW … AS …). */
export async function viewFromDictionary(conn: oracledb.Connection, owner: string, name: string): Promise<string> {
  const v = await conn.execute<[string, string, string | null, string | null, string | null]>(
    `select text, editioning_view, type_text, bequeath, duality_view from all_views where owner = :o and view_name = :n`, { o: owner, n: name });
  const row = v.rows?.[0];
  if (!row) throw new Error(`View ${owner}.${name} nicht gefunden`);
  const text = row[0];
  // what this statement cannot say: restored from it, the view would lose it for good
  const extra = await conn.execute<[number, number]>(
    `select (select count(*) from all_constraints where owner = :o and table_name = :n
               and (constraint_type in ('P', 'U', 'R') or (constraint_type in ('O', 'V') and constraint_name not like 'SYS\\_%' escape '\\'))),
            (select count(*) from all_tab_cols where owner = :o and table_name = :n and hidden_column = 'YES' and user_generated = 'YES')
       from dual`, { o: owner, n: name });
  const [cons0, invisible] = extra.rows?.[0] ?? [0, 0];
  if (row[1] === 'Y' || row[2] || row[4] === 'Y' || cons0 > 0 || invisible > 0) {
    throw new Error(`View ${owner}.${name} lässt sich ohne DBMS_METADATA nicht originalgetreu nachbauen (Editioning-, Objekt- oder Duality-View, benannte Constraints oder unsichtbare Spalten)`);
  }
  const cols = await conn.execute<[string]>(`select column_name from all_tab_columns where owner = :o and table_name = :n order by column_id`, { o: owner, n: name });
  const cons = await conn.execute<[string]>(`select constraint_type from all_constraints where owner = :o and table_name = :n and constraint_type in ('O', 'V')`, { o: owner, n: name });
  const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
  const types = new Set((cons.rows ?? []).map((r) => r[0]));
  // the text ends with WITH READ ONLY / CHECK OPTION as written (23ai); added only if not
  const written = /\bwith\s+(read\s+only|check\s+option)\s*$/i.test(text.trim());
  const tail = written ? '' : types.has('O') ? ' WITH READ ONLY' : types.has('V') ? ' WITH CHECK OPTION' : '';
  // BEQUEATH DEFINER is the default
  const bequeath = row[3] === 'CURRENT_USER' ? ' BEQUEATH CURRENT_USER' : '';
  return `FORCE VIEW ${q(owner)}.${q(name)} (${(cols.rows ?? []).map((r) => q(r[0])).join(', ')})${bequeath} AS ${text.trim()}${tail}`;
}

/**
 * Compiles source (without CREATE) with the object's original settings, in the object's
 * schema (CURRENT_SCHEMA is switched for the statement if needed: objects of other
 * schemas need CREATE ANY PROCEDURE / TYPE / TRIGGER). Returns error text or null.
 */
export async function compile(conn: oracledb.Connection, obj: SourceObject, source: string): Promise<string | null> {
  return (await compileDetailed(conn, obj, source)).error;
}

export interface CompileOutcome {
  /** Error text, or null if the object is valid. */
  error: string | null;
  /**
   * Statements rejected at once (views): character offset of the error in source, as
   * the server reports it.
   */
  offset?: number;
  /** Compiled, but a property could not be put back (a trigger's DISABLED status, say). */
  warning?: string;
  /**
   * Rejected at once, and pltest had not changed the object before: it holds its original, the
   * journal has no entry for it, nothing to restore.
   */
  untouched?: boolean;
}

export async function compileDetailed(conn: oracledb.Connection, obj: SourceObject, source: string): Promise<CompileOutcome> {
  const cur = (await conn.execute<[string]>(`select sys_context('USERENV', 'CURRENT_SCHEMA') from dual`)).rows![0][0];
  if (cur === obj.owner) return compileHere(conn, obj, source);
  // quoted: a schema named in mixed case ("MyApp") is not MYAPP
  const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
  await conn.execute(`alter session set current_schema = ${q(obj.owner)}`);
  try {
    return await compileHere(conn, obj, source);
  } finally {
    await conn.execute(`alter session set current_schema = ${q(cur)}`);
  }
}

/**
 * What CREATE OR REPLACE loses and the original object had: a trigger's DISABLED status, a
 * view's table and column comments (from loadObject's settings, kept in the journal too).
 */
async function keepProperties(conn: oracledb.Connection, obj: SourceObject): Promise<string | undefined> {
  const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
  const lit = (x: string) => `'${x.replace(/'/g, "''")}'`;
  const full = `${q(obj.owner)}.${q(obj.name)}`;
  // (disabled by the statement itself, see withDisable; ALTER where that did not take)
  const status = obj.type === 'TRIGGER' && obj.settings.trigger_status === 'DISABLED'
    ? (await conn.execute<[string]>(`select status from all_triggers where owner = :o and trigger_name = :n`, { o: obj.owner, n: obj.name })).rows?.[0]?.[0]
    : undefined;
  if (status !== undefined && status !== 'DISABLED') {
    try {
      await conn.execute(`alter trigger ${full} disable`);
    } catch (e) {
      return `Trigger ${obj.name} bleibt aktiv (war deaktiviert): ${(e as Error).message.split('\n')[0]}`;
    }
  }
  if (obj.type === 'VIEW' && obj.settings.comments) {
    const c = JSON.parse(obj.settings.comments) as { table: string | null; cols: Record<string, string> };
    let failure: string | undefined;
    const comment = (sql: string) => conn.execute(sql).then(() => {}, (e: Error) => {
      // a column the mutant's text no longer has cannot take its comment (ORA-00904); anything
      // else (a missing COMMENT ANY TABLE for another schema's view) loses it: reported
      if (!e.message.includes('ORA-00904')) failure ??= e.message.split('\n')[0];
    });
    if (c.table) await comment(`comment on table ${full} is ${lit(c.table)}`);
    for (const [col, text] of Object.entries(c.cols)) await comment(`comment on column ${full}.${q(col)} is ${lit(text)}`);
    if (failure) return `Kommentare der View ${obj.name} nicht wiederhergestellt: ${failure}`;
  }
  return undefined;
}

/**
 * A trigger's statement with DISABLE in its header (in front of WHEN or the body): CREATE OR
 * REPLACE TRIGGER enables a trigger otherwise, and ALTER TRIGGER on another schema's trigger
 * needs ALTER ANY TRIGGER. Oracle keeps the clause out of the stored source (fingerprints stay).
 * undefined: no place found.
 */
export function withDisable(source: string): string | undefined {
  const t = tokenize(source);
  const on = t.findIndex((x) => x.kind === 'ident' && x.up === 'ON');
  if (on < 0) return undefined;
  let depth = 0;
  for (let i = on + 1; i < t.length; i++) {
    const x = t[i];
    if (x.text === '(') depth++;
    else if (x.text === ')') depth--;
    // the body's label (<<blk>> BEGIN …) belongs to the block: DISABLE goes in front of it
    else if (depth === 0 && x.text === '<<') return `${source.slice(0, x.start)}DISABLE ${source.slice(x.start)}`;
    else if (depth === 0 && x.kind === 'ident') {
      if (x.up === 'DISABLE') return source;
      if (x.up === 'ENABLE') return source.slice(0, x.start) + 'DISABLE' + source.slice(x.end);
      if (['WHEN', 'DECLARE', 'BEGIN', 'COMPOUND', 'CALL'].includes(x.up)) return `${source.slice(0, x.start)}DISABLE ${source.slice(x.start)}`;
    }
  }
  return undefined;
}

async function compileHere(conn: oracledb.Connection, obj: SourceObject, source: string): Promise<CompileOutcome> {
  const st = obj.settings;
  // (a trigger with compile errors stays disabled this way: never compiled again without it)
  const disabled = obj.type === 'TRIGGER' && st.trigger_status === 'DISABLED' ? withDisable(source) : undefined;
  if (disabled) source = disabled;
  if (st.plsql_optimize_level) await conn.execute(`alter session set plsql_optimize_level = ${Number(st.plsql_optimize_level)}`);
  if (st.plsql_code_type) await conn.execute(`alter session set plsql_code_type = '${st.plsql_code_type.replace(/'/g, '')}'`);
  await conn.execute(`alter session set plsql_ccflags = '${(st.plsql_ccflags ?? '').replace(/'/g, "''")}'`);
  if (st.nls_length_semantics) await conn.execute(`alter session set nls_length_semantics = ${st.nls_length_semantics === 'CHAR' ? 'CHAR' : 'BYTE'}`);
  // PL/Scope data of the unit stays as it was (code that inspects PL/Scope, e.g. plscope-utils)
  if (st.plscope_settings) await conn.execute(`alter session set plscope_settings = '${st.plscope_settings.replace(/'/g, '')}'`);
  // the unit's compiler warnings (a CI that checks them sees the same after the run)
  if (st.plsql_warnings) await conn.execute(`alter session set plsql_warnings = '${st.plsql_warnings.replace(/'/g, '')}'`);
  // compiled for debugging (breakpoints): stays so; set for every unit, the session keeps it
  if (obj.type !== 'VIEW') await conn.execute(`alter session set plsql_debug = ${st.plsql_debug === 'TRUE' ? 'TRUE' : 'FALSE'}`);
  // likewise implicit BOOLEAN conversion (a unit may need it to compile at all); refused before 23.26
  if (obj.type !== 'VIEW') await conn.execute(`alter session set plsql_implicit_conversion_bool = ${st.plsql_implicit_conversion_bool === 'TRUE' ? 'TRUE' : 'FALSE'}`).catch(() => {});
  const prefix = 'create or replace ';
  try {
    await conn.execute(prefix + source.replace(/\s*$/, ''));
  } catch (e) {
    // ORA-24344: success with compilation error -> read the errors below
    const msg = (e as Error).message;
    if (!msg.includes('ORA-24344')) {
      const off = (e as { offset?: number }).offset;
      return { error: msg.split('\n')[0], offset: typeof off === 'number' && off >= prefix.length ? off - prefix.length : undefined };
    }
  }
  const warning = await keepProperties(conn, obj);
  const err = await conn.execute<[number, string]>(
    `select line, text from all_errors where owner = :o and name = :n and type = :t and attribute = 'ERROR' order by sequence`,
    { o: obj.owner, n: obj.name, t: obj.type },
  );
  if (err.rows?.length) return { error: err.rows.slice(0, 3).map((r) => `Zeile ${r[0]}: ${r[1].trim()}`).join('; '), warning };
  return { error: null, warning };
}

/**
 * Replaces an object's code (instrumented or mutated). The original goes into the
 * restore journal before the first change, so it survives a crashed run.
 */
export async function replaceSource(conn: oracledb.Connection, obj: SourceObject, source: string, tool: string): Promise<string | null> {
  return (await replaceSourceDetailed(conn, obj, source, tool)).error;
}

export async function replaceSourceDetailed(conn: oracledb.Connection, obj: SourceObject, source: string, tool: string): Promise<CompileOutcome> {
  const fresh = await journalRemember(conn, obj, tool);
  // noted before the compile: if the run dies during it, the unit holds this text or the one it
  // holds now (read from the database, not assumed from the last note: a compile that failed
  // before its DDL changed nothing)
  const now = await currentCode(conn, obj).catch(() => undefined);
  // what cannot be read cannot be checked after a crash (a restore would take it for dropped)
  if (!now) {
    if (fresh) await journalForget(conn, obj);
    return { error: `${obj.owner}.${obj.name} ist nicht lesbar (ALL_SOURCE/ALL_VIEWS): nicht verändert`, untouched: fresh };
  }
  // someone compiled a newer version since the original was read: the journal would put the old
  // one back over it at the end
  if (fresh && now.sha !== codeFingerprint(obj.type, obj.original)) {
    await journalForget(conn, obj);
    return { error: `${obj.owner}.${obj.name} wurde geändert, seit es gelesen wurde: nicht verändert`, untouched: true };
  }
  await journalNote(conn, obj, source, now.sha);
  const out = await compileDetailed(conn, obj, source);
  // rejected at once (a lock, a privilege, a view statement): the object still holds the text before
  if (out.error && !/^Zeile \d+:/.test(out.error)) {
    // (a privilege, a lock the next restore would hit just the same)
    if (fresh) {
      await journalForget(conn, obj);
      out.untouched = true;
    } else await journalUnnote(conn, obj);
  } else {
    // what the dictionary made of it (a view's SELECT * expanded, a trigger's ENABLE/DISABLE or
    // comments after CREATE left out): a restore compares with that
    const held = await currentCode(conn, obj).catch(() => undefined);
    if (held) await journalSettle(conn, obj, held.sha);
  }
  return out;
}

/**
 * The code of an object as the database holds it now (a view: its query) and its fingerprint,
 * comparable to codeFingerprint's; undefined for a missing object.
 */
async function currentCode(conn: oracledb.Connection, obj: Pick<SourceObject, 'owner' | 'name' | 'type'>): Promise<{ text: string; sha: string } | undefined> {
  if (obj.type === 'VIEW') {
    const v = await conn.execute<[string]>(`select text from all_views where owner = :o and view_name = :n`, { o: obj.owner, n: obj.name });
    const text = v.rows?.[0]?.[0];
    return text === undefined ? undefined : { text, sha: fingerprint(text) };
  }
  const r = await conn.execute<[string]>(`select text from all_source where owner = :o and name = :n and type = :t order by line`, { o: obj.owner, n: obj.name, t: obj.type });
  if (!r.rows?.length) return undefined;
  const text = r.rows.map((x) => x[0]).join('');
  return { text, sha: fingerprint(text) };
}

/**
 * Journal entries a dead run left, back to their originals, unless the unit holds code that is
 * neither pltest's (the fingerprint of what it compiled last) nor carries its marks: then
 * someone has put newer work there since, which wins; its entry is dropped with a warning.
 */
export async function restoreJournal(conn: oracledb.Connection, entries: JournalEntry[], say: (m: string) => void): Promise<number> {
  const todo: SourceObject[] = [];
  let hidden = 0;
  const [user, schema] = (await conn.execute<[string, string]>(`select user, sys_context('USERENV', 'CURRENT_SCHEMA') from dual`)).rows![0];
  for (const e of entries) {
    // (not readable: restored as before; the compile reports what is wrong)
    const cur = await currentCode(conn, e.object).catch(() => null);
    if (cur === undefined) {
      // missing from ALL_SOURCE / ALL_VIEWS: dropped, or only not visible to this user (another
      // schema's body without the ANY privileges); DBA_OBJECTS tells, or the own schema
      const dba = await conn.execute<[number]>(`select count(*) from dba_objects where owner = :o and object_name = :n and object_type = :t`, { o: e.owner, n: e.name, t: e.type })
        .then((r) => r.rows?.[0]?.[0] ?? 0, () => undefined);
      // without DBA_OBJECTS: the session sees the object whenever it exists in its own schemas, or
      // with the ANY privilege that shows such objects in ALL_SOURCE / ALL_VIEWS
      const any = e.type === 'VIEW' ? ['SELECT ANY TABLE', 'READ ANY TABLE'] : e.type === 'TRIGGER' ? ['CREATE ANY TRIGGER'] : ['CREATE ANY PROCEDURE', 'EXECUTE ANY PROCEDURE'];
      const sees = dba === undefined && (e.owner === user || e.owner === schema
        || ((await conn.execute<[number]>(`select count(*) from session_privs where privilege in (${any.map((p) => `'${p}'`).join(', ')})`)).rows?.[0]?.[0] ?? 0) > 0);
      if (dba === 0 || sees) {
        // pltest never drops an object: someone did since, on purpose
        say(`  ✗ ${e.owner}.${e.name} existiert nicht mehr: Journal-Eintrag verworfen, nicht neu angelegt`);
        await journalForget(conn, e.object);
      } else {
        say(`  ✗ ${e.owner}.${e.name} ist für ${user} nicht sichtbar: Journal-Eintrag bleibt, mit dem Benutzer des Laufs zurückspielen (pltest restore)`);
        hidden++;
      }
      continue;
    }
    // noted before its compile and not settled, or by an older version (other fingerprints): no
    // comparison possible, the original goes back
    const comparable = e.currentSha && e.pending === 0;
    if (comparable) {
      // pltest's: the text it was about to compile, the one before, or the original itself
      const ours = new Set([e.currentSha, e.prevSha, codeFingerprint(e.object.type, e.object.original)]);
      if (cur && !ours.has(cur.sha) && !/plmut_ctl\.|plmut\$a|cov\$\./i.test(cur.text)) {
        say(`  ✗ ${e.owner}.${e.name} wurde nach dem abgebrochenen Lauf geändert: Journal-Eintrag verworfen, die neuere Fassung bleibt`);
        await journalForget(conn, e.object);
        continue;
      }
    }
    todo.push(e.object);
  }
  // how many hold changed code still (or may: not visible here)
  return hidden + (await restoreAll(conn, todo, say));
}

/**
 * Compiles the originals again and clears their journal entries. recompile: then compile
 * what became invalid in their schemas (dependents of a view, say); without it they
 * recompile on first use.
 */
export async function restoreAll(conn: oracledb.Connection, objs: SourceObject[], say: (m: string) => void, recompile = true): Promise<number> {
  const schemas = new Set<string>();
  let failed = 0;
  for (const obj of objs) {
    // one object that cannot even be tried (its schema is gone, say) must not stop the others
    const out = await compileDetailed(conn, obj, obj.original).catch((e: Error) => ({ error: e.message.split('\n')[0], warning: undefined }) as CompileOutcome);
    const err = out.error;
    if (out.warning) say(`  ✗ ${out.warning}`);
    if (err) {
      say(`  ✗ Wiederherstellung von ${obj.name} fehlgeschlagen: ${err}`);
      // compile errors ("Zeile n: …"): the original is in place, only invalid; anything else
      // left the changed code there and the entry must stay
      if (!/^Zeile \d+:/.test(err)) {
        failed++;
        continue;
      }
    }
    await journalForget(conn, obj);
    schemas.add(obj.owner);
  }
  // (may be refused for another schema: the originals are back anyway)
  if (recompile) {
    for (const s of schemas) {
      await conn.execute(`begin dbms_utility.compile_schema(:s, compile_all => false, reuse_settings => true); end;`, { s })
        .catch((e: Error) => say(`  Hinweis: Neukompilieren von ${s} nicht möglich: ${e.message.split('\n')[0]}`));
    }
  }
  // materialized views on a replaced view or function are left NEEDS_COMPILE (compile_schema
  // leaves them)
  for (const obj of objs) {
    const mv = await conn.execute<[string, string]>(
      `select owner, name from all_dependencies where referenced_owner = :o and referenced_name = :n and type = 'MATERIALIZED VIEW'`,
      { o: obj.owner, n: obj.name },
    ).catch(() => ({ rows: [] as [string, string][] }));
    const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
    for (const [o, n] of mv.rows ?? []) await conn.execute(`alter materialized view ${q(o)}.${q(n)} compile`).catch(() => {});
  }
  say(`Originalcode von ${objs.length - failed} Objekten wiederhergestellt${failed ? `, ${failed} nicht (Journal-Eintrag bleibt)` : ''}`);
  // how many hold changed code still (their entries stay)
  return failed;
}

export interface CompileError {
  line: number;
  position: number;
  text: string;
}

/** All compile errors of an object (attribute ERROR), with line and column. */
export async function objectErrors(conn: oracledb.Connection, obj: Pick<SourceObject, 'owner' | 'name' | 'type'>): Promise<CompileError[]> {
  const err = await conn.execute<[number, number, string]>(
    `select line, position, text from all_errors where owner = :o and name = :n and type = :t and attribute = 'ERROR' order by sequence`,
    { o: obj.owner, n: obj.name, t: obj.type },
  );
  return (err.rows ?? []).map(([line, position, text]) => ({ line, position, text: text.trim() }));
}

/** Runs the statements of a SQL*Plus style script; "already exists" errors are skipped. */
export async function runScript(conn: oracledb.Connection, statements: string[], where: string): Promise<void> {
  // a script may switch CURRENT_SCHEMA: the run's journal and lock stay where they were
  const home = (await conn.execute<[string]>(`select sys_context('USERENV', 'CURRENT_SCHEMA') from dual`)).rows![0][0];
  try {
    for (const stmt of statements) {
      try {
        await conn.execute(stmt);
      } catch (e) {
        const msg = (e as Error).message;
        if (/ORA-00955|ORA-01430|ORA-02260|ORA-02275|ORA-01920|ORA-24344/.test(msg)) continue;
        throw new Error(`${where}: ${msg.split('\n')[0]}`);
      }
    }
  } finally {
    await conn.execute(`alter session set current_schema = "${home.replace(/"/g, '""')}"`).catch(() => {});
  }
}
