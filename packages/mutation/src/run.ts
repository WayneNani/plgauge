/**
 * A mutation testing run, ported from plmut (internal/run): install, baseline,
 * mutants, verdicts. Two modes:
 *
 * - schema (default): all mutants compiled into the code once; a recording run notes
 *   which test reaches which mutant; each mutant runs only against its covering
 *   tests, the fastest first, fail-fast.
 * - naive: every mutant compiled on its own, all tests each time (or, with measured
 *   coverage, the tests that ran the statement around it). Slow but independent of the
 *   schema rewriter: the oracle.
 *
 * Several databases (workers) share the mutants; the first one decides schema,
 * baseline and coverage. Every code change goes through the core's restore journal.
 */
import { globSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import oracledb from 'oracledb';
import {
  dbIdent, ensureJournal, failureMessage, failureSummary, journalEntries, loadObject, restoreJournal, lockRun, RUN_LOCK, objectErrors, replaceSourceDetailed, restoreAll, runScript, runTestHooks, sha256, splitScript, touches,
  type ChangedLines, type SourceObject,
} from '@plgauge/core';
import { revokeRuntime, type CoverageExport } from '@plgauge/coverage';
import { CoverageIndex, unitLineOf } from './link.js';
import { expand, mutatedUnit, objectName, objectOwner, unitKey, withoutCreate, withoutLeadingComments, type Mutant, type Point } from './mutant.js';
import { findPoints } from './find.js';
import { buildSchema, livePlan, locate, orderedMain, planDiff, positionOf, switchable, type PlanRow, type SchemaUnit } from './schema.js';
import {
  activate, aborted, failed, firstFailure, firstLine, hits, installControl, installRuntime, isMemory,
  loops, newSession, parseDbUrl, resetPackages, runTests, setLoopLimits,
  type ConnectConfig, type RunResult, type Session, type TestResult,
} from './session.js';

export type Status = 'KILLED' | 'SURVIVED' | 'TIMEOUT' | 'MEMORY' | 'NOT_COVERED' | 'COMPILE_ERROR' | 'ERROR';

/** Project file plgauge.json. */
export interface Config {
  /** Scripts, in order, relative to the project. */
  install: string[];
  /** Globs of files whose units are mutated. */
  mutate: string[];
  /** utPLSQL paths; empty runs the whole schema. */
  tests: string[];
  /**
   * Scripts relative to the project, run before the first test run (test seams: synonyms to
   * mocks, say) and at the very end, after the originals are back, also when the run fails.
   */
  beforeTests: string[];
  afterTests: string[];
}

export interface Options {
  dir: string;
  /** oracle://user:pw@host:port/service, one per worker database. */
  dbUrls: string[];
  ops?: Set<string>;
  timeoutFactor?: number;
  mode?: 'schema' | 'naive';
  skipInstall?: boolean;
  /** After a side effect: shell command that resets the worker; {port} is replaced. */
  resetCmd?: string;
  /** >0: run only this many mutants, chosen at random (seeded). */
  sample?: number;
  seed?: number;
  log?: (m: string) => void;
  /** Measured coverage (plgauge-coverage/1): the oracle mode runs only the tests around each mutant. */
  coverage?: CoverageExport;
  /** Diff mode: only mutants on these lines (core changedLines). */
  diff?: ChangedLines;
  /** Second look at kills and timeouts on another worker (default on; see confirmVerdicts). */
  confirm?: boolean;
}

export interface Result {
  id: number;
  op: string;
  file: string;
  unit: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  sub: string;
  ctx: string;
  category: string;
  original: string;
  mutated: string;
  status: Status;
  killedBy?: string;
  detail?: string;
  durationMs: number;
  /** A test committed while this mutant was active. */
  sideEffect?: boolean;
  /** File line of the unit keyword: ALL_SOURCE line = line - unitLine + 1. */
  unitLine: number;
  /** Tests that reached the mutant (schema mode: recording run; oracle mode: selected by coverage). */
  coveredBy?: string[];
  /**
   * The second look (confirmVerdicts) disagreed: a kill that did not repeat with the killing
   * test alone on another worker, or a timeout that finished with twice the time.
   */
  unstable?: string;
  mutant: Mutant;
}

export interface Report {
  mode: string;
  baselineMs: number;
  limitMs: number;
  tests: number;
  excludedTests: number;
  flakyTests: string[];
  skippedVariants: number;
  results: Result[];
  elapsedMs: number;
  /** The run stopped early (the run lock went to another run): results are partial. */
  aborted?: string;
  /** Objects whose originals did not go back at the end (they stay in the journal). */
  unrestored?: string[];
  /** afterTests failed on these workers: the test seams may still be switched. */
  afterTestsFailed?: string[];
}

/** The project file plgauge.json. */
export function loadConfig(dir: string): Config {
  const c = JSON.parse(readFileSync(join(dir, 'plgauge.json'), 'utf8')) as Partial<Config>;
  return { install: c.install ?? [], mutate: c.mutate ?? [], tests: c.tests ?? [], beforeTests: c.beforeTests ?? [], afterTests: c.afterTests ?? [] };
}

export function mutateFiles(cfg: Config, dir: string): string[] {
  const files = new Set<string>();
  for (const g of cfg.mutate) for (const f of globSync(g, { cwd: dir })) files.add(join(dir, f));
  const out = [...files].sort();
  if (!out.length) throw new Error(`no files match ${cfg.mutate.join(', ')}`);
  return out;
}

/** Finds and numbers the mutants of a project, applying ops and sample. */
export function projectMutants(dir: string, opt: Pick<Options, 'ops' | 'sample' | 'seed' | 'diff'> = {}) {
  const cfg = loadConfig(dir);
  const files = findPoints(mutateFiles(cfg, dir));
  let ms = expand(files, opt.ops);
  const all = ms.length;
  if (opt.diff) {
    ms = ms.filter((m) => touches(opt.diff!, m.file, m.line, m.endLine));
    ms.forEach((m, i) => (m.id = i + 1));
  }
  if (opt.sample && opt.sample > 0 && opt.sample < ms.length) ms = sample(ms, opt.sample, opt.seed ?? 1);
  return { cfg, files, mutants: ms, all };
}

/** Picks n mutants at random, deterministic for a seed (mulberry32), in ID order. */
export function sample<T>(items: T[], n: number, seed: number): T[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const idx = items.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).sort((a, b) => a - b).map((i) => items[i]);
}

const isCompanion = (text: string) => text.includes('Statement ignored') || text.includes('Item ignored');
const lostConnection = (e?: Error) => !!e && /NJS-500|NJS-003|NJS-521|DPI-1010|DPI-1080|ORA-00028|ORA-03113|ORA-03135|ORA-07445/.test(e.message);
/** Errors of state left from replaced code (type or package specs created anew): gone in the next run. */
const STALE_STATE = /ORA-(21700|04061|04065|04068|06508)\b/;
/** A quoted identifier, exactly as written. */
const quoted = (x: string) => `"${x.replace(/"/g, '""')}"`;
/** detail of a TIMEOUT from the loop guard (not a time limit; never re-checked). */
const LOOP_GUARD = 'loop guard';

class Worker {
  deploy!: oracledb.Connection;
  monitor!: oracledb.Connection;
  test!: Session;
  db: ConnectConfig;
  loopLimits?: Map<number, number>;
  schema?: SchemaUnit[];
  lastUnit = '';
  /** Units currently changed in this database, by unit key. */
  changed = new Map<string, SourceObject>();
  private objects = new Map<string, SourceObject>();

  constructor(public url: string, public name: string, private run: Run) {
    this.db = parseDbUrl(url);
  }

  get logf() {
    return this.run.logf;
  }

  /** Holds the run lock of this schema (lockRun) for the whole run, across reconnects. */
  private lock?: oracledb.Connection;

  /**
   * The run lock: taken once, taken again when its connection died (a database reset or
   * restart ends the session and frees the row; another run may have it by then).
   */
  ensureLock(): Promise<void> {
    // one at a time: the ping and a reconnect must not both take it (the second would see the
    // first's row lock and take it for another run)
    this.locking ??= this.takeLock().finally(() => {
      this.locking = undefined;
    });
    return this.locking;
  }

  private locking?: Promise<void>;

  private async takeLock(): Promise<void> {
    const l = this.lock;
    if (l) {
      if (await l.execute('select 1 from dual').then(() => true, () => false)) return;
      await l.close().catch(() => {});
      if (this.lock === l) this.lock = undefined;
    }
    if (this.down) return;
    this.guard();
    const c = await oracledb.getConnection(this.db);
    // a silently dropped connection must not hang every caller until TCP gives up
    c.callTimeout = 15_000;
    try {
      await lockRun(c, RUN_LOCK);
    } catch (e) {
      await c.close().catch(() => {});
      // held before: someone else has it now (a session of ours the server has not cleaned up
      // cannot be told apart; stopping is the safe side)
      if (this.held && (e as Error).message.includes('Another plgauge run')) {
        this.foreign = true;
        this.run.abort ??= `Run lock${this.name} lost to another run (or the old session still holds it); changed code stays in the journal: plgauge restore once the lock is free`;
        this.logf(`ERROR${this.name}: ${this.run.abort}, aborting the run`);
      }
      throw e;
    }
    // shut down meanwhile: the run is over, the lock goes with the connection
    if (this.down) return c.close().catch(() => {});
    this.lock = c;
    this.held = true;
    // an idle session may be ended (IDLE_TIME, a firewall): a ping every minute keeps it, and a
    // lost lock is taken again or reported
    clearInterval(this.ping);
    this.ping = setInterval(() => {
      if (this.retired || this.foreign) return clearInterval(this.ping);
      // a network hiccup: try again next minute (takeLock marks a lock that went to another run)
      this.ensureLock().catch((e: Error) => {
        if (!this.foreign) this.logf(`WARNING${this.name}: run lock not renewed: ${firstLine(e)}`);
      });
    }, 60_000);
    this.ping.unref();
  }

  private ping?: NodeJS.Timeout;
  /**
   * The lock this worker held went to another run: that run restored this one's journal at
   * its start and works on the schema now. This worker changes nothing there any more, not
   * even to restore; the whole run stops (run.abort).
   */
  foreign = false;
  /** This worker held the lock once: failing to take it again later means someone else has it. */
  held = false;

  private guard(): void {
    if (this.foreign) throw new Error(`Run lock${this.name} lost to another run`);
  }
  /** Set by shutdown: no lock is taken any more. */
  private down = false;

  /** The lock and the connections; what a broken run (or connection) left changed comes back from the journal. */
  private async connect(): Promise<void> {
    await this.ensureLock();
    this.deploy = await oracledb.getConnection(this.db);
    this.monitor = await oracledb.getConnection(this.db);
    // its statements are short (select 1, cancel, kill): a dropped connection must not hang the watchdog
    this.monitor.callTimeout = 30_000;
    this.test = await newSession(this.db);
    // a run that died (of either tool: the lock keeps the other out now) left its units changed:
    // put the journaled originals back first, or this run would take the changed code for the
    // original, restore that at the end and forget the entry with the true one
    await ensureJournal(this.deploy);
    await this.restoreLeftovers('of an aborted run are being restored from the journal');
  }

  /** Closes the connections; a new database: objects, grants and the schema name are to be found again. */
  private async forget(): Promise<void> {
    await this.close();
    this.objects.clear();
    this.changed.clear();
    this.lastUnit = '';
    this.schemaName = undefined;
    this.granted.clear();
  }

  /** The schema build again on new connections (none before the first install). */
  private async reinstall(): Promise<void> {
    if (!this.schema) return;
    await this.installSchema(this.schema);
    if (this.loopLimits) await setLoopLimits(this.test, this.loopLimits);
    await this.warmUp();
  }

  async open(): Promise<void> {
    await this.connect();
    if (!this.run.opt.skipInstall) {
      const scripts: [string, string[]][] = [];
      for (const s of this.run.cfg.install) {
        const path = resolve(this.run.opt.dir, s);
        const stmts = splitScript(readFileSync(path, 'utf8'));
        await runScript(this.deploy, stmts, path);
        scripts.push([path, stmts]);
      }
      // checked after all scripts: a unit may use what a later one creates
      for (const [path, stmts] of scripts) {
        const invalid = await this.invalidUnits(stmts);
        if (invalid.length) throw new Error(`Installation${this.name}: ${path}: invalid: ${invalid.join(', ')}`);
      }
    }
    await ensureJournal(this.deploy);
    await installRuntime(this.deploy);
    // also after a reset (a fresh database); on a connection of their own, like the journal
    // restore: their session state must not reach the deploy connection. From here on afterTests
    // runs at the end, also without beforeTests
    this.seams = true;
    if (this.run.cfg.beforeTests.length) await this.hooks(this.run.cfg.beforeTests);
  }

  /** The worker reached its beforeTests (configured or not): afterTests runs at the end. */
  seams = false;

  private async hooks(scripts: string[], allOf = false): Promise<void> {
    const c = await oracledb.getConnection(this.db);
    try {
      await runTestHooks(c, scripts.map((s) => resolve(this.run.opt.dir, s)), allOf);
    } finally {
      await c.close().catch(() => {});
    }
  }

  /**
   * End of the run, after the originals are back: the afterTests scripts, only while the schema
   * is still this run's. Returns the failure, if any.
   */
  async afterTests(): Promise<string | undefined> {
    if (!this.seams || !this.run.cfg.afterTests.length) return;
    try {
      await this.ensureLock();
      this.guard();
      await this.hooks(this.run.cfg.afterTests, true);
    } catch (e) {
      return `Worker${this.name}: ${firstLine(e as Error)}`;
    }
  }

  /**
   * Journaled originals back, on a connection of their own: compiling them sets session
   * parameters (ccflags, length semantics, …) that install scripts on the deploy connection
   * must not inherit.
   */
  private async restoreLeftovers(what: string): Promise<void> {
    const c = await oracledb.getConnection(this.db);
    try {
      const entries = await journalEntries(c);
      if (!entries.length) return;
      this.logf(`Worker${this.name}: ${entries.length} objects ${what}`);
      await restoreJournal(c, entries, (m) => (m.includes('✗') ? this.logf(`WARNING${this.name}: ${m.trim()}`) : undefined));
      // an original that did not go back (a session of the dead run still holds the unit, say):
      // this run would take the changed code for the original and lose the true one at its end
      const still = await journalEntries(c);
      if (still.length) throw new Error(`${still.length} objects of an aborted run could not be restored (${still.map((e) => e.name).join(', ')}); run plgauge restore first`);
    } finally {
      await c.close().catch(() => {});
    }
  }

  /**
   * End of the run: whatever this worker's journal still holds (a retired worker, a restore that
   * failed) goes back. Returns what stays changed: empty when the originals are all back.
   */
  async finalRestore(): Promise<string[]> {
    try {
      // only while the schema is still this run's (a lost lock: another run restored and owns it)
      await this.ensureLock();
      if (!this.foreign) await this.restoreLeftovers('restored from the journal');
      return [];
    } catch (e) {
      // the lock went to another run: it restored this run's journal, the schema is its own now
      if (this.foreign) return [];
      // no journal table yet (the worker failed before ensureJournal): nothing was changed
      if ((e as Error).message.includes('ORA-00942')) return [];
      return [`Worker${this.name}: ${firstLine(e as Error)}`];
    }
  }

  /**
   * The units the install scripts created that are not VALID, after one recompile (a body
   * installed before what it uses is INVALID until then; SQL*Plus users rely on the implicit
   * recompile on first use).
   */
  private async invalidUnits(stmts: string[]): Promise<string[]> {
    // (a script may switch CURRENT_SCHEMA: unqualified names after that are there)
    let schema = await this.currentSchema();
    const units: { type: string; owner: string; name: string }[] = [];
    for (const raw of stmts) {
      const st = withoutLeadingComments(raw);
      const sw = /^alter\s+session\s+set\s+current_schema\s*=\s*("[^"]+"|[\w$#À-\uffff]+)/i.exec(st);
      if (sw) schema = sw[1].startsWith('"') ? sw[1].slice(1, -1) : sw[1].toUpperCase();
      // (a view has no status worth a recompile)
      const c = createStatement(st);
      if (c && c.type !== 'VIEW') units.push({ type: c.type, owner: objectOwner(c.name) ?? schema, name: objectName(c.name) });
    }
    const status = async (u: (typeof units)[number]) =>
      (await this.deploy.execute<[string]>(`select status from all_objects where owner = :o and object_name = :n and object_type = :t`, { o: u.owner, n: u.name, t: u.type })).rows?.[0]?.[0];
    const out: string[] = [];
    for (const u of units) {
      const before = await status(u);
      // VALID, or gone again (a helper the script drops after use)
      if (before === 'VALID' || before === undefined) continue;
      const [kind, body] = u.type.endsWith(' BODY') ? [u.type.replace(' BODY', ''), ' BODY'] : [u.type, ''];
      await this.deploy.execute(`alter ${kind} ${quoted(u.owner)}.${quoted(u.name)} compile${body} reuse settings`).catch(() => {});
      if ((await status(u)) !== 'VALID') out.push(`${u.type} ${u.name}`);
    }
    return out;
  }

  async close(): Promise<void> {
    for (const c of [this.test?.conn, this.deploy, this.monitor]) await c?.close().catch(() => {});
  }

  /** End of the run: the connections and the run lock. */
  async shutdown(): Promise<void> {
    this.down = true;
    clearInterval(this.ping);
    await this.locking?.catch(() => {});
    await this.close();
    await this.lock?.close().catch(() => {});
    this.lock = undefined;
  }

  /**
   * The database object of a unit, loaded once (it goes into the restore journal). A unit
   * written with a schema (other_schema.name) lives there (A4); the schema mode then gives
   * that schema the right to call plgauge_ctl.
   */
  async object(key: string, type: string, name: string): Promise<SourceObject> {
    let o = this.objects.get(key);
    if (!o) {
      const user = await this.currentSchema();
      const owner = objectOwner(name) ?? user;
      // the same object under another unit key: its original is the one read first (the object
      // may hold that key's changed code by now)
      const same = [...this.objects.values()].find((x) => x.owner === owner && x.name === objectName(name) && x.type === type);
      o = same ?? (await loadObject(this.deploy, owner, objectName(name), type));
      if (owner !== user && !this.granted.has(owner)) {
        // a grant that was there before (deliberate, or kept for unrestored code) is not this run's to take back
        const had = await this.deploy.execute(`select 1 from all_tab_privs where table_schema = :u and table_name = 'PLGAUGE_CTL' and grantee = :o and privilege = 'EXECUTE'`, { u: user, o: owner });
        if (!had.rows?.length) await this.deploy.execute(`grant execute on plgauge_ctl to ${dbIdent(owner)}`).then(() => this.added.add(owner), () => {});
        this.granted.add(owner);
      }
      this.objects.set(key, o);
    }
    return o;
  }

  schemaName?: string;
  private granted = new Set<string>();
  /** Schemas this run gave EXECUTE on plgauge_ctl (kept across reconnects): taken back at the end. */
  private added = new Set<string>();

  /**
   * End of the run, after the restore: EXECUTE on plgauge_ctl back from the schemas this run
   * granted it to, except those whose changed code stays in the journal (it would turn invalid).
   */
  async revokeGrants(): Promise<void> {
    if (!this.added.size || this.foreign) return;
    try {
      await this.ensureLock();
      this.guard();
      const c = await oracledb.getConnection(this.db);
      try {
        const left = new Set((await journalEntries(c)).map((e) => e.owner));
        const home = (await c.execute<[string]>(`select sys_context('USERENV','CURRENT_SCHEMA') from dual`)).rows![0][0];
        await revokeRuntime(c, home, [...this.added].filter((o) => !left.has(o)), this.logf, 'plgauge_ctl');
      } finally {
        await c.close().catch(() => {});
      }
    } catch (e) {
      this.logf(`WARNING${this.name}: execute on plgauge_ctl not revoked: ${firstLine(e as Error)}`);
    }
  }

  async currentSchema(): Promise<string> {
    this.schemaName ??= (await this.deploy.execute<[string]>(`select sys_context('USERENV','CURRENT_SCHEMA') from dual`)).rows![0][0];
    return this.schemaName;
  }

  /** Compiles a unit's new text; returns the compile errors (empty = valid). */
  async compileUnit(key: string, type: string, name: string, text: string) {
    // the lock checked before every change (its session may have ended since the last ping, and
    // another run may have taken it): changes only under the lock
    await this.ensureLock();
    this.guard();
    const obj = await this.object(key, type, name);
    this.changed.set(key, obj);
    const out = await replaceSourceDetailed(this.deploy, obj, text, 'mutation');
    if (!out.error) return [];
    if (out.offset !== undefined) {
      // a view statement rejected at once: the server's offset into the text
      const { line, col } = positionOf(text, out.offset);
      return [{ line, position: col, text: out.error }];
    }
    // not compiled at all (a lock: ORA-04021, a privilege): no error of this text; the caller's
    // verdict is ERROR, not COMPILE_ERROR. Never changed before: nothing to restore either
    if (!/^line \d+:/.test(out.error)) {
      if (out.untouched) this.changed.delete(key);
      throw new Error(out.error);
    }
    const errs = await objectErrors(this.deploy, obj);
    return errs.length ? errs : [{ line: 0, position: 0, text: out.error }];
  }

  async restore(key: string, recompile = true): Promise<void> {
    const obj = this.changed.get(key);
    if (!obj) return;
    // only under the lock (its session may have ended, another run may own the schema now)
    await this.ensureLock();
    this.guard();
    let failure = '';
    await restoreAll(this.deploy, [obj], (m) => {
      // a warning (a trigger left enabled) is no failure: the original is in place
      if (m.includes('✗') && /Restore of .+ failed: /.test(m)) failure = m.trim();
      else if (m.includes('✗')) this.logf(`WARNING${this.name}: ${m.trim()}`);
    }, recompile);
    // compile errors ("line n: …"): the original is in place, only invalid (as it may have been
    // before the run); any other failure left the changed code there: the key stays, the caller
    // must not take the unit for the original
    if (failure && !/failed: line \d+:/.test(failure)) throw new Error(failure);
    if (failure) this.logf(`WARNING${this.name}: ${failure}`);
    this.changed.delete(key);
  }

  async restoreAll(): Promise<void> {
    // the other run restored this one's journal itself
    if (this.foreign) return;
    for (const key of [...this.changed.keys()]) await this.restore(key).catch((e) => this.logf(`WARNING${this.name}: ${firstLine(e)}`));
    this.lastUnit = '';
    // the originals are back: a reconnect must not install the schema again
    this.schema = undefined;
  }

  retired = false;

  /** Whether the deploy connection still answers. */
  async alive(): Promise<boolean> {
    try {
      // the monitor too: without it no timeout can cancel a test
      await this.deploy.execute('select 1 from dual');
      await this.monitor.execute('select 1 from dual');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * New connections after a broken one: the originals come back from the restore journal
   * (the database may hold a mutated unit), then the schema build is installed again.
   */
  async reopen(): Promise<boolean> {
    await this.forget();
    try {
      await this.connect();
      await installRuntime(this.deploy);
      await this.reinstall();
      this.logf(`Worker${this.name} reconnected`);
      return true;
    } catch (e) {
      this.logf(`Rebuild${this.name} failed: ${firstLine(e as Error)}`);
      return false;
    }
  }

  async reconnectTest(): Promise<void> {
    await this.test.conn.close().catch(() => {});
    this.test = await newSession(this.db);
    if (this.loopLimits) await setLoopLimits(this.test, this.loopLimits);
  }

  /**
   * The tests to run: the single tests that passed the baseline (by name: repair and the second
   * look select from them), before it the configured paths.
   */
  testPaths(): string[] {
    return this.run.passing.length ? this.run.passing : this.run.cfg.tests;
  }

  /**
   * A schema with UNION ALL branches: the first execution parses all of them (cursors and views
   * with many: seconds). One run of all tests on the original takes that out of the time limit;
   * after every (re)install.
   */
  async warmUp(): Promise<void> {
    if (!this.schema?.some((u) => u.branched)) return;
    await activate(this.test, 0);
    await this.runTests(this.testPaths(), 10 * 60_000);
    await activate(this.test, 0);
  }

  /**
   * Whether a run may have left committed data: it said so, or it was cut off (timeout, kill,
   * error) before it could say, while the tests commit at all.
   */
  dirty(run: RunResult): boolean {
    return this.run.testsCommit && (run.committed || run.timedOut || run.killed || !!run.err);
  }

  /**
   * A commit the tests do not make by themselves: the mutant's side effect. With tests that
   * commit, a commit in a run of tests none of which committed in the baseline (tests: the
   * single tests of the run).
   */
  sideEffect(res: Result, run: RunResult, tests?: string[]): void {
    const single = new Set(this.run.passing);
    const own = !this.run.testsCommit || (!!tests && tests.every((t) => single.has(t)) && !tests.some((t) => this.run.committers.has(t)));
    if (run.committed && own && !res.sideEffect) {
      res.sideEffect = true;
      this.logf(`WARNING${this.name}: mutant ${res.id} caused a commit; this database's data may have changed`);
    }
  }

  /** Set when tests started (dispatch: a crash before them is no kill). */
  testsRan = false;

  /** A test call is running (a signal breaks it off). */
  inTests = false;

  async runTests(paths: string[], limitMs = this.run.limitMs): Promise<RunResult> {
    // after Ctrl-C no test run starts (a repair, a second look), and one broken off counts for
    // nothing: callers take the error as "no result" (a CI kill follows within seconds)
    const stopped = () => {
      if (this.run.interrupted) throw new Error('Abort requested');
    };
    stopped();
    this.testsRan = true;
    this.guard();
    this.inTests = true;
    let r: RunResult;
    try {
      r = await runTests(this.test, this.monitor, paths, limitMs);
    } finally {
      this.inTests = false;
    }
    // a test may have left CURRENT_SCHEMA switched (a mutant made it skip the switch back): the
    // run's packages are found in the run's schema only
    const home = await this.currentSchema();
    await this.test.conn.execute(`alter session set current_schema = ${quoted(home)}`).catch(() => {});
    stopped();
    if (r.killed || (!r.timedOut && lostConnection(r.err))) await this.reconnectTest();
    return r;
  }

  classify(res: Result, run: RunResult, tests?: string[]): void {
    // When the tests commit by themselves, a commit says nothing about the mutant.
    this.sideEffect(res, run, tests);
    if (run.timedOut) res.status = 'TIMEOUT';
    else if (isMemory(run.err)) Object.assign(res, { status: 'MEMORY', detail: firstLine(run.err!) });
    // a lost connection says nothing about the mutant (dispatch rebuilds the worker and tries again)
    else if (lostConnection(run.err)) Object.assign(res, { status: 'ERROR', detail: firstLine(run.err!) });
    else if (run.err && run.err.message.includes('ORA-')) Object.assign(res, { status: 'KILLED', killedBy: '(ut.run aborted)', detail: firstLine(run.err) });
    else if (run.err) Object.assign(res, { status: 'ERROR', detail: firstLine(run.err) });
    else if (failed(run)) Object.assign(res, { status: 'KILLED', killedBy: firstFailure(run) });
    else res.status = 'SURVIVED';
  }

  /** Oracle rewriter: compile the unit with one mutant, run all tests. */
  async naive(m: Mutant): Promise<Result> {
    const res = newResult(m);
    const t0 = performance.now();
    const compile = () => this.compileUnit(unitKey(m), m.unitRef.type, m.unitRef.name, withoutCreate(mutatedUnit(m)));
    try {
      const errs = await compile();
      if (errs.length) return Object.assign(res, { status: 'COMPILE_ERROR' as const, detail: errs.slice(0, 3).map((e) => `${e.line}:${e.position} ${e.text}`).join('; ') });
      let tests = this.testPaths();
      const sel = await this.run.selection(this, m);
      if (sel) {
        // configured paths may be suites: select from the single tests of the baseline
        tests = this.run.passing.filter((t) => sel.includes(t));
        res.coveredBy = tests;
        if (!tests.length) return Object.assign(res, { status: 'NOT_COVERED' as const, detail: 'not executed by any test according to coverage' });
      }
      await resetPackages(this.test);
      const run = await this.runTests(tests);
      this.classify(res, run, tests);
      // committed data of the mutant: the next run (the second look, the next mutant) would start from it
      let dirty = this.dirty(run);
      // a side effect changed the data: the second look would run on it (dispatch resets the database next)
      if (this.run.opt.confirm !== false && !res.sideEffect && wantsConfirm(res, tests)) {
        let ready = true;
        if (dirty) {
          // no clean data for the second look unless repaired
          const rp = await this.repair(tests, unitKey(m));
          ready = rp.repaired;
          dirty = !rp.repaired;
          // the second look must start from the data as without mutants: repaired, now the mutant again
          const again = rp.restored && ready ? await compile().catch((e: Error) => [{ line: 0, position: 0, text: firstLine(e) }]) : [];
          if (again.length) {
            this.logf(`Second look${this.name}, mutant ${m.id}: no longer compiles (${again[0].text}), verdict unchecked`);
            ready = false;
          }
        }
        if (ready) {
          const c = await this.confirmHere(res, tests);
          dirty = dirty || (!!c && this.dirty(c));
        }
      }
      if (dirty) await this.repair(tests, unitKey(m));
    } catch (e) {
      Object.assign(res, { status: 'ERROR', detail: firstLine(e as Error) });
    } finally {
      res.durationMs = performance.now() - t0;
    }
    return res;
  }

  /** Schema mode: activate one mutant, run its covering tests (fastest alone, then the rest). */
  async schemaMutant(res: Result, covering: string[] | undefined): Promise<void> {
    const t0 = performance.now();
    if (covering) res.coveredBy = covering;
    const ran: string[] = [];
    let committed = false;
    try {
      const tests = (covering ?? []).filter((t) => !this.run.flaky.has(t));
      if (!tests.length) {
        res.status = 'NOT_COVERED';
        return;
      }
      await activate(this.test, res.id);
      const batches = tests.length > 1 ? [tests.slice(0, 1), tests.slice(1)] : [tests];
      for (const b of batches) {
        const run = await this.runTests(b);
        ran.push(...b);
        committed ||= this.dirty(run);
        this.classify(res, run, b);
        if (run.killed) return;
        if (await aborted(this.test).catch(() => false)) {
          Object.assign(res, { status: 'TIMEOUT', killedBy: undefined, detail: LOOP_GUARD });
          return;
        }
        if (res.status !== 'SURVIVED') return;
      }
    } catch (e) {
      Object.assign(res, { status: 'ERROR', detail: firstLine(e as Error) });
    } finally {
      res.durationMs = performance.now() - t0;
      if (committed) await this.repair(ran);
    }
  }

  /**
   * Tests that commit (the baseline did) leave a mutant's data behind, and the next mutant's
   * tests would start from it: verdicts would depend on the order of the mutants. Those of
   * the tests that commit (Run.committers) run again on the original code (naiveKey: the
   * unit put back first), which writes their data as without mutants. restored: the unit is
   * the original now (oracle mode); repaired: the tests ran through (or none of them commits).
   */
  async repair(tests: string[], naiveKey?: string): Promise<{ restored: boolean; repaired: boolean }> {
    tests = tests.filter((t) => this.run.committers.has(t));
    const out = { restored: false, repaired: false };
    // none of them commits: nothing to write back
    if (!tests.length) return { restored: false, repaired: true };
    try {
      if (naiveKey) {
        await this.restore(naiveKey, false);
        out.restored = true;
        await resetPackages(this.test);
      } else await activate(this.test, 0);
      const run = await this.runTests(tests);
      this.run.repairs++;
      out.repaired = !run.timedOut && !run.killed && !run.err;
      if (!out.repaired) this.logf(`WARNING${this.name}: data after mutant not reliably restored: ${run.timedOut ? 'timeout' : firstLine(run.err ?? new Error('aborted'))}`);
    } catch (e) {
      this.logf(`WARNING${this.name}: data after mutant not restored: ${firstLine(e as Error)}`);
    }
    return out;
  }

  /**
   * Oracle mode: the second look right after the verdict, while the mutant is still compiled
   * (another worker would have to compile it again; see wantsConfirm). A kill by one of several
   * tests runs again with that test alone; a timeout runs again with twice the time. If the
   * first run committed, naive() repairs the data and compiles the mutant again first. Catches
   * dependence on the order of the tests and on data, not on the database. Returns the run.
   */
  async confirmHere(res: Result, tests: string[]): Promise<RunResult | undefined> {
    const kill = res.status === 'KILLED';
    try {
      await resetPackages(this.test);
      const ran = kill ? [res.killedBy!] : tests;
      const run = await this.runTests(ran, kill ? this.run.limitMs : 2 * this.run.limitMs);
      this.sideEffect(res, run, ran);
      // a lost connection says nothing about the mutant
      if (!lostConnection(run.err)) this.judgeAgain(res, run, ran);
      return run;
    } catch (e) {
      this.logf(`Second look${this.name}, mutant ${res.id}: ${firstLine(e as Error)}`);
      return undefined;
    }
  }

  /** Second look at a verdict on this worker; see confirmVerdicts. */
  async confirm(r: Result): Promise<void> {
    const timeout = r.status === 'TIMEOUT';
    const tests = !timeout ? [r.killedBy!] : (r.coveredBy ?? this.testPaths()).filter((t) => !this.run.flaky.has(t));
    if (!tests.length) return;
    try {
      await activate(this.test, r.id);
      const run = await this.runTests(tests, timeout ? 2 * this.run.limitMs : this.run.limitMs);
      const guard = await aborted(this.test).catch(() => false);
      if (this.dirty(run)) await this.repair(tests);
      // (confirmVerdicts sends no result with a side effect: one now is this run's)
      this.sideEffect(r, run, tests);
      if (r.sideEffect) await this.resetAfterSideEffect();
      if (!lostConnection(run.err)) this.judgeAgain(r, run, tests, this.name ? ` on${this.name}` : '', guard);
    } catch (e) {
      this.logf(`Second look${this.name}, mutant ${r.id}: ${firstLine(e as Error)}`);
    }
  }

  /** The second look's verdict on a kill or a timeout (confirm, confirmHere); where: the worker, if another one looked. */
  private judgeAgain(r: Result, run: RunResult, tests: string[], where = '', guard = false): void {
    if (r.status === 'KILLED') {
      if (!run.timedOut && !run.err && !failed(run)) r.unstable = `not repeatable: ${r.killedBy!.split('.').pop()} passes on its own${where}`;
      return;
    }
    if (run.timedOut || run.killed || guard) return;
    const again = newResult(r.mutant);
    again.sideEffect = r.sideEffect; // already noted
    this.classify(again, run, tests);
    r.unstable = `close to the time limit: second attempt${where} ${again.status} after ${Math.round(run.elapsedMs)} ms (limit ${Math.round(this.run.limitMs)} ms)`;
    Object.assign(r, { status: again.status, killedBy: again.killedBy, detail: again.detail });
  }

  compileSchemaUnit(su: SchemaUnit) {
    return this.compileUnit(su.key, su.type, su.owner ? `"${su.owner}"."${su.name}"` : su.name, su.text);
  }

  async installSchema(units: SchemaUnit[]): Promise<void> {
    await installControl(this.deploy);
    for (const su of units) {
      const errs = await this.compileSchemaUnit(su);
      if (errs.length) throw new Error(`${su.key} invalid${this.name}: ${errs.slice(0, 3).map((e) => e.text).join('; ')}`);
    }
  }

  /** After a side effect: replace the database (resetCmd) and set it up again. */
  async resetAfterSideEffect(): Promise<void> {
    const cmd0 = this.run.opt.resetCmd;
    // the database belongs to another run now: never reset it
    if (!cmd0 || this.foreign) return;
    // (the URL may leave the port out: Oracle's default, as parseDbUrl takes it)
    const cmd = cmd0.replaceAll('{port}', new URL(this.url).port || '1521');
    this.logf(`Resetting worker${this.name}: ${cmd}`);
    const t0 = Date.now();
    try {
      await promisify(execFile)('sh', ['-c', cmd]);
    } catch (e) {
      this.logf(`Reset${this.name} failed: ${firstLine(e as Error)}`);
      return;
    }
    await this.forget();
    try {
      await this.open();
      await this.reinstall();
      this.logf(`Worker${this.name} reset in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      // half set up, its verdicts would be wrong: it takes no more mutants
      this.retired = true;
      this.logf(`Rebuild${this.name} failed, worker retires: ${firstLine(e as Error)}`);
    }
  }
}

function newResult(m: Mutant): Result {
  return {
    id: m.id, op: m.op, file: m.file, unit: m.unit, line: m.line, col: m.col, endLine: m.endLine, endCol: m.endCol,
    sub: m.sub, ctx: m.ctx, category: m.category, original: m.original, mutated: m.mutated,
    status: 'ERROR', durationMs: 0, unitLine: unitLineOf(m), mutant: m,
  };
}

class Run {
  workers: Worker[] = [];
  total = 0;
  done = 0;
  logf: (m: string) => void;

  constructor(public opt: Options, public cfg: Config) {
    this.logf = opt.log ?? (() => {});
  }

  get primary() {
    return this.workers[0];
  }

  private covIndex?: CoverageIndex;
  /** Passing tests the coverage file does not know (with --coverage). */
  private unmeasured: string[] = [];
  private covUsable = new Map<string, boolean>();
  /** Schema mode: covering tests per mutant from the recording run. */
  covering = new Map<number, string[]>();
  /** Unswitched mutants whose reach the recording run noted (view blocks): covering is complete for them. */
  recorded = new Set<number>();
  /** The worker that decided each mutant (dispatch). */
  ranOn = new Map<number, Worker>();
  /** Test runs that wrote the data back after a mutant (Worker.repair). */
  repairs = 0;
  /**
   * Schema mode, the state of the build (see buildSchema): its mutants, those that did not
   * compile (with the error), points not switched, view blocks whose wrapper did not compile.
   */
  ms: Mutant[] = [];
  dropped = new Map<number, string>();
  naive = new Set<Point>();
  broken = new Set<string>();
  /** Views that go into the schema exactly as written (see buildSchema). */
  plain = new Set<string>();
  /** Units the schema could not put in place at all (not even with errors): left out of it. */
  unplaced = new Set<string>();
  /** Units whose schema text compileSchema put in place on the primary (valid or not). */
  placed = new Set<string>();
  /** Ctrl-C: the dispatch loops stop, the phases before them end at the next checkpoint. */
  interrupted = false;
  checkpoint(): void {
    if (this.interrupted) throw new Error('Abort requested (Ctrl-C), originals restored');
    if (this.abort) throw new Error(this.abort);
  }
  /** Tests that commit on their own (found by the baseline when the tests commit at all). */
  committers = new Set<string>();
  /** Set when the run must stop (the run lock was lost); runMutation fails with it. */
  abort?: string;

  /**
   * Oracle mode with coverage: the test paths that executed the statement around the
   * mutant, or null (run all) if the unit has no matching coverage. The unit in the
   * database must be the one that was measured (same ALL_SOURCE hash).
   */
  async selection(w: Worker, m: Mutant): Promise<string[] | null> {
    if (this.recorded.has(m.id)) return this.covering.get(m.id) ?? [];
    if (!this.opt.coverage) return null;
    if (!this.covIndex) {
      this.covIndex = new CoverageIndex(this.opt.coverage);
      // a test the coverage run did not measure (another schema's tests, added since) may reach
      // any mutant: it runs against all of them
      this.unmeasured = this.passing.filter((t) => !this.covIndex!.measured.has(t));
      if (this.unmeasured.length) this.logf(`WARNING: ${this.unmeasured.length} of ${this.passing.length} tests are not in the coverage file and run against every mutant (e.g. ${this.unmeasured[0]})`);
    }
    const obj = this.covIndex.object(m.unit);
    if (!obj) return null;
    const key = unitKey(m);
    let ok = this.covUsable.get(key);
    if (ok === undefined) {
      const o = await w.object(key, m.unitRef.type, m.unitRef.name);
      ok = !obj.rawSha256 || obj.rawSha256 === sha256(o.original);
      if (!ok) this.logf(`WARNING: coverage of ${m.unit} does not match the code in the database, running all tests`);
      this.covUsable.set(key, ok);
    }
    if (!ok) return null;
    const line = m.line - unitLineOf(m) + 1;
    const sel = this.covIndex.testsAt(obj, line, line > 1 ? m.col : undefined);
    // a flaky test may reach the mutant in this run although it did not when measured
    return sel && [...new Set([...sel, ...this.covIndex.flaky, ...this.unmeasured])];
  }

  progress(w: Worker, r: Result) {
    const one = (s: string) => {
      const t = s.split(/\s+/).join(' ');
      return [...t].length > 60 ? [...t].slice(0, 57).join('') + '…' : t;
    };
    this.total = Math.max(this.total, ++this.done);
    this.logf(`[${this.done}/${this.total}]${w.name} ${r.status.padEnd(13)} ${r.file.split('/').pop()}:${r.line} ${r.op} ${one(r.original)} → ${one(r.mutated)}`);
  }

  /**
   * Runs fn for every mutant, spread over all workers; results in input order. A worker
   * whose database connection breaks (a crashed server process, say) is rebuilt and tries
   * the mutant again; if that fails it retires and the others take its mutants.
   */
  async dispatch(ms: Mutant[], fn: (w: Worker, m: Mutant) => Promise<Result>, stop: () => boolean): Promise<Result[]> {
    const results: (Result | undefined)[] = new Array(ms.length);
    let next = 0;
    const again: number[] = [];
    const broken = (r: Result) => r.status === 'ERROR' && lostConnection(new Error(r.detail ?? ''));
    const work = async (w: Worker) => {
      while (!stop() && !w.retired) {
        const i = again.length ? again.shift()! : next++;
        if (i >= ms.length) return;
        w.testsRan = false;
        let r = await fn(w, ms[i]);
        if (broken(r) || !(await w.alive())) {
          this.logf(`Worker${w.name}: connection lost (${r.detail ?? 'management connection'}), rebuilding …`);
          let up = await w.reopen();
          if (up) {
            w.testsRan = false;
            r = await fn(w, ms[i]);
            // (read now: the reopen below warms up, and that runs tests)
            const ranTests = w.testsRan;
            // on a fresh connection it broke the server process again: the mutant does it
            if (broken(r)) {
              up = await w.reopen();
              // under the tests: they would fail; before them (compiling the mutant): no test saw it
              if (up && ranTests) Object.assign(r, { status: 'KILLED', killedBy: '(server process crashed)' });
              else if (up) r.detail = `server process crashed while compiling: ${r.detail ?? ''}`;
            }
          }
          if (!up) {
            w.retired = true;
            again.push(i);
            this.logf(`Worker${w.name} retires, the others take over its mutants`);
            return;
          }
        }
        // a run broken off by Ctrl-C says nothing about the mutant: left out (the report is partial)
        if (this.interrupted) return;
        if (r.sideEffect) await w.resetAfterSideEffect();
        results[i] = r;
        this.ranOn.set(r.id, w);
        this.progress(w, r);
      }
    };
    // a worker that retires after the others ran out of work leaves its mutant in again: once more
    while (!stop() && (again.length || next < ms.length) && this.workers.some((w) => !w.retired)) {
      await Promise.all(this.workers.filter((w) => !w.retired).map(work));
    }
    // all workers retired with work left: nothing more can run, but what ran stays in the report
    if (!stop() && this.workers.every((w) => w.retired)) {
      const left = ms.filter((_, i) => !results[i]).length;
      if (left) {
        this.logf(`all worker databases failed: ${left} mutants without a verdict`);
        // a partial report: marked, and the CLI ends with an error code
        this.abort ??= 'all worker databases failed';
      }
      ms.forEach((m, i) => {
        results[i] ??= Object.assign(newResult(m), { detail: 'all worker databases failed' });
      });
    }
    return results.filter((r): r is Result => !!r);
  }

  async restoreEverywhere() {
    await Promise.all(this.workers.map((w) => w.restoreAll()));
  }

  /** Schema mode: the schema units as the state of the build stands. */
  async build(): Promise<SchemaUnit[]> {
    return buildSchema(this.ms, new Set(this.dropped.keys()), this.naive, await this.primary.currentSchema(), this.broken, this.plain);
  }

  /** Schema mode: all points of a unit run one by one; plain: a view goes in exactly as written. */
  oneByOne(key: string, plain = false): void {
    for (const m of this.ms) if (unitKey(m) === key) this.naive.add(m.point);
    if (plain) this.plain.add(key);
  }

  /** The baseline, the same for all workers: time limit, the single tests that pass, how many were excluded, tests found unreliable. */
  limitMs = 0;
  passing: string[] = [];
  excluded = 0;
  flaky = new Set<string>();

  /** Tests found unreliable leave the run. */
  exclude(bad: Set<string>): void {
    const keep = this.passing.filter((t) => !bad.has(t));
    this.excluded += this.passing.length - keep.length;
    this.passing = keep;
    for (const f of bad) this.flaky.add(f);
  }

  /** The baseline committed: commits under mutants are no side effect of theirs. */
  testsCommit = false;

  /** Baseline twice; tests failing in either run are excluded (most do DDL or depend on state). */
  async baseline(): Promise<{ ms: number; tests: TestResult[] }> {
    const w = this.primary;
    let slowest = 0;
    const failedNames = new Map<string, string>();
    let last: TestResult[] = [];
    for (let i = 0; i < 2; i++) {
      this.checkpoint();
      await resetPackages(w.test);
      const r = await w.runTests(this.cfg.tests, 10 * 60_000);
      if (r.err) throw new Error(`Baseline: ${firstLine(r.err)}`);
      if (r.committed && !this.testsCommit) {
        this.testsCommit = true;
        this.logf('Note: the tests commit even without mutants; commits under mutants do not count as side effects, no reset');
      }
      for (const t of r.tests) {
        // the first run after an install may meet state of the replaced code (ORA-21700 when type
        // or package specs were created anew, ORA-04068 …): such a test counts if the second passes
        if (t.failed && !(i === 0 && STALE_STATE.test(t.message))) failedNames.set(t.name, t.message);
      }
      slowest = Math.max(slowest, r.elapsedMs);
      last = r.tests;
    }
    const ok = last.filter((t) => !failedNames.has(t.name) && !t.ignored);
    // grouped: a whole suite usually fails for one reason (beforeall, a test package that does not compile)
    const red = [...failedNames].map(([n, msg]) => ({
      suite: n.split('.').slice(0, -1).join('.'), name: n.split('.').pop()!, status: /^error occured/i.test(msg) ? 'error' as const : 'failed' as const, message: failureMessage(msg),
    }));
    for (const w of failureSummary(red, 'without mutants (excluded)')) this.logf(w);
    if (!ok.length) throw new Error('Baseline: no test passes without mutants');
    this.excluded = failedNames.size;
    this.passing = ok.map((t) => t.name);
    if (this.testsCommit && !this.committers.size) {
      // which of them commit: each alone, once
      for (const t of ok) {
        this.checkpoint();
        await resetPackages(w.test);
        if ((await w.runTests([t.name], 10 * 60_000)).committed) this.committers.add(t.name);
      }
      this.logf(`${this.committers.size} tests commit: ${[...this.committers].map((t) => t.split('.').pop()).join(', ')}`);
    }
    this.limitMs = slowest * (this.opt.timeoutFactor ?? 5) + 2000;
    return { ms: slowest, tests: ok };
  }

  /**
   * Re-runs every killing test twice alone against the original behaviour. A test
   * failing there depends on state or order: it is excluded and its mutants run again.
   */
  async recheckKillers(rep: Report, rerun: (ms: Mutant[]) => Promise<Result[]>, stop: () => boolean, only?: Set<number>): Promise<void> {
    if (stop()) return;
    // the baseline's worker unless it retired (its connections are closed then)
    const w = this.workers.find((x) => !x.retired);
    if (!w) return;
    const killers = [...new Set(rep.results.filter((r) => (!only || only.has(r.id)) && killedByTest(r)).map((r) => r.killedBy!))].sort();
    const flaky = new Set<string>();
    try {
      for (const name of killers) {
        if (stop()) break;
        for (let i = 0; i < 2 && !flaky.has(name); i++) {
          await resetPackages(w.test);
          const run = await w.runTests([name]);
          // a test that fails without a mutant is unreliable; a timeout or a lost connection says nothing
          if (!run.err && !run.timedOut && failed(run)) {
            flaky.add(name);
            this.logf(`flaky, fails without a mutant too: ${name}: ${failureMessage(firstFailure(run, 'message')) ?? ''}`);
          } else if (run.err || run.timedOut) {
            this.logf(`recheck of ${name} without a result: ${run.timedOut ? 'timeout' : firstLine(run.err!)}`);
          }
        }
      }
    } catch (e) {
      // the worker's session is gone: the verdicts stand as they are
      this.logf(`recheck of the killing tests aborted: ${firstLine(e as Error)}`);
    }
    if (!flaky.size) return;
    rep.flakyTests = [...rep.flakyTests, ...flaky].sort();
    this.exclude(flaky);
    // every kill of a test found unreliable, also one checked earlier (another recheck call)
    const again = rep.results.filter((r) => r.status === 'KILLED' && flaky.has(r.killedBy ?? ''));
    this.logf(`${again.length} mutants run again without the flaky tests`);
    const byId = new Map(rep.results.map((r, i) => [r.id, i]));
    for (const r of await rerun(again.map((x) => x.mutant))) rep.results[byId.get(r.id)!] = r;
  }
}

/**
 * CREATE OR REPLACE VIEW drops the view's INSTEAD OF triggers, and putting the original text
 * back does not bring them back: a view with triggers is not mutated at all.
 */
async function withoutTriggeredViews(run: Run, ms: Mutant[]): Promise<Mutant[]> {
  if (!ms.some((m) => m.unitRef.type === 'VIEW')) return ms;
  // on every worker database (they may differ beyond the install, and so may their users):
  // DBA_TRIGGERS sees all, ALL_TRIGGERS another schema's triggers only with CREATE ANY TRIGGER
  const checks: { me: string; triggered: Set<string>; complete: boolean }[] = [];
  for (const w of run.workers) {
    const dba = await w.deploy.execute<[string, string]>(`select table_owner, table_name from dba_triggers where base_object_type = 'VIEW'`).catch(() => undefined);
    const r = dba ?? await w.deploy.execute<[string, string]>(`select table_owner, table_name from all_triggers where base_object_type = 'VIEW'`);
    const complete = !!dba || ((await w.deploy.execute<[number]>(`select count(*) from session_privs where privilege = 'CREATE ANY TRIGGER'`)).rows?.[0]?.[0] ?? 0) > 0;
    checks.push({ me: await w.currentSchema(), triggered: new Set((r.rows ?? []).map(([o, n]) => `${o}.${n}`)), complete });
  }
  // per worker: the view as that worker's user names it unqualified
  const key = (m: Mutant, c: (typeof checks)[number]) => `${objectOwner(m.unitRef.name) ?? c.me}.${objectName(m.unitRef.name)}`;
  const hasTrigger = (m: Mutant) => checks.some((c) => c.triggered.has(key(m, c)));
  const unchecked = (m: Mutant) => checks.some((c) => !c.complete && (objectOwner(m.unitRef.name) ?? c.me) !== c.me);
  const out: Mutant[] = [];
  const left = new Map<string, Mutant>(); // unit key → its first mutant (all of the unit's are left out)
  for (const m of ms) {
    if (m.unitRef.type !== 'VIEW' || (!hasTrigger(m) && !unchecked(m))) out.push(m);
    else if (!left.has(unitKey(m))) left.set(unitKey(m), m);
  }
  for (const [k, m] of left) run.logf(hasTrigger(m)
    ? `${k}: view with an INSTEAD OF trigger, not mutated (CREATE OR REPLACE VIEW would drop the trigger)`
    : `${k}: view of another schema whose INSTEAD OF triggers cannot be checked without CREATE ANY TRIGGER: not mutated`);
  return out;
}

/** A kill by a test (not by a broken-off run or a crash, whose killedBy is in parentheses). */
const killedByTest = (r: Result) => r.status === 'KILLED' && !!r.killedBy && !r.killedBy.startsWith('(');

/** Oracle mode: whether a verdict gets a second look (a kill by one of several tests, a timeout). */
function wantsConfirm(res: Result, tests: string[]): boolean {
  return (killedByTest(res) && tests.length > 1) || res.status === 'TIMEOUT';
}

/** What second looks found among results. */
function unstableSummary(rs: Result[]): string {
  const kills = rs.filter((r) => r.unstable?.startsWith('not repeatable')).length;
  const slow = rs.filter((r) => r.unstable?.startsWith('close to the time limit')).length;
  return `${kills} kills not repeatable, ${slow} timeouts close to the time limit`;
}

/**
 * Schema mode: second look at verdicts that may hang on circumstances. Every kill by a test runs again
 * with that test alone on another worker (the next one; the same one without others), on
 * repaired data. A kill that does not repeat depends on the order of the tests, on data
 * another test or mutant left, or on the database: it stays KILLED, marked unstable. A
 * timeout (not the loop guard's) runs again with twice the time; one that finishes takes
 * the new verdict, marked unstable.
 */
async function confirmVerdicts(run: Run, results: Result[], stop: () => boolean): Promise<void> {
  if (run.opt.confirm === false) return;
  // a mutant with a side effect changes the data of the worker that checks it: no second look
  const todo = results.filter((r) => !r.sideEffect).filter((r) => killedByTest(r) || (r.status === 'TIMEOUT' && r.detail !== LOOP_GUARD));
  if (!todo.length) return;
  const live = run.workers.filter((w) => !w.retired);
  if (!live.length) return;
  const byWorker = new Map<Worker, Result[]>();
  for (const r of todo) {
    const i = live.indexOf(run.ranOn.get(r.id) ?? live[0]);
    const to = live[(i + 1) % live.length];
    byWorker.set(to, [...(byWorker.get(to) ?? []), r]);
  }
  const t0 = performance.now();
  // each worker takes the verdicts of one other: no two share a database
  await Promise.all([...byWorker].map(async ([w, rs]) => {
    for (const r of rs) if (!stop() && !w.retired) await w.confirm(r);
    await activate(w.test, 0).catch((e) => run.logf(`Second look${w.name}: ${firstLine(e as Error)}`));
  }));
  run.logf(`Second look: ${todo.length} verdicts in ${Math.round(performance.now() - t0)}ms, ${unstableSummary(todo)}`);
}

/** Type and [schema.]name of the unit a script statement creates (leading comments skipped). */
function createStatement(stmt: string): { type: string; name: string } | undefined {
  // (names as the lexer reads them: letters beyond ASCII too, quoted ones with their spaces)
  const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NO\s+)?FORCE\s+|(?:NON)?EDITIONABLE\s+|EDITIONING\s+)*(PACKAGE\s+BODY|PACKAGE|TYPE\s+BODY|PROCEDURE|FUNCTION|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[\w$#À-\uffff]+)(?:\s*\.\s*(?:"[^"]+"|[\w$#À-\uffff]+))?)/i.exec(withoutLeadingComments(stmt));
  return m ? { type: m[1].replace(/\s+/g, ' ').toUpperCase(), name: m[2].replace(/\s*\.\s*(?=(?:"[^"]+"|[\w$#À-\uffff]+)$)/, '.') } : undefined;
}

/** "TYPE|NAME" of the unit a script statement creates (leading comments skipped), or ''. */
export function createdUnit(stmt: string): string {
  // (a package spec is no unit of mutants)
  const c = createStatement(stmt);
  return c && c.type !== 'PACKAGE' ? `${c.type}|${objectName(c.name)}` : '';
}

/** Waits for all, then throws the first failure. */
async function settled(ps: Promise<unknown>[]): Promise<void> {
  const bad = (await Promise.allSettled(ps)).find((o): o is PromiseRejectedResult => o.status === 'rejected');
  if (bad) throw bad.reason;
}

export async function runMutation(opt: Options): Promise<Report> {
  const t0 = performance.now();
  const { cfg, files, mutants } = projectMutants(opt.dir, opt);
  let ms = mutants;
  const run = new Run(opt, cfg);
  const mode = opt.mode ?? 'schema';
  let skipped = 0;
  for (const f of files) {
    skipped += f.skipped;
    if (f.errors.length) run.logf(`skipped, not parsable: ${f.path}: ${f.errors.join('; ')}`);
  }
  // a unit of an installed file whose CREATE the install never runs (no "/" at the end, after EXIT,
  // held back by "."): the database keeps another version, mutants of the file text are wrong
  if (!opt.skipInstall) {
    const installed = new Set(cfg.install.map((s) => resolve(opt.dir, s)));
    const missing = new Set<unknown>();
    for (const f of files) {
      if (!installed.has(resolve(f.path))) continue;
      const created = new Set(splitScript(f.src.toString('utf8')).map(createdUnit).filter(Boolean));
      for (const u of f.units) {
        if (created.has(`${u.type.replace(/\s+/g, ' ').toUpperCase()}|${objectName(u.name)}`)) continue;
        missing.add(u);
        run.logf(`skipped, not created by the install script (no "/" after it?): ${f.path}#${u.type} ${u.name}`);
      }
    }
    ms = ms.filter((m) => !missing.has(m.unitRef));
  }
  run.logf(`${ms.length} mutants in ${files.length} files${opt.diff ? ' (changed lines only)' : ''}, ${skipped} equivalent or pointless variants left out`);
  if (!ms.length) {
    run.logf('no mutants: nothing to do');
    return { ...emptyReport(0), mode, skippedVariants: skipped, elapsedMs: performance.now() - t0 };
  }
  if (!opt.dbUrls.length) throw new Error('no database: set --db or PLGAUGE_DB');
  opt.dbUrls.forEach((u, i) => run.workers.push(new Worker(u, opt.dbUrls.length > 1 ? ` w${i + 1}` : '', run)));
  let report: Report | undefined;
  const onSig = () => {
    if (run.interrupted) return run.logf('The originals are being restored, please wait (otherwise: plgauge restore)');
    run.interrupted = true;
    run.logf('Abort requested, restoring the originals …');
    // test calls in flight end now (a CI cancel kills the process a few seconds later)
    for (const w of run.workers) if (w.inTests) w.test.conn.break().catch(() => {});
  };
  // kept until the originals are back: a second Ctrl-C must not kill the restore
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    // (a worker still opening would otherwise keep its lock and connections)
    await settled(run.workers.map((w) => w.open()));
    if (run.workers.length > 1) run.logf(`${run.workers.length} worker databases`);
    // the switched code names the run's schema (its context, its plgauge_ctl): one for all workers
    const homes = new Set(await Promise.all(run.workers.map((w) => w.currentSchema())));
    if (homes.size > 1) throw new Error(`Worker databases with different schemas (${[...homes].join(', ')}) are not supported: all workers need the same user or CURRENT_SCHEMA`);
    run.checkpoint();
    // one database object defined in two files (a unit file and an install-all script, say, or
    // once with its schema and once without): both would compile into the same object, the
    // second over the first; the first file's counts
    const home = await run.primary.currentSchema();
    const objectOf = new Map<string, string>();
    const twice = new Set<string>();
    for (const m of ms) {
      const id = `${objectOwner(m.unitRef.name) ?? home}|${objectName(m.unitRef.name)}|${m.unitRef.type}`;
      const first = objectOf.get(id);
      if (first === undefined) objectOf.set(id, unitKey(m));
      else if (first !== unitKey(m)) twice.add(unitKey(m));
    }
    for (const k of twice) run.logf(`skipped, object already defined in another file: ${k}`);
    ms = await withoutTriggeredViews(run, ms.filter((m) => !twice.has(unitKey(m))));
    run.total = ms.length;
    const stop = () => run.interrupted || !!run.abort;
    const rep = mode === 'naive' ? await runNaive(run, ms, stop) : await runSchema(run, ms, stop);
    if (run.abort) rep.aborted = run.abort;
    else if (run.interrupted) rep.aborted = 'Abort requested (Ctrl-C)';
    if (run.repairs) run.logf(`${run.repairs} test runs restored data after a mutant`);
    Object.assign(rep, { mode, skippedVariants: skipped, limitMs: run.limitMs, tests: run.passing.length, excludedTests: run.excluded });
    rep.elapsedMs = performance.now() - t0;
    rep.results.sort((a, b) => a.id - b.id);
    report = rep;
    return rep;
  } finally {
    // (a worker whose lock went to another run restores nothing: Worker.restoreAll)
    await run.restoreEverywhere().catch(() => {});
    // what a retired worker, a dead deploy connection or a failed restore above left changed is in
    // the worker's journal (read on a fresh connection); what stays is reported always (also with -q)
    // (a worker that never held the lock changed nothing: another run has the schema)
    const left = (await Promise.all(run.workers.filter((w) => w.held && !w.foreign).map((w) => w.finalRestore()))).flat();
    // (the lock lost while restoring: the report must not look complete)
    if (report && run.abort && !report.aborted) report.aborted = run.abort;
    if (left.length) {
      const msg = `ERROR: originals not restored (${left.join('; ')}); the changed code is in the journal: plgauge restore`;
      (opt.log ?? console.error)(msg);
      if (report) report.unrestored = left;
    }
    await Promise.all(run.workers.filter((w) => w.held).map((w) => w.revokeGrants()));
    const hooks = (await Promise.all(run.workers.map((w) => w.afterTests()))).filter((f): f is string => !!f);
    if (hooks.length) {
      (opt.log ?? console.error)(`ERROR: afterTests: ${hooks.join('; ')} (the test seams may still be switched)`);
      if (report) report.afterTestsFailed = hooks;
    }
    await Promise.all(run.workers.map((w) => w.shutdown()));
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

function emptyReport(baselineMs: number): Report {
  return { mode: '', baselineMs, limitMs: 0, tests: 0, excludedTests: 0, flakyTests: [], skippedVariants: 0, results: [], elapsedMs: 0 };
}

async function naiveList(run: Run, ms: Mutant[], stop: () => boolean): Promise<Result[]> {
  const out = await run.dispatch(ms, async (w, m) => {
    if (w.lastUnit && w.lastUnit !== unitKey(m)) {
      try {
        await w.restore(w.lastUnit);
      } catch (e) {
        // a lost connection: dispatch rebuilds the worker and tries the mutant again
        return Object.assign(newResult(m), { status: 'ERROR' as const, detail: firstLine(e as Error) });
      }
    }
    w.lastUnit = unitKey(m);
    return w.naive(m);
  }, stop);
  await run.restoreEverywhere();
  return out;
}

/** Mutants compiled one by one into rep, their killing tests rechecked; then what the second looks (Worker.confirmHere) found. */
async function naivePhase(run: Run, rep: Report, ms: Mutant[], stop: () => boolean): Promise<void> {
  const one = await naiveList(run, ms, stop);
  rep.results.push(...one);
  const ids = new Set(one.map((r) => r.id));
  await run.recheckKillers(rep, (again) => naiveList(run, again, stop), stop, ids);
  if (run.opt.confirm !== false) run.logf(`Second look (compiled one by one): ${unstableSummary(rep.results.filter((r) => ids.has(r.id)))}`);
}

async function runNaive(run: Run, ms: Mutant[], stop: () => boolean): Promise<Report> {
  const base = await run.baseline();
  run.checkpoint();
  const rep = emptyReport(base.ms);
  run.logf(`Baseline: ${base.tests.length} tests in ${Math.round(base.ms)}ms, time limit ${Math.round(run.limitMs)}ms`);
  await naivePhase(run, rep, ms, stop);
  return rep;
}

async function runSchema(run: Run, ms: Mutant[], stop: () => boolean): Promise<Report> {
  const w = run.primary;
  if (ms.some((m) => m.point.naiveOnly === 'cache') || [...new Set(ms.map((m) => m.sourceFile))].some((f) => /\bRESULT_CACHE\b/i.test(f.src.toString('utf8')))) {
    run.logf('Note: RESULT_CACHE functions run one by one; their cached results can hide mutants in code they call (use --mode naive for those)');
  }
  run.ms = ms;
  const { naive, dropped } = run;
  for (const m of ms) if (!switchable(m.point) || orderedMain(m.unitRef, m.point.scope)) naive.add(m.point);
  const t0 = performance.now();
  await installControl(w.deploy);
  const plans = await capBranches(run);
  let rounds = await compileSchema(run);
  run.checkpoint();
  rounds += await isolateViews(run);
  rounds += await checkPlans(run, plans);
  run.checkpoint();
  // (a unit left out stays original on every worker)
  const built = await run.build();
  const units = built.filter((u) => !run.unplaced.has(u.key));
  // loop guard ids run over all units, the ones left out too
  const loopCount = built.reduce((n, u) => n + u.loops, 0);
  w.schema = units;
  // (restoring while another worker still compiles would miss units)
  await settled(run.workers.slice(1).map(async (h) => {
    h.schema = units;
    await h.installSchema(units);
  }));
  run.logf(`Schema compiled in ${Math.round(performance.now() - t0)}ms (${rounds} rounds), ${dropped.size} mutants dropped, ${naive.size} points without the schema`);

  // the first execution parses the branches (cursors and views with many: seconds); the time limit must not include it
  run.checkpoint();
  await settled(run.workers.map((h) => h.warmUp()));
  run.checkpoint();
  await activate(w.test, 0);
  const base = await run.baseline();
  run.checkpoint();
  const rep = emptyReport(base.ms);
  run.logf(`Baseline with the schema: ${base.tests.length} tests in ${Math.round(base.ms)}ms, time limit ${Math.round(run.limitMs)}ms`);

  // (with the recorded view points, which run one by one on the recording's reach)
  const covering = await record(run, base.tests, units.flatMap((u) => [...u.mutants.map((m) => m.id), ...u.recorded]), loopCount);
  run.checkpoint();
  run.covering = covering;
  run.recorded = new Set(units.flatMap((u) => u.recorded));
  for (const h of run.workers.slice(1)) {
    h.loopLimits = w.loopLimits;
    await setLoopLimits(h.test, w.loopLimits!);
  }

  // what the schema really holds (or what it dropped); anything else runs one by one, whatever
  // the bookkeeping says (a point that no rule took out but no branch took in would come out NOT_COVERED)
  const inSchema = new Set(units.flatMap((u) => u.mutants.map((m) => m.id)));
  const switched = ms.filter((m) => inSchema.has(m.id) || dropped.has(m.id));
  const fallback = ms.filter((m) => !inSchema.has(m.id) && !dropped.has(m.id));
  const schemaOne = async (wk: Worker, m: Mutant) => {
    const res = newResult(m);
    const msg = dropped.get(m.id);
    if (msg !== undefined) Object.assign(res, { status: 'COMPILE_ERROR', detail: msg });
    else await wk.schemaMutant(res, covering.get(m.id));
    return res;
  };
  const schemaList = async (list: Mutant[]) => {
    const out = await run.dispatch(list, schemaOne, stop);
    for (const wk of run.workers) if (!wk.retired) await activate(wk.test, 0).catch((e) => run.logf(`Worker${wk.name}: ${firstLine(e as Error)}`));
    return out;
  };
  rep.results = await schemaList(switched);
  await run.recheckKillers(rep, schemaList, stop);
  await confirmVerdicts(run, rep.results, stop);
  if (fallback.length && !stop()) {
    await run.restoreEverywhere();
    run.logf(`${fallback.length} mutants without the schema, compiled one by one`);
    await naivePhase(run, rep, fallback, stop);
  }
  return rep;
}

/**
 * Branch variants per view: each branch is a copy of its block, which the optimizer plans
 * again; WITH clauses inside the dictionary views a copy uses are materialized in front of
 * all branches, at every execution. At most VIEW_BRANCHES per view, fewer when planning the
 * original takes long (VIEW_PLAN_BUDGET_MS / EXPLAIN PLAN time).
 */
const VIEW_BRANCHES = 20;
const VIEW_PLAN_BUDGET_MS = 10_000;
/** Branch variants per cursor declaration: its query is planned once per copy, at the first OPEN. */
const CURSOR_BRANCHES = 20;
/** Duplicated statements and dynamic SQL literals: bytes of all copies of one (a cursor FOR loop copies its body too). */
const DUP_BYTES = 256 * 1024;

/**
 * How many variants go into the schema as copies, in ID order: per view (see VIEW_BRANCHES),
 * per cursor declaration, per duplicated statement. The other points run with the oracle
 * rewriter; inside a view their tests are still selected by the recording of their block.
 * Returns the plans of the original views (livePlan), for checkPlans.
 */
async function capBranches(run: Run): Promise<Map<string, ViewPlans>> {
  const { primary: w, ms, naive } = run;
  const plans = new Map<string, ViewPlans>();
  const cap = (bms: Mutant[], n: number, what: string) => {
    let kept = 0;
    let points = 0;
    for (const p of new Set(bms.map((m) => m.point))) {
      const k = bms.filter((x) => x.point === p).length;
      if (kept + k <= n) kept += k;
      else {
        naive.add(p);
        points++;
      }
    }
    if (points) run.logf(`${what}: ${kept} of ${bms.length} variants as copies, ${points} points one by one`);
  };
  const groups = new Map<string, Mutant[]>();
  // every view gets its original plan, also one whose points all run one by one: it may still
  // carry the recording wrapper, which checkPlans must compare too
  for (const m of ms) if (m.unitRef.type === 'VIEW' && !groups.has(unitKey(m))) groups.set(unitKey(m), []);
  for (const m of ms) {
    if (naive.has(m.point) || !switchable(m.point)) continue;
    const at = m.point.dyn ?? m.point.scope;
    const key = m.unitRef.type === 'VIEW' ? unitKey(m) : at ? `${unitKey(m)}@${at.join(':')}` : '';
    if (key) groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  for (const [key, gms] of groups) {
    const u = (gms[0] ?? ms.find((m) => unitKey(m) === key)!).unitRef;
    const branches = gms.filter((m) => !m.point.inline);
    if (u.type === 'VIEW') {
      // the plan of the original, for the check after compiling; its time for the cap
      let probe: number;
      try {
        const owner = objectOwner(u.name) ?? (await w.currentSchema());
        const e = await explain(w, owner, objectName(u.name));
        probe = e.ms;
        // views built on this one: a UNION ALL view cannot be merged into them any more
        const deps: ViewPlans['deps'] = [];
        for (const [o, n] of await dependentViews(w, owner, objectName(u.name))) {
          // a dependent that cannot be explained cannot be compared: thrown, the view stays as written
          deps.push({ owner: o, name: n, plan: livePlan((await explain(w, o, n)).rows) });
        }
        plans.set(key, { own: livePlan(e.rows), deps });
      } catch (e) {
        // without a plan neither the cap nor the plan check can work: the view stays as written
        run.oneByOne(key, true);
        run.logf(`${key}: EXPLAIN PLAN failed (${firstLine(e as Error)}), view kept original, mutants one by one`);
        continue;
      }
      if (!branches.length) continue;
      cap(branches, Math.min(VIEW_BRANCHES, Math.floor(VIEW_PLAN_BUDGET_MS / Math.max(probe, 1))), `${key}: parsing ${Math.round(probe)}ms`);
    } else if (gms[0].point.union && !gms[0].point.dyn) {
      cap(branches, CURSOR_BRANCHES, `${unitKey(gms[0])}:${gms[0].line} cursor`);
    } else {
      // every variant is the whole literal (dynamic SQL) or the whole statement again
      const { dyn, scope } = gms[0].point;
      const [a, b] = dyn ?? scope!;
      cap(gms, Math.floor(DUP_BYTES / Math.max(b - a, 1)), `${unitKey(gms[0])}:${gms[0].line} ${dyn ? 'dynamic SQL' : 'statement'} (${b - a} bytes)`);
    }
  }
  return plans;
}

/**
 * Views built on a view, directly, over other views or through synonyms (three levels, at
 * most 50): a UNION ALL view cannot be merged into them any more.
 */
async function dependentViews(w: Worker, owner: string, name: string): Promise<[string, string][]> {
  const out = new Map<string, [string, string]>();
  let level: [string, string][] = [[owner, name]];
  for (let depth = 0; depth < 3 && level.length && out.size < 50; depth++) {
    const next: [string, string][] = [];
    for (const [o, n] of level) {
      const syn = await w.deploy.execute<[string, string]>(
        `select owner, synonym_name from all_synonyms where table_owner = :o and table_name = :n`, { o, n });
      const refs: [string, string][] = [[o, n], ...(syn.rows ?? [])];
      for (const [ro, rn] of refs) {
        const r = await w.deploy.execute<[string, string]>(
          `select owner, name from all_dependencies where referenced_owner = :o and referenced_name = :n
             and referenced_type in ('VIEW', 'SYNONYM') and type = 'VIEW'`, { o: ro, n: rn });
        for (const d of r.rows ?? []) {
          const k = `${d[0]}.${d[1]}`;
          if (!out.has(k) && out.size < 50) {
            out.set(k, d);
            next.push(d);
          }
        }
      }
    }
    level = next;
  }
  return [...out.values()];
}

/** A view's original plan (livePlan) and those of the views built on it. */
interface ViewPlans {
  own: string[];
  deps: { owner: string; name: string; plan: string[] }[];
}

/**
 * EXPLAIN PLAN for a view (always optimizes, never executes): its plan rows and the time it
 * took. On a connection of its own: planning a view with many heavy copies can exceed the
 * server's cursor heap (ORA-00600 KGL-heap-size-exceeded), and the process dies with it.
 */
async function explain(w: Worker, owner: string, name: string): Promise<{ rows: PlanRow[]; ms: number }> {
  const c = await oracledb.getConnection(w.db);
  // PLAN_TABLE may be a table of the schema rather than the session's temporary one: an ID of
  // its own, and the rows go with the rollback at close (never committed)
  const id = `plgauge${randomUUID().slice(0, 8)}`;
  try {
    const t0 = performance.now();
    await c.execute(`explain plan set statement_id = '${id}' for select * from "${owner}"."${name}"`);
    const ms = performance.now() - t0;
    const r = await c.execute<[number, number | null, string, string | null, string | null, string | null]>(
      `select id, parent_id, operation, options, object_name, filter_predicates from plan_table where statement_id = :id order by id`,
      { id },
    );
    return { ms, rows: (r.rows ?? []).map(([id, parent, op, options, obj, filter]) => ({ id, parent, op: [op, options, obj].filter(Boolean).join(' '), filter })) };
  } finally {
    await c.rollback().catch(() => {});
    await c.close().catch(() => {});
  }
}

/**
 * Views: the plan of the switched view without its dead branches must be the original's (the
 * same operations on the same objects). Otherwise the copies changed it (a WITH clause now
 * materialized, a branch filter pushed into a table scan, another join order), and every
 * test that queries the view would run differently, slower or not at all. Such a view stays
 * original; its mutants run one by one. Returns the compile rounds spent.
 */
async function checkPlans(run: Run, plans: Map<string, ViewPlans>): Promise<number> {
  const { primary: w, ms, naive, dropped } = run;
  let rounds = 0;
  let checked = 0;
  // first the branches go; if the recording wrapper alone still changes the plan, the view stays
  // as written; from the third pass on (compile errors changed a view again, a dependent view
  // went back) at once. Every pass from then on makes one more view plain or ends: it ends.
  for (let pass = 0; ; pass++) {
    run.checkpoint();
    const views = (await run.build()).filter((u) => u.type === 'VIEW' && u.text !== u.original && plans.has(u.key));
    if (!pass) checked = views.length;
    const me = await w.currentSchema();
    const changed = new Set(views.map((v) => `${v.owner ?? me}.${v.name}`));
    let differs = false;
    for (const v of views) {
      let d: string | undefined;
      const p = plans.get(v.key)!;
      try {
        d = planDiff(p.own, livePlan((await explain(w, v.owner ?? me, v.name)).rows));
        for (const dep of p.deps) {
          if (d) break;
          // a dependent that is switched itself answers for its plan in its own check
          if (changed.has(`${dep.owner}.${dep.name}`)) continue;
          const x = planDiff(dep.plan, livePlan((await explain(w, dep.owner, dep.name)).rows));
          if (x) d = `in ${dep.name}: ${x}`;
        }
      } catch (e) {
        d = `not checkable: ${firstLine(e as Error)}`;
      }
      if (!d) continue;
      if (pass < 2 && ms.some((m) => unitKey(m) === v.key && !naive.has(m.point) && !dropped.has(m.id))) {
        run.oneByOne(v.key);
        run.logf(`${v.key}: plan with branches differs (${d}), mutants one by one, block for the recording only`);
      } else {
        // its mutants run one by one (some may still be switched when this comes from pass 2 on)
        run.oneByOne(v.key, true);
        run.logf(`${v.key}: plan differs even with just the recording wrapper (${d}), view kept original`);
      }
      differs = true;
    }
    if (!differs) break;
    rounds += await compileSchema(run, (su) => su.type === 'VIEW');
  }
  if (checked) run.logf(`Plan comparison: ${checked} views checked`);
  return rounds;
}

/** Names of the tests that fail in one run on the primary (the current code, no mutant active). */
async function failingTests(run: Run, paths: string[]): Promise<Set<string>> {
  const w = run.primary;
  await activate(w.test, 0);
  await resetPackages(w.test);
  const r = await w.runTests(paths, 10 * 60_000);
  if (r.err) throw new Error(`Baseline: ${firstLine(r.err)}`);
  return new Set(r.tests.filter((t) => t.failed).map((t) => t.name));
}

/**
 * Views in the schema change the view's text, and code that reads it (a view's source, a
 * lineage analysis) sees the copies: such tests would fail in the baseline and be lost for
 * every mutant. Tests failing with the switched views but not with the original ones are
 * traced to single views; those views stay original, their mutants run one by one (naive).
 * Returns the compile rounds spent putting the views back.
 */
async function isolateViews(run: Run): Promise<number> {
  const w = run.primary;
  const views = (await run.build()).filter((u) => u.type === 'VIEW' && u.text !== u.original && !run.unplaced.has(u.key));
  if (!views.length) return 0;
  const withViews = await failingTests(run, run.cfg.tests);
  if (!withViews.size) return 0;
  // dependents of the views recompile on first use: no compile_schema per view
  for (const v of views) await w.restore(v.key, false);
  const without = await failingTests(run, run.cfg.tests);
  const extra = [...withViews].filter((t) => !without.has(t));
  if (extra.length) {
    const culprits = new Map<SchemaUnit, string[]>();
    for (const v of views) {
      // a view that cannot be put in place alone (a lock, say) is not tried on its own
      const errs = await w.compileSchemaUnit(v).catch(() => undefined);
      if (errs === undefined) continue;
      const f = await failingTests(run, extra);
      const hit = extra.filter((t) => f.has(t));
      if (hit.length) culprits.set(v, hit);
      await w.restore(v.key, false);
    }
    // no single view: they fail together
    if (!culprits.size) for (const v of views) culprits.set(v, extra);
    for (const [v, tests] of culprits) {
      run.oneByOne(v.key, true);
      run.logf(`${v.key}: without the schema (failing with it: ${tests.map((t) => t.split('.').pop()).join(', ')}), mutants one by one`);
    }
  }
  // the views back into the schema (those to blame as originals); the other units are unchanged
  return compileSchema(run, (su) => su.type === 'VIEW');
}

/**
 * Compiles the schema units (those passing only) on the primary, charges compile errors to the branch or
 * point they occur in and repeats until every unit is valid.
 */
async function compileSchema(run: Run, only: (su: SchemaUnit) => boolean = () => true): Promise<number> {
  const { primary: w, dropped, naive, broken } = run;
  // as many rounds as errors take things out (CREATE VIEW reports one error at a time); a round
  // that takes nothing out cannot be followed by a better one
  const state = () => dropped.size + naive.size + broken.size;
  for (let round = 1; ; round++) {
    let bad = false;
    const before = state();
    run.checkpoint();
    for (const su of (await run.build()).filter((u) => only(u) && !run.unplaced.has(u.key))) {
      // not compiled at all (a lock, a privilege): the unit stays out of the schema, its mutants
      // run one by one, the run goes on
      let failure = '';
      const errs = await w.compileSchemaUnit(su).catch((e: Error) => ((failure = firstLine(e)), []));
      if (failure) {
        // an earlier round put its schema text there: back to the original, like on the other workers
        if (run.placed.has(su.key)) await w.restore(su.key, false);
        run.unplaced.add(su.key);
        run.oneByOne(su.key);
        run.logf(`${su.key}: not compilable (${failure}), without the schema, mutants one by one`);
        continue;
      }
      run.placed.add(su.key);
      if (!errs.length) continue;
      bad = true;
      for (const e of errs) {
        if (isCompanion(e.text)) continue;
        const rg = e.line > 0 ? locate(su, e.line, e.position) : undefined;
        if (rg && rg.mutantId) dropped.set(rg.mutantId, `${e.line}:${e.position} ${e.text}`);
        else if (rg) {
          for (const q of rg.points ?? [rg.point]) naive.add(q);
          if (rg.block) broken.add(rg.block);
        } else {
          run.logf(`unassigned error in ${su.key}: ${e.line}:${e.position} ${e.text}`);
          for (const m of su.mutants) naive.add(m.point);
        }
      }
    }
    if (!bad) return round;
    if (state() === before) throw new Error(`Schema not compilable after ${round} rounds (errors that belong to no mutant)`);
  }
}

/** Recording run: covering tests per mutant ID, fastest first; loop limits. */
async function record(run: Run, tests: TestResult[], ids: number[], loopCount: number): Promise<Map<number, string[]>> {
  const w = run.primary;
  await activate(w.test, -1);
  await w.test.conn.execute(`begin plgauge_ctl.arm; end;`);
  const r = await w.runTests(w.testPaths(), 10 * 60_000);
  if (r.err) throw new Error(`Recording run: ${firstLine(r.err)}`);
  // a test reset all package state (DBMS_SESSION.RESET_PACKAGE): the hits are gone with it
  const intact = (await w.test.conn.execute<[number]>(`select plgauge_ctl.intact from dual`)).rows?.[0]?.[0] === 1;
  // A test that passed the baseline but fails now depends on state or order.
  const flakyNow = r.tests.filter((t) => t.failed);
  for (const t of flakyNow) run.logf(`flaky, fails in the recording run: ${t.name}: ${failureMessage(t.message) ?? ''}`);
  if (flakyNow.length) {
    // (run.passing are the names of tests: both come from the baseline)
    run.exclude(new Set(flakyNow.map((t) => t.name)));
    tests = tests.filter((t) => !run.flaky.has(t.name));
  }
  const dur = new Map(tests.map((t) => [t.name, t.durationMs]));
  const all = tests.map((t) => t.name);
  const byId = new Map<number, Set<string>>();
  for (const [test, ids] of await hits(w.test)) for (const id of ids) for (const n of test === '' ? all : [test]) (byId.get(id) ?? byId.set(id, new Set()).get(id)!).add(n);
  const covering = new Map<number, string[]>([...byId].map(([id, set]) => [id, [...set].sort((a, b) => (dur.get(a) ?? 0) - (dur.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))]));
  if (!intact) {
    // no mutant may come out NOT_COVERED on lost hits: all tests for every switched mutant
    run.logf('WARNING: a test reset the package state (DBMS_SESSION.RESET_PACKAGE?): the recording is incomplete, every mutant runs with all tests');
    const sorted = [...all].sort((a, b) => (dur.get(a) ?? 0) - (dur.get(b) ?? 0));
    for (const id of ids) covering.set(id, sorted);
  }
  // counts after a reset would be partial: limits from them could stop the original code, and so
  // could the default; without them every guard is as good as off (the watchdog's time limit
  // still stops an endless loop)
  const counts = intact ? await loops(w.test) : new Map<number, number>();
  w.loopLimits = intact
    ? new Map([...counts].map(([id, n]) => [id, Math.max(1000, 10 * n)]))
    : new Map(Array.from({ length: loopCount }, (_, k) => [k + 1, 1_000_000_000] as [number, number]));
  await setLoopLimits(w.test, w.loopLimits);
  run.logf(`Recording: ${covering.size} of ${run.total} mutants reached, ${counts.size} loops counted`);
  return covering;
}

