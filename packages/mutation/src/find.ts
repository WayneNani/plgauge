/**
 * Finds mutation points with the core parser. Successor of the Java finder (IslandSQL):
 * same operators, same heuristics, same output (units, points and loop positions with
 * UTF-8 byte offsets into the file). Where IslandSQL misread the source, this finder
 * follows Oracle: left-associative arithmetic, BETWEEN ... AND and IS OF, cursor
 * attributes, || mixed with + and -. Conditional compilation is resolved with the
 * lexer, so q-quoted strings cannot derail it.
 *
 * Operators: ROR, LCR, AOR (incl. MOD → * and a || b → a), SBR, RET, EXC, NUL, CUR.
 */
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { parse, preprocessBlocks, type Node, type Token } from '@pltest/core';
import type { Loop, Point, SourceFile, Unit } from './mutant.js';

export function findPoints(paths: string[]): SourceFile[] {
  return paths.map((p) => findInFile(p, readFileSync(p)));
}

export function findInFile(path: string, buf: Buffer): SourceFile {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { path, errors: ['keine UTF-8-Datei'], units: [], points: [], loops: [], skipped: 0, src: buf };
  }
  const f = new Finder(path, text);
  return { ...f.run(), src: buf };
}

// ------------------------------------------------------------ preprocessing

const SQLPLUS = /^\s*(SHOW|SHO|SET|PROMPT|PRO|REM|REMARK|WHENEVER|SPOOL|DEFINE|UNDEFINE|COLUMN|COL|TTITLE|BTITLE|PAUSE|CLEAR|EXEC|EXECUTE|CONNECT|CONN|DISCONNECT|EXIT|QUIT|@)(\b|@|$).*/i;
const CREATE = /^\s*CREATE\b.*/i;

const utf8Len = (c: number) => (c < 0x80 ? 1 : c < 0x800 ? 2 : 3);

/**
 * SQL*Plus commands outside CREATE statements become spaces. Like all preprocessing
 * here it keeps every offset (one space per UTF-16 unit), so byte offsets can be taken
 * from the original file.
 */
export function blankSqlPlus(s: string): string {
  let out = '';
  let inUnit = false;
  for (const line of s.split(/(?<=\n)/)) {
    const body = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (!inUnit && CREATE.test(body)) inUnit = true;
    if (body.trim() === '/') {
      inUnit = false;
    } else if (!inUnit && SQLPLUS.test(body)) {
      out += ' '.repeat(body.length) + (line.endsWith('\n') ? '\n' : '');
      continue;
    }
    out += line;
  }
  return out;
}

/**
 * The text the finder parses: SQL*Plus commands blanked, conditional compilation
 * reduced to the last branch of every $IF block (see core preprocess). Returns the
 * $IF block ranges, where no mutants go.
 */
export function prepare(text: string): { text: string; blocks: [number, number][] } {
  const s = blankSqlPlus(text);
  try {
    return preprocessBlocks(s);
  } catch {
    return { text: s, blocks: [] };
  }
}

// ------------------------------------------------------------------ finder

const ROR: Record<string, string[]> = {
  '<': ['<=', '<>', 'FALSE'],
  '<=': ['<', '=', 'TRUE'],
  '>': ['>=', '<>', 'FALSE'],
  '>=': ['>', '=', 'TRUE'],
  '=': ['<=', '>=', 'FALSE'],
  '<>': ['<', '>', 'TRUE'],
};
// x > 0 equals x <> 0 for x >= 0, and so on (gomutant's equivZero tables)
const EQUIV_ZERO_RIGHT: Record<string, string> = { '<>': '>', '=': '<=', '>': '<>', '<=': '=' };
const EQUIV_ZERO_LEFT: Record<string, string> = { '<>': '<', '=': '>=', '<': '<>', '>=': '=' };
const NON_NEGATIVE = /^(LENGTH|LENGTHB|LENGTHC|COUNT|INSTR|INSTRB|ABS|DBMS_LOB\.GETLENGTH|CARDINALITY)\s*\(.*\)$|^[\w$#."]+\.COUNT(\s*\(\s*\))?$|^[\w$#."]+%ROWCOUNT$/is;

const isStringLiteral = (e: string) =>
  (e.length >= 2 && e.startsWith("'") && e.endsWith("'") && e.indexOf("'", 1) === e.length - 1) || /^'([^']|'')*'$/s.test(e);
const isLiteral = (e: string) => isStringLiteral(e) || /^-?\d+(\.\d+)?$/.test(e) || /^(NULL|TRUE|FALSE)$/i.test(e);

/** Statement kinds the SBR operator removes (plus EXIT WHEN). */
const SBR_KINDS = new Set(['assign', 'sql', 'call', 'raise']);

interface Env {
  sub: string;
  ctx: 'plsql' | 'sql';
  /** The enclosing IF branch raises: conditions are checks (category "pruefung"). */
  guard: boolean;
}

class Finder {
  private src: string;
  private blocks: [number, number][];
  private byteAt: Uint32Array;
  private t: Token[] = [];
  private units: Unit[] = [];
  private points: Point[] = [];
  private loops: Loop[] = [];
  private skipped = 0;
  private unit = -1;

  constructor(private path: string, text: string) {
    const r = prepare(text);
    this.src = r.text;
    this.blocks = r.blocks;
    // offsets are kept by the preprocessing: bytes come from the original text
    this.byteAt = new Uint32Array(text.length + 1);
    let b = 0;
    for (let i = 0; i < text.length; i++) {
      this.byteAt[i] = b;
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        this.byteAt[i + 1] = b;
        b += 4;
        i++;
      } else b += utf8Len(c);
    }
    this.byteAt[text.length] = b;
  }

  run(): Omit<SourceFile, 'src'> {
    let parsed;
    try {
      parsed = parse(this.src);
    } catch (e) {
      return { path: this.path, errors: [(e as Error).message], units: [], points: [], loops: [], skipped: 0 };
    }
    this.t = parsed.tokens;
    for (const u of parsed.units) {
      this.unit = this.units.length;
      this.units.push({
        type: u.op!, name: u.name!, start: this.sb(u.a), end: this.eb(u.b - 1),
        decl: u.op === 'PACKAGE BODY' && u.at! >= 0 ? this.eb(u.at!) : -1,
      });
      const env: Env = { sub: u.op === 'PROCEDURE' || u.op === 'FUNCTION' ? '' : '', ctx: 'plsql', guard: false };
      for (const k of u.kids) this.walk(k, null, env);
    }
    return {
      path: this.path,
      errors: parsed.errors.map((e) => `${e.line}:${e.col} ${e.message}`),
      units: this.units, points: this.points, loops: this.loops, skipped: this.skipped,
    };
  }

  // ------------------------------------------------------------- offsets

  /** Byte offset of the start of token k. */
  private sb(k: number): number {
    return this.byteAt[this.t[k].start];
  }
  /** Byte offset right after token k. */
  private eb(k: number): number {
    return this.byteAt[this.t[k].end];
  }
  private text(n: Node): string {
    return this.src.slice(this.t[n.a].start, this.t[n.b - 1].end);
  }
  private inConditional(charIndex: number): boolean {
    return this.blocks.some(([a, b]) => a <= charIndex && charIndex < b);
  }

  private point(op: string, kind: Point['kind'], n: Node, env: Env, ctx: 'plsql' | 'sql', cat: string, mutants: string[]) {
    this.pointSpan(op, kind, n.a, n.b - 1, this.text(n), env, ctx, cat, mutants);
  }

  private pointSpan(op: string, kind: Point['kind'], a: number, last: number, orig: string, env: Env, ctx: 'plsql' | 'sql', cat: string, mutants: string[]) {
    if (this.inConditional(this.t[a].start)) return;
    this.points.push({
      unit: this.unit, op, kind, sub: env.sub, ctx, cat, start: this.sb(a), end: this.eb(last), orig, mutants,
    });
  }

  // ---------------------------------------------------------------- walk

  private walk(n: Node, parent: Node | null, env: Env): void {
    switch (n.k) {
      case 'subprog': {
        const sub = env.sub ? `${env.sub}.${n.name}` : n.name!;
        const inner: Env = { sub, ctx: 'plsql', guard: false };
        for (const k of n.kids) this.walk(k, n, inner);
        const body = n.kids.find((k) => k.k === 'body');
        if (body) this.ret(body, n, inner);
        return;
      }
      case 'cursor': case 'query': case 'sql':
        env = { ...env, ctx: 'sql' };
        break;
      case 'stmt':
        env = { ...env, ctx: 'plsql', guard: false };
        this.stmt(n, env);
        break;
      case 'handler':
        this.exc(n, env);
        break;
      case 'branch':
        if (n.name === 'if') {
          const [cond, seq] = n.kids;
          this.walk(cond, n, { ...env, guard: this.containsRaise(n) });
          this.walk(seq, n, env);
          return;
        }
        break;
      case 'range':
        if (n.name === '') this.curBounds(n, env);
        break;
      case 'cmp':
        this.ror(n, env);
        break;
      case 'logic':
        this.lcr(n, env);
        break;
      case 'bin':
        this.aor(n, parent, env);
        break;
      case 'isnull':
        this.nulCondition(n, env);
        break;
      case 'call':
        this.callOps(n, env);
        break;
      case 'name':
        this.curAttribute(n, env);
        break;
    }
    for (const k of n.kids) this.walk(k, n, env);
  }

  private stmt(n: Node, env: Env) {
    if (n.op === 'loop') {
      const at = this.eb(n.at!);
      if (!this.inConditional(this.t[n.at!].end)) this.loops.push({ unit: this.unit, at });
    }
    // SBR: simple statements; RETURN, NULL and control flow stay
    let cat = '';
    if (n.op === 'raise' || (n.op === 'call' && this.isRaiseCall(n))) cat = 'fehlerpfad';
    if (SBR_KINDS.has(n.op!) || (n.op === 'exit' && n.at! >= 0)) {
      this.point('SBR', 'stmt', n, env, 'plsql', cat, ['NULL;']);
    }
  }

  private isRaiseCall(n: Node): boolean {
    return this.t[n.a].up === 'RAISE_APPLICATION_ERROR';
  }

  /** True if the IF branch (condition and statements) raises. */
  private containsRaise(n: Node): boolean {
    if (n.k === 'stmt' && (n.op === 'raise' || (n.op === 'call' && this.isRaiseCall(n)))) return true;
    return n.kids.some((k) => this.containsRaise(k));
  }

  /** Extreme mutation: the subprogram returns at once (functions return NULL), or fails at once. */
  private ret(body: Node, sp: Node, env: Env) {
    const begin = body.at!;
    if (this.inConditional(this.t[begin].end)) return;
    const at = this.eb(begin);
    const repl = sp.op === 'FUNCTION' ? 'RETURN NULL;' : 'RETURN;';
    this.points.push({
      unit: this.unit, op: 'RET', kind: 'insert', sub: env.sub, ctx: 'plsql', cat: 'funktion', start: at, end: at, orig: '',
      mutants: [` ${repl}`, " RAISE_APPLICATION_ERROR(-20998, 'plmut: RET');"],
    });
  }

  /** EXC: the handler swallows the exception (its statements become NULL). */
  private exc(h: Node, env: Env) {
    const stmts = h.kids[0].kids.filter((k) => k.k === 'stmt' || k.k === 'pragma');
    if (!stmts.length) return;
    if (stmts.length === 1 && (SBR_KINDS.has(stmts[0].op!) || stmts[0].op === 'exit')) return; // same mutant as SBR
    const first = stmts[0];
    const last = stmts[stmts.length - 1];
    const a = first.at2 ?? first.a;
    const body = this.src.slice(this.t[a].start, this.t[last.b - 1].end);
    if (body.replace(/\s+/g, '').toUpperCase() === 'NULL;') return;
    this.pointSpan('EXC', 'stmt', a, last.b - 1, body, env, 'plsql', 'fehlerpfad', ['NULL;']);
  }

  /** Sufficient ROR replacements (Kaminski, Ammann, Offutt), as in gomutant. */
  private ror(c: Node, env: Env) {
    let op = c.op!;
    if (op === '!=' || op === '^=' || op === '~=') op = '<>';
    let repl = ROR[op];
    if (!repl) return;
    const s = this.t[c.a].start;
    const before = this.src.slice(s, this.t[c.at!].start);
    const after = this.src.slice(this.t[c.at!].end, this.t[c.b - 1].end);
    const left = before.trim();
    const right = after.trim();
    if (isLiteral(left) && isLiteral(right)) {
      this.skipped += repl.length; // constant comparison
      return;
    }
    // codes compared with a string literal are categories, not an order
    if ((op === '=' || op === '<>') && (isStringLiteral(left) || isStringLiteral(right))) {
      this.skipped += 1;
      repl = ['TRUE', 'FALSE'];
    }
    let equivalent: string | undefined;
    if (right === '0' && NON_NEGATIVE.test(left)) equivalent = EQUIV_ZERO_RIGHT[op];
    if (left === '0' && NON_NEGATIVE.test(right)) equivalent = EQUIV_ZERO_LEFT[op];
    const mutants: string[] = [];
    for (const r of repl) {
      if (r === equivalent) {
        this.skipped++;
        continue;
      }
      mutants.push(r === 'TRUE' || r === 'FALSE' ? r : before + r + after);
    }
    this.point('ROR', 'bool', c, env, env.ctx, env.guard ? 'pruefung' : '', mutants);
  }

  /** Non-redundant LCR replacements (Just et al.), as in gomutant. */
  private lcr(c: Node, env: Env) {
    const [l, r] = c.kids.map((k) => this.text(k));
    const mutants = c.op === 'AND' ? [l, r, `(${l}) = (${r})`, 'FALSE'] : [l, r, `(${l}) <> (${r})`, 'TRUE'];
    // v = A OR v = B with different constants cannot both hold: <> equals OR
    if (c.op === 'OR' && this.exclusiveEquals(c.kids[0], c.kids[1])) {
      mutants.splice(2, 1);
      this.skipped++;
    }
    this.point('LCR', 'bool', c, env, env.ctx, env.guard ? 'pruefung' : '', mutants);
  }

  private exclusiveEquals(x: Node, y: Node): boolean {
    const a = this.equalsParts(x);
    const b = this.equalsParts(y);
    return !!a && !!b && a[0].toUpperCase() === b[0].toUpperCase() && isLiteral(a[1]) && isLiteral(b[1]) && a[1] !== b[1];
  }

  private equalsParts(e: Node): [string, string] | null {
    if (e.k !== 'cmp' || e.op !== '=') return null;
    const l = this.text(e.kids[0]).trim();
    const r = this.text(e.kids[1]).trim();
    if (isLiteral(r)) return [l, r];
    if (isLiteral(l)) return [r, l];
    return null;
  }

  /**
   * AOR: + and - swap, * and / swap; a || b becomes a. Operators of one level
   * evaluate left to right, so the k-th operator's point covers operands 0..k.
   * || shares its level with + and -; a mixed chain gets no || mutants.
   */
  private aor(n: Node, parent: Node | null, env: Env) {
    const level = (op?: string) => (op === '+' || op === '-' || op === '||' ? 1 : op === '*' || op === '/' ? 2 : 0);
    const lv = level(n.op);
    if (!lv) return;
    if (parent?.k === 'bin' && level(parent.op) === lv && parent.kids[0] === n) return; // not the root of the chain
    const operands: Node[] = [];
    const ops: number[] = [];
    const flatten = (x: Node) => {
      if (x.k === 'bin' && level(x.op) === lv) {
        flatten(x.kids[0]);
        ops.push(x.at!);
        operands.push(x.kids[1]);
      } else operands.push(x);
    };
    flatten(n);
    const mixed = ops.some((o) => this.t[o].text === '||') && ops.some((o) => this.t[o].text !== '||');
    const a = operands[0].a;
    for (let k = 0; k < ops.length; k++) {
      const op = this.t[ops[k]];
      const last = operands[k + 1].b - 1;
      const span = this.src.slice(this.t[a].start, this.t[last].end);
      if (op.text === '||') {
        if (mixed) continue;
        const left = this.src.slice(this.t[a].start, this.t[operands[k].b - 1].end);
        this.pointSpan('AOR', 'value', a, last, span, env, env.ctx, '', [left]);
        continue;
      }
      const swapped = op.text === '+' ? '-' : op.text === '-' ? '+' : op.text === '*' ? '/' : '*';
      const o = op.start - this.t[a].start;
      this.pointSpan('AOR', 'value', a, last, span, env, env.ctx, '', [span.slice(0, o) + swapped + span.slice(o + 1)]);
    }
  }

  /** NUL: IS NULL and IS NOT NULL swap. */
  private nulCondition(c: Node, env: Env) {
    const s = this.t[c.a].start;
    const e = this.t[c.b - 1].end;
    let m: string;
    if (c.at2! >= 0) {
      const not = this.t[c.at2!];
      let ne = not.end;
      while (ne < e && /\s/.test(this.src[ne])) ne++;
      m = this.src.slice(s, not.start) + this.src.slice(ne, e);
    } else {
      const ie = this.t[c.at!].end;
      m = `${this.src.slice(s, ie)} NOT${this.src.slice(ie, e)}`;
    }
    this.point('NUL', 'bool', c, env, env.ctx, env.guard ? 'pruefung' : '', [m]);
  }

  /** NVL(a, b) gives a or b; COALESCE drops its first argument or keeps only it; MOD(a, b) becomes a * b. */
  private callOps(f: Node, env: Env) {
    const name = f.name;
    if (!name) return;
    const args = f.kids.filter((k) => k.k === 'arg');
    if (args.some((x) => x.name)) return; // named arguments
    const texts = args.map((x) => this.text(x).trim());
    if (name === 'MOD') {
      if (texts.length === 2) this.point('AOR', 'value', f, env, env.ctx, '', [`(${texts[0]}) * (${texts[1]})`]);
      return;
    }
    if (name !== 'NVL' && name !== 'COALESCE') return;
    if (texts.length < 2 || (name === 'NVL' && texts.length !== 2)) return;
    const mutants = [texts[0], texts.length === 2 ? texts[1] : `${this.t[f.a].text}(${texts.slice(1).join(', ')})`];
    this.point('NUL', 'value', f, env, env.ctx, '', mutants);
  }

  /** CUR: cursor%FOUND and %NOTFOUND swap. */
  private curAttribute(n: Node, env: Env) {
    if (n.at === undefined || n.at < 0 || n.at + 1 !== n.b - 1) return;
    const attr = this.t[n.at + 1].up;
    const swapped = attr === 'FOUND' ? 'NOTFOUND' : attr === 'NOTFOUND' ? 'FOUND' : null;
    if (!swapped) return;
    const cursor = this.src.slice(this.t[n.a].start, this.t[n.at - 1].end);
    this.point('CUR', 'bool', n, env, 'plsql', '', [`${cursor}%${swapped}`]);
  }

  /** CUR: a FOR loop loses its first or its last iteration. */
  private curBounds(r: Node, env: Env) {
    const [lo, hi] = r.kids;
    if (lo.a >= lo.b || hi.a >= hi.b) return;
    this.point('CUR', 'value', lo, env, 'plsql', '', [`(${this.text(lo)}) + 1`]);
    this.point('CUR', 'value', hi, env, 'plsql', '', [`(${this.text(hi)}) - 1`]);
  }
}
