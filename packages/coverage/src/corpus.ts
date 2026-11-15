/**
 * Robustness check on a corpus of PL/SQL files.
 *
 * Offline: every package body, type body, procedure, function and trigger must parse, and the
 * instrumented text must keep the line count.
 * With a database: every body whose ORIGINAL compiles must also compile INSTRUMENTED.
 * Specs are compiled first (all files), then bodies, so cross-file dependencies resolve.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TextDecoder } from 'node:util';
import oracledb from 'oracledb';
import { instrument } from './instrument.js';
import { firstLine, parseUnit, preprocess, walk as walkTree } from '@plgauge/core';
import { newIds } from './model.js';
import { HITS_TABLE, RUNTIME_BODY, RUNTIME_SPEC } from './runtime.js';

const EXT = /\.(sql|pks|pkb|pkg|tps|tpb|typ|prc|fnc|trg|bdy|spc|plb|pls)$/i;
const UNIT = /^\s*create\s+(?:or\s+replace\s+)?(?:(?:editionable|noneditionable)\s+)?(package\s+body|type\s+body|package|type|procedure|function|trigger)\s+((?:"[^"]+"|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|[\w$#]+))?)/i;

export interface CorpusUnit {
  file: string;
  line: number;
  kind: string;
  name: string;
  text: string;
  latin1: boolean;
}

export interface CorpusResult {
  files: number;
  latin1Files: string[];
  units: { body: number; spec: number };
  parsed: number;
  failures: { unit: string; error: string }[];
  decisions: number;
  conditions: number;
  statements: number;
  gaps: number;
  /** Parser completeness: expression regions the parser could not read fully. */
  opaque: { regions: number; tokens: number; totalTokens: number; samples: { unit: string; line: number; text: string }[] };
  ms: number;
  db?: { originalOk: number; instrumentedOk: number; failures: { unit: string; error: string }[] };
}

/** The SQL and PL/SQL files below dir (.git and node_modules left out). */
export function sqlFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sqlFiles(p, out);
    else if (EXT.test(e)) out.push(p);
  }
  return out;
}

/** Splits a SQL*Plus script into CREATE units ("/" on its own line ends PL/SQL). */
export function extractUnits(file: string, root: string): CorpusUnit[] {
  const buf = readFileSync(file);
  let text: string;
  let latin1 = false;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = buf.toString('latin1');
    latin1 = true;
  }
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const units: CorpusUnit[] = [];
  let cur: { start: number; kind: string; name: string; body: string[] } | null = null;
  const emit = (c: NonNullable<typeof cur>) => units.push({ file: relative(root, file), line: c.start, kind: c.kind, name: c.name, text: c.body.join('\n') + '\n', latin1 });
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (!cur) {
      const m = UNIT.exec(line);
      if (m) cur = { start: k + 1, kind: m[1].toLowerCase().replace(/\s+/g, ' '), name: m[2].replace(/\s+/g, ''), body: [] };
      else continue;
    }
    if (line.trim() === '/') {
      emit(cur);
      cur = null;
      continue;
    }
    cur.body.push(line);
  }
  if (cur && cur.body.join('').trim()) emit(cur);
  return units;
}

const isBody = (u: CorpusUnit) => !['package', 'type'].includes(u.kind);
const idOf = (u: CorpusUnit) => `${u.file}:${u.line} ${u.kind} ${u.name}`;

export async function runCorpus(dirs: string[], db?: { user: string; password: string; connectString: string }): Promise<CorpusResult> {
  const t0 = performance.now();
  const files = dirs.flatMap((d) => sqlFiles(d).map((f) => ({ f, root: d })));
  const units = files.flatMap(({ f, root }) => extractUnits(f, join(root, '..')));
  const res: CorpusResult = {
    files: files.length,
    latin1Files: [...new Set(units.filter((u) => u.latin1).map((u) => u.file))],
    units: { body: units.filter(isBody).length, spec: units.filter((u) => !isBody(u)).length },
    parsed: 0, failures: [], decisions: 0, conditions: 0, statements: 0, gaps: 0, ms: 0,
    opaque: { regions: 0, tokens: 0, totalTokens: 0, samples: [] },
  };
  const instrumented = new Map<CorpusUnit, string>();
  for (const u of units.filter(isBody)) {
    const id = idOf(u);
    try {
      const src = preprocess(u.text);
      const r = instrument(src, 'CORPUS', newIds(), { sqlProbes: true });
      if (r.instrumented.split('\n').length !== u.text.split('\n').length) throw new Error('line count changed');
      res.parsed++;
      res.decisions += r.map.decisions.length;
      res.conditions += r.map.decisions.reduce((a, d) => a + d.conds.length, 0);
      res.statements += r.map.statements.length;
      res.gaps += r.map.gaps.length;
      instrumented.set(u, r.instrumented);
      const p = parseUnit(src);
      res.opaque.totalTokens += p.tokens.length;
      walkTree(p.unit, (n) => {
        if (n.k !== 'opaque' || n.b <= n.a) return;
        res.opaque.regions++;
        res.opaque.tokens += n.b - n.a;
        if (res.opaque.samples.length < 400) {
          const text = p.tokens.slice(n.a, n.b).map((t) => t.text).join(' ');
          res.opaque.samples.push({ unit: id, line: p.tokens[n.a].line, text: text.length > 160 ? text.slice(0, 160) + '…' : text });
        }
        return false;
      });
    } catch (e) {
      res.failures.push({ unit: id, error: (e as Error).message });
    }
  }
  res.ms = performance.now() - t0;
  if (db) res.db = await compileCheck(units, instrumented, db);
  return res;
}

async function compileCheck(units: CorpusUnit[], instrumented: Map<CorpusUnit, string>, db: { user: string; password: string; connectString: string }) {
  const conn = await oracledb.getConnection(db);
  const out = { originalOk: 0, instrumentedOk: 0, failures: [] as { unit: string; error: string }[] };
  const errorsOf = async (u: CorpusUnit) => {
    const last = u.name.split('.').pop()!;
    const name = last.replace(/"/g, '');
    const r = await conn.execute<[number, string]>(
      `select line, text from user_errors where name = :n and type = :t and attribute = 'ERROR' order by sequence`,
      { n: /^".*"$/.test(last) ? name : name.toUpperCase(), t: u.kind.toUpperCase() },
    );
    return r.rows?.length ? r.rows.slice(0, 2).map((x) => `line ${x[0]}: ${x[1].trim().split('\n')[0]}`).join('; ') : null;
  };
  const compile = async (u: CorpusUnit, text: string) => {
    // strip a schema prefix so that everything lands in the corpus schema
    const src = text.replace(UNIT, (m) => m.replace(/(?:"[^"]+"|[\w$#]+)\s*\.\s*(?=(?:"[^"]+"|[\w$#]+)\s*$)/, ''));
    try {
      await conn.execute(src.replace(/\s*$/, ''));
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes('ORA-24344')) return firstLine(msg);
    }
    return errorsOf(u);
  };
  try {
    try { await conn.execute(HITS_TABLE); } catch { /* exists */ }
    await conn.execute(RUNTIME_SPEC);
    await conn.execute(RUNTIME_BODY);
    // pass 1: specs (twice, to settle dependencies between them)
    const specs = units.filter((u) => !isBody(u));
    for (let pass = 0; pass < 2; pass++) for (const u of specs) await compile(u, u.text);
    // pass 2: bodies, original then instrumented
    for (const [u, instr] of instrumented) {
      if (await compile(u, u.text)) continue; // original does not compile here (missing objects) -> not comparable
      out.originalOk++;
      const err = await compile(u, instr);
      if (err) out.failures.push({ unit: idOf(u), error: err });
      else out.instrumentedOk++;
      await compile(u, u.text); // restore
    }
  } finally {
    await conn.close();
  }
  return out;
}
