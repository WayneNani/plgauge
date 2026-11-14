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
import { journalForget, journalRemember } from './journal.js';

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
    // the complete statement (column list, FORCE, options) without CREATE OR REPLACE
    const r = await conn.execute<[string]>(`select dbms_metadata.get_ddl('VIEW', :n, :o) ddl from dual`, { n: name, o: owner }, { fetchInfo: { DDL: { type: oracledb.STRING } } });
    const original = String(r.rows?.[0]?.[0] ?? '').replace(/^\s*create\s+or\s+replace\s+/i, '').trim();
    if (!original) throw new Error(`View ${owner}.${name} nicht gefunden`);
    return { owner, name, type, original, processed: original, settings: {} };
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
  const st = await conn.execute<[number, string, string, string, string]>(
    `select plsql_optimize_level, plsql_code_type, plsql_ccflags, nls_length_semantics, plscope_settings
       from all_plsql_object_settings where owner = :o and name = :n and type = :t`, { o: owner, n: name, t: type },
  );
  const s = st.rows?.[0];
  return {
    owner, name, type, original, processed,
    settings: s
      ? { plsql_optimize_level: String(s[0]), plsql_code_type: s[1], plsql_ccflags: s[2] ?? '', nls_length_semantics: s[3], plscope_settings: s[4] ?? '' }
      : {},
  };
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
}

export async function compileDetailed(conn: oracledb.Connection, obj: SourceObject, source: string): Promise<CompileOutcome> {
  const cur = (await conn.execute<[string]>(`select sys_context('USERENV', 'CURRENT_SCHEMA') from dual`)).rows![0][0];
  if (cur === obj.owner) return compileHere(conn, obj, source);
  await conn.execute(`alter session set current_schema = ${dbIdent(obj.owner)}`);
  try {
    return await compileHere(conn, obj, source);
  } finally {
    await conn.execute(`alter session set current_schema = ${dbIdent(cur)}`);
  }
}

async function compileHere(conn: oracledb.Connection, obj: SourceObject, source: string): Promise<CompileOutcome> {
  const st = obj.settings;
  if (st.plsql_optimize_level) await conn.execute(`alter session set plsql_optimize_level = ${Number(st.plsql_optimize_level)}`);
  if (st.plsql_code_type) await conn.execute(`alter session set plsql_code_type = '${st.plsql_code_type.replace(/'/g, '')}'`);
  await conn.execute(`alter session set plsql_ccflags = '${(st.plsql_ccflags ?? '').replace(/'/g, "''")}'`);
  if (st.nls_length_semantics) await conn.execute(`alter session set nls_length_semantics = ${st.nls_length_semantics === 'CHAR' ? 'CHAR' : 'BYTE'}`);
  // PL/Scope data of the unit stays as it was (code that inspects PL/Scope, e.g. plscope-utils)
  if (st.plscope_settings) await conn.execute(`alter session set plscope_settings = '${st.plscope_settings.replace(/'/g, '')}'`);
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
  const err = await conn.execute<[number, string]>(
    `select line, text from all_errors where owner = :o and name = :n and type = :t and attribute = 'ERROR' order by sequence`,
    { o: obj.owner, n: obj.name, t: obj.type },
  );
  if (err.rows?.length) return { error: err.rows.slice(0, 3).map((r) => `Zeile ${r[0]}: ${r[1].trim()}`).join('; ') };
  return { error: null };
}

/**
 * Replaces an object's code (instrumented or mutated). The original goes into the
 * restore journal before the first change, so it survives a crashed run.
 */
export async function replaceSource(conn: oracledb.Connection, obj: SourceObject, source: string, tool: string): Promise<string | null> {
  return (await replaceSourceDetailed(conn, obj, source, tool)).error;
}

export async function replaceSourceDetailed(conn: oracledb.Connection, obj: SourceObject, source: string, tool: string): Promise<CompileOutcome> {
  await journalRemember(conn, obj, tool);
  return compileDetailed(conn, obj, source);
}

/** Compiles the originals again and clears their journal entries. */
export async function restoreAll(conn: oracledb.Connection, objs: SourceObject[], say: (m: string) => void): Promise<void> {
  const schemas = new Set<string>();
  for (const obj of objs) {
    const err = await compile(conn, obj, obj.original);
    if (err) {
      say(`  ✗ Wiederherstellung von ${obj.name} fehlgeschlagen: ${err}`);
      continue;
    }
    await journalForget(conn, obj);
    schemas.add(obj.owner);
  }
  for (const s of schemas) await conn.execute(`begin dbms_utility.compile_schema(:s, compile_all => false); end;`, { s });
  say(`Originalcode von ${objs.length} Objekten wiederhergestellt`);
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
  for (const stmt of statements) {
    try {
      await conn.execute(stmt);
    } catch (e) {
      const msg = (e as Error).message;
      if (/ORA-00955|ORA-01430|ORA-02260|ORA-02275|ORA-01920|ORA-24344/.test(msg)) continue;
      throw new Error(`${where}: ${msg.split('\n')[0]}`);
    }
  }
}
