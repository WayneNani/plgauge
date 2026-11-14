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
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import oracledb from 'oracledb';
import {
  dbIdent, ensureJournal, journalEntries, loadObject, objectErrors, replaceSourceDetailed, restoreAll, runScript, sha256, splitScript, touches,
  type ChangedLines, type SourceObject,
} from '@pltest/core';
import type { CoverageExport } from '@pltest/coverage';
import { CoverageIndex, unitLineOf } from './link.js';
import { expand, mutatedUnit, objectName, objectOwner, unitKey, withoutCreate, type Mutant, type Point, type SourceFile } from './mutant.js';
import { findPoints } from './find.js';
import { buildSchema, locate, switchable, type SchemaUnit } from './schema.js';
import {
  activate, aborted, failed, firstFailure, firstFailureMessage, firstLine, hits, installControl, installRuntime, isMemory,
  loops, newSession, parseDbUrl, resetPackages, runTests, setLoopLimits,
  type ConnectConfig, type RunResult, type Session, type TestResult,
} from './session.js';
import { globSync } from 'node:fs';

export type Status = 'KILLED' | 'SURVIVED' | 'TIMEOUT' | 'MEMORY' | 'NOT_COVERED' | 'COMPILE_ERROR' | 'ERROR';

/** Project file plmut.json. */
export interface Config {
  /** Scripts, in order, relative to the project. */
  install: string[];
  /** Globs of files whose units are mutated. */
  mutate: string[];
  /** utPLSQL paths; empty runs the whole schema. */
  tests: string[];
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
  /** Measured coverage (plcov-coverage/1): the oracle mode runs only the tests around each mutant. */
  coverage?: CoverageExport;
  /** Diff mode: only mutants on these lines (core changedLines). */
  diff?: ChangedLines;
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
}

/** The project file: pltest.json, or plmut.json from before the merge. */
export function loadConfig(dir: string): Config {
  const file = existsSync(join(dir, 'pltest.json')) ? 'pltest.json' : 'plmut.json';
  const c = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Partial<Config>;
  return { install: c.install ?? [], mutate: c.mutate ?? [], tests: c.tests ?? [] };
}

export function mutateFiles(cfg: Config, dir: string): string[] {
  const files = new Set<string>();
  for (const g of cfg.mutate) for (const f of globSync(g, { cwd: dir })) files.add(join(dir, f));
  const out = [...files].sort();
  if (!out.length) throw new Error(`keine Dateien zu ${cfg.mutate.join(', ')}`);
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

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const isCompanion = (text: string) => text.includes('Statement ignored') || text.includes('Item ignored');
const lostConnection = (e?: Error) => !!e && /NJS-500|NJS-003|NJS-521|DPI-1010|DPI-1080|ORA-00028|ORA-03113|ORA-03135|ORA-07445/.test(e.message);

class Worker {
  deploy!: oracledb.Connection;
  monitor!: oracledb.Connection;
  test!: Session;
  db: ConnectConfig;
  limitMs = 0;
  passing: string[] = [];
  excluded = 0;
  flaky = new Set<string>();
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

  async open(): Promise<void> {
    this.deploy = await oracledb.getConnection(this.db);
    this.monitor = await oracledb.getConnection(this.db);
    this.test = await newSession(this.db);
    if (!this.run.opt.skipInstall) {
      for (const s of this.run.cfg.install) {
        const path = join(this.run.opt.dir, s);
        const stmts = splitScript(readFileSync(path, 'utf8'));
        await runScript(this.deploy, stmts, path);
        const invalid = await this.invalidUnits(stmts);
        if (invalid.length) throw new Error(`Installation${this.name}: ${path}: ungültig: ${invalid.join(', ')}`);
      }
    }
    await ensureJournal(this.deploy);
    await installRuntime(this.deploy);
  }

  private async invalidUnits(stmts: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const st of stmts) {
      const m = /^\s*create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(package\s+body|package|type\s+body|procedure|function|trigger)\s+("?[\w$#."]+"?)/i.exec(st);
      if (!m) continue;
      const type = m[1].toUpperCase().replace(/\s+/g, ' ');
      const name = objectName(m[2]);
      const owner = objectOwner(m[2]) ?? (await this.currentSchema());
      const r = await this.deploy.execute<[string]>(`select status from all_objects where owner = :o and object_name = :n and object_type = :t`, { o: owner, n: name, t: type });
      if (r.rows?.[0]?.[0] !== 'VALID') out.push(`${type} ${name}`);
    }
    return out;
  }

  async close(): Promise<void> {
    for (const c of [this.test?.conn, this.deploy, this.monitor]) await c?.close().catch(() => {});
  }

  /**
   * The database object of a unit, loaded once (it goes into the restore journal). A unit
   * written with a schema (other_schema.name) lives there (A4); the schema mode then gives
   * that schema the right to call plmut_ctl.
   */
  async object(key: string, type: string, name: string): Promise<SourceObject> {
    let o = this.objects.get(key);
    if (!o) {
      const user = await this.currentSchema();
      const owner = objectOwner(name) ?? user;
      o = await loadObject(this.deploy, owner, objectName(name), type);
      if (owner !== user && !this.granted.has(owner)) {
        await this.deploy.execute(`grant execute on plmut_ctl to ${dbIdent(owner)}`).catch(() => {});
        this.granted.add(owner);
      }
      this.objects.set(key, o);
    }
    return o;
  }

  schemaName?: string;
  private granted = new Set<string>();

  async currentSchema(): Promise<string> {
    this.schemaName ??= (await this.deploy.execute<[string]>(`select sys_context('USERENV','CURRENT_SCHEMA') from dual`)).rows![0][0];
    return this.schemaName;
  }

  /** Compiles a unit's new text; returns the compile errors (empty = valid). */
  async compileUnit(key: string, type: string, name: string, text: string) {
    const obj = await this.object(key, type, name);
    this.changed.set(key, obj);
    const out = await replaceSourceDetailed(this.deploy, obj, text, 'mutation');
    if (!out.error) return [];
    if (out.offset !== undefined) {
      // a view statement rejected at once: the server's offset into the text
      const before = text.slice(0, out.offset);
      const line = before.split('\n').length;
      return [{ line, position: [...before.slice(before.lastIndexOf('\n') + 1)].length + 1, text: out.error }];
    }
    const errs = await objectErrors(this.deploy, obj);
    return errs.length ? errs : [{ line: 0, position: 0, text: out.error }];
  }

  async restore(key: string): Promise<void> {
    const obj = this.changed.get(key);
    if (!obj) return;
    await restoreAll(this.deploy, [obj], (m) => (m.includes('✗') ? this.logf(`WARNUNG${this.name}: ${m.trim()}`) : undefined));
    this.changed.delete(key);
  }

  async restoreAll(): Promise<void> {
    for (const key of [...this.changed.keys()]) await this.restore(key).catch((e) => this.logf(`WARNUNG${this.name}: ${firstLine(e)}`));
    this.lastUnit = '';
  }

  retired = false;

  /** Whether the deploy connection still answers. */
  async alive(): Promise<boolean> {
    try {
      await this.deploy.execute('select 1 from dual');
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
    await this.close();
    this.objects.clear();
    this.changed.clear();
    this.lastUnit = '';
    this.schemaName = undefined;
    this.granted.clear();
    try {
      this.deploy = await oracledb.getConnection(this.db);
      this.monitor = await oracledb.getConnection(this.db);
      this.test = await newSession(this.db);
      await ensureJournal(this.deploy);
      const mine = (await journalEntries(this.deploy)).filter((e) => e.tool === 'mutation');
      if (mine.length) await restoreAll(this.deploy, mine.map((e) => e.object), () => {});
      await installRuntime(this.deploy);
      if (this.schema) {
        await this.installSchema(this.schema);
        if (this.loopLimits) await setLoopLimits(this.test, this.loopLimits);
      }
      this.logf(`Worker${this.name} neu verbunden`);
      return true;
    } catch (e) {
      this.logf(`Neuaufbau${this.name} gescheitert: ${firstLine(e as Error)}`);
      return false;
    }
  }

  async reconnectTest(): Promise<void> {
    await this.test.conn.close().catch(() => {});
    this.test = await newSession(this.db);
    if (this.loopLimits) await setLoopLimits(this.test, this.loopLimits);
  }

  testPaths(): string[] {
    return this.excluded === 0 ? this.run.cfg.tests : this.passing;
  }

  async runTests(paths: string[], limitMs = this.limitMs): Promise<RunResult> {
    const r = await runTests(this.test, this.monitor, paths, limitMs);
    if (r.killed || (!r.timedOut && lostConnection(r.err))) await this.reconnectTest();
    return r;
  }

  classify(res: Result, run: RunResult): void {
    // When the tests commit by themselves, a commit says nothing about the mutant.
    if (run.committed && !this.run.testsCommit) {
      res.sideEffect = true;
      this.logf(`WARNUNG${this.name}: Mutant ${res.id} hat einen Commit ausgelöst; Daten dieser Datenbank können verändert sein`);
    }
    if (run.timedOut) res.status = 'TIMEOUT';
    else if (isMemory(run.err)) Object.assign(res, { status: 'MEMORY', detail: firstLine(run.err!) });
    else if (run.err && run.err.message.includes('ORA-')) Object.assign(res, { status: 'KILLED', killedBy: '(Abbruch von ut.run)', detail: firstLine(run.err) });
    else if (run.err) Object.assign(res, { status: 'ERROR', detail: firstLine(run.err) });
    else if (failed(run)) Object.assign(res, { status: 'KILLED', killedBy: firstFailure(run) });
    else res.status = 'SURVIVED';
  }

  /** Oracle rewriter: compile the unit with one mutant, run all tests. */
  async naive(m: Mutant): Promise<Result> {
    const res = newResult(m);
    const t0 = performance.now();
    try {
      const errs = await this.compileUnit(unitKey(m), m.unitRef.type, m.unitRef.name, withoutCreate(mutatedUnit(m)));
      if (errs.length) {
        res.status = 'COMPILE_ERROR';
        res.detail = errs.slice(0, 3).map((e) => `${e.line}:${e.position} ${e.text}`).join('; ');
        return res;
      }
      let tests = this.testPaths();
      const sel = await this.run.selection(this, m);
      if (sel) {
        // configured paths may be suites: select from the single tests of the baseline
        tests = this.passing.filter((t) => sel.includes(t));
        res.coveredBy = tests;
        if (!tests.length) {
          Object.assign(res, { status: 'NOT_COVERED', detail: 'laut Coverage von keinem Test ausgeführt' });
          return res;
        }
      }
      await resetPackages(this.test);
      this.classify(res, await this.runTests(tests));
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
    try {
      const tests = (covering ?? []).filter((t) => !this.flaky.has(t));
      if (!tests.length) {
        res.status = 'NOT_COVERED';
        return;
      }
      await activate(this.test, res.id);
      const batches = tests.length > 1 ? [tests.slice(0, 1), tests.slice(1)] : [tests];
      for (const b of batches) {
        const run = await this.runTests(b);
        this.classify(res, run);
        if (run.killed) return;
        if (await aborted(this.test).catch(() => false)) {
          Object.assign(res, { status: 'TIMEOUT', killedBy: undefined, detail: 'Schleifenwächter' });
          return;
        }
        if (res.status !== 'SURVIVED') return;
      }
    } catch (e) {
      Object.assign(res, { status: 'ERROR', detail: firstLine(e as Error) });
    } finally {
      res.durationMs = performance.now() - t0;
    }
  }

  async installSchema(units: SchemaUnit[]): Promise<void> {
    await installControl(this.deploy);
    for (const su of units) {
      const errs = await this.compileUnit(su.key, su.type, su.owner ? `"${su.owner}"."${su.name}"` : su.name, su.text);
      if (errs.length) throw new Error(`${su.key} ungültig${this.name}: ${errs.slice(0, 3).map((e) => e.text).join('; ')}`);
    }
  }

  /** After a side effect: replace the database (resetCmd) and set it up again. */
  async resetAfterSideEffect(): Promise<void> {
    const cmd0 = this.run.opt.resetCmd;
    if (!cmd0) return;
    const port = new URL(this.url).port;
    const cmd = cmd0.replaceAll('{port}', port);
    this.logf(`Worker${this.name} wird zurückgesetzt: ${cmd}`);
    const t0 = Date.now();
    try {
      await promisify(execFile)('sh', ['-c', cmd]);
    } catch (e) {
      this.logf(`Zurücksetzen${this.name} gescheitert: ${firstLine(e as Error)}`);
      return;
    }
    await this.close();
    this.objects.clear();
    this.changed.clear();
    this.lastUnit = '';
    try {
      await this.open();
      if (this.schema) {
        await this.installSchema(this.schema);
        if (this.loopLimits) await setLoopLimits(this.test, this.loopLimits);
      }
      this.logf(`Worker${this.name} zurückgesetzt in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      this.logf(`Neuaufbau${this.name} gescheitert: ${firstLine(e as Error)}`);
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
  private covUsable = new Map<string, boolean>();
  /** Schema mode: covering tests per mutant from the recording run. */
  covering = new Map<number, string[]>();
  /** Unswitched mutants whose reach the recording run noted (view blocks): covering is complete for them. */
  recorded = new Set<number>();

  /**
   * Oracle mode with coverage: the test paths that executed the statement around the
   * mutant, or null (run all) if the unit has no matching coverage. The unit in the
   * database must be the one that was measured (same ALL_SOURCE hash).
   */
  async selection(w: Worker, m: Mutant): Promise<string[] | null> {
    if (this.recorded.has(m.id)) return this.covering.get(m.id) ?? [];
    if (!this.opt.coverage) return null;
    this.covIndex ??= new CoverageIndex(this.opt.coverage);
    const obj = this.covIndex.object(m.unit);
    if (!obj) return null;
    const key = unitKey(m);
    let ok = this.covUsable.get(key);
    if (ok === undefined) {
      const o = await w.object(key, m.unitRef.type, m.unitRef.name);
      ok = !obj.rawSha256 || obj.rawSha256 === sha256(o.original);
      if (!ok) this.logf(`WARNUNG: Coverage von ${m.unit} passt nicht zum Code in der Datenbank, alle Tests laufen`);
      this.covUsable.set(key, ok);
    }
    if (!ok) return null;
    const line = m.line - unitLineOf(m) + 1;
    const sel = this.covIndex.testsAt(obj, line, line > 1 ? m.col : undefined);
    // a flaky test may reach the mutant in this run although it did not when measured
    return sel && [...sel, ...[...this.covIndex.flaky].filter((t) => !sel.includes(t))];
  }

  progress(w: Worker, r: Result) {
    this.done++;
    const one = (s: string) => {
      const t = s.split(/\s+/).join(' ');
      return [...t].length > 60 ? [...t].slice(0, 57).join('') + '…' : t;
    };
    this.logf(`[${this.done}/${this.total}]${w.name} ${r.status.padEnd(13)} ${r.file.split('/').pop()}:${r.line} ${r.op} ${one(r.original)} → ${one(r.mutated)}`);
  }

  /** Runs fn for every mutant, spread over all workers; results in input order. */
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
    await Promise.all(this.workers.map(async (w) => {
      while (!stop() && !w.retired) {
        const i = again.length ? again.shift()! : next++;
        if (i >= ms.length) return;
        let r = await fn(w, ms[i]);
        if (broken(r) || !(await w.alive())) {
          this.logf(`Worker${w.name}: Verbindung verloren (${r.detail ?? 'Verwaltungsverbindung'}), baue neu auf …`);
          if (await w.reopen()) {
            r = await fn(w, ms[i]);
          } else {
            w.retired = true;
            again.push(i);
            this.logf(`Worker${w.name} scheidet aus, die anderen übernehmen seine Mutanten`);
            return;
          }
        }
        if (r.sideEffect) await w.resetAfterSideEffect();
        results[i] = r;
        this.progress(w, r);
      }
    }));
    // all workers retired with work left: nothing more can run
    if (again.length || next < ms.length) {
      if (this.workers.every((w) => w.retired)) throw new Error('alle Worker-Datenbanken ausgefallen');
    }
    return results.filter((r): r is Result => !!r);
  }

  async restoreEverywhere() {
    await Promise.all(this.workers.map((w) => w.restoreAll()));
  }

  /** The baseline committed: commits under mutants are no side effect of theirs. */
  testsCommit = false;

  shareBaseline() {
    for (const h of this.workers.slice(1)) Object.assign(h, { limitMs: this.primary.limitMs, passing: this.primary.passing, excluded: this.primary.excluded, flaky: this.primary.flaky });
  }

  /** Baseline twice; tests failing in either run are excluded (most do DDL or depend on state). */
  async baseline(): Promise<{ ms: number; tests: TestResult[] }> {
    const w = this.primary;
    let slowest = 0;
    const failedNames = new Map<string, string>();
    let last: TestResult[] = [];
    for (let i = 0; i < 2; i++) {
      await resetPackages(w.test);
      const r = await w.runTests(this.cfg.tests, 10 * 60_000);
      if (r.err) throw new Error(`Baseline: ${firstLine(r.err)}`);
      if (r.committed && !this.testsCommit) {
        this.testsCommit = true;
        this.logf('Hinweis: Die Tests committen schon ohne Mutanten; Commits unter Mutanten gelten nicht als Nebenwirkung, kein Zurücksetzen');
      }
      for (const t of r.tests) if (t.failed) failedNames.set(t.name, t.message);
      slowest = Math.max(slowest, r.elapsedMs);
      last = r.tests;
    }
    const ok = last.filter((t) => !failedNames.has(t.name) && !t.ignored);
    for (const [n, msg] of failedNames) this.logf(`ausgeschlossen, scheitert ohne Mutanten: ${n}: ${msg.split(/\s+/).join(' ').slice(0, 60)}`);
    if (!ok.length) throw new Error('Baseline: kein Test besteht ohne Mutanten');
    w.excluded = failedNames.size;
    w.passing = ok.map((t) => t.name);
    w.limitMs = slowest * (this.opt.timeoutFactor ?? 5) + 2000;
    this.shareBaseline();
    return { ms: slowest, tests: ok };
  }

  /**
   * Re-runs every killing test twice alone against the original behaviour. A test
   * failing there depends on state or order: it is excluded and its mutants run again.
   */
  async recheckKillers(rep: Report, rerun: (ms: Mutant[]) => Promise<Result[]>): Promise<void> {
    const w = this.primary;
    const killers = [...new Set(rep.results.filter((r) => r.status === 'KILLED' && r.killedBy && !r.killedBy.startsWith('(')).map((r) => r.killedBy!))].sort();
    const flaky = new Set<string>();
    for (const name of killers) {
      for (let i = 0; i < 2 && !flaky.has(name); i++) {
        await resetPackages(w.test);
        const run = await w.runTests([name]);
        if (failed(run)) {
          flaky.add(name);
          this.logf(`unzuverlässig, scheitert auch ohne Mutant: ${name}: ${firstFailureMessage(run).slice(0, 60)}`);
        }
      }
    }
    if (!flaky.size) return;
    rep.flakyTests.push(...[...flaky].sort());
    const keep = w.passing.filter((t) => !flaky.has(t));
    w.excluded += w.passing.length - keep.length;
    w.passing = keep;
    for (const f of flaky) w.flaky.add(f);
    this.shareBaseline();
    rep.tests = w.passing.length;
    rep.excludedTests = w.excluded;
    const again = rep.results.filter((r) => r.status === 'KILLED' && flaky.has(r.killedBy ?? ''));
    this.logf(`${again.length} Mutanten werden ohne die unzuverlässigen Tests wiederholt`);
    const byId = new Map(rep.results.map((r, i) => [r.id, i]));
    for (const r of await rerun(again.map((x) => x.mutant))) rep.results[byId.get(r.id)!] = r;
  }
}

/** Executes a complete run. */
export async function runMutation(opt: Options): Promise<Report> {
  const t0 = performance.now();
  const { cfg, files, mutants: ms } = projectMutants(opt.dir, opt);
  const run = new Run(opt, cfg);
  run.total = ms.length;
  let skipped = 0;
  for (const f of files) {
    skipped += f.skipped;
    if (f.errors.length) run.logf(`übersprungen, nicht parsbar: ${f.path}: ${f.errors.join('; ')}`);
  }
  run.logf(`${ms.length} Mutanten in ${files.length} Dateien${opt.diff ? ' (nur geänderte Zeilen)' : ''}, ${skipped} gleichwertige oder sinnlose Varianten ausgelassen`);
  if (!ms.length) {
    run.logf('keine Mutanten: nichts zu tun');
    return { mode: opt.mode ?? 'schema', baselineMs: 0, limitMs: 0, tests: 0, excludedTests: 0, flakyTests: [], skippedVariants: skipped, results: [], elapsedMs: performance.now() - t0 };
  }
  if (!opt.dbUrls.length) throw new Error('keine Datenbank: --db oder PLMUT_DB setzen');
  opt.dbUrls.forEach((u, i) => run.workers.push(new Worker(u, opt.dbUrls.length > 1 ? ` w${i + 1}` : '', run)));
  let interrupted = false;
  const onSig = () => {
    interrupted = true;
    run.logf('Abbruch angefordert, stelle Originale wieder her …');
  };
  process.once('SIGINT', onSig);
  try {
    await Promise.all(run.workers.map((w) => w.open()));
    if (run.workers.length > 1) run.logf(`${run.workers.length} Worker-Datenbanken`);
    const mode = opt.mode ?? 'schema';
    const rep = mode === 'naive' ? await runNaive(run, ms, () => interrupted) : await runSchema(run, ms, () => interrupted);
    rep.mode = mode;
    rep.skippedVariants = skipped;
    rep.elapsedMs = performance.now() - t0;
    rep.results.sort((a, b) => a.id - b.id);
    return rep;
  } finally {
    process.off('SIGINT', onSig);
    await run.restoreEverywhere().catch(() => {});
    await Promise.all(run.workers.map((w) => w.close()));
  }
}

function emptyReport(run: Run, baselineMs: number, tests: number): Report {
  const w = run.primary;
  return { mode: '', baselineMs, limitMs: w.limitMs, tests, excludedTests: w.excluded, flakyTests: [], skippedVariants: 0, results: [], elapsedMs: 0 };
}

async function naiveList(run: Run, ms: Mutant[], stop: () => boolean): Promise<Result[]> {
  const out = await run.dispatch(ms, async (w, m) => {
    if (w.lastUnit && w.lastUnit !== unitKey(m)) await w.restore(w.lastUnit);
    w.lastUnit = unitKey(m);
    return w.naive(m);
  }, stop);
  await run.restoreEverywhere();
  return out;
}

async function runNaive(run: Run, ms: Mutant[], stop: () => boolean): Promise<Report> {
  const base = await run.baseline();
  const rep = emptyReport(run, base.ms, base.tests.length);
  run.logf(`Baseline: ${base.tests.length} Tests in ${Math.round(base.ms)}ms, Zeitgrenze ${Math.round(run.primary.limitMs)}ms`);
  rep.results = await naiveList(run, ms, stop);
  await run.recheckKillers(rep, (again) => naiveList(run, again, stop));
  return rep;
}

async function runSchema(run: Run, ms: Mutant[], stop: () => boolean): Promise<Report> {
  const w = run.primary;
  const naive = new Set<Point>(ms.filter((m) => !switchable(m.point)).map((m) => m.point));
  const dropped = new Map<number, string>();
  const t0 = performance.now();
  await installControl(w.deploy);
  await capViews(run, ms, naive);
  let rounds = await compileSchema(run, ms, dropped, naive);
  if (await isolateViews(run, ms, dropped, naive)) rounds += await compileSchema(run, ms, dropped, naive);
  const units = buildSchema(ms, new Set(dropped.keys()), naive, await w.currentSchema());
  w.schema = units;
  await Promise.all(run.workers.slice(1).map(async (h) => {
    h.schema = units;
    await h.installSchema(units);
  }));
  run.logf(`Schema kompiliert in ${Math.round(performance.now() - t0)}ms (${rounds} Runden), ${dropped.size} Mutanten verworfen, ${naive.size} Stellen ohne Schema`);

  await activate(w.test, 0);
  const base = await run.baseline();
  const rep = emptyReport(run, base.ms, base.tests.length);
  run.logf(`Baseline mit Schema: ${base.tests.length} Tests in ${Math.round(base.ms)}ms, Zeitgrenze ${Math.round(w.limitMs)}ms`);

  const covering = await record(run, base.tests);
  run.covering = covering;
  run.recorded = new Set(units.flatMap((u) => u.recorded));
  rep.tests = w.passing.length;
  rep.excludedTests = w.excluded;
  for (const h of run.workers.slice(1)) {
    h.loopLimits = w.loopLimits;
    await setLoopLimits(h.test, w.loopLimits!);
  }

  const switched = ms.filter((m) => !naive.has(m.point));
  const fallback = ms.filter((m) => naive.has(m.point));
  const schemaOne = async (wk: Worker, m: Mutant) => {
    const res = newResult(m);
    const msg = dropped.get(m.id);
    if (msg !== undefined) Object.assign(res, { status: 'COMPILE_ERROR', detail: msg });
    else await wk.schemaMutant(res, covering.get(m.id));
    return res;
  };
  rep.results = await run.dispatch(switched, schemaOne, stop);
  for (const wk of run.workers) await activate(wk.test, 0);
  await run.recheckKillers(rep, async (again) => {
    const out = await run.dispatch(again, schemaOne, stop);
    for (const wk of run.workers) await activate(wk.test, 0);
    return out;
  });
  if (fallback.length && !stop()) {
    await run.restoreEverywhere();
    run.logf(`${fallback.length} Mutanten ohne Schema, einzeln kompiliert`);
    rep.results.push(...(await naiveList(run, fallback, stop)));
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

/**
 * Views: how many branch variants go into the schema (see VIEW_BRANCHES), in ID order. The
 * other points run with the oracle rewriter, their tests still selected by the recording of
 * their block.
 */
async function capViews(run: Run, ms: Mutant[], naive: Set<Point>): Promise<void> {
  const w = run.primary;
  const byUnit = new Map<string, Mutant[]>();
  for (const m of ms) {
    if (m.unitRef.type !== 'VIEW' || naive.has(m.point) || m.point.inline || !switchable(m.point)) continue;
    byUnit.set(unitKey(m), [...(byUnit.get(unitKey(m)) ?? []), m]);
  }
  for (const [key, bms] of byUnit) {
    const u = bms[0].unitRef;
    const owner = objectOwner(u.name) ?? (await w.currentSchema());
    const t0 = performance.now();
    try {
      // EXPLAIN PLAN always optimizes and never executes (a query with ROWNUM < 0 may skip both)
      await w.deploy.execute(`explain plan set statement_id = 'pltest' for select * from "${owner}"."${objectName(u.name)}"`);
    } catch (e) {
      run.logf(`Messprobe ${key}: ${firstLine(e as Error)}`);
      continue;
    }
    const probe = performance.now() - t0;
    const cap = Math.min(VIEW_BRANCHES, Math.floor(VIEW_PLAN_BUDGET_MS / Math.max(probe, 1)));
    if (bms.length <= cap) continue;
    let kept = 0;
    let points = 0;
    for (const p of new Set(bms.map((m) => m.point))) {
      const n = bms.filter((x) => x.point === p).length;
      if (kept + n <= cap) kept += n;
      else {
        naive.add(p);
        points++;
      }
    }
    run.logf(`${key}: Parsen ${Math.round(probe)}ms, ${kept} von ${bms.length} Varianten als Zweige, ${points} Stellen einzeln`);
  }
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
 * Returns whether points were moved, so that the schema has to be compiled again.
 */
async function isolateViews(run: Run, ms: Mutant[], dropped: Map<number, string>, naive: Set<Point>): Promise<boolean> {
  const w = run.primary;
  const views = buildSchema(ms, new Set(dropped.keys()), naive, await w.currentSchema()).filter((u) => u.type === 'VIEW' && u.mutants.length);
  if (!views.length) return false;
  const withViews = await failingTests(run, run.cfg.tests);
  if (!withViews.size) return false;
  for (const v of views) await w.restore(v.key);
  const without = await failingTests(run, run.cfg.tests);
  const extra = [...withViews].filter((t) => !without.has(t));
  if (!extra.length) return true; // the views come back with the next compile
  const culprits = new Map<SchemaUnit, string[]>();
  for (const v of views) {
    await w.compileUnit(v.key, v.type, v.owner ? `"${v.owner}"."${v.name}"` : v.name, v.text);
    const f = await failingTests(run, extra);
    const hit = extra.filter((t) => f.has(t));
    if (hit.length) culprits.set(v, hit);
    await w.restore(v.key);
  }
  // no single view: they fail together
  if (!culprits.size) for (const v of views) culprits.set(v, extra);
  for (const [v, tests] of culprits) {
    for (const m of ms) if (unitKey(m) === v.key) naive.add(m.point);
    run.logf(`${v.key}: ohne Schema (scheitern damit: ${tests.map((t) => t.split('.').pop()).join(', ')}), Mutanten einzeln`);
  }
  return true;
}

/**
 * Compiles the schema units on the primary, charges compile errors to the branch or
 * point they occur in and repeats until every unit is valid.
 */
async function compileSchema(run: Run, ms: Mutant[], dropped: Map<number, string>, naive: Set<Point>): Promise<number> {
  const w = run.primary;
  for (let round = 1; round <= 20; round++) {
    let bad = false;
    for (const su of buildSchema(ms, new Set(dropped.keys()), naive, await w.currentSchema())) {
      const errs = await w.compileUnit(su.key, su.type, su.owner ? `"${su.owner}"."${su.name}"` : su.name, su.text);
      if (!errs.length) continue;
      bad = true;
      for (const e of errs) {
        if (isCompanion(e.text)) continue;
        const rg = e.line > 0 ? locate(su, e.line, e.position) : undefined;
        if (rg && rg.mutantId) dropped.set(rg.mutantId, `${e.line}:${e.position} ${e.text}`);
        else if (rg) for (const q of rg.points ?? [rg.point]) naive.add(q);
        else {
          run.logf(`Fehler ohne Zuordnung in ${su.key}: ${e.line}:${e.position} ${e.text}`);
          for (const m of su.mutants) naive.add(m.point);
        }
      }
    }
    if (!bad) return round;
  }
  throw new Error('Schema nach 20 Runden nicht kompilierbar');
}

/** Recording run: covering tests per mutant ID, fastest first; loop limits. */
async function record(run: Run, tests: TestResult[]): Promise<Map<number, string[]>> {
  const w = run.primary;
  await activate(w.test, -1);
  const r = await w.runTests(w.testPaths(), 10 * 60_000);
  if (r.err) throw new Error(`Aufzeichnungslauf: ${firstLine(r.err)}`);
  // A test that passed the baseline but fails now depends on state or order.
  const flakyNow = r.tests.filter((t) => t.failed);
  for (const t of flakyNow) {
    w.flaky.add(t.name);
    run.logf(`unzuverlässig, scheitert im Aufzeichnungslauf: ${t.name}: ${t.message.split(/\s+/).join(' ').slice(0, 60)}`);
  }
  if (flakyNow.length) {
    const keep = tests.filter((t) => !w.flaky.has(t.name));
    w.excluded += tests.length - keep.length;
    tests = keep;
    w.passing = keep.map((t) => t.name);
    run.shareBaseline();
  }
  const h = await hits(w.test);
  const dur = new Map(tests.map((t) => [t.name, t.durationMs]));
  const all = tests.map((t) => t.name);
  const byId = new Map<number, Set<string>>();
  const add = (id: number, name: string) => {
    let s = byId.get(id);
    if (!s) byId.set(id, (s = new Set()));
    s.add(name);
  };
  for (const [test, ids] of h) for (const id of ids) (test === '' ? all : [test]).forEach((n) => add(id, n));
  const covering = new Map<number, string[]>();
  for (const [id, set] of byId) {
    covering.set(id, [...set].sort((a, b) => (dur.get(a) ?? 0) - (dur.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)));
  }
  const counts = await loops(w.test);
  w.loopLimits = new Map([...counts].map(([id, n]) => [id, Math.max(1000, 10 * n)]));
  await setLoopLimits(w.test, w.loopLimits);
  run.logf(`Aufzeichnung: ${covering.size} von ${run.total} Mutanten erreicht, ${counts.size} Schleifen gezählt`);
  return covering;
}

export { sleep };
