/**
 * A mutation testing run, ported from plmut (internal/run): install, baseline,
 * mutants, verdicts. Two modes:
 *
 * - schema (default): all mutants compiled into the code once; a recording run notes
 *   which test reaches which mutant; each mutant runs only against its covering
 *   tests, the fastest first, fail-fast.
 * - naive: every mutant compiled on its own, all tests each time. Slow but independent
 *   of the schema rewriter: the oracle.
 *
 * Several databases (workers) share the mutants; the first one decides schema,
 * baseline and coverage. Every code change goes through the core's restore journal.
 */
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import oracledb from 'oracledb';
import {
  ensureJournal, loadObject, objectErrors, replaceSource, restoreAll, runScript, splitScript, type SourceObject,
} from '@pltest/core';
import { expand, mutatedUnit, objectName, unitKey, withoutCreate, type Mutant, type Point, type SourceFile } from './mutant.js';
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

export function loadConfig(dir: string): Config {
  const c = JSON.parse(readFileSync(join(dir, 'plmut.json'), 'utf8')) as Partial<Config>;
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
export function projectMutants(dir: string, opt: Pick<Options, 'ops' | 'sample' | 'seed'> = {}) {
  const cfg = loadConfig(dir);
  const files = findPoints(mutateFiles(cfg, dir));
  let ms = expand(files, opt.ops);
  const all = ms.length;
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
const lostConnection = (e?: Error) => !!e && /NJS-500|NJS-003|DPI-1010|DPI-1080|ORA-00028|ORA-03113|ORA-03135/.test(e.message);

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
      const r = await this.deploy.execute<[string]>(`select status from user_objects where object_name = :n and object_type = :t`, { n: name, t: type });
      if (r.rows?.[0]?.[0] !== 'VALID') out.push(`${type} ${name}`);
    }
    return out;
  }

  async close(): Promise<void> {
    for (const c of [this.test?.conn, this.deploy, this.monitor]) await c?.close().catch(() => {});
  }

  /** The database object of a unit, loaded once (it goes into the restore journal). */
  private async object(key: string, type: string, name: string): Promise<SourceObject> {
    let o = this.objects.get(key);
    if (!o) {
      const owner = (await this.deploy.execute<[string]>(`select sys_context('USERENV','CURRENT_SCHEMA') from dual`)).rows![0][0];
      o = await loadObject(this.deploy, owner, objectName(name), type);
      this.objects.set(key, o);
    }
    return o;
  }

  /** Compiles a unit's new text; returns the compile errors (empty = valid). */
  async compileUnit(key: string, type: string, name: string, text: string) {
    const obj = await this.object(key, type, name);
    this.changed.set(key, obj);
    const summary = await replaceSource(this.deploy, obj, text, 'mutation');
    if (!summary) return [];
    const errs = await objectErrors(this.deploy, obj);
    return errs.length ? errs : [{ line: 0, position: 0, text: summary }];
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
    if (run.committed) {
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
      await resetPackages(this.test);
      this.classify(res, await this.runTests(this.testPaths()));
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
      const errs = await this.compileUnit(su.key, su.type, su.name, su.text);
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
    status: 'ERROR', durationMs: 0, mutant: m,
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

  progress(w: Worker, r: Result) {
    this.done++;
    const one = (s: string) => {
      const t = s.split(/\s+/).join(' ');
      return [...t].length > 60 ? [...t].slice(0, 57).join('') + '…' : t;
    };
    this.logf(`[${this.done}/${this.total}]${w.name} ${r.status.padEnd(13)} ${r.file.split('/').pop()}:${r.line} ${r.op} ${one(r.original)} → ${one(r.mutated)}`);
  }

  /** Runs fn for every mutant, spread over all workers; results in input order. */
  async dispatch(ms: Mutant[], fn: (w: Worker, m: Mutant) => Promise<Result>, stop: () => boolean): Promise<Result[]> {
    const results: (Result | undefined)[] = new Array(ms.length);
    let next = 0;
    await Promise.all(this.workers.map(async (w) => {
      while (!stop()) {
        const i = next++;
        if (i >= ms.length) return;
        const r = await fn(w, ms[i]);
        if (r.sideEffect) await w.resetAfterSideEffect();
        results[i] = r;
        this.progress(w, r);
      }
    }));
    return results.filter((r): r is Result => !!r);
  }

  async restoreEverywhere() {
    await Promise.all(this.workers.map((w) => w.restoreAll()));
  }

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
  run.logf(`${ms.length} Mutanten in ${files.length} Dateien, ${skipped} gleichwertige oder sinnlose Varianten ausgelassen`);
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
  const rounds = await compileSchema(run, ms, dropped, naive);
  const units = buildSchema(ms, new Set(dropped.keys()), naive);
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
 * Compiles the schema units on the primary, charges compile errors to the branch or
 * point they occur in and repeats until every unit is valid.
 */
async function compileSchema(run: Run, ms: Mutant[], dropped: Map<number, string>, naive: Set<Point>): Promise<number> {
  const w = run.primary;
  for (let round = 1; round <= 20; round++) {
    let bad = false;
    for (const su of buildSchema(ms, new Set(dropped.keys()), naive)) {
      const errs = await w.compileUnit(su.key, su.type, su.name, su.text);
      if (!errs.length) continue;
      bad = true;
      for (const e of errs) {
        if (isCompanion(e.text)) continue;
        const rg = e.line > 0 ? locate(su, e.line, e.position) : undefined;
        if (rg && rg.mutantId) dropped.set(rg.mutantId, `${e.line}:${e.position} ${e.text}`);
        else if (rg) naive.add(rg.point);
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
