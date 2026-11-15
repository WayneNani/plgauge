/**
 * Database sessions for mutation runs, ported from plmut (internal/db): running
 * utPLSQL under a time limit, reading the TeamCity output, activating mutants,
 * reading recorded hits and loop counts.
 */
import oracledb from 'oracledb';
import { utInfoContext } from '@pltest/core';
import { contextName, CTL_BODY, CTL_SPEC, CTX, MARKER_TABLE, RT_BODY, RT_SPEC } from './ddl.js';

export interface ConnectConfig {
  user: string;
  password: string;
  connectString: string;
}

/** Parses oracle://user:password@host:port/service (the PLMUT_DB form). */
export function parseDbUrl(url: string): ConnectConfig {
  const u = new URL(url);
  if (u.protocol !== 'oracle:') throw new Error(`keine oracle://-URL: ${url}`);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    connectString: `${u.hostname}:${u.port || 1521}${u.pathname}`,
  };
}

/** A session with its identity, so that a monitor session can cancel or kill its calls. */
export interface Session {
  conn: oracledb.Connection;
  sid: number;
  serial: number;
}

export async function newSession(cfg: ConnectConfig): Promise<Session> {
  const conn = await oracledb.getConnection(cfg);
  try {
    const r = await conn.execute<[number, number]>(
      `select to_number(sys_context('USERENV','SID')), serial# from v$session where sid = sys_context('USERENV','SID')`,
    );
    const [sid, serial] = r.rows![0];
    return { conn, sid, serial };
  } catch (e) {
    // (an open connection would keep the process alive)
    await conn.close().catch(() => {});
    throw e;
  }
}

async function compileDdl(conn: oracledb.Connection, ddl: string, type: string, name: string): Promise<void> {
  try {
    await conn.execute(ddl);
  } catch (e) {
    if (!(e as Error).message.includes('ORA-24344')) throw e;
  }
  const err = await conn.execute<[number, string]>(
    `select line, text from user_errors where name = :n and type = :t and attribute = 'ERROR' order by sequence`, { n: name, t: type },
  );
  if (err.rows?.length) throw new Error(`${type} ${name}: ${err.rows.map((r) => `${r[0]}: ${r[1].trim()}`).join('; ')}`);
}

/** Marker table and plmut_rt. */
export async function installRuntime(conn: oracledb.Connection): Promise<void> {
  try {
    await conn.execute(MARKER_TABLE);
  } catch (e) {
    if (!(e as Error).message.includes('ORA-00955')) throw e;
  }
  await compileDdl(conn, RT_SPEC, 'PACKAGE', 'PLMUT_RT');
  await compileDdl(conn, RT_BODY, 'PACKAGE BODY', 'PLMUT_RT');
}

export { contextName };

/** Context and plmut_ctl. */
export async function installControl(conn: oracledb.Connection): Promise<void> {
  const schema = (await conn.execute<[string]>(`select sys_context('USERENV','CURRENT_SCHEMA') from dual`)).rows![0][0];
  const ctx = contextName(schema);
  try {
    await conn.execute(CTX.replace(/plmut_ctx/i, ctx));
  } catch (e) {
    throw new Error(`CREATE CONTEXT (Recht CREATE ANY CONTEXT nötig): ${(e as Error).message}`);
  }
  await compileDdl(conn, CTL_SPEC.replace(/PLMUT_CTX/g, ctx), 'PACKAGE', 'PLMUT_CTL');
  await compileDdl(conn, CTL_BODY.replace(/PLMUT_CTX/g, ctx).replace(/UT3_INFO/g, await utInfoContext(conn)), 'PACKAGE BODY', 'PLMUT_CTL');
}

export interface TestResult {
  /** owner.package.procedure, lower case */
  name: string;
  failed: boolean;
  ignored: boolean;
  durationMs: number;
  message: string;
}

export interface RunResult {
  tests: TestResult[];
  elapsedMs: number;
  /** The call itself failed. */
  err?: Error;
  /** The watchdog cancelled the call. */
  timedOut: boolean;
  /** The session had to be killed; it is unusable. */
  killed: boolean;
  /** A test committed the session's transaction (side effect). */
  committed: boolean;
}

export const failed = (r: RunResult) => !!r.err || r.tests.some((t) => t.failed);

export function firstFailure(r: RunResult): string {
  return r.tests.find((t) => t.failed)?.name ?? (r.err ? firstLine(r.err) : '');
}

export function firstFailureMessage(r: RunResult): string {
  return r.tests.find((t) => t.failed)?.message ?? (r.err ? firstLine(r.err) : '');
}

export const firstLine = (e: Error | string) => String(e instanceof Error ? e.message : e).split('\n')[0];

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * Runs utPLSQL paths in session s. If the call takes longer than limitMs, the
 * monitor cancels it in three steps, as measured in spike M0: ALTER SYSTEM CANCEL SQL
 * (immediate), then the driver's break (can lag ~11 s for loops with SQL), then
 * KILL SESSION.
 */
export async function runTests(s: Session, monitor: oracledb.Connection, paths: string[], limitMs: number): Promise<RunResult> {
  let done = false;
  let timedOut = false;
  let killed = false;
  const watchdog = (async () => {
    const steps: [number, () => Promise<unknown>][] = [
      [limitMs, async () => {
        timedOut = true;
        await monitor.execute(`ALTER SYSTEM CANCEL SQL '${s.sid}, ${s.serial}'`).catch(() => {});
      }],
      [5000, () => s.conn.break().catch(() => {})],
      [5000, async () => {
        killed = true;
        await monitor.execute(`ALTER SYSTEM KILL SESSION '${s.sid},${s.serial}' IMMEDIATE`).catch(() => {});
      }],
    ];
    for (const [after, step] of steps) {
      const t0 = Date.now();
      while (!done && Date.now() - t0 < after) await sleep(Math.min(50, after));
      if (done) return;
      await step();
    }
  })();

  const t0 = performance.now();
  const res: RunResult = { tests: [], elapsedMs: 0, timedOut: false, killed: false, committed: false };
  try {
    const r = await s.conn.execute(`BEGIN plmut_rt.run_tests(:p, :o); END;`, {
      p: { val: paths.join(','), type: oracledb.DB_TYPE_CLOB },
      o: { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_CLOB },
    });
    const lob = (r.outBinds as { o: oracledb.Lob | null }).o;
    const out = lob ? String(await lob.getData()) : '';
    // (a commit after a test that rolled back the whole transaction, marker included, is not seen)
    res.committed = out.includes('##plmut[committed]');
    res.tests = parseTeamCity(out);
    if (!res.tests.length) res.err = new Error('keine Tests im Report (Pfade prüfen)');
  } catch (e) {
    res.err = e as Error;
  } finally {
    res.elapsedMs = performance.now() - t0;
    done = true;
    await watchdog;
    res.timedOut = timedOut;
    res.killed = killed;
  }
  return res;
}

/** Discards the session's package state, so the next call does not hit ORA-04068. */
export async function resetPackages(s: Session): Promise<void> {
  await s.conn.execute(`BEGIN DBMS_SESSION.RESET_PACKAGE; END;`);
}

/** Sets the active mutant and discards package state. 0 = none, -1 = recording run. */
export async function activate(s: Session, id: number): Promise<void> {
  await s.conn.execute(`BEGIN plmut_ctl.activate(:id); END;`, { id });
  await resetPackages(s);
}

async function clobCall(s: Session, block: string): Promise<string> {
  const r = await s.conn.execute(block, { o: { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_CLOB } });
  const lob = (r.outBinds as { o: oracledb.Lob | null }).o;
  return lob ? String(await lob.getData()) : '';
}

/** Per test name, the mutant IDs whose points the test reached ("" = outside a test). */
export async function hits(s: Session): Promise<Map<string, number[]>> {
  const out = await clobCall(s, `BEGIN plmut_ctl.dump_hits(:o); END;`);
  const m = new Map<string, number[]>();
  for (const line of out.split('\n')) {
    const k = line.lastIndexOf('|');
    if (k < 0) continue;
    const id = Number(line.slice(k + 1));
    if (!Number.isFinite(id)) continue;
    const test = line.slice(0, k);
    const list = m.get(test) ?? [];
    list.push(id);
    m.set(test, list);
  }
  return m;
}

/** Iteration count per loop guard of the last run. */
export async function loops(s: Session): Promise<Map<number, number>> {
  const out = await clobCall(s, `BEGIN plmut_ctl.dump_loops(:o); END;`);
  const m = new Map<number, number>();
  for (const line of out.split('\n')) {
    const [a, b] = line.split('|');
    if (b !== undefined && Number.isFinite(Number(a)) && Number.isFinite(Number(b))) m.set(Number(a), Number(b));
  }
  return m;
}

/** Stores loop limits in the session's context, where they survive package resets. */
export async function setLoopLimits(s: Session, limits: Map<number, number>): Promise<void> {
  for (const [id, n] of limits) await s.conn.execute(`BEGIN plmut_ctl.set_limit(:id, :n); END;`, { id, n });
}

/** Whether a loop guard fired since the last activation. */
export async function aborted(s: Session): Promise<boolean> {
  const r = await s.conn.execute<[number]>(`SELECT plmut_ctl.aborted FROM dual`);
  return r.rows![0][0] === 1;
}

export const isMemory = (e?: Error) => !!e && /ORA-04036|ORA-04030/.test(e.message);

/** Reads the TeamCity service messages that utPLSQL prints. */
export function parseTeamCity(out: string): TestResult[] {
  const tests: TestResult[] = [];
  const index = new Map<string, TestResult>();
  const get = (name: string) => {
    let t = index.get(name);
    if (!t) {
      t = { name, failed: false, ignored: false, durationMs: 0, message: '' };
      index.set(name, t);
      tests.push(t);
    }
    return t;
  };
  for (let line of out.split('\n')) {
    line = line.trim();
    if (!line.startsWith('##teamcity[') || !line.endsWith(']')) continue;
    const body = line.slice('##teamcity['.length, -1);
    const sp = body.indexOf(' ');
    const kind = sp < 0 ? body : body.slice(0, sp);
    const a = parseAttrs(sp < 0 ? '' : body.slice(sp + 1));
    const name = a.name ?? '';
    switch (kind) {
      case 'testStarted':
        get(name);
        break;
      case 'testFailed': {
        const t = get(name);
        t.failed = true;
        if (!t.message) t.message = `${a.message ?? ''} ${a.details ?? ''}`.trim();
        break;
      }
      case 'testIgnored':
        get(name).ignored = true;
        break;
      case 'testFinished': {
        const d = Number(a.duration);
        if (Number.isFinite(d)) get(name).durationMs = d;
        break;
      }
    }
  }
  return tests;
}

/** name='value' pairs with TeamCity escapes (|' |n |r || |[ |]). */
function parseAttrs(s: string): Record<string, string> {
  const m: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ') i++;
    const eq = s.indexOf("='", i);
    if (eq < 0) break;
    const key = s.slice(i, eq);
    i = eq + 2;
    let v = '';
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '|' && i + 1 < s.length) {
        const n = s[++i];
        v += n === 'n' ? '\n' : n === 'r' ? '\r' : n;
        continue;
      }
      if (c === "'") break;
      v += c;
    }
    m[key] = v;
    i++;
  }
  return m;
}
