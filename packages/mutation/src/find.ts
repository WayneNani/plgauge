/**
 * Finds mutation points with the core parser. Successor of the Java finder (IslandSQL):
 * same operators, same heuristics, same output (units, points and loop positions with
 * UTF-8 byte offsets into the file). Where IslandSQL misread the source, this finder
 * follows Oracle: left-associative arithmetic, BETWEEN ... AND and IS OF, cursor
 * attributes, || mixed with + and -. Conditional compilation is resolved with the
 * lexer, so q-quoted strings cannot derail it.
 *
 * Operators of stage 1: ROR, LCR, AOR (incl. MOD → * and a || b → a), SBR, RET, EXC, NUL, CUR.
 * Stage 2, SQL only: SEL, JOI, ORD, UNI, AGR, SUB, WHR, COL (see SQL_OPERATORS).
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

/** The operators of stage 1 (PL/SQL and SQL expressions), as in plmut. */
export const STAGE1_OPERATORS = ['ROR', 'LCR', 'AOR', 'SBR', 'RET', 'EXC', 'NUL', 'CUR'];

/**
 * Stage 2: SQL operators after Tuya, Suárez-Cabal and de la Riva ("Mutating database
 * queries", 2007), reduced to variants that rarely are equivalent:
 *
 *   SEL  DISTINCT/UNIQUE removed; FETCH FIRST … removed (row limit)
 *   JOI  LEFT/RIGHT/FULL JOIN → JOIN; [INNER] JOIN → LEFT JOIN; (+) removed
 *   ORD  ORDER BY: every item ASC ↔ DESC (also in OVER and WITHIN GROUP)
 *   UNI  UNION ↔ UNION ALL; INTERSECT ↔ MINUS/EXCEPT
 *   AGR  MIN ↔ MAX; SUM ↔ AVG; COUNT(DISTINCT x) → COUNT(x); COUNT(x) → COUNT(*)
 *   SUB  EXISTS ↔ NOT EXISTS; IN (subquery) ↔ NOT IN
 *   WHR  WHERE/HAVING condition → TRUE (filter dropped)
 *   COL  UPDATE SET: one assignment dropped; INSERT: one column with its value dropped
 */
export const SQL_OPERATORS = ['SEL', 'JOI', 'ORD', 'UNI', 'AGR', 'SUB', 'WHR', 'COL'];

/** Statement kinds the SBR operator removes (plus EXIT WHEN). */
const SBR_KINDS = new Set(['assign', 'sql', 'call', 'raise']);

interface Env {
  sub: string;
  ctx: 'plsql' | 'sql';
  /** The enclosing IF branch raises: conditions are checks (category "pruefung"). */
  guard: boolean;
  /** Byte range of the enclosing PL/SQL statement with static SQL (for clause points). */
  scope?: [number, number];
  /** Index variable of the enclosing FORALL (upper case). */
  forall?: string;
  /** Inside a view's query. */
  view?: boolean;
  /** Inside a query block the schema switches with UNION ALL branches (views, cursor declarations). */
  union?: boolean;
  /** In a select list (of the innermost query): a switch there cannot change the plan. */
  proj?: boolean;
}

/** A place where a string becomes SQL: a literal, or a variable holding one (see Finder.dynamicSql). */
interface Sink {
  tok: number;
  sub: string;
  /** Token range of the enclosing subprogram (or unit), where a variable's literal is searched. */
  range: [number, number];
}

/** Statements the schema rewriter may duplicate to switch a clause point. */
const SCOPE_STMTS = new Set(['sql', 'forall', 'open']);
const ORDER_END = new Set(['FETCH', 'OFFSET', 'FOR', 'ROWS', 'RANGE', 'GROUPS', 'UNION', 'INTERSECT', 'MINUS', 'EXCEPT', 'LIMIT']);
const SET_END = new Set(['WHERE', 'RETURNING', 'RETURN', 'LOG', 'DELETE', 'WHEN']);
const AGGREGATE_SWAP: Record<string, string> = { MIN: 'MAX', MAX: 'MIN', SUM: 'AVG', AVG: 'SUM' };

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
  /** Dynamic SQL of the current unit: EXECUTE IMMEDIATE, OPEN … FOR, DBMS_SQL.PARSE with a literal or variable. */
  private sinks: Sink[] = [];
  /** Token range of the innermost subprogram being walked. */
  private range: [number, number] = [0, 0];

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
      parsed = parse(this.src, { views: true });
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
      const env: Env = { sub: '', ctx: 'plsql', guard: false };
      this.sinks = [];
      this.range = [u.a, u.b];
      // a view's query is its own scope: the schema switches it with one UNION ALL branch per variant
      if (u.op === 'VIEW') {
        env.view = true;
        env.union = true;
        const ins = this.inlineHints(u);
        if (ins.length) this.units[this.unit].inserts = ins;
        this.units[this.unit].main = this.blockRange(u.kids[0]);
        this.units[this.unit].ordered = this.ordered(u.kids[0]);
      }
      for (const k of u.kids) this.walk(k, null, env);
      this.dynamicSql();
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
    const p: Point = { unit: this.unit, op, kind, sub: env.sub, ctx, cat, start: this.sb(a), end: this.eb(last), orig, mutants };
    // SQL inside a PL/SQL statement: the schema switches it by duplicating the statement
    if ((kind === 'clause' || ctx === 'sql') && env.scope) {
      p.scope = env.scope;
      if (env.union) p.union = true;
    }
    if (env.union && env.proj && ctx === 'sql' && (kind === 'bool' || kind === 'value')) p.inline = true;
    this.points.push(p);
  }

  // ---------------------------------------------------------------- walk

  private walk(n: Node, parent: Node | null, env: Env): void {
    switch (n.k) {
      case 'subprog': {
        const sub = env.sub ? `${env.sub}.${n.name}` : n.name!;
        const inner: Env = { sub, ctx: 'plsql', guard: false };
        const outer = this.range;
        this.range = [n.a, n.b];
        for (const k of n.kids) this.walk(k, n, inner);
        this.range = outer;
        const body = n.kids.find((k) => k.k === 'body');
        if (body) this.ret(body, n, inner);
        return;
      }
      case 'cursor': {
        // the query of a cursor declaration: one UNION ALL block, if its order and locks allow
        // (parameter defaults are PL/SQL expressions outside it)
        for (const k of n.kids) {
          if (k.k !== 'query') this.walk(k, n, { ...env, ctx: 'plsql', scope: undefined, union: false });
          else this.walk(k, n, { ...env, ctx: 'sql', ...(this.cursorBlock(k) ? { scope: this.blockRange(k), union: true } : { scope: undefined, union: false }) });
        }
        return;
      }
      case 'query': case 'sql':
        env = { ...env, ctx: 'sql' };
        if (env.view && n.k === 'query') {
          // an ordered subquery stays inside its block: wrapped, its order (ROWNUM top-N) would not hold
          if (this.viewBlock(n, parent) && (!parent || !this.ordered(n))) env.scope = this.blockRange(n);
          // a recursive WITH element is no block, and it lies outside the main query's block
          else if (env.scope && !(env.scope[0] <= this.sb(n.a) && this.eb(n.b - 1) <= env.scope[1])) env.scope = undefined;
        }
        this.sqlClauses(n, parent, env);
        break;
      case 'stmt':
        env = {
          ...env, ctx: 'plsql', guard: false, union: false,
          // a cursor FOR loop over a query: the loop is duplicated, body and all
          scope: SCOPE_STMTS.has(n.op!) || (n.op === 'loop' && n.name === 'cursor-for' && n.kids[0]?.k === 'query') ? [this.sb(n.a), this.eb(n.b - 1)] : undefined,
          forall: n.op === 'forall' ? this.t[n.a + 1]?.up : undefined,
        };
        this.stmt(n, env);
        this.sink(n, env);
        break;
      case 'not':
        if (env.ctx === 'sql' && n.kids.length === 1 && n.kids[0].k === 'pred' && n.kids[0].op === 'EXISTS') {
          this.point('SUB', 'bool', n, env, 'sql', '', [this.text(n.kids[0])]);
        }
        break;
      case 'pred':
        if (env.ctx === 'sql') this.sub(n, parent, env);
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
    if (n.k === 'sql' || n.k === 'query') {
      // only UNION ALL blocks (views, cursor declarations) switch select-list points in place
      const lists = env.union ? this.selectLists(n) : [];
      for (const k of n.kids) this.walk(k, n, { ...env, proj: lists.some(([a, b]) => a <= k.a && k.b <= b) });
      this.whr(n, { ...env, proj: false });
      return;
    }
    for (const k of n.kids) this.walk(k, n, env);
  }

  /**
   * Cursor declarations: the query becomes one UNION ALL block (see schema.ts) unless it ends
   * in ORDER BY (wrapped, the order would no longer be guaranteed), locks rows (FOR UPDATE
   * cannot be wrapped) or starts with WITH (copies would reference its elements more often,
   * and Oracle would materialize them in front of every branch).
   */
  private cursorBlock(q: Node): boolean {
    let a = q.a;
    if (this.t[a].text === '(' && this.close(a) === q.b - 1) a++;
    if (this.t[a].up !== 'SELECT' || this.ordered(q)) return false;
    for (let k = a; k < q.b; k++) {
      if (this.t[k].text === '(') k = this.close(k);
      else if (this.t[k].up === 'FOR' && this.t[k + 1]?.up === 'UPDATE') return false;
    }
    return true;
  }

  // -------------------------------------------------------- dynamic SQL

  /** Notes where a statement passes a string to the SQL engine: EXECUTE IMMEDIATE, OPEN … FOR, DBMS_SQL.PARSE. */
  private sink(n: Node, env: Env) {
    let a = -1;
    let b = -1;
    if (n.op === 'exec' || (n.op === 'open' && n.kids[0]?.k !== 'query' && this.t[n.kids[0]?.a - 1]?.up === 'FOR')) {
      a = n.kids[0].a;
      b = n.kids[0].b;
    } else if (n.op === 'call') {
      // [SYS.]DBMS_SQL.PARSE(c, statement, …)
      let k = n.a;
      if (this.t[k].up === 'SYS' && this.t[k + 1]?.text === '.') k += 2;
      if (this.t[k].up !== 'DBMS_SQL' || this.t[k + 1]?.text !== '.' || this.t[k + 2]?.up !== 'PARSE' || this.t[k + 3]?.text !== '(') return;
      const open = k + 3;
      const close = this.close(open);
      let j = open + 1;
      while (j < close && this.t[j].text !== ',') j = this.t[j].text === '(' ? this.close(j) + 1 : j + 1;
      a = j + 1;
      b = a;
      while (b < close && this.t[b].text !== ',') b = this.t[b].text === '(' ? this.close(b) + 1 : b + 1;
      if (this.t[a]?.text.startsWith('=')) return; // named notation: not worth the trouble
    }
    // (x) is x
    while (a >= 0 && b - a > 2 && this.t[a].text === '(' && this.close(a) === b - 1) {
      a++;
      b--;
    }
    if (a < 0 || b !== a + 1) return; // a single token: a literal or a variable
    if (this.t[a].kind === 'string' || this.t[a].kind === 'ident') this.sinks.push({ tok: a, sub: env.sub, range: this.range });
  }

  /**
   * Dynamic SQL: string literals that reach a sink, directly or through a variable declared
   * in the subprogram that only ever holds whole literals (see varLiterals). The literal's
   * text is parsed as SQL and mutated like static SQL; a mutant is the literal with one change
   * (quotes doubled again). The schema switches the whole literal in place (point.dyn): every
   * variant is its own statement, parsed when executed, so no plan suffers.
   */
  private dynamicSql() {
    const lits = new Map<number, { sub: string; max?: number }>();
    const sinks = new Set(this.sinks.map((s) => s.tok));
    for (const s of this.sinks) {
      if (this.t[s.tok].kind === 'string') {
        lits.set(s.tok, { sub: s.sub });
        continue;
      }
      const v = this.varLiterals(this.t[s.tok].up, s.range, sinks);
      if (!v) continue;
      for (const k of v.lits) {
        const max = Math.min(lits.get(k)?.max ?? Infinity, v.max ?? Infinity);
        lits.set(k, { sub: s.sub, max: Number.isFinite(max) ? max : undefined });
      }
    }
    for (const [k, l] of [...lits].sort((x, y) => x[0] - y[0])) this.literal(k, l.sub, l.max);
  }

  /**
   * The literals a variable holds as whole statements: declared in the range, every other
   * occurrence an assignment (name := …; a literal is noted, any other value replaces it), a
   * sink or a read in a concatenation. A variable built from itself (l_sql := l_sql || …,
   * replace(l_sql, …)), passed to a procedure (an OUT parameter) or fetched into holds a
   * statement the literal is only part of: mutated alone, a fragment would break where the
   * whole statement does not. max: the declared length (VARCHAR2(n)), which a variant must not exceed.
   */
  private varLiterals(name: string, range: [number, number], sinks: Set<number>): { lits: number[]; max?: number } | undefined {
    const lits: number[] = [];
    let declared = false;
    let max: number | undefined;
    const starts = new Set(['IS', 'AS', 'BEGIN', 'THEN', 'ELSE', 'LOOP', 'DECLARE']);
    for (let k = range[0]; k < range[1]; k++) {
      const t = this.t[k];
      if (t.kind !== 'ident' || t.up !== name || this.t[k - 1]?.text === '.') continue;
      if (this.t[k + 1]?.text === '.' || this.t[k + 1]?.text === '(') return undefined; // a record, a collection
      if (sinks.has(k)) continue;
      const prev = this.t[k - 1];
      const atStart = !prev || prev.text === ';' || starts.has(prev.up);
      if (atStart && this.t[k + 1]?.text === ':=') {
        if (this.t[k + 2]?.kind === 'string' && this.t[k + 3]?.text === ';') {
          lits.push(k + 2);
          k += 3;
          continue;
        }
        // another value replaces the literal; one built from the variable itself (v := v || …, replace(v, …)) does not
        const e = this.rhsEnd(k + 2, range[1]);
        if (this.mentions(name, k + 2, e)) return undefined;
        k = e;
        continue;
      }
      if (atStart && !declared && this.t[k + 1]?.kind === 'ident') {
        // name [CONSTANT] type[(n [BYTE|CHAR])] [NOT NULL] [:= | DEFAULT literal];
        let e = k + 1;
        if (this.t[e].up === 'CONSTANT') e++;
        // other types (a subtype, %TYPE) give no length to check
        if (['VARCHAR2', 'VARCHAR', 'NVARCHAR2'].includes(this.t[e]?.up) && this.t[e + 1]?.text === '(' && this.t[e + 2]?.kind === 'number') {
          const n = Number(this.t[e + 2].text);
          // BYTE (the default semantics) is checked in bytes, CHAR and NVARCHAR2 in characters
          const chars = this.t[e + 3]?.up === 'CHAR' || this.t[e].up === 'NVARCHAR2';
          max = chars ? -n : n;
        }
        while (e < range[1] && this.t[e].text !== ';' && this.t[e].text !== ':=' && this.t[e].up !== 'DEFAULT') e = this.t[e].text === '(' ? this.close(e) + 1 : e + 1;
        declared = true;
        if (this.t[e]?.text === ';') {
          k = e;
          continue;
        }
        if (this.t[e + 1]?.kind === 'string' && this.t[e + 2]?.text === ';') {
          lits.push(e + 1);
          k = e + 2;
        } else k = this.rhsEnd(e + 1, range[1]);
        continue;
      }
      // read in a concatenation for a call (logging); one that builds another statement would
      // carry the literal as a fragment (other := name || ' where …')
      if (prev?.text === '||' || this.t[k + 1]?.text === '||') {
        let j = k - 1;
        while (j > range[0] && this.t[j].text !== ';' && !starts.has(this.t[j].up)) j--;
        if (this.t[j + 2]?.text === ':=' || this.t[j + 1]?.up === 'RETURN') return undefined;
        continue;
      }
      return undefined;
    }
    return declared && lits.length ? { lits, max } : undefined;
  }

  /** The semicolon that ends an expression starting at a. */
  private rhsEnd(a: number, end: number): number {
    let e = a;
    while (e < end && this.t[e].text !== ';') e = this.t[e].text === '(' ? this.close(e) + 1 : e + 1;
    return e;
  }

  /** Whether the variable name occurs in [a, b) (not as a member: x.name). */
  private mentions(name: string, a: number, b: number): boolean {
    for (let k = a; k < b; k++) if (this.t[k].kind === 'ident' && this.t[k].up === name && this.t[k - 1]?.text !== '.') return true;
    return false;
  }

  /** max: the variable's declared length; bytes if positive, characters if negative (see varLiterals). */
  private literal(k: number, sub: string, max?: number) {
    const tok = this.t[k];
    if (this.inConditional(tok.start)) return;
    const s = this.src.slice(tok.start, tok.end);
    const q = /^n?q'(.)/i.exec(s);
    let content = '';
    const map: number[] = [];
    let closing = '';
    if (q) {
      const open = q[1];
      closing = ({ '[': ']', '{': '}', '<': '>', '(': ')' } as Record<string, string>)[open] ?? open;
      if (!s.endsWith(`${closing}'`)) return;
      const from = tok.start + q[0].length;
      const to = tok.end - 2;
      content = this.src.slice(from, to);
      for (let i = 0; i <= content.length; i++) map.push(from + i);
    } else {
      const p = /^n?'/i.exec(s);
      if (!p) return;
      const from = tok.start + p[0].length;
      const to = tok.end - 1;
      for (let i = from; i < to; i++) {
        map.push(i);
        content += this.src[i];
        if (this.src[i] === "'") i++; // '' stands for '
      }
      map.push(to);
    }
    let prefix: string;
    if (/^\s*\(?\s*(SELECT|WITH)\b/i.test(content)) prefix = 'OPEN plmut$c FOR ';
    else if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(content)) prefix = '';
    else return;
    if (/;\s*$/.test(content)) return;
    const head = `CREATE PROCEDURE plmut$dyn IS BEGIN\n${prefix}`;
    const text = `${head}${content};\nEND;\n`;
    const inner = new Finder(this.path, text).run();
    if (inner.errors.length || inner.units.length !== 1) return;
    const buf = Buffer.from(text, 'utf8');
    const from = Buffer.byteLength(head);
    const to = from + Buffer.byteLength(content);
    const at = (byte: number) => map[buf.subarray(from, byte).toString('utf8').length];
    const escape = (m: string) => (q ? m : m.replaceAll("'", "''"));
    this.skipped += inner.skipped;
    for (const p of inner.points) {
      if (p.start < from || p.end > to || p.kind === 'insert' || p.kind === 'stmt') continue;
      const a = at(p.start);
      const b = at(p.end);
      const orig = buf.subarray(p.start, p.end).toString('utf8');
      // a variant longer than the variable would fail with ORA-06502 before reaching SQL
      const fits = (m: string) => max === undefined
        || (max > 0 ? Buffer.byteLength(content) - (p.end - p.start) + Buffer.byteLength(m) <= max : content.length - orig.length + m.length <= -max);
      const mutants = p.mutants.filter(fits).map(escape).filter((m) => !q || !m.includes(`${closing}'`));
      if (!mutants.length) continue;
      this.points.push({
        unit: this.unit, op: p.op, kind: p.kind, sub, ctx: 'sql', cat: p.cat,
        start: this.byteAt[a], end: this.byteAt[b], orig: this.src.slice(a, b), mutants,
        dyn: [this.sb(k), this.eb(k)],
      });
    }
  }

  /**
   * Views: the query blocks the schema switches with UNION ALL — the view's query, WITH
   * elements and inline views in FROM. Subqueries in conditions and select lists stay
   * inside their block: wrapped they could no longer be unnested into joins.
   */
  private viewBlock(q: Node, parent: Node | null): boolean {
    if (!parent) return true;
    if (!['SELECT', 'WITH'].includes(this.t[q.a].up) || this.t[q.a - 1]?.text !== '(') return false;
    // a WITH element with a column list may be recursive: anchor UNION ALL recursive member
    // must stay its top level (ORA-32040)
    if (this.t[q.a - 2]?.up === 'AS' && this.t[q.a - 3]?.text === ')') return false;
    return ['FROM', 'JOIN', ',', 'AS'].includes(this.t[q.a - 2]?.up ?? '');
  }

  /**
   * Views: INLINE hints for the WITH elements the view references once (see Unit.inserts).
   * An element with a column list may be recursive and is never inlined; a hint of the
   * author's own (INLINE, MATERIALIZE) wins.
   */
  private inlineHints(u: Node): { at: number; text: string; block: number }[] {
    const out: { at: number; text: string; block: number }[] = [];
    for (let k = u.a; k < u.b; k++) {
      if (this.t[k].up !== 'WITH' || this.t[k].kind !== 'ident') continue;
      // elements: name AS ( query ) [, …]
      let e = k + 1;
      while (this.t[e]?.kind === 'ident') {
        const name = this.t[e].up;
        const cols = this.t[e + 1]?.text === '(';
        const as = cols ? this.close(e + 1) + 1 : e + 1;
        if (this.t[as]?.up !== 'AS' || this.t[as + 1]?.text !== '(') break;
        const open = as + 1;
        const close = this.close(open);
        const sel = open + 1;
        let refs = 0;
        for (let j = close + 1; j < u.b; j++) {
          // d in FROM d, not d.x (a column of d) or f(…)
          if (this.t[j].up === name && this.t[j].kind === 'ident' && this.t[j - 1]?.text !== '.' && !['(', '.'].includes(this.t[j + 1]?.text)) refs++;
        }
        if (!cols && refs === 1 && this.t[sel].up === 'SELECT') {
          const after = this.src.slice(this.t[sel].end, this.t[sel + 1]?.start ?? this.t[sel].end);
          const hint = /^\s*(\/\*\+|--\+)/.exec(after);
          if (!/\b(INLINE|MATERIALIZE)\b/i.test(after)) {
            if (!hint) out.push({ at: this.eb(sel), text: ' /*+ INLINE */', block: this.sb(sel) });
            else if (hint[1] === '/*+') out.push({ at: this.byteAt[this.t[sel].end + hint[0].length], text: ' INLINE', block: this.sb(sel) });
          }
        }
        // SEARCH … SET … and CYCLE … of a recursive element come before the comma
        const element = (c: number) => {
          if (this.t[c + 1]?.kind !== 'ident') return false;
          const a = this.t[c + 2]?.text === '(' ? this.close(c + 2) + 1 : c + 2;
          return this.t[a]?.up === 'AS' && this.t[a + 1]?.text === '(';
        };
        let j = close + 1;
        while (j < u.b && !(this.t[j].text === ',' && element(j)) && this.t[j].up !== 'SELECT') j = this.t[j].text === '(' ? this.close(j) + 1 : j + 1;
        if (this.t[j]?.text !== ',') break;
        e = j + 1;
      }
    }
    return out;
  }

  /** ORDER BY at the top level of a query's main part (not in OVER, subqueries or WITH elements). */
  private ordered(q: Node): boolean {
    let a = q.a;
    let last = q.b - 1;
    if (this.t[a].text === '(' && this.close(a) === last) {
      a++;
      last--;
    }
    for (let k = a; k <= last; k++) {
      if (this.t[k].text === '(') k = this.close(k);
      else if (this.t[k].up === 'ORDER' && this.t[k].kind === 'ident' && ['BY', 'SIBLINGS'].includes(this.t[k + 1]?.up)) return true;
    }
    return false;
  }

  /** Byte range of a view block: without enclosing parentheses, a WITH query from its main SELECT on. */
  private blockRange(q: Node): [number, number] {
    let a = q.a;
    let last = q.b - 1;
    if (this.t[a].text === '(' && this.close(a) === last) {
      a++;
      last--;
    }
    if (this.t[a].up === 'WITH') {
      for (let k = a + 1; k <= last; k++) {
        if (this.t[k].text === '(') k = this.close(k);
        else if (this.t[k].up === 'SELECT') {
          a = k;
          break;
        }
      }
    }
    return [this.sb(a), this.eb(last)];
  }

  /** Token ranges [a, b) of the select lists of a query (its own, not those of nested queries). */
  private selectLists(q: Node): [number, number][] {
    const nested = q.kids.filter((k) => k.k === 'query' || k.k === 'sql');
    const out: [number, number][] = [];
    let d = 0;
    let start = -1;
    for (let k = q.a; k < q.b; k++) {
      const r = nested.find((x) => x.a <= k && k < x.b);
      if (r) {
        k = r.b - 1;
        continue;
      }
      const x = this.t[k];
      if (x.kind === 'op' && x.text === '(') d++;
      else if (x.kind === 'op' && x.text === ')') d--;
      else if (x.kind === 'ident' && d === (this.t[q.a].text === '(' ? 1 : 0)) {
        if (x.up === 'SELECT') start = k + 1;
        else if (start >= 0 && ['FROM', 'INTO', 'BULK'].includes(x.up)) {
          out.push([start, k]);
          start = -1;
        }
      }
    }
    return out;
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
    const level = (op?: string) => (op === '+' || op === '-' || op === '||' ? 1 : op === '*' || op === '/' || op === 'MOD' ? 2 : 0);
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
      // n MOD m becomes n * m, as for the function MOD(n, m)
      const swapped = op.text === '+' ? '-' : op.text === '-' ? '+' : op.text === '*' ? '/' : '*';
      const o = op.start - this.t[a].start;
      this.pointSpan('AOR', 'value', a, last, span, env, env.ctx, '', [span.slice(0, o) + swapped + span.slice(o + op.text.length)]);
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
    if (env.ctx === 'sql' && this.t[f.a].up === name && this.t[f.a + 1]?.text === '(') this.agr(f, name, args, texts, env);
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

  // ------------------------------------------------------- SQL (stage 2)

  /** Index of the token closing the parenthesis at k. */
  private close(k: number): number {
    let d = 0;
    for (let i = k; i < this.t.length; i++) {
      const x = this.t[i];
      if (x.kind !== 'op') continue;
      if (x.text === '(') d++;
      else if (x.text === ')' && --d === 0) return i;
    }
    return this.t.length - 1;
  }

  private span(a: number, last: number): string {
    return this.src.slice(this.t[a].start, this.t[last].end);
  }

  /**
   * Clause operators on the tokens of one query or SQL statement, without the tokens of
   * nested queries (they get their own call).
   */
  private sqlClauses(q: Node, parent: Node | null, env: Env) {
    const nested: [number, number][] = [];
    const collect = (x: Node) => {
      for (const k of x.kids) {
        if (k.k === 'query' || k.k === 'sql') nested.push([k.a, k.b]);
        else collect(k);
      }
    };
    collect(q);
    let from = q.a;
    let to = q.b;
    if (this.t[from].text === '(' && this.close(from) === to - 1) {
      from++;
      to--;
    }
    const own: number[] = [];
    const depth: number[] = [];
    let d = 0;
    for (let k = from; k < to; k++) {
      const r = nested.find(([a, b]) => a <= k && k < b);
      if (r) {
        k = r[1] - 1;
        continue;
      }
      const x = this.t[k];
      if (x.kind === 'op' && x.text === ')') d--;
      own.push(k);
      depth.push(d);
      if (x.kind === 'op' && x.text === '(') d++;
    }
    const up = (i: number) => (i >= 0 && i < own.length ? (this.t[own[i]].kind === 'op' ? this.t[own[i]].text : this.t[own[i]].up) : '');
    // a subquery of IN or EXISTS: duplicates and order do not matter
    const member = parent?.k === 'pred' && (parent.op === 'IN' || parent.op === 'EXISTS');
    const top = own.map((_, i) => i).filter((i) => depth[i] === 0);
    const has = (w: string) => top.some((i) => up(i) === w);
    const fetch = top.some((i) => up(i) === 'FETCH' && ['FIRST', 'NEXT'].includes(up(i + 1)));
    const singleRow = q.k === 'sql' && (q.op === 'SELECT' || q.op === 'WITH') && has('INTO') && !has('BULK');
    // body of a WITH element with a column list: may be recursive, and then needs UNION ALL (ORA-32040)
    const b0 = this.t[q.a].text === '(' ? q.a : q.a - 1;
    const recursive = this.t[b0]?.text === '(' && this.t[b0 - 1]?.up === 'AS' && this.t[b0 - 2]?.text === ')';
    const clause = (op: string, i: number, j: number, mutants: string[]) =>
      this.pointSpan(op, 'clause', own[i], own[j], this.span(own[i], own[j]), env, 'sql', '', mutants);
    /** Items of a comma list from own index i while depth is dd, up to a stop word. */
    const items = (i: number, dd: number, stop: Set<string>): [number, number][] => {
      const out: [number, number][] = [];
      let s = i;
      let j = i;
      for (; j < own.length; j++) {
        if (depth[j] < dd || (depth[j] === dd && (stop.has(up(j)) || up(j) === ';'))) break;
        if (depth[j] === dd && up(j) === ',') {
          out.push([s, j - 1]);
          s = j + 1;
        }
      }
      out.push([s, j - 1]);
      return out.filter(([a, b]) => a <= b);
    };
    const JOIN_WORDS = new Set(['ON', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'NATURAL', 'WHERE', 'PARTITION', 'OUTER', 'GROUP', 'ORDER', ')', ',', ';', '']);
    /** Alias (or table name) of the table joined at own index k, upper case; '' if unknown. */
    const joinedAlias = (k: number): string => {
      let name = '';
      if (up(k) === '(') {
        let j = k + 1;
        while (j < own.length && !(up(j) === ')' && depth[j] === depth[k])) j++;
        k = j + 1;
      } else {
        while (k < own.length && this.t[own[k]].kind !== 'op') {
          name = up(k);
          if (up(k + 1) !== '.') break;
          k += 2;
        }
        k++;
      }
      const al = up(k);
      return al && this.t[own[k]].kind !== 'op' && !JOIN_WORDS.has(al) ? al : name;
    };
    const dropOne = (list: [number, number][]) =>
      list.map((_, k) => list.filter((__, m) => m !== k).map(([a, b]) => this.span(own[a], own[b])).join(', '));

    for (let i = 0; i < own.length; i++) {
      const w = up(i);
      switch (w) {
        case 'SELECT':
          if (up(i + 1) === 'DISTINCT' || up(i + 1) === 'UNIQUE') {
            if (member) this.skipped++;
            else clause('SEL', i + 1, i + 1, ['']);
          }
          break;
        case 'FETCH':
          if (up(i + 1) === 'FIRST' || up(i + 1) === 'NEXT') {
            let j = i + 2;
            while (j < own.length && depth[j] >= depth[i] && up(j) !== 'ONLY' && up(j) !== 'TIES') j++;
            if (j < own.length && depth[j] === depth[i]) clause('SEL', i, j, ['']);
          }
          break;
        case 'JOIN': {
          let s = i;
          if (up(s - 1) === 'OUTER') s--;
          const kind = up(s - 1);
          if (kind === 'LEFT' || kind === 'RIGHT' || kind === 'FULL') clause('JOI', s - 1, i, ['JOIN']);
          else if (kind === 'INNER' || (kind !== 'CROSS' && s === i)) {
            const a0 = kind === 'INNER' ? s - 1 : i;
            // WHERE rejects the NULL rows of the joined table: LEFT JOIN changes nothing
            if (this.nullRejected(q, joinedAlias(i + 1))) this.skipped++;
            else clause('JOI', a0, i, ['LEFT JOIN']);
          }
          break;
        }
        case '(':
          if (up(i + 1) === '+' && up(i + 2) === ')' && own[i + 2] === own[i] + 2) clause('JOI', i, i + 2, ['']);
          break;
        case 'UNION':
          if (member) {
            this.skipped++;
            break;
          }
          if (up(i + 1) === 'ALL') {
            if (recursive) this.skipped++;
            else clause('UNI', i, i + 1, ['UNION']);
          }
          else clause('UNI', i, i, ['UNION ALL']);
          break;
        case 'INTERSECT':
          clause('UNI', i, i, ['MINUS']);
          break;
        case 'MINUS': case 'EXCEPT':
          clause('UNI', i, i, ['INTERSECT']);
          break;
        case 'ORDER': {
          let b = i + 1;
          if (up(b) === 'SIBLINGS') b++;
          if (up(b) !== 'BY') break;
          const list = items(b + 1, depth[b], ORDER_END);
          // the order of a single-row SELECT INTO or of an IN/EXISTS subquery does not matter
          if (depth[i] === 0 && (member || (singleRow && !fetch))) {
            this.skipped += list.length;
            break;
          }
          // one mutant per list: every item reversed. It changes the result as soon as any
          // item matters (per item, a constant first key would make its own mutant equivalent)
          const edits: [number, number, string][] = []; // [char offset, length to drop, insert]
          for (const [s, e0] of list) {
            let e = e0;
            if (up(e - 1) === 'NULLS' && (up(e) === 'FIRST' || up(e) === 'LAST')) e -= 2;
            const dir = up(e);
            if (dir === 'DESC' || dir === 'ASC') edits.push([this.t[own[e]].start, this.t[own[e]].end - this.t[own[e]].start, dir === 'DESC' ? 'ASC' : 'DESC']);
            else if (e >= s) edits.push([this.t[own[e]].end, 0, ' DESC']);
          }
          if (edits.length) {
            const [s0] = list[0];
            const eN = list[list.length - 1][1];
            const base = this.t[own[s0]].start;
            let txt = this.span(own[s0], own[eN]);
            for (const [at, len, ins] of edits.reverse()) txt = txt.slice(0, at - base) + ins + txt.slice(at - base + len);
            clause('ORD', s0, eN, [txt]);
          }
          i = b;
          break;
        }
        case 'SET': {
          if (q.k !== 'sql' || depth[i] !== 0) break;
          const target = (q.op === 'UPDATE' && !top.slice(0, top.indexOf(i)).some((k) => up(k) === 'SET')) || (q.op === 'MERGE' && up(i - 1) === 'UPDATE');
          if (!target) break;
          const list = items(i + 1, 0, SET_END);
          if (list.length >= 2) clause('COL', list[0][0], list[list.length - 1][1], dropOne(list));
          break;
        }
        case 'VALUES': {
          if (up(i - 1) !== ')' || up(i + 1) !== '(') break;
          let o = i - 2;
          while (o >= 0 && !(up(o) === '(' && depth[o] === depth[i - 1])) o--;
          let c = i + 2;
          while (c < own.length && !(up(c) === ')' && depth[c] === depth[i + 1])) c++;
          if (o < 0 || c >= own.length || up(c + 1) === ',') break;
          const cols = items(o + 1, depth[o] + 1, new Set());
          const vals = items(i + 2, depth[i + 1] + 1, new Set());
          if (cols.length < 2 || cols.length !== vals.length) break;
          const between = this.src.slice(this.t[own[i - 1]].end, this.t[own[i + 1]].start);
          const cs = dropOne(cols);
          const vs = dropOne(vals);
          clause('COL', o, c, cs.map((x, k) => `(${x})${between}(${vs[k]})`));
          break;
        }
      }
    }
  }

  /** True if a conjunct of q's WHERE compares a column of alias in a way a NULL fails. */
  private nullRejected(q: Node, alias: string): boolean {
    if (!alias) return false;
    const where = q.kids.find((c) => this.t[c.a - 1]?.up === 'WHERE');
    if (!where) return false;
    const conj: Node[] = [];
    const flat = (x: Node) => {
      if (x.k === 'logic' && x.op === 'AND') x.kids.forEach(flat);
      else if (x.k === 'paren' && x.kids.length === 1) flat(x.kids[0]);
      else conj.push(x);
    };
    flat(where);
    const ofAlias = (x: Node) => x.k === 'name' && x.b - x.a >= 3 && this.t[x.a].up === alias && this.t[x.a + 1].text === '.';
    // comparisons, LIKE, BETWEEN, IN, = ANY: NULL makes them unknown. Not IS DISTINCT FROM or
    // IS [NOT] TRUE/UNKNOWN/JSON …, which hold for NULL or test it
    const rejects = (c: Node) => c.k === 'cmp' || (c.k === 'pred' && (['LIKE', 'BETWEEN', 'IN'].includes(c.op!) || c.op!.endsWith(' ANY')));
    return conj.some((c) => rejects(c) && c.kids.some(ofAlias));
  }

  /** SUB: EXISTS (subquery) gets NOT; x [NOT] IN (subquery) flips. NOT EXISTS is handled at the NOT node. */
  private sub(n: Node, parent: Node | null, env: Env) {
    if (n.op === 'EXISTS') {
      if (parent?.k !== 'not') this.point('SUB', 'bool', n, env, 'sql', '', [`NOT ${this.text(n)}`]);
      return;
    }
    if (n.op !== 'IN' || n.kids.length !== 2 || n.kids[1].k !== 'query') return;
    let k = n.kids[0].b;
    while (k < n.kids[1].a && this.t[k].up !== 'IN') k++;
    if (k >= n.kids[1].a) return;
    const s = this.t[n.a].start;
    const e = this.t[n.b - 1].end;
    const not = k - 1 >= n.kids[0].b && this.t[k - 1].up === 'NOT' ? k - 1 : -1;
    const m = not >= 0
      ? this.src.slice(s, this.t[not].start) + this.src.slice(this.t[k].start, e)
      : `${this.src.slice(s, this.t[k].start)}NOT ${this.src.slice(this.t[k].start, e)}`;
    this.point('SUB', 'bool', n, env, 'sql', '', [m]);
  }

  /** AGR: MIN ↔ MAX, SUM ↔ AVG, COUNT(DISTINCT x) → COUNT(x), COUNT(x) → COUNT(*). */
  private agr(f: Node, name: string, args: Node[], texts: string[], env: Env) {
    const rest = this.src.slice(this.t[f.a].end, this.t[f.b - 1].end);
    const swap = AGGREGATE_SWAP[name];
    if (swap) {
      if (args.length === 1) this.point('AGR', 'value', f, env, 'sql', '', [swap + rest]);
      return;
    }
    if (name !== 'COUNT' || args.length !== 1) return;
    const arg = args[0];
    const close = this.close(f.a + 1);
    const tail = this.src.slice(this.t[close].end, this.t[f.b - 1].end);
    if (this.t[arg.a].up === 'DISTINCT' || this.t[arg.a].up === 'UNIQUE') {
      const inner = this.src.slice(this.t[arg.a + 1].start, this.t[arg.b - 1].end);
      this.point('AGR', 'value', f, env, 'sql', '', [`${this.t[f.a].text}(${inner})${tail}`]);
    } else if (texts[0] !== '*' && !isLiteral(texts[0]) && !/^ALL\b/i.test(texts[0])) {
      this.point('AGR', 'value', f, env, 'sql', '', [`${this.t[f.a].text}(*)${tail}`]);
    }
  }

  /** WHR: the WHERE or HAVING condition becomes TRUE, unless another point already gives TRUE there. */
  private whr(q: Node, env: Env) {
    for (const c of q.kids) {
      const kw = this.t[c.a - 1]?.up;
      if (kw !== 'WHERE' && kw !== 'HAVING') continue;
      let x = c;
      while (x.k === 'paren' && x.kids.length === 1) x = x.kids[0];
      if (x.k === 'lit' || (x.k === 'cmp' && x.kids.every((k) => isLiteral(this.text(k).trim())))) continue;
      // in FORALL the condition may hold the only bulk bind (PLS-00435)
      if (env.forall && this.t.slice(c.a, c.b).some((t) => t.up === env.forall)) {
        this.skipped++;
        continue;
      }
      const s = this.sb(x.a);
      const e = this.eb(x.b - 1);
      if (this.points.some((p) => p.start === s && p.end === e && p.kind === 'bool' && p.mutants.includes('TRUE'))) {
        this.skipped++;
        continue;
      }
      this.point('WHR', 'bool', c, env, 'sql', '', ['TRUE']);
    }
  }
}
