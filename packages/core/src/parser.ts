/**
 * PL/SQL parser shared by coverage and mutation.
 *
 * It builds a syntax tree over the significant tokens of the lexer: program units,
 * declarations, subprograms, statements, embedded SQL and expressions with Oracle's
 * precedence and associativity (left to right within a level; || shares its level
 * with binary + and -).
 *
 * The parser is region based: statement boundaries (THEN, LOOP, ;) are found by
 * scanning at parenthesis depth 0 first, and expressions are parsed only inside
 * such a region. An expression the parser does not fully understand becomes an
 * "opaque" node; parenthesised groups and CASE expressions inside it are still
 * parsed. So an unknown construct costs the points inside it, never a wrong span.
 * Structural errors (a missing END IF, say) fail the whole unit.
 */
import { tokenize, type Token } from './lexer.js';

export type NodeKind =
  // structure
  | 'unit' | 'subprog' | 'decls' | 'decl' | 'cursor' | 'body' | 'seq' | 'stmt' | 'branch' | 'else' | 'handler'
  | 'pragma' | 'label' | 'section' | 'trigger-when'
  // expressions and conditions
  | 'bin' | 'unary' | 'cmp' | 'logic' | 'not' | 'isnull' | 'pred' | 'paren' | 'list' | 'call' | 'arg' | 'name'
  | 'lit' | 'case' | 'when' | 'query' | 'sql' | 'range' | 'opaque'
  // understood syntax around expressions: (x AS type), CAST(x AS t), EXTRACT(y FROM d), JSON_VALUE(d, p RETURNING t)
  | 'cast' | 'clause';

export interface Node {
  k: NodeKind;
  /** First token (index into the significant tokens). */
  a: number;
  /** One past the last token. */
  b: number;
  kids: Node[];
  /**
   * Operator (bin, unary, cmp, logic, pred), statement kind (stmt), unit type (unit),
   * FUNCTION or PROCEDURE (subprog), loop kind (stmt loop: loop, while, for, cursor-for).
   */
  op?: string;
  /** Token of the operator or keyword: IS of IS NULL, LOOP, BEGIN, IS/AS of a unit, % of an attribute. */
  at?: number;
  /** stmt: first label token; isnull: NOT token (or -1); call: first "(". */
  at2?: number;
  /** Subprogram, unit or function name; loop kind; branch kind. */
  name?: string;
}

export interface ParseErrorEntry {
  line: number;
  col: number;
  message: string;
}

export interface ParsedSource {
  src: string;
  /** Significant tokens (no whitespace, no comments). */
  tokens: Token[];
  units: Node[];
  errors: ParseErrorEntry[];
}

export class ParseFailure extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(`${message} (Zeile ${line})`);
  }
}

/** Unit types whose code runs and can be measured or mutated. */
export const BODY_TYPES = ['PACKAGE BODY', 'TYPE BODY', 'PROCEDURE', 'FUNCTION', 'TRIGGER'] as const;

const STMT_END = new Set(['END', 'EXCEPTION', 'ELSIF', 'ELSE', 'WHEN']);
const CMP_OPS = new Set(['=', '<>', '!=', '~=', '^=', '<', '>', '<=', '>=']);
const SQL_STMT = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'LOCK']);

/** Words that never start an operand. */
const NOT_OPERAND = new Set([
  'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'BY', 'INTO', 'BULK', 'THEN', 'ELSE', 'ELSIF', 'END', 'LOOP', 'WHEN',
  'UNION', 'INTERSECT', 'MINUS', 'EXCEPT', 'CONNECT', 'START', 'SELECT', 'ON', 'USING', 'RETURNING', 'RETURN', 'IS',
  'AS', 'AND', 'OR', 'IN', 'LIKE', 'LIKEC', 'LIKE2', 'LIKE4', 'BETWEEN', 'SET', 'VALUES', 'WITH', 'FOR', 'BEGIN',
  'DECLARE', 'EXCEPTION', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'ASC', 'DESC', 'NULLS', 'JOIN', 'INNER', 'CROSS',
  'NATURAL', 'FULL', 'OUTER', 'PIVOT', 'UNPIVOT', 'ESCAPE', 'IF', 'MEMBER', 'SUBMULTISET', 'MULTISET', 'COLLATE',
  'EXIT', 'CONTINUE', 'GOTO', 'RAISE', 'PRAGMA', 'FORALL', 'WHILE', 'DISTINCT', 'UNIQUE', 'ALL', 'ANY', 'SOME', 'OF',
  'NOT', 'CONNECT_BY_ROOT', 'PRIOR',
]);

/** Words that may be followed by "(" without being a function call. */
const NOT_CALL = new Set([
  'IN', 'VALUES', 'USING', 'ON', 'AS', 'OF', 'AND', 'OR', 'NOT', 'THEN', 'ELSE', 'ELSIF', 'WHEN', 'LIKE', 'LIKEC', 'LIKE2',
  'LIKE4', 'BETWEEN', 'FROM', 'WHERE', 'INTO', 'RETURNING', 'RETURN', 'SELECT', 'BY', 'IS', 'WITH', 'UNION',
  'INTERSECT', 'MINUS', 'EXCEPT', 'HAVING', 'CONNECT', 'START', 'JOIN', 'MULTISET', 'ALL', 'ANY', 'SOME', 'DISTINCT',
  'UNIQUE', 'PRIOR', 'IF', 'WHILE', 'LOOP', 'END', 'EXCEPTION', 'BEGIN', 'DECLARE', 'ORDER', 'GROUP', 'MEMBER',
  // SET(collection) is a function; UPDATE … SET is handled by the SQL scanner
  'SUBMULTISET', 'FOR', 'PIVOT', 'UNPIVOT', 'CONNECT_BY_ROOT', 'COLLATE',
]);

/** Keywords after an expression in a function argument (CAST(x AS t), JSON_VALUE(x, p RETURNING t), ...). */
const ARG_TAIL_FROM = new Set(['FROM']);
const ARG_TAIL = new Set([
  'AS', 'FROM', 'RETURNING', 'USING', 'DEFAULT', 'ON', 'FORMAT', 'PASSING', 'COLUMNS', 'ERROR', 'NULL', 'WITH', 'WITHOUT',
  'KEEP', 'ORDER', 'SEPARATOR', 'EMPTY', 'TRUE', 'FALSE', 'IGNORE', 'RESPECT', 'TYPE', 'PRETTY', 'ASCII', 'TRUNCATE',
  'ALLOW', 'DISALLOW', 'STRICT', 'LAX', 'ABSENT', 'NO', 'INDENT', 'VERSION', 'STANDALONE', 'EVALNAME', 'NAME', 'WRAPPER',
  'ENCODING', 'IDENT', 'CHAR', 'BYTE',
]);

/** Words of a SQL statement that only switch sqlScan's state. */
const SQL_STATE = new Map(Object.entries({
  values: 'VALUES', into: 'INTO COLLECT', from: 'FROM USING JOIN APPLY', skip: 'MODEL PIVOT UNPIVOT MATCH_RECOGNIZE WINDOW',
  target: 'INSERT UPDATE DELETE MERGE', with: 'WITH', '': 'UNION INTERSECT MINUS EXCEPT',
}).flatMap(([state, ws]) => ws.split(' ').map((w) => [w, state] as const)));

const SQL_CLAUSE_END = new Set([
  'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'INTO', 'BULK', 'UNION', 'INTERSECT', 'MINUS', 'EXCEPT', 'CONNECT',
  'START', 'RETURNING', 'RETURN', 'SET', 'VALUES', 'ON', 'USING', 'WHEN', 'THEN', 'ELSE', 'FOR', 'OFFSET', 'FETCH',
  'MODEL', 'WINDOW', 'LOG', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'PIVOT', 'UNPIVOT', 'SELECT',
  'WITH', 'LIMIT', 'DELETE', 'UPDATE', 'INSERT',
]);

/**
 * Parses a file. With `views`, CREATE VIEW statements are units too (op VIEW, one query
 * node as kid, `at` = the AS token); the unit ends before the terminating semicolon.
 */
export function parse(src: string, opts: { views?: boolean } = {}): ParsedSource {
  const p = new Parser(src, true);
  p.views = !!opts.views;
  p.file();
  return { src, tokens: p.t, units: p.units, errors: p.errors };
}

/** Parses a single unit (source starting with CREATE or with the unit keyword). Throws on errors. */
export function parseUnit(src: string): { tokens: Token[]; unit: Node } {
  const p = new Parser(src);
  const unit = p.unitAt();
  // tokens left after the unit (but a "/"): it ended early, measuring only its beginning would mislead
  const rest = p.t.slice(unit.b).filter((t) => t.text !== '/' && t.text !== ';');
  if (rest.length) throw new ParseFailure(`Einheit endet vor dem Text (${rest[0].text})`, rest[0].line, rest[0].col);
  return { tokens: p.t, unit };
}

// stop sets of find/need
const SEMI = new Set([';']), COMMA = new Set([',']), THEN = new Set(['THEN']), WHEN = new Set(['WHEN']), LOOP = new Set(['LOOP']);
const IN = new Set(['IN']), IS = new Set(['IS']), AS = new Set(['AS']), IS_AS = new Set(['IS', 'AS']), FOR = new Set(['FOR']), BY = new Set(['BY']);
const BEGIN = new Set(['BEGIN']), BEGIN_END = new Set(['BEGIN', 'END']), TIMING_END = new Set(['BEFORE', 'AFTER', 'INSTEAD', 'END']);
const EQ = new Set(['=']), ASSIGN = new Set([':=']), INIT = new Set([':=', 'DEFAULT']), DOTS = new Set(['..']), LIMIT = new Set(['LIMIT']);
const FOR_FILTER = new Set(['WHILE', 'WHEN']), USING = new Set(['USING']), USING_END = new Set(['RETURNING', 'RETURN', 'INTO']);
const EXEC_END = new Set(['INTO', 'USING', 'RETURNING', 'RETURN', 'BULK']), FORALL_DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'EXECUTE', 'SAVE']);
const CASE_PARTS = new Set(['WHEN', 'ELSE', 'END']);
const NAME_SKIP = new Set(['CREATE', 'OR', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'PACKAGE', 'BODY', 'PROCEDURE', 'FUNCTION', 'TYPE', 'TRIGGER', 'IF', 'NOT', 'EXISTS']);
const NAME_STOP = new Set(['IS', 'AS', '(', 'RETURN', 'AUTHID', 'BEFORE', 'AFTER', 'INSTEAD', 'FOR', 'SHARING', 'ACCESSIBLE', 'DEFAULT', 'BEQUEATH', 'OF']);

/** For every parenthesis the index of its partner (-1: none). */
export function matchParens(t: Token[]): Int32Array {
  const match = new Int32Array(t.length).fill(-1);
  const stack: number[] = [];
  t.forEach((x, k) => {
    if (x.kind !== 'op') return;
    if (x.text === '(') stack.push(k);
    else if (x.text === ')' && stack.length) {
      const o = stack.pop()!;
      match[o] = k;
      match[k] = o;
    }
  });
  return match;
}

const node = (k: NodeKind, a: number, b: number, kids: Node[] = [], extra: Partial<Node> = {}): Node => ({ k, a, b, kids, ...extra });

class Parser {
  t: Token[];
  i = 0;
  lim: number;
  units: Node[] = [];
  errors: ParseErrorEntry[] = [];
  views = false;
  private match: Int32Array;

  constructor(private src: string, tolerant = false) {
    this.t = tokenize(src, { tolerant }).filter((x) => x.kind !== 'trivia');
    this.lim = this.t.length;
    this.match = matchParens(this.t);
  }

  // ------------------------------------------------------------- helpers

  private up(k = 0): string {
    const j = this.i + k;
    return j < this.lim ? this.t[j].up : '';
  }
  private upAt(j: number): string {
    return j < this.t.length ? this.t[j].up : '';
  }
  /** A query starts at j. */
  private isQuery(j: number): boolean {
    const u = this.upAt(j);
    return u === 'SELECT' || u === 'WITH';
  }
  private isWord(j: number, ...w: string[]): boolean {
    const x = this.t[j];
    return !!x && j < this.lim && x.kind === 'ident' && w.includes(x.up);
  }
  private at(...w: string[]): boolean {
    const x = this.t[this.i];
    if (!x || this.i >= this.lim) return false;
    return (x.kind === 'ident' || x.kind === 'op') && w.includes(x.up);
  }
  private isOp(j: number, op: string): boolean {
    const x = this.t[j];
    return !!x && j < this.lim && x.kind === 'op' && x.text === op;
  }
  private eof(): boolean {
    return this.i >= this.lim;
  }
  private fail(msg: string, j = this.i): never {
    const x = this.t[Math.min(j, this.t.length - 1)];
    throw new ParseFailure(msg, x?.line ?? 1, x?.col ?? 1);
  }
  private expect(w: string): number {
    if (!this.at(w)) this.fail(`Erwartet "${w}", gefunden "${this.eof() ? 'Ende' : this.t[this.i].text}"`);
    return this.i++;
  }
  private close(open: number): number {
    const m = this.match[open];
    if (m < 0) this.fail('Schließende Klammer fehlt', open);
    return m;
  }

  /**
   * Index of the next token in `stops` at depth 0 (parentheses, CASE ... END),
   * searching [from, end). Returns -1 if there is none.
   */
  find(from: number, stops: Set<string>, end = this.t.length): number {
    let cases = 0;
    for (let k = from; k < end; k++) {
      const x = this.t[k];
      if (x.kind === 'op' && x.text === '(') {
        const m = this.match[k];
        if (m < 0) return -1;
        k = m;
        continue;
      }
      if (x.kind === 'op' && x.text === ')') return -1;
      if (cases === 0 && (x.kind === 'ident' || x.kind === 'op') && stops.has(x.up)) return k;
      if (x.kind === 'ident' && x.up === 'CASE') cases++;
      else if (x.kind === 'ident' && x.up === 'END' && cases > 0) cases--;
    }
    return -1;
  }
  private need(from: number, stops: Set<string>, end = this.t.length): number {
    const k = this.find(from, stops, end);
    if (k < 0) this.fail(`"${[...stops].join('/')}" nicht gefunden`, from);
    return k;
  }

  /** Splits [a, b) at commas of depth 0. */
  private commas(a: number, b: number): [number, number][] {
    const out: [number, number][] = [];
    let s = a;
    for (;;) {
      const c = this.find(s, COMMA, b);
      if (c < 0) {
        out.push([s, b]);
        return out;
      }
      out.push([s, c]);
      s = c + 1;
    }
  }

  // ---------------------------------------------------------- file level

  file() {
    while (this.i < this.t.length) {
      const s = this.i;
      if (this.isCreateUnit(s)) {
        try {
          this.units.push(this.unitAt());
          if (this.isSlash(this.i)) this.i++;
          continue;
        } catch (e) {
          if (!(e instanceof ParseFailure)) throw e;
          this.errors.push({ line: e.line, col: e.col, message: e.message });
          this.lim = this.t.length;
        }
      }
      this.i = this.skipStatement(s);
    }
  }

  /** "/" alone on its line ends a PL/SQL unit in SQL*Plus scripts. */
  private isSlash(k: number): boolean {
    const x = this.t[k];
    if (!x || x.text !== '/' || x.kind !== 'op' || !this.firstOnLine(k)) return false;
    const le = this.src.indexOf('\n', x.end);
    return this.src.slice(x.end, le < 0 ? this.src.length : le).trim() === '';
  }

  private firstOnLine(k: number): boolean {
    const x = this.t[k];
    const ls = this.src.lastIndexOf('\n', x.start - 1) + 1;
    return this.src.slice(ls, x.start).trim() === '';
  }

  private skipStatement(s: number): number {
    if (this.isSlash(s)) return s + 1;
    for (let k = s + 1; k < this.t.length; k++) {
      if (this.isSlash(k)) return k + 1;
      if (this.t[k].up === 'CREATE' && this.t[k].kind === 'ident' && this.firstOnLine(k) && this.isCreateUnit(k)) return k;
    }
    return this.t.length;
  }

  private isCreateUnit(s: number): boolean {
    let k = s;
    if (this.upAt(k) !== 'CREATE') return false;
    k++;
    if (this.upAt(k) === 'OR' && this.upAt(k + 1) === 'REPLACE') k += 2;
    while (['EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING', 'FORCE', 'NO'].includes(this.upAt(k))) k++;
    const u = this.upAt(k);
    // a name must follow (GRANT CREATE PROCEDURE TO …, CREATE TRIGGER, … are privileges)
    const named = (j: number) => ['ident', 'qident'].includes(this.t[j]?.kind) && this.upAt(j) !== 'TO';
    if (u === 'VIEW') return this.views && named(k + 1);
    if (u === 'PACKAGE' || u === 'TYPE') return this.upAt(k + 1) === 'BODY' && named(k + 2);
    return (u === 'PROCEDURE' || u === 'FUNCTION' || u === 'TRIGGER') && named(k + 1);
  }

  // ---------------------------------------------------------------- units

  unitAt(): Node {
    const a = this.i;
    while (this.at('CREATE', 'OR', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING', 'FORCE', 'NO')) this.i++;
    const kw = this.up();
    if (kw === 'VIEW') return this.view(a);
    if (kw === 'PROCEDURE' || kw === 'FUNCTION') {
      const name = this.unitName();
      const sp = this.subprog(true);
      return node('unit', a, this.i, [sp], { op: kw, name, at: -1 });
    }
    if (kw === 'TRIGGER') {
      this.i++;
      return this.trigger(a, this.unitName());
    }
    if (kw !== 'PACKAGE' && kw !== 'TYPE') this.fail(`Nicht unterstützter Objekttyp "${this.t[this.i]?.text}"`);
    this.i++;
    this.expect('BODY');
    const name = this.unitName();
    const is = this.need(this.i, IS_AS);
    this.i = is + 1;
    const kids: Node[] = [];
    if (kw === 'PACKAGE') {
      kids.push(this.decls(BEGIN_END));
      if (this.at('BEGIN')) kids.push(this.body());
      else this.end();
    } else {
      const da = this.i;
      const ds: Node[] = [];
      while (!this.at('END')) {
        if (this.eof()) this.fail('END des Type Body fehlt');
        while (this.at('MEMBER', 'STATIC', 'CONSTRUCTOR', 'MAP', 'ORDER', 'OVERRIDING', 'FINAL', 'INSTANTIABLE', 'NOT', ',')) this.i++;
        if (this.at('PROCEDURE', 'FUNCTION')) ds.push(this.subprog(false));
        else this.fail(`Unerwartetes "${this.t[this.i].text}" im Type Body`);
      }
      kids.push(node('decls', da, this.i, ds));
      this.end();
    }
    return node('unit', a, this.i, kids, { op: `${kw} BODY`, name, at: is });
  }

  /** END [kw] [name] ; (a unit's END, END CASE, END LOOP; END IF without a name). */
  private end(kw = '', named = true) {
    this.expect('END');
    if (kw) this.expect(kw);
    if (named && !this.at(';')) this.i++;
    this.expect(';');
  }

  /** The unit name as written: the tokens before IS/AS/(/RETURN/... (plmut's rule). */
  private unitName(): string {
    let k = this.i;
    while (NAME_SKIP.has(this.upAt(k))) k++;
    let name = '';
    while (k < this.t.length && !NAME_STOP.has(this.upAt(k))) {
      name += this.t[k].text;
      if (this.upAt(k + 1) !== '.' && this.upAt(k) !== '.') break;
      k++;
    }
    return name;
  }

  /**
   * CREATE VIEW name [(columns)] [options] AS query [WITH READ ONLY | WITH CHECK OPTION
   * [CONSTRAINT c]] ; — the query ends at a semicolon of depth 0, a slash line or the
   * next CREATE at the start of a line.
   */
  private view(a: number): Node {
    this.i++;
    const name = this.unitName();
    let as = -1;
    for (let k = this.i; k < this.t.length; k++) {
      if (this.isOp(k, '(')) {
        k = this.close(k);
        continue;
      }
      if (this.isOp(k, ';')) break;
      if (this.isWord(k, 'AS') && (this.isQuery(k + 1) || this.isOp(k + 1, '('))) {
        as = k;
        break;
      }
    }
    if (as < 0) this.fail('AS der View nicht gefunden', a);
    // PL/SQL in WITH: its semicolons do not end the view, and the query scan cannot read it
    if (this.upAt(as + 1) === 'WITH' && ['FUNCTION', 'PROCEDURE'].includes(this.upAt(as + 2))) this.fail('View mit WITH FUNCTION wird nicht unterstützt', as + 1);
    let end = as + 1;
    while (end < this.t.length && !this.isOp(end, ';') && !this.isSlash(end) && !(this.t[end].up === 'CREATE' && this.t[end].kind === 'ident' && this.firstOnLine(end))) {
      end = this.isOp(end, '(') ? this.close(end) + 1 : end + 1;
    }
    // trailing view constraints are not part of the query
    let qb = end;
    const w = (k: number, ...ws: string[]) => k > as && this.isWord(k, ...ws);
    if (w(qb - 3, 'WITH') && w(qb - 2, 'READ') && w(qb - 1, 'ONLY')) qb -= 3;
    else if (w(qb - 3, 'WITH') && w(qb - 2, 'CHECK') && w(qb - 1, 'OPTION')) qb -= 3;
    else if (w(qb - 5, 'WITH') && w(qb - 4, 'CHECK') && w(qb - 3, 'OPTION') && w(qb - 2, 'CONSTRAINT')) qb -= 5;
    if (qb <= as + 1) this.fail('Abfrage der View fehlt', as);
    const q = this.query(as + 1, qb);
    this.i = this.isOp(end, ';') ? end + 1 : end;
    return node('unit', a, end, [q], { op: 'VIEW', name, at: as });
  }

  private trigger(a: number, name: string): Node {
    // header up to DECLARE / BEGIN / COMPOUND TRIGGER / CALL
    const kids: Node[] = [];
    while (!this.at('DECLARE', 'BEGIN', 'COMPOUND', 'CALL')) {
      if (this.eof()) this.fail('Trigger-Rumpf nicht gefunden', a);
      if (this.at('WHEN') && this.isOp(this.i + 1, '(')) {
        const o = this.i + 1;
        const c = this.close(o);
        kids.push(node('trigger-when', this.i, c + 1, [this.region(o + 1, c)]));
        this.i = c + 1;
        continue;
      }
      if (this.at('(')) {
        this.i = this.close(this.i) + 1;
        continue;
      }
      this.i++;
    }
    if (this.at('CALL')) {
      // CALL proc(…) ends at its semicolon, or (written without one) at the unit's slash: never
      // in the next unit
      let k = this.i + 1;
      while (k < this.lim && this.t[k].text !== ';' && this.t[k].text !== '/') k = this.t[k].text === '(' ? this.close(k) + 1 : k + 1;
      this.i = k < this.lim && this.t[k].text === ';' ? k + 1 : k;
    } else if (this.at('COMPOUND')) {
      this.i++;
      this.expect('TRIGGER');
      kids.push(this.decls(TIMING_END));
      while (this.at('BEFORE', 'AFTER', 'INSTEAD')) {
        const sa = this.i;
        this.i = this.need(this.i, IS) + 1;
        const b = this.body();
        kids.push(node('section', sa, this.i, [b]));
      }
      this.end();
    } else {
      kids.push(...this.block());
    }
    return node('unit', a, this.i, kids, { op: 'TRIGGER', name, at: -1 });
  }

  /** At PROCEDURE/FUNCTION: header, then body, forward declaration or call specification. */
  private subprog(top: boolean): Node {
    const a = this.i;
    const kind = this.t[this.i].up;
    this.i++;
    // name: the last part of a dotted name
    let nameTok = this.i;
    this.i++;
    while (top && this.at('.')) {
      nameTok = this.i + 1;
      this.i += 2;
    }
    const name = this.t[nameTok].text;
    const kids: Node[] = [];
    for (;;) {
      if (this.eof()) this.fail(`Kopf von ${name} nicht abgeschlossen`, a);
      if (this.at('(')) {
        const c = this.close(this.i);
        kids.push(...this.paramDefaults(this.i + 1, c));
        this.i = c + 1;
        continue;
      }
      // RETURN SELF AS RESULT (a constructor); not AS result NUMBER (a local named result)
      if (this.at('AS') && this.up(1) === 'RESULT' && this.t[this.i - 1]?.up === 'SELF') {
        this.i += 2;
        continue;
      }
      if (this.at('IS', 'AS')) break;
      if (this.at(';')) {
        this.i++;
        return node('subprog', a, this.i, kids, { op: kind, name, at: nameTok });
      }
      this.i++;
    }
    this.i++;
    // a call spec; not a first local variable named language, external or mle
    const spec = (this.at('LANGUAGE') && ['C', 'JAVA', 'JAVASCRIPT'].includes(this.up(1)))
      || (this.at('EXTERNAL') && ['NAME', 'LIBRARY', 'WITH', 'PARAMETERS', ';'].includes(this.up(1)))
      || (this.at('MLE') && ['MODULE', 'LANGUAGE'].includes(this.up(1)));
    if (spec) this.i = this.need(this.i, SEMI) + 1;
    else kids.push(this.decls(BEGIN_END), this.body());
    return node('subprog', a, this.i, kids, { op: kind, name, at: nameTok });
  }

  /** Default values of parameters in [a, b). */
  private paramDefaults(a: number, b: number): Node[] {
    const out: Node[] = [];
    for (const [s, e] of this.commas(a, b)) {
      const d = this.find(s, INIT, e);
      if (d >= 0 && d + 1 < e) out.push(node('decl', s, e, [this.region(d + 1, e)]));
    }
    return out;
  }

  private decls(stop: Set<string>): Node {
    const a = this.i;
    const kids: Node[] = [];
    while (!this.eof() && !(stop.has(this.up()) && this.t[this.i].kind === 'ident')) {
      if (this.at('PROCEDURE', 'FUNCTION')) {
        kids.push(this.subprog(false));
      } else if (this.at('CURSOR')) {
        kids.push(this.cursorDecl());
      } else if (this.at('PRAGMA')) {
        const s = this.i;
        this.i = this.need(this.i, SEMI) + 1;
        kids.push(node('pragma', s, this.i));
      } else if (this.at('TYPE', 'SUBTYPE')) {
        this.i = this.need(this.i, SEMI) + 1;
      } else {
        const s = this.i;
        const semi = this.need(this.i, SEMI);
        const d = this.find(s, INIT, semi);
        kids.push(node('decl', s, semi + 1, d >= 0 && d + 1 < semi ? [this.region(d + 1, semi)] : []));
        this.i = semi + 1;
      }
    }
    return node('decls', a, this.i, kids);
  }

  private cursorDecl(): Node {
    const a = this.i;
    const semi = this.need(this.i, SEMI);
    const kids: Node[] = [];
    let k = this.i + 2;
    if (this.isOp(k, '(')) {
      const c = this.close(k);
      kids.push(...this.paramDefaults(k + 1, c));
      k = c + 1;
    }
    const is = this.find(k, IS, semi);
    if (is >= 0) kids.push(this.query(is + 1, semi));
    this.i = semi + 1;
    return node('cursor', a, this.i, kids);
  }

  /** [DECLARE decls] BEGIN ... END */
  private block(): Node[] {
    const out: Node[] = [];
    if (this.at('DECLARE')) {
      this.i++;
      out.push(this.decls(BEGIN));
    }
    out.push(this.body());
    return out;
  }

  /** BEGIN statements [EXCEPTION handlers] END [label]; */
  private body(): Node {
    const a = this.i;
    const begin = this.expect('BEGIN');
    const kids: Node[] = [this.seq()];
    if (this.at('EXCEPTION')) {
      this.i++;
      while (this.at('WHEN')) {
        const ha = this.i;
        const then = this.need(this.i + 1, THEN);
        this.i = then + 1;
        const s = this.seq();
        kids.push(node('handler', ha, this.i, [s], { at: then }));
      }
    }
    this.expect('END');
    // END [label] ; — or END BEFORE STATEMENT; in compound triggers
    let n = 0;
    while (!this.at(';')) {
      if (this.eof() || ++n > 3) this.fail('";" nach END erwartet');
      this.i++;
    }
    this.i++;
    return node('body', a, this.i, kids, { at: begin });
  }

  // ----------------------------------------------------------- statements

  /** The statement from a to its semicolon (la: its first label). */
  private stmtTo(semi: number, a: number, la: number, op: string, kids: Node[] = [], extra: Partial<Node> = {}): Node {
    this.i = semi + 1;
    return node('stmt', a, this.i, kids, { op, at2: la, ...extra });
  }

  private seq(): Node {
    const a = this.i;
    const kids: Node[] = [];
    while (!this.eof() && !(STMT_END.has(this.up()) && this.t[this.i].kind === 'ident')) kids.push(this.stmt());
    return node('seq', a, this.i, kids);
  }

  private stmt(): Node {
    const la = this.i;
    while (this.at('<<')) {
      this.i++;
      this.i++;
      this.expect('>>');
    }
    if (this.eof() || (STMT_END.has(this.up()) && this.t[this.i].kind === 'ident')) {
      // a label right before END: Oracle needs a statement, but we keep going
      return node('label', la, this.i, [], { at2: la });
    }
    const a = this.i;
    const u = this.up();
    const kind = this.t[a].kind;
    // OPEN, FETCH, ... are not reserved: open(x); calls a procedure named open
    const softKw = ['OPEN', 'FETCH', 'CLOSE', 'PIPE', 'SET', 'LOCK', 'EXECUTE', 'SAVEPOINT', 'COMMIT', 'ROLLBACK', 'MERGE'];
    const kw = kind === 'ident' && !this.isOp(a + 1, ':=') && !this.isOp(a + 1, '.') && !this.isOp(a + 1, '%')
      && !(softKw.includes(u) && (this.isOp(a + 1, '(') || this.isOp(a + 1, ';')) && u !== 'COMMIT' && u !== 'ROLLBACK');
    if (kw) {
      switch (u) {
        case 'IF': return this.ifStmt(a, la);
        case 'CASE': return this.caseStmt(a, la);
        case 'LOOP': case 'WHILE': case 'FOR': return this.loop(a, la);
        case 'FORALL': return this.forall(a, la);
        case 'EXIT': case 'CONTINUE': {
          const semi = this.need(a + 1, SEMI);
          const w = this.find(a + 1, WHEN, semi);
          return this.stmtTo(semi, a, la, u.toLowerCase(), w >= 0 ? [this.region(w + 1, semi)] : [], { at: w });
        }
        case 'RETURN': {
          const semi = this.need(a + 1, SEMI);
          return this.stmtTo(semi, a, la, 'return', semi > a + 1 ? [this.region(a + 1, semi)] : []);
        }
        case 'RAISE': case 'GOTO': case 'CLOSE':
          return this.stmtTo(this.need(a, SEMI), a, la, u.toLowerCase());
        case 'NULL':
          if (this.isOp(a + 1, ';')) return this.stmtTo(a + 1, a, la, 'null');
          break;
        case 'BEGIN': case 'DECLARE': {
          const kids = this.block();
          return node('stmt', a, this.i, kids, { op: 'block', at2: la });
        }
        case 'PRAGMA': {
          this.i = this.need(this.i, SEMI) + 1;
          return node('pragma', a, this.i, [], { at2: la });
        }
        case 'EXECUTE': return this.execImmediate(a, la);
        case 'OPEN': return this.openStmt(a, la);
        case 'FETCH': {
          const semi = this.need(a, SEMI);
          const lim = this.find(a, LIMIT, semi);
          return this.stmtTo(semi, a, la, 'fetch', lim >= 0 ? [this.region(lim + 1, semi)] : []);
        }
        case 'PIPE': {
          const semi = this.need(a, SEMI);
          return this.stmtTo(semi, a, la, 'pipe', this.isOp(a + 2, '(') && this.close(a + 2) < semi ? [this.region(a + 3, this.close(a + 2))] : []);
        }
      }
    }
    const semi = this.need(a, SEMI);
    if ((kw && (SQL_STMT.has(u) || (u === 'SET' && this.upAt(a + 1) === 'TRANSACTION'))) || (kind === 'op' && u === '(' && this.isQuery(a + 1))) {
      return this.stmtTo(semi, a, la, 'sql', [this.sqlStatement(a, semi)]);
    }
    // assignment or procedure call
    const asg = this.find(a, ASSIGN, semi);
    if (asg < 0) return this.stmtTo(semi, a, la, 'call', [this.region(a, semi)]);
    return this.stmtTo(semi, a, la, 'assign', [this.region(a, asg), this.region(asg + 1, semi)], { at: asg });
  }

  private ifStmt(a: number, la: number): Node {
    this.i++;
    const kids: Node[] = [];
    let kw = a;
    for (;;) {
      const then = this.need(this.i, THEN);
      const cond = this.region(this.i, then);
      this.i = then + 1;
      const s = this.seq();
      kids.push(node('branch', kw, this.i, [cond, s], { name: 'if', at: then }));
      if (!this.at('ELSIF')) break;
      kw = this.i++;
    }
    this.elseBranch(kids);
    this.end('IF', false);
    return node('stmt', a, this.i, kids, { op: 'if', at2: la });
  }

  private caseStmt(a: number, la: number): Node {
    this.i++;
    const kids: Node[] = [];
    const searched = this.at('WHEN');
    if (!searched) {
      const w = this.need(this.i, WHEN);
      kids.push(this.region(this.i, w));
      this.i = w;
    }
    while (this.at('WHEN')) {
      const w = this.i;
      const then = this.need(this.i + 1, THEN);
      const cond = this.region(w + 1, then);
      this.i = then + 1;
      const s = this.seq();
      kids.push(node('branch', w, this.i, [cond, s], { name: searched ? 'case' : 'case-simple', at: then }));
    }
    this.elseBranch(kids);
    this.end('CASE');
    return node('stmt', a, this.i, kids, { op: 'case', at2: la, name: searched ? 'searched' : 'simple' });
  }

  private elseBranch(kids: Node[]) {
    if (!this.at('ELSE')) return;
    const e = this.i++;
    const s = this.seq();
    kids.push(node('else', e, this.i, [s]));
  }

  private loop(a: number, la: number): Node {
    const kids: Node[] = [];
    let kind = 'loop';
    if (this.at('WHILE')) {
      kind = 'while';
      this.i++;
      const lp = this.need(this.i, LOOP);
      kids.push(this.region(this.i, lp));
      this.i = lp;
    } else if (this.at('FOR')) {
      this.i++;
      const lp = this.need(this.i, LOOP);
      const inIdx = this.need(this.i, IN, lp);
      let k = inIdx + 1;
      if (this.isWord(k, 'REVERSE')) k++;
      kind = 'for';
      if (this.isOp(k, '(') && this.isQuery(k + 1)) {
        kind = 'cursor-for';
        const c = this.close(k);
        kids.push(this.query(k + 1, c));
      } else {
        for (const [s, e] of this.commas(k, lp)) {
          // 21c iteration controls: … [WHILE cond] [WHEN cond]
          const f = this.find(s, FOR_FILTER, e);
          const ce = f >= 0 ? f : e;
          const dots = this.find(s, DOTS, ce);
          if (this.isWord(s, 'VALUES', 'INDICES', 'PAIRS') && this.isWord(s + 1, 'OF')) {
            kids.push(this.region(s + 2, ce));
          } else if (dots < 0) {
            // cursor FOR loop over a declared cursor, or an iteration over an expression
            kind = 'cursor-for';
            kids.push(this.region(s, ce));
          } else {
            const by = this.find(dots + 1, BY, ce);
            const r = node('range', s, ce, [this.region(s, dots), this.region(dots + 1, by >= 0 ? by : ce)], { at: dots, name: by >= 0 ? 'by' : '' });
            if (by >= 0) r.kids.push(this.region(by + 1, ce));
            kids.push(r);
          }
          for (let w = f; w >= 0 && w < e;) {
            const next = this.find(w + 1, FOR_FILTER, e);
            const we = next >= 0 ? next : e;
            kids.push(node('branch', w, we, [this.region(w + 1, we)], { name: `for-${this.upAt(w).toLowerCase()}`, at: w }));
            w = next;
          }
        }
      }
      this.i = lp;
    }
    const loopTok = this.expect('LOOP');
    kids.push(this.seq());
    this.end('LOOP');
    return node('stmt', a, this.i, kids, { op: 'loop', name: kind, at: loopTok, at2: la });
  }

  private forall(a: number, la: number): Node {
    const semi = this.need(this.i, SEMI);
    const inIdx = this.need(this.i, IN, semi);
    const dml = this.need(inIdx + 1, FORALL_DML, semi);
    const kids: Node[] = [];
    let k = inIdx + 1;
    if (this.isWord(k, 'VALUES', 'INDICES') && this.isWord(k + 1, 'OF')) {
      kids.push(this.region(k + 2, dml));
    } else {
      const dots = this.find(k, DOTS, dml);
      if (dots >= 0) kids.push(node('range', k, dml, [this.region(k, dots), this.region(dots + 1, dml)], { at: dots, name: 'forall' }));
    }
    k = dml;
    if (this.isWord(k, 'SAVE')) k += 2;
    if (this.upAt(k) === 'EXECUTE') {
      this.i = k;
      kids.push(this.execImmediate(k, k));
    } else {
      kids.push(this.sqlStatement(k, semi));
    }
    return this.stmtTo(semi, a, la, 'forall', kids);
  }

  private execImmediate(a: number, la: number): Node {
    const semi = this.need(this.i, SEMI);
    let k = this.i + 1;
    if (this.isWord(k, 'IMMEDIATE')) k++;
    const e = this.find(k, EXEC_END, semi);
    const kids: Node[] = [this.region(k, e >= 0 ? e : semi)];
    const using = this.find(k, USING, semi);
    if (using >= 0) {
      const ue = this.find(using + 1, USING_END, semi);
      this.binds(using + 1, ue >= 0 ? ue : semi, kids);
    }
    return this.stmtTo(semi, a, la, 'exec', kids);
  }

  private openStmt(a: number, la: number): Node {
    const semi = this.need(this.i, SEMI);
    const f = this.find(a + 1, FOR, semi);
    const kids: Node[] = [];
    if (f < 0) {
      if (a + 1 < semi) kids.push(this.region(a + 1, semi));
    } else {
      const using = this.find(f + 1, USING, semi);
      const qe = using >= 0 ? using : semi;
      kids.push(this.isQuery(f + 1) || (this.isOp(f + 1, '(') && this.isQuery(f + 2)) ? this.query(f + 1, qe) : this.region(f + 1, qe));
      if (using >= 0) this.binds(using + 1, semi, kids);
    }
    return this.stmtTo(semi, a, la, 'open', kids);
  }

  /** The bind arguments of USING in [a, b): [IN] [OUT] expression, comma separated. */
  private binds(a: number, b: number, kids: Node[]) {
    for (const [s, x] of this.commas(a, b)) {
      let s2 = s;
      while (this.isWord(s2, 'IN', 'OUT')) s2++;
      if (s2 < x) kids.push(this.region(s2, x));
    }
  }

  // ------------------------------------------------------------------ SQL

  /** A SQL statement in [a, b): node "sql" with the expressions and queries found in it. */
  sqlStatement(a: number, b: number): Node {
    return node('sql', a, b, this.sqlScan(a, b), { op: this.upAt(a) });
  }

  /** A query in [a, b) (with or without enclosing parentheses). */
  query(a: number, b: number): Node {
    return node('query', a, b, this.sqlScan(a, b));
  }

  /**
   * Clause-driven scan of SQL tokens in [a, b): parses select lists, conditions,
   * SET and VALUES lists, ORDER/GROUP BY lists and subqueries; skips names,
   * aliases, hints and options.
   */
  private sqlScan(a: number, b: number): Node[] {
    const out: Node[] = [];
    let state = '';
    let k = a;
    while (k < b) {
      const x = this.t[k];
      if (x.kind === 'op' && x.text === '(') {
        const m = this.match[k];
        if (m < 0 || m >= b) break;
        if (this.isQuery(k + 1)) {
          out.push(this.query(k + 1, m));
        } else if (state === 'from') {
          out.push(...this.sqlScan(k + 1, m));
        } else if (state === 'values' || state === 'other') {
          out.push(...this.exprList(k + 1, m));
        }
        k = m + 1;
        continue;
      }
      if (x.kind !== 'ident') {
        k++;
        continue;
      }
      const u = x.up;
      const next = SQL_STATE.get(u);
      if (next !== undefined) {
        state = next;
        k++;
        continue;
      }
      const nx = this.upAt(k + 1);
      switch (u) {
        case 'SELECT': {
          k++;
          while (this.isWordIn(k, b, 'DISTINCT', 'UNIQUE', 'ALL')) k++;
          k = this.list(k, b, out, true);
          state = 'list';
          continue;
        }
        case 'WHERE':
          if (nx === 'CURRENT' && this.upAt(k + 2) === 'OF') {
            k += 4;
            continue;
          }
        // falls through
        case 'HAVING': case 'ON':
          k = this.condAt(k + 1, b, out);
          state = 'cond';
          continue;
        case 'START':
          if (nx === 'WITH') {
            k = this.condAt(k + 2, b, out);
            continue;
          }
          break;
        case 'CONNECT':
          if (nx === 'BY') {
            k += 2;
            if (this.isWordIn(k, b, 'NOCYCLE')) k++;
            k = this.condAt(k, b, out);
            continue;
          }
          break;
        case 'WHEN':
          if (nx === 'MATCHED' || (nx === 'NOT' && this.upAt(k + 2) === 'MATCHED')) {
            k = this.find(k, THEN, b);
            if (k < 0) return out;
            k++;
            continue;
          }
          k = this.condAt(k + 1, b, out);
          continue;
        case 'BY':
          k = this.list(k + 1, b, out, false);
          continue;
        case 'SET':
          if (state === 'target') {
            k = this.setList(k + 1, b, out);
            continue;
          }
          break;
        case 'RETURNING': case 'RETURN':
          k = this.list(k + 1, b, out, false);
          state = 'into';
          continue;
        case 'OFFSET':
          k = this.condAt(k + 1, b, out, () => this.additive());
          continue;
        case 'FETCH':
          if (nx === 'FIRST' || nx === 'NEXT') {
            k = this.condAt(k + 2, b, out, () => this.additive());
            continue;
          }
          break;
        case 'FOR':
          if (nx === 'UPDATE') return out;
          break;
        case 'TABLE': case 'LATERAL': case 'THE':
          if (this.isOp(k + 1, '(')) {
            const m = this.match[k + 1];
            if (m > 0 && m < b) {
              out.push(this.isQuery(k + 2) ? this.query(k + 2, m) : this.region(k + 2, m));
              k = m + 1;
              continue;
            }
          }
          break;
      }
      // a table function in FROM: json_table(...), xmltable(...), pkg.f(...)
      if (state === 'from' && this.isOp(k + 1, '(') && !SQL_CLAUSE_END.has(u)) {
        const m = this.match[k + 1];
        if (m > 0 && m < b) {
          out.push(this.region(k, m + 1));
          k = m + 1;
          continue;
        }
      }
      k++;
    }
    return out;
  }

  private isWordIn(k: number, b: number, ...w: string[]): boolean {
    return k < b && this.t[k].kind === 'ident' && w.includes(this.t[k].up);
  }

  /** Expression list with optional aliases and ORDER BY modifiers; returns the index after it. */
  private list(k: number, b: number, out: Node[], aliases: boolean): number {
    for (;;) {
      if (k >= b) return k;
      if (this.isOp(k, '*')) {
        k++;
      } else {
        const n = this.parseAt(k, b, () => this.cond());
        if (!n) return k;
        out.push(n);
        k = n.b;
      }
      // modifiers and alias
      if (this.isWordIn(k, b, 'AS')) k += 2;
      else if (!aliases && this.isWordIn(k, b, 'ASC', 'DESC')) k++;
      if (this.isWordIn(k, b, 'NULLS')) k += 2;
      if (aliases && k < b && (this.t[k].kind === 'ident' || this.t[k].kind === 'qident') && !SQL_CLAUSE_END.has(this.t[k].up)
        && !NOT_OPERAND.has(this.t[k].up)) k++;
      if (k < b && this.isOp(k, ',')) {
        k++;
        continue;
      }
      return k;
    }
  }

  /** Parses a condition (or with f an expression) at k into out; returns the index after it. */
  private condAt(k: number, b: number, out: Node[], f = () => this.cond()): number {
    const n = this.parseAt(k, b, f);
    if (n) out.push(n);
    return n ? n.b : k;
  }

  /** UPDATE ... SET col = expr, (cols) = (subquery), ... */
  private setList(k: number, b: number, out: Node[]): number {
    for (;;) {
      const eq = this.find(k, EQ, b);
      if (eq < 0) return k;
      const n = this.condAt(eq + 1, b, out);
      if (n === eq + 1) return n;
      k = n;
      if (k < b && this.isOp(k, ',')) {
        k++;
        continue;
      }
      return k;
    }
  }

  /** Comma separated expressions in [a, b). */
  private exprList(a: number, b: number): Node[] {
    if (a >= b) return [];
    return this.commas(a, b).filter(([s, e]) => s < e).map(([s, e]) => this.region(s, e));
  }

  /** Runs a parse function at token k with limit b; null if it parses nothing. */
  private parseAt(k: number, b: number, f: () => Node | null): Node | null {
    const si = this.i;
    const sl = this.lim;
    this.i = k;
    this.lim = b;
    try {
      return f();
    } catch (e) {
      if (e instanceof ParseFailure) return null;
      throw e;
    } finally {
      this.i = si;
      this.lim = sl;
    }
  }

  // ---------------------------------------------------------- expressions

  /**
   * An expression or condition filling exactly [a, b). If the parser cannot read
   * all of it, the result is an opaque node with the parenthesised groups and
   * CASE expressions inside parsed on their own.
   */
  region(a: number, b: number): Node {
    if (a >= b) return node('opaque', a, b);
    const n = this.parseAt(a, b, () => {
      const r = this.cond();
      return r && this.i === b ? r : null;
    });
    return n ?? node('opaque', a, b, this.rescue(a, b));
  }

  private rescue(a: number, b: number): Node[] {
    const out: Node[] = [];
    for (let k = a; k < b; k++) {
      const x = this.t[k];
      if (x.kind === 'op' && x.text === '(') {
        const m = this.match[k];
        if (m < 0 || m >= b) break;
        if (this.isQuery(k + 1)) out.push(this.query(k + 1, m));
        else out.push(...this.exprList(k + 1, m));
        k = m;
      } else if (x.kind === 'ident' && x.up === 'CASE') {
        const e = this.caseEnd(k, b);
        if (e < 0) break;
        const n = this.parseAt(k, e + 1, () => this.caseExpr());
        if (n) out.push(n);
        k = e;
      }
    }
    return out;
  }

  /** Index of the END closing the CASE at k, or -1. */
  private caseEnd(k: number, b: number): number {
    let depth = 0;
    for (let j = k + 1; j < b; j++) {
      const x = this.t[j];
      if (x.kind === 'op' && x.text === '(') {
        const m = this.match[j];
        if (m < 0) return -1;
        j = m;
        continue;
      }
      if (x.kind !== 'ident') continue;
      if (x.up === 'CASE') depth++;
      else if (x.up === 'END') {
        if (depth === 0) return j;
        depth--;
      }
    }
    return -1;
  }

  cond(): Node | null {
    return this.logic('OR');
  }

  /** OR over AND over NOT, left to right. */
  private logic(op: 'OR' | 'AND'): Node | null {
    let l = op === 'OR' ? this.logic('AND') : this.not();
    if (!l) return null;
    while (this.at(op) && this.t[this.i].kind === 'ident') {
      const at = this.i++;
      const r = op === 'OR' ? this.logic('AND') : this.not();
      if (!r) return null;
      l = node('logic', l.a, r.b, [l, r], { op, at });
    }
    return l;
  }

  private not(): Node | null {
    if (this.isWord(this.i, 'NOT')) {
      const a = this.i++;
      const e = this.not();
      if (!e) return null;
      return node('not', a, e.b, [e]);
    }
    return this.predicate();
  }

  /** l with its right operand r (null: not parsed). */
  private two(k: NodeKind, l: Node, r: Node | null, op: string, at: number): Node | null {
    return r ? node(k, l.a, r.b, [l, r], { op, at }) : null;
  }

  private predicate(): Node | null {
    const l = this.additive();
    if (!l) return null;
    const x = this.t[this.i];
    if (!x || this.i >= this.lim) return l;
    if (x.kind === 'op' && CMP_OPS.has(x.text)) {
      const opTok = this.i++;
      if (!this.isWord(this.i, 'ANY', 'SOME', 'ALL')) return this.two('cmp', l, this.additive(), x.text, opTok);
      this.i++;
      return this.two('pred', l, this.primary(), x.text + ' ANY', opTok);
    }
    if (x.kind !== 'ident') return l;
    if (x.up === 'IS') {
      const isTok = this.i++;
      let notTok = -1;
      if (this.isWord(this.i, 'NOT')) notTok = this.i++;
      if (this.isWord(this.i, 'NULL')) {
        this.i++;
        return node('isnull', l.a, this.i, [l], { at: isTok, at2: notTok });
      }
      if (this.isWord(this.i, 'OF')) {
        this.i++;
        if (this.isWord(this.i, 'TYPE')) this.i++;
        if (!this.isOp(this.i, '(')) return null;
        this.i = this.close(this.i) + 1;
      } else if (this.isWord(this.i, 'DISTINCT')) {
        this.i++;
        if (!this.isWord(this.i, 'FROM')) return null;
        this.i++;
        return this.two('pred', l, this.additive(), 'IS DISTINCT FROM', isTok);
      } else if (this.isWord(this.i, 'A')) {
        this.i += 2;
      } else if (this.isWord(this.i, 'JSON')) {
        this.i++;
        while (this.isWord(this.i, 'FORMAT', 'JSON', 'STRICT', 'LAX', 'ALLOW', 'DISALLOW', 'SCALARS', 'WITH', 'WITHOUT', 'UNIQUE', 'KEYS', 'VALIDATE')) this.i++;
        if (this.isOp(this.i, '(')) this.i = this.close(this.i) + 1;
      } else if (this.isWord(this.i, 'EMPTY', 'NAN', 'INFINITE', 'PRESENT', 'DANGLING', 'TRUE', 'FALSE', 'UNKNOWN')) {
        this.i++;
      } else {
        return null;
      }
      return node('pred', l.a, this.i, [l], { op: 'IS', at: isTok });
    }
    let k = this.i;
    const neg = x.up === 'NOT';
    if (neg) k++;
    const w = this.upAt(k);
    if (k >= this.lim) return l;
    if (['LIKE', 'LIKEC', 'LIKE2', 'LIKE4'].includes(w)) {
      this.i = k + 1;
      const r = this.additive();
      if (!r) return null;
      const kids = [l, r];
      if (this.isWord(this.i, 'ESCAPE')) {
        this.i++;
        const e = this.additive();
        if (!e) return null;
        kids.push(e);
      }
      return node('pred', l.a, this.i, kids, { op: 'LIKE', at: k });
    }
    if (w === 'BETWEEN') {
      this.i = k + 1;
      const lo = this.additive();
      if (!lo || !this.isWord(this.i, 'AND')) return null;
      this.i++;
      const hi = this.additive();
      if (!hi) return null;
      return node('pred', l.a, hi.b, [l, lo, hi], { op: 'BETWEEN', at: k });
    }
    if (w === 'IN') {
      this.i = k + 1;
      return this.two('pred', l, this.primary(), 'IN', k);
    }
    if (w === 'MEMBER' || w === 'SUBMULTISET') {
      this.i = k + 1;
      if (this.isWord(this.i, 'OF')) this.i++;
      return this.two('pred', l, this.additive(), w, k);
    }
    return l;
  }

  additive(): Node | null {
    let l = this.mult();
    if (!l) return null;
    for (;;) {
      const x = this.t[this.i];
      if (!x || this.i >= this.lim || x.kind !== 'op' || !['+', '-', '||'].includes(x.text)) return l;
      const op = this.i++;
      const r = this.mult();
      if (!r) return null;
      l = node('bin', l.a, r.b, [l, r], { op: x.text, at: op });
    }
  }

  private mult(): Node | null {
    let l = this.unary();
    if (!l) return null;
    for (;;) {
      const x = this.t[this.i];
      // PL/SQL also knows MOD as an operator: n MOD 2
      const isMod = x && this.i < this.lim && x.kind === 'ident' && x.up === 'MOD' && !this.isOp(this.i + 1, '(');
      if (!x || this.i >= this.lim || (!isMod && (x.kind !== 'op' || !['*', '/'].includes(x.text)))) return l;
      const op = this.i++;
      const r = this.unary();
      if (!r) return null;
      l = node('bin', l.a, r.b, [l, r], { op: isMod ? 'MOD' : x.text, at: op });
    }
  }

  /** ** binds tighter than the sign: -2 ** 2 = -(2 ** 2); the exponent may carry a sign. */
  private power(): Node | null {
    const l = this.postfix();
    if (!l || !this.isOp(this.i, '**')) return l;
    const op = this.i++;
    return this.two('bin', l, this.unary(), '**', op);
  }

  private unary(): Node | null {
    const x = this.t[this.i];
    if (!x || this.i >= this.lim) return null;
    if ((x.kind === 'op' && (x.text === '-' || x.text === '+')) || (x.kind === 'ident' && ['PRIOR', 'CONNECT_BY_ROOT'].includes(x.up))) {
      const a = this.i++;
      const e = this.unary();
      if (!e) return null;
      return node('unary', a, e.b, [e], { op: x.up });
    }
    return this.power();
  }

  private postfix(): Node | null {
    let p = this.primary();
    if (!p) return null;
    for (;;) {
      if (this.isWord(this.i, 'AT') && this.isWord(this.i + 1, 'TIME') && this.isWord(this.i + 2, 'ZONE')) {
        this.i += 3;
        const z = this.primary();
        if (!z) return null;
        p = node('clause', p.a, z.b, [p, z], { op: 'AT TIME ZONE' });
      } else if (this.isWord(this.i, 'AT') && this.isWord(this.i + 1, 'LOCAL')) {
        this.i += 2;
        p = node('clause', p.a, this.i, [p], { op: 'AT LOCAL' });
      } else if (this.isWord(this.i, 'COLLATE')) {
        this.i += 2;
        p = node('clause', p.a, this.i, [p], { op: 'COLLATE' });
      } else if (this.isWord(this.i, 'MULTISET') && this.isWord(this.i + 1, 'UNION', 'INTERSECT', 'EXCEPT')) {
        this.i += 2;
        if (this.isWord(this.i, 'ALL', 'DISTINCT')) this.i++;
        const r = this.primary();
        if (!r) return null;
        p = node('clause', p.a, r.b, [p, r], { op: 'MULTISET' });
      } else {
        return p;
      }
    }
  }

  private primary(): Node | null {
    const a = this.i;
    const x = this.t[a];
    if (!x || a >= this.lim) return null;
    if (x.kind === 'op') {
      if (x.text === '(') {
        const m = this.close(a);
        if (m >= this.lim) return null;
        this.i = m + 1;
        if (this.isQuery(a + 1)) return node('query', a, m + 1, this.sqlScan(a + 1, m));
        const asAt = this.find(a + 1, AS, m);
        const items = asAt > a + 1 && this.isTypeName(asAt + 1, m) ? [node('cast', a + 1, m, [this.region(a + 1, asAt)], { op: 'AS' })] : this.exprList(a + 1, m);
        const p = node(items.length === 1 ? 'paren' : 'list', a, m + 1, items);
        // (self as t).method(...), (expr).attribute
        if (this.isOp(this.i, '.') && this.i + 1 < this.lim && ['ident', 'qident'].includes(this.t[this.i + 1].kind)) return this.nameChain(a, p);
        return p;
      }
      if (x.text === ':' && this.t[a + 1] && a + 1 < this.lim) {
        // a numbered bind (:1) is a value of its own
        if (this.t[a + 1].kind === 'number' && /^\d+$/.test(this.t[a + 1].text)) {
          this.i = a + 2;
          return node('lit', a, this.i);
        }
        this.i = a + 1;
        return this.nameChain(a);
      }
      return null;
    }
    if (x.kind === 'string' || x.kind === 'number' || (x.kind === 'ident' && (x.up === 'NULL' || x.up === 'TRUE' || x.up === 'FALSE'))) {
      this.i++;
      return node('lit', a, this.i);
    }
    if (x.kind === 'qident') return this.nameChain(a);
    if (x.kind !== 'ident') return null;
    const u = x.up;
    const next = this.t[a + 1];
    if ((u === 'DATE' || u === 'TIMESTAMP') && next?.kind === 'string') {
      this.i += 2;
      return node('lit', a, this.i);
    }
    if (u === 'INTERVAL' && next?.kind === 'string') {
      this.i += 2;
      while (this.isWord(this.i, 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'TO')) {
        this.i++;
        if (this.isOp(this.i, '(')) this.i = this.close(this.i) + 1;
      }
      return node('lit', a, this.i);
    }
    if (u === 'CASE') return this.caseExpr();
    if ((u === 'EXISTS' || u === 'CURSOR') && next?.text === '(') {
      const m = this.close(a + 1);
      if (m >= this.lim) return null;
      this.i = m + 1;
      return node(u === 'EXISTS' ? 'pred' : 'query', a, m + 1, [node('query', a + 1, m + 1, this.sqlScan(a + 2, m))], { op: u });
    }
    if (u === 'NEW' && (next?.kind === 'ident' || next?.kind === 'qident')) {
      this.i = a + 1;
      const n = this.nameChain(a + 1);
      if (!n) return null;
      n.a = a;
      return n;
    }
    if (NOT_OPERAND.has(u) && !(next?.text === '(' && !NOT_CALL.has(u))) return null;
    return this.nameChain(a);
  }

  /** name(.name)*[@link][%attr][(args)]..., starting at token `a` (the current position may be later for binds). */
  private nameChain(a: number, lead?: Node): Node | null {
    let call = -1;
    let attr = -1;
    let parts = 0;
    let simple = !lead;
    const args: Node[] = lead ? [lead] : [];
    // first identifier (or a parenthesised expression before .member)
    const first = this.t[lead ? a : this.i];
    if (!lead) {
      if (!first || (first.kind !== 'ident' && first.kind !== 'qident')) return null;
      this.i++;
    }
    parts++;
    for (;;) {
      if (this.isOp(this.i, '.') && this.i + 1 < this.lim) {
        const nx = this.t[this.i + 1];
        if (nx.kind === 'ident' || nx.kind === 'qident' || (nx.kind === 'op' && nx.text === '*')) {
          this.i += 2;
          parts++;
          if (call >= 0) simple = false;
          continue;
        }
        return null;
      }
      if (this.isOp(this.i, '@') && this.i + 1 < this.lim) {
        if (call >= 0) simple = false;
        this.i += 2;
        while (this.isOp(this.i, '.') && this.i + 1 < this.lim) this.i += 2;
        continue;
      }
      if (this.isOp(this.i, '%') && this.i + 1 < this.lim && this.t[this.i + 1].kind === 'ident') {
        attr = this.i;
        if (call >= 0) simple = false;
        this.i += 2;
        continue;
      }
      if (this.isOp(this.i, '(')) {
        const m = this.close(this.i);
        if (m >= this.lim) return null;
        // outer join marker (+)
        if (this.isOp(this.i + 1, '+') && m === this.i + 2) {
          this.i = m + 1;
          continue;
        }
        if (call < 0) call = this.i;
        else simple = false;
        args.push(...this.args(this.i + 1, m));
        this.i = m + 1;
        continue;
      }
      break;
    }
    // analytic and aggregate clauses
    for (;;) {
      if (this.isWord(this.i, 'IGNORE', 'RESPECT') && this.isWord(this.i + 1, 'NULLS')) {
        this.i += 2;
        continue;
      }
      if ((this.isWord(this.i, 'OVER', 'KEEP', 'FILTER') && this.isOp(this.i + 1, '('))
        || (this.isWord(this.i, 'WITHIN') && this.isWord(this.i + 1, 'GROUP') && this.isOp(this.i + 2, '('))) {
        const o = this.isWord(this.i, 'WITHIN') ? this.i + 2 : this.i + 1;
        const m = this.close(o);
        if (m >= this.lim) return null;
        args.push(...this.sqlScan(o + 1, m));
        this.i = m + 1;
        continue;
      }
      if (this.isWord(this.i, 'OVER') && this.t[this.i + 1]?.kind === 'ident') {
        this.i += 2;
        continue;
      }
      break;
    }
    if (call < 0) return node('name', a, this.i, args, { at: attr });
    if (parts > 1 || attr >= 0) simple = false;
    return node('call', a, this.i, args, { at2: call, name: simple ? first.up : undefined });
  }

  /** Whether [k, e) is a type name: name(.name)* with an optional (precision). */
  private isTypeName(k: number, e: number): boolean {
    if (k >= e || !['ident', 'qident'].includes(this.t[k].kind)) return false;
    k++;
    while (k + 1 < e && this.isOp(k, '.')) k += 2;
    if (k < e && this.isOp(k, '(')) k = this.match[k] + 1;
    return k === e;
  }

  /** Arguments in [a, b): each an "arg" node with its expression. */
  private args(a: number, b: number): Node[] {
    if (a >= b) return [];
    const out: Node[] = [];
    for (const [s, e] of this.commas(a, b)) {
      if (s >= e) continue;
      let k = s;
      while (this.isWordIn(k, e, 'DISTINCT', 'UNIQUE', 'ALL', 'LEADING', 'TRAILING', 'BOTH') && k + 1 < e) k++;
      if (this.isOp(k, '*') && k + 1 === e) {
        out.push(node('arg', s, e, [], { name: '*' }));
        continue;
      }
      let named = '';
      if ((this.t[k].kind === 'ident' || this.t[k].kind === 'qident') && this.isOp(k + 1, '=>')) {
        named = this.t[k].text;
        k += 2;
      }
      const full = this.parseAt(k, e, () => {
        const r = this.cond();
        return r && this.i === e ? r : null;
      });
      if (full) {
        out.push(node('arg', s, e, [full], { name: named }));
        continue;
      }
      // expression followed by a keyword clause: CAST(x AS t), JSON_VALUE(d, p RETURNING t), EXTRACT(YEAR FROM d)
      const head = this.parseAt(k, e, () => this.cond());
      const kids: Node[] = [];
      let rest = k;
      if (head && head.b < e && this.t[head.b].kind === 'ident') {
        kids.push(head);
        rest = head.b;
      }
      const from = this.find(rest, ARG_TAIL_FROM, e);
      if (from >= 0 && from + 1 < e) kids.push(this.region(from + 1, e));
      else kids.push(...this.rescue(rest, e));
      const known = rest > k && ARG_TAIL.has(this.t[rest].up);
      out.push(node('arg', s, e, [node(known ? 'clause' : 'opaque', k, e, kids)], { name: named }));
    }
    return out;
  }

  private caseExpr(): Node | null {
    const a = this.i;
    const end = this.caseEnd(a, this.lim);
    if (end < 0) return null;
    const kids: Node[] = [];
    let k = a + 1;
    if (this.upAt(k) !== 'WHEN') {
      const w = this.find(k, WHEN, end);
      if (w < 0) return null;
      kids.push(this.region(k, w));
      k = w;
    }
    while (this.upAt(k) === 'WHEN' && k < end) {
      const then = this.find(k + 1, THEN, end);
      if (then < 0) return null;
      const re = this.find(then + 1, CASE_PARTS, end + 1);
      if (re < 0) return null;
      kids.push(node('when', k, re, [this.region(k + 1, then), this.region(then + 1, re)], { at: then }));
      k = re;
    }
    if (this.upAt(k) === 'ELSE' && k < end) {
      kids.push(node('else', k, end, [this.region(k + 1, end)]));
      k = end;
    }
    if (k !== end) return null;
    this.i = end + 1;
    return node('case', a, end + 1, kids, { name: this.upAt(a + 1) === 'WHEN' ? 'searched' : 'simple' });
  }
}

/** Calls f for every node below n (pre-order) with its parent. */
export function walk(n: Node, f: (n: Node, parent: Node | null) => void | false, parent: Node | null = null): void {
  if (f(n, parent) === false) return;
  for (const c of n.kids) walk(c, f, n);
}
