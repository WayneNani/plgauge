/**
 * Instrumenter for PL/SQL program units, on the syntax tree of the core parser.
 *
 * The tree gives the control-flow structure (blocks, IF, CASE, loops, EXIT/CONTINUE
 * WHEN, exception handlers, nested subprograms), the boolean structure of conditions
 * (AND / OR / NOT, parentheses; BETWEEN ... AND stays one condition) and the searched
 * CASE expressions inside statements and SQL. Simple CASE expressions (CASE x WHEN 1 …) get a
 * branch probe in front of every result: THEN CASE WHEN cov$.bt(id) THEN result END; the probe
 * is always TRUE, so value, type and evaluation order stay. Compound triggers and the
 * WHEN/WHILE filters of FOR loops (21c) are measured as well.
 *
 * Instrumentation is purely additive and never inserts line breaks, so line numbers in
 * error stacks and reports stay identical to the original source. Probe ids are given
 * in source order, exactly as by the token parser this replaces (plan phase 3), so the
 * instrumented text is the same byte for byte.
 */
import { matchParens, parseUnit, ParseFailure, tokenize, type Node, type Token } from '@plgauge/core';
import type {
  Branch, CondNode, Condition, Construct, ConstructKind, Decision, DecisionKind,
  IdCounters, LoopProbe, ObjectMap, Span, StatementProbe,
} from './model.js';

export interface InstrumentOptions {
  /** Instrument conditions inside SQL statements (requires Oracle 23ai / 26ai BOOLEAN in SQL). */
  sqlProbes: boolean;
  /** Name of the runtime package. */
  runtime?: string;
  /** The unit's spec declares PRAGMA RESTRICT_REFERENCES (see Instrumenter.q). */
  restricted?: boolean;
}

export interface InstrumentResult {
  instrumented: string;
  map: ObjectMap;
}

export class ParseError extends Error {
  constructor(message: string, public line: number) {
    super(`${message} (line ${line})`);
  }
}

interface Edit {
  pos: number;
  text: string;
  gen: number;
}

/** First words of statements whose CASE expressions are scanned as SQL. */
const SQL_START = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'OPEN', 'FORALL']);
const SQL_CLAUSES: Record<string, string> = {
  SELECT: 'select', FROM: 'from', WHERE: 'where', GROUP: 'group', HAVING: 'having', ORDER: 'order',
  SET: 'set', VALUES: 'values', ON: 'on', CONNECT: 'where', START: 'where', INTO: 'into',
  RETURNING: 'returning', RETURN: 'returning', USING: 'using', FETCH: 'fetch', OFFSET: 'fetch',
};
/** Clauses in which CASE expressions are instrumented. Predicates (WHERE, ON, ...) are left alone on purpose. */
const SQL_SAFE_CLAUSES = new Set(['select', 'set', 'values']);
const MAX_VECTOR_CONDS = 30;

export function instrument(source: string, owner: string, ids: IdCounters, opts: InstrumentOptions): InstrumentResult {
  const p = new Instrumenter(source, owner, ids, opts);
  p.run();
  return { instrumented: p.applyEdits(), map: p.map };
}

class Instrumenter {
  private t: Token[] = [];
  private unit!: Node;
  private match: Int32Array = new Int32Array(0);
  private edits: Edit[] = [];
  private gen = 0;
  private rt: string;
  private nfPending = false;
  private nfRange = false;
  private nfNest = 0;
  private pendingInsert: number | null = null;
  map: ObjectMap;

  constructor(private src: string, owner: string, private ids: IdCounters, private opts: InstrumentOptions) {
    this.rt = opts.runtime ?? 'cov$';
    // code under PRAGMA RESTRICT_REFERENCES (…, RNPS, WNPS) may not call the q… probes in its SQL
    // (PLS-00452): there the probes with the package's full purity, at the price of parallel slaves
    this.q = opts.restricted || /\bRESTRICT_REFERENCES\b/i.test(src) ? '' : 'q';
    this.map = { owner, name: '', type: '', source: src, statements: [], decisions: [], constructs: [], loops: [], gaps: [] };
  }

  run() {
    this.precheck();
    try {
      const r = parseUnit(this.src);
      this.t = r.tokens;
      this.unit = r.unit;
    } catch (e) {
      if (e instanceof ParseFailure) throw new ParseError(e.message.replace(/ \(\w+ \d+\)$/, ''), e.line);
      throw e;
    }
    this.match = matchParens(this.t);
    const u = this.unit;
    this.map.type = u.op!;
    this.readName();
    switch (u.op) {
      case 'PACKAGE BODY':
        this.decls(u.kids[0]);
        if (u.kids[1]) this.body(u.kids[1]);
        break;
      case 'TYPE BODY':
        for (const k of u.kids[0].kids) if (k.k === 'subprog') this.subprog(k);
        break;
      case 'PROCEDURE': case 'FUNCTION':
        this.subprog(u.kids[0]);
        break;
      case 'TRIGGER': {
        const begin = u.kids.findIndex((k) => k.k === 'decls' || k.k === 'body');
        // a CALL trigger has no PL/SQL of its own
        if (begin < 0) {
          this.gap(this.t[u.a].line, 'CALL trigger: no PL/SQL body to measure');
          break;
        }
        const first = u.kids[begin];
        const declIdx = first.k === 'decls' ? first.a - 1 : first.a; // DECLARE token
        for (let k = u.a; k < declIdx; k++) {
          if (this.t[k].up === 'WHEN') this.gap(this.t[k].line, 'WHEN clause of the trigger is not measured');
          if (this.t[k].up === '(' && this.match[k] > 0) k = this.match[k];
        }
        for (const k of u.kids.slice(begin)) {
          if (k.k === 'decls') this.decls(k);
          else if (k.k === 'body') this.body(k);
          else if (k.k === 'section') this.body(k.kids[0]); // timing point of a compound trigger
        }
        break;
      }
    }
  }

  /** Units the instrumenter refuses, with the messages of the token parser. */
  private precheck() {
    const toks = tokenize(this.src).filter((x) => x.kind !== 'trivia');
    let k = 0;
    while (['CREATE', 'OR', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING'].includes(toks[k]?.up)) k++;
    const kind = toks[k]?.up;
    if (kind === 'PACKAGE' && toks[k + 1]?.up !== 'BODY') throw new ParseError('Package specifications are not instrumented', toks[k].line);
    if (!['PACKAGE', 'PROCEDURE', 'FUNCTION', 'TYPE', 'TRIGGER'].includes(kind ?? '')) {
      throw new ParseError(`Unsupported object type "${toks[k]?.text ?? ''}"`, toks[k]?.line ?? 1);
    }
  }

  private readName() {
    let k = this.unit.a;
    while (['CREATE', 'OR', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING', 'PACKAGE', 'TYPE', 'BODY', 'PROCEDURE', 'FUNCTION', 'TRIGGER'].includes(this.t[k].up)) k++;
    let name = this.t[k].text;
    if (this.t[k + 1]?.up === '.') name = this.t[k + 2].text;
    this.map.name = name.startsWith('"') ? name.slice(1, -1) : name.toUpperCase();
  }

  // ---------------------------------------------------------------- helpers

  private ins(pos: number, text: string) {
    if (text.includes('\n')) throw new Error('Instrumentation must not insert line breaks');
    this.edits.push({ pos, text, gen: this.gen++ });
  }
  private gap(line: number, reason: string) {
    if (!this.map.gaps.some((g) => g.line === line && g.reason === reason)) this.map.gaps.push({ line, reason });
  }
  private endOf(tok: Token): { line: number; col: number } {
    const nl = tok.text.lastIndexOf('\n');
    if (nl < 0) return { line: tok.line, col: tok.col + tok.text.length };
    return { line: tok.line + (tok.text.match(/\n/g)?.length ?? 0), col: tok.text.length - nl };
  }
  private span(a: number, bInclusive: number): Span {
    const ta = this.t[a];
    const tb = this.t[bInclusive];
    const e = this.endOf(tb);
    return { start: ta.start, end: tb.end, line: ta.line, col: ta.col, endLine: e.line, endCol: e.col };
  }
  private text(a: number, bInclusive: number): string {
    return this.src.slice(this.t[a].start, this.t[bInclusive].end);
  }
  /** The text on one line, for a branch label. */
  private label(a: number, bInclusive: number): string {
    return this.text(a, bInclusive).replace(/\s+/g, ' ');
  }
  private caseGaps(a: number, b: number, where: string) {
    for (let k = a; k < b; k++) if (this.t[k].up === 'CASE' && this.t[k].kind === 'ident') this.gap(this.t[k].line, `CASE expression in ${where} is not measured`);
  }
  private get nf(): boolean {
    return this.nfPending || this.nfRange || this.nfNest > 0;
  }
  private br(label: string, tok: Token, more: Partial<Branch> = {}): Branch {
    return { label, line: tok.line, col: tok.col, nf: false, ...more };
  }
  private newConstruct(kind: ConstructKind, ctx: 'plsql' | 'sql', tok: Token): Construct {
    const c: Construct = { id: this.ids.construct++, kind, ctx, line: tok.line, col: tok.col, branches: [] };
    this.map.constructs.push(c);
    return c;
  }

  // ------------------------------------------------------------- structure

  private subprog(sp: Node) {
    const decls = sp.kids.find((k) => k.k === 'decls');
    const body = sp.kids.find((k) => k.k === 'body');
    if (decls) this.decls(decls);
    if (body) this.body(body);
  }

  private decls(n: Node) {
    for (const d of n.kids) {
      if (d.k === 'subprog') this.subprog(d);
      else if (d.k === 'cursor') {
        const q = d.kids.find((k) => k.k === 'query');
        if (q) this.scanRegion(q.a, q.b, 'sql', 'start', [q]);
      } else if (d.k === 'decl' && d.kids.length) {
        const v = d.kids[0];
        this.scanRegion(v.a, v.b, 'plsql', 'plsql', [v]);
      }
    }
  }

  /** BEGIN statements [EXCEPTION handlers] END */
  private body(b: Node) {
    this.seq(b.kids[0]);
    const handlers = b.kids.slice(1);
    if (!handlers.length) return;
    const c = this.newConstruct('handlers', 'plsql', this.t[handlers[0].a - 1]);
    for (const h of handlers) {
      const whenIdx = h.a;
      const thenIdx = h.at!;
      const id = this.ids.branch++;
      this.ins(this.t[thenIdx].end, ` ${this.rt}.b(${id});`);
      const r = this.seq(h.kids[0]);
      c.branches.push(this.br(`WHEN ${this.label(whenIdx + 1, thenIdx - 1)}`, this.t[whenIdx], { nf: r.firstNF, probe: id }));
    }
  }

  // ------------------------------------------------------------ statements

  private seq(n: Node): { firstNF: boolean } {
    let firstNF: boolean | null = null;
    // PRAGMA COVERAGE('NOT_FEASIBLE') marks the rest of the current statement sequence (its basic block).
    let listNf = 0;
    try {
      for (const s of n.kids) {
        const nf = this.statement(s);
        if (nf === null && this.nfPending) {
          this.nfPending = false;
          this.nfNest++;
          listNf++;
        }
        if (nf !== null && firstNF === null) firstNF = nf;
      }
    } finally {
      this.nfNest -= listNf;
    }
    return { firstNF: firstNF ?? false };
  }

  /** Returns the not-feasible flag of the statement, or null for a pragma or a lone label. */
  private statement(s: Node): boolean | null {
    let insertPos = this.t[s.at2 ?? s.a].start;
    if (s.k === 'pragma') {
      if (this.t[s.a + 1]?.up === 'COVERAGE') {
        const arg = this.t[s.a + 3]?.text.toUpperCase() ?? '';
        if (arg === "'NOT_FEASIBLE'") this.nfPending = true;
        else if (arg === "'NOT_FEASIBLE_START'") this.nfRange = true;
        else if (arg === "'NOT_FEASIBLE_END'") this.nfRange = false;
      } else {
        // e.g. PRAGMA INLINE must stay directly in front of its statement
        this.pendingInsert ??= insertPos;
      }
      return null;
    }
    if (this.pendingInsert !== null) {
      insertPos = this.pendingInsert;
      this.pendingInsert = null;
    }
    if (s.k !== 'stmt') return null;
    // a labelled statement: the probe after the label, where a GOTO lands (a loop, a block and a
    // CASE statement keep it in front: the label is theirs, END and EXIT name it, a block's
    // declarations are qualified with it)
    if (s.at2 !== undefined && s.at2 !== s.a && s.op !== 'loop' && s.op !== 'block' && s.op !== 'case' && insertPos === this.t[s.at2].start) insertPos = this.t[s.a].start;
    const first = this.t[s.a];
    const nf = this.nf;
    this.nfPending = false;
    const stmt: StatementProbe = { id: this.ids.stmt++, line: first.line, endLine: first.line, kind: '', nf };
    this.map.statements.push(stmt);
    this.ins(insertPos, `${this.rt}.s(${stmt.id});`);
    if (nf) this.nfNest++;
    try {
      stmt.kind = this.dispatch(s, insertPos);
    } finally {
      if (nf) this.nfNest--;
    }
    const end = this.endOf(this.t[s.b - 1]);
    Object.assign(stmt, { endLine: end.line, col: first.col, endCol: end.col });
    return nf;
  }

  private dispatch(s: Node, insertPos: number): string {
    const u = this.t[s.a].up;
    const up = (k: number) => this.t[s.a + k]?.up ?? '';
    if (up(1) === ':=' || (up(1) === '.' && up(3) === ':=')) {
      this.scanRegion(s.a, s.b - 1, 'plsql', 'plsql', s.kids);
      return 'assignment';
    }
    switch (u) {
      case 'IF': this.ifStmt(s); return 'if';
      case 'CASE': this.caseStmt(s); return 'case';
      case 'LOOP': case 'WHILE': case 'FOR': this.loop(s, insertPos); return 'loop';
      case 'EXIT': case 'CONTINUE': this.exitWhen(s); return u.toLowerCase();
      case 'BEGIN': case 'DECLARE':
        for (const k of s.kids) {
          if (k.k === 'decls') this.decls(k);
          else this.body(k);
        }
        return 'block';
      case 'EXECUTE':
        this.gap(this.t[s.a].line, 'Dynamic SQL (EXECUTE IMMEDIATE) is not instrumented');
        return 'execute-immediate';
      default:
        if (SQL_START.has(u)) {
          this.scanRegion(s.a, s.b - 1, 'sql', 'start', s.kids);
          return 'sql';
        }
        this.scanRegion(s.a, s.b - 1, 'plsql', 'plsql', s.kids);
        return u === 'RETURN' ? 'return' : u === 'RAISE' ? 'raise' : 'call';
    }
  }

  private ifStmt(s: Node) {
    const c = this.newConstruct('if', 'plsql', this.t[s.a]);
    let last: Decision | null = null;
    let endIdx = s.b - 3;
    for (const k of s.kids) {
      if (k.k === 'branch') {
        const kind: DecisionKind = this.t[k.a].up === 'IF' ? 'if' : 'elsif';
        last = this.decision(kind, k.kids[0], 'plsql');
        const nf = this.seq(k.kids[1]).firstNF;
        c.branches.push(this.br(kind === 'if' ? 'THEN' : 'ELSIF … THEN', this.t[k.a], { nf, derived: { decision: last!.id, outcome: 'T' } }));
        endIdx = k.b;
      } else {
        const nf = this.seq(k.kids[0]).firstNF;
        c.branches.push(this.br('ELSE', this.t[k.a], { nf, derived: { decision: last!.id, outcome: 'notT' } }));
        return;
      }
    }
    c.branches.push(this.br('ELSE (implicit)', this.t[endIdx], { derived: { decision: last!.id, outcome: 'notT' } }));
  }

  private caseStmt(s: Node) {
    const searched = s.name === 'searched';
    const c = this.newConstruct('case', 'plsql', this.t[s.a]);
    let last: Decision | null = null;
    let endIdx = -1;
    // searched: derived from the WHEN conditions; simple: a probe after THEN / ELSE, or as the implicit ELSE
    const arm = (label: string, tok: Token, cond: Node | null, pos: number, probe: (id: number) => string, body?: Node) => {
      const br = this.br(label, tok);
      if (searched) {
        if (cond) last = this.decision('case-when', cond, 'plsql');
        br.derived = { decision: last!.id, outcome: cond ? 'T' : 'notT' };
      } else {
        br.probe = this.ids.branch++;
        this.ins(pos, probe(br.probe));
      }
      if (body) br.nf = this.seq(body).firstNF;
      c.branches.push(br);
    };
    for (const k of s.kids) {
      if (k.k === 'branch') {
        arm(`WHEN ${this.label(k.a + 1, k.at! - 1)}`, this.t[k.a], k.kids[0], this.t[k.at!].end, (id) => ` ${this.rt}.b(${id});`, k.kids[1]);
        endIdx = k.b;
      } else if (k.k === 'else') {
        arm('ELSE', this.t[k.a], null, this.t[k.a].end, (id) => ` ${this.rt}.b(${id});`, k.kids[0]);
        return;
      }
    }
    arm('ELSE (implicit → CASE_NOT_FOUND)', this.t[endIdx], null, this.t[endIdx].start, (id) => `else ${this.rt}.b(${id}); raise case_not_found; `);
  }

  private loop(s: Node, insertPos: number) {
    const first = this.t[s.a];
    const loop: LoopProbe = { id: this.ids.loop++, kind: 'loop', line: first.line, endLine: first.line, nf: this.nf };
    this.map.loops.push(loop);
    const loopIdx = s.at!;
    if (first.up === 'WHILE') {
      loop.kind = 'while';
      this.twoWay('while', s.kids[0], first, 'Condition TRUE → iteration', 'Condition not TRUE → end');
    } else if (first.up === 'FOR') {
      if (this.t.slice(s.a + 1, loopIdx).some((t) => t.up === 'SELECT' || t.up === 'WITH')) loop.kind = 'cursor-for';
      if (loop.kind === 'cursor-for') this.scanRegion(s.a + 1, loopIdx, 'sql', 'start', s.kids.filter((k) => k.k !== 'seq' && k.k !== 'branch'));
      else {
        loop.kind = 'for';
        this.caseGaps(s.a + 1, loopIdx, 'loop bounds');
      }
      // 21c: FOR i IN … WHEN cond (skips the iteration) / WHILE cond (ends the loop)
      for (const f of s.kids.filter((k) => k.k === 'branch')) {
        const when = f.name === 'for-when';
        this.twoWay(when ? 'for-when' : 'for-while', f.kids[0], this.t[f.a], when ? 'WHEN TRUE → iteration' : 'WHILE TRUE → continue',
          when ? 'WHEN not TRUE → skipped' : 'WHILE not TRUE → end');
      }
    }
    this.ins(insertPos, `${this.rt}.le(${loop.id});`);
    this.ins(this.t[loopIdx].end, ` ${this.rt}.li(${loop.id});`);
    this.seq(s.kids[s.kids.length - 1]);
    const semi = this.t[s.b - 1];
    this.ins(semi.end, ` ${this.rt}.lx(${loop.id});`);
    loop.endLine = semi.line;
  }

  private exitWhen(s: Node) {
    const kw = this.t[s.a];
    if (s.at! < 0) return;
    const exit = kw.up === 'EXIT';
    this.twoWay(exit ? 'exit-when' : 'continue-when', s.kids[0], kw, `TRUE → ${exit ? 'exit loop' : 'next iteration'}`, 'not TRUE → continue');
  }

  /** A construct of one decision with its two outcomes (WHILE, EXIT/CONTINUE WHEN, FOR … WHEN/WHILE). */
  private twoWay(kind: ConstructKind & DecisionKind, cond: Node, tok: Token, yes: string, no: string) {
    const c = this.newConstruct(kind, 'plsql', tok);
    const d = this.decision(kind, cond, 'plsql')!;
    c.branches.push(this.br(yes, tok, { derived: { decision: d.id, outcome: 'T' } }), this.br(no, tok, { derived: { decision: d.id, outcome: 'notT' } }));
  }

  // -------------------------------------------------------------- decisions

  /** Prefix of the probes in SQL: 'q' (see the runtime), '' in code under RESTRICT_REFERENCES. */
  private q: string;

  /** The context of the condition being wrapped: in SQL the probes are the q… variants. */
  private probeCtx: 'plsql' | 'sql' = 'plsql';

  /** Wraps a condition with decision and condition probes. */
  private decision(kind: DecisionKind, cond: Node, ctx: 'plsql' | 'sql'): Decision | null {
    const { a, b } = cond;
    if (b <= a) throw new ParseError('Empty condition', this.t[a]?.line ?? 0);
    if (ctx === 'sql' && !this.opts.sqlProbes) return null;
    const id = this.ids.dec++;
    const vectors = ctx === 'plsql';
    const rt = this.rt;
    this.ins(this.t[a].start, vectors ? `${rt}.d(${id},${rt}.o(${id}) and (` : `${rt}.${this.q}d(${id},`);
    const conds: Condition[] = [];
    const outer = this.probeCtx;
    this.probeCtx = ctx;
    let tree: CondNode;
    try {
      tree = cond.k === 'opaque' ? this.tokenOr(a, b, id, conds, true) : this.condTree(cond, id, conds, true);
    } finally {
      this.probeCtx = outer;
    }
    this.ins(this.t[b - 1].end, vectors ? '))' : ')');
    const d: Decision = {
      id, kind, ctx, span: this.span(a, b - 1), text: this.text(a, b - 1), conds, tree,
      vectors: vectors && conds.length <= MAX_VECTOR_CONDS, nf: this.nf,
    };
    this.map.decisions.push(d);
    // a CASE inside the condition gets no probes of its own: say so
    this.caseGaps(a, b, 'a condition');
    return d;
  }

  // `pos` is the polarity: false under an odd number of NOTs (see runtime functions c / n).
  private condTree(n: Node, d: number, conds: Condition[], pos: boolean): CondNode {
    if (n.k === 'logic') {
      const parts: Node[] = [];
      const flat = (x: Node) => {
        if (x.k === 'logic' && x.op === n.op) {
          flat(x.kids[0]);
          parts.push(x.kids[1]);
        } else parts.push(x);
      };
      flat(n);
      return { t: n.op === 'AND' ? 'and' : 'or', c: parts.map((p) => this.condTree(p, d, conds, pos)) };
    }
    if (n.k === 'not') return { t: 'not', c: [this.condTree(n.kids[0], d, conds, !pos)] };
    if (n.k === 'paren' && n.kids.length === 1 && (n.kids[0].k === 'logic' || n.kids[0].k === 'not')) {
      return this.condTree(n.kids[0], d, conds, pos);
    }
    if (n.k === 'paren' && n.kids.length === 1 && n.kids[0].k === 'opaque' && this.groupIsBoolean(n.a + 1, n.b - 1)) {
      return this.tokenOr(n.a + 1, n.b - 1, d, conds, pos);
    }
    return this.atom(n.a, n.b, d, conds, pos);
  }

  private atom(j: number, k: number, d: number, conds: Condition[], pos: boolean): CondNode {
    const i = conds.length + 1;
    conds.push({ i, text: this.text(j, k - 1), span: this.span(j, k - 1) });
    // the runtime keys a condition as d*256 + i*4 + v: from the 64th on it would hit the next
    // decision's; those conditions go unmeasured
    if (i > 63) {
      if (i === 64) this.gap(this.t[j].line, 'Decision with more than 63 conditions: the rest are not measured');
      return { t: 'cond', i };
    }
    this.ins(this.t[j].start, `${this.rt}.${this.probeCtx === 'sql' ? this.q : ''}${pos ? 'c' : 'n'}(${d},${i},`);
    this.ins(this.t[k - 1].end, ')');
    return { t: 'cond', i };
  }

  // Token-level fallback for conditions the parser could not read completely:
  // atoms run to the next AND / OR at depth 0 (BETWEEN x AND y and CASE ... END stay inside).

  private upAt(j: number): string {
    return this.t[j]?.up ?? '';
  }

  private tokenOr(j: number, end: number, d: number, conds: Condition[], pos: boolean): CondNode {
    const [node, k] = this.pLogic('or', j, end, d, conds, pos);
    if (k !== end) throw new ParseError(`Condition not fully understood at "${this.t[k].text}"`, this.t[k].line);
    return node;
  }

  /** OR over AND over NOT. */
  private pLogic(t: 'or' | 'and', j: number, end: number, d: number, conds: Condition[], pos: boolean): [CondNode, number] {
    const parts: CondNode[] = [];
    let [n, k] = t === 'or' ? this.pLogic('and', j, end, d, conds, pos) : this.pNot(j, end, d, conds, pos);
    parts.push(n);
    while (k < end && this.upAt(k) === (t === 'or' ? 'OR' : 'AND')) {
      [n, k] = t === 'or' ? this.pLogic('and', k + 1, end, d, conds, pos) : this.pNot(k + 1, end, d, conds, pos);
      parts.push(n);
    }
    return [parts.length === 1 ? parts[0] : { t, c: parts }, k];
  }

  private pNot(j: number, end: number, d: number, conds: Condition[], pos: boolean): [CondNode, number] {
    if (this.upAt(j) === 'NOT') {
      const [n, k] = this.pNot(j + 1, end, d, conds, !pos);
      return [{ t: 'not', c: [n] }, k];
    }
    return this.pPrimary(j, end, d, conds, pos);
  }

  private pPrimary(j: number, end: number, d: number, conds: Condition[], pos: boolean): [CondNode, number] {
    if (j >= end) throw new ParseError('Operand missing in condition', this.t[Math.min(j, this.t.length - 1)].line);
    if (this.t[j].up === '(' && this.t[j].kind === 'op') {
      const m = this.match[j];
      if (m < 0) throw new ParseError('Closing parenthesis missing', this.t[j].line);
      const after = this.upAt(m + 1);
      if (m < end && (m + 1 === end || after === 'AND' || after === 'OR') && this.groupIsBoolean(j + 1, m)) {
        const [n, k] = this.pLogic('or', j + 1, m, d, conds, pos);
        if (k !== m) throw new ParseError('Parenthesized expression not understood', this.t[k].line);
        return [n, m + 1];
      }
    }
    const k = this.atomEnd(j, end);
    if (k === j) throw new ParseError(`Operand missing before "${this.t[k].text}"`, this.t[k].line);
    return [this.atom(j, k, d, conds, pos), k];
  }

  /** Where the atom at j ends: the next AND / OR at depth 0 (BETWEEN x AND y and CASE ... END inside), or end. */
  private atomEnd(j: number, end: number): number {
    let depth = 0;
    let caseDepth = 0;
    let between = false;
    for (let k = j; k < end; k++) {
      const tk = this.t[k];
      const u = tk.up;
      if (depth === 0 && caseDepth === 0 && tk.kind === 'ident') {
        if (u === 'OR' || (u === 'AND' && !between)) return k;
        if (u === 'AND') between = false;
        if (u === 'BETWEEN') between = true;
      }
      if (tk.kind === 'op' && u === '(') depth++;
      else if (tk.kind === 'op' && u === ')') depth--;
      else if (tk.kind === 'ident' && u === 'CASE') caseDepth++;
      else if (tk.kind === 'ident' && u === 'END' && caseDepth > 0) caseDepth--;
    }
    return end;
  }

  /** True if the token range is a boolean combination (top-level AND/OR or leading NOT). */
  private groupIsBoolean(a: number, b: number): boolean {
    return this.upAt(a) === 'NOT' || this.atomEnd(a, b) < b;
  }

  // ------------------------------------------------------ CASE expressions

  /**
   * Instruments the searched CASE expressions in the token region [a, b), taken from
   * the syntax tree below `roots`. The SQL clause of each CASE is tracked on the tokens:
   * only CASE expressions in the select list, SET and VALUES clauses are touched;
   * predicates would change execution plans.
   */
  private scanRegion(a: number, b: number, ctx: 'plsql' | 'sql', clause: string, roots: Node[]) {
    const cases = new Map<number, Node>();
    const collect = (n: Node) => {
      if (n.k === 'case') cases.set(n.a, n);
      for (const k of n.kids) collect(k);
    };
    roots.forEach(collect);
    // GROUP BY, or SELECT DISTINCT … ORDER BY: the expressions must stay identical to the selected ones (ORA-01791)
    const seen = new Set<string>();
    if (ctx === 'sql') for (let k = a; k < b - 1; k++) seen.add(`${this.t[k].up} ${this.t[k + 1].up}`);
    const hasGroupBy = seen.has('GROUP BY') || ((seen.has('SELECT DISTINCT') || seen.has('SELECT UNIQUE')) && seen.has('ORDER BY'));
    const stack = [clause];
    for (let k = a; k < b; k++) {
      const tk = this.t[k];
      const u = tk.up;
      if (tk.kind === 'op' && u === '(') {
        stack.push(stack[stack.length - 1]);
        continue;
      }
      if (tk.kind === 'op' && u === ')') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (tk.kind !== 'ident') continue;
      if (ctx === 'sql' && SQL_CLAUSES[u]) {
        stack[stack.length - 1] = SQL_CLAUSES[u];
        continue;
      }
      if (u !== 'CASE') continue;
      const cl = stack[stack.length - 1];
      const c = cases.get(k);
      const skip = ctx !== 'sql' ? '' : !this.opts.sqlProbes ? 'CASE expression in SQL: measurable only from Oracle 23ai/26ai on'
        : !SQL_SAFE_CLAUSES.has(cl) ? `CASE in ${cl.toUpperCase()} clause deliberately not measured (would change the execution plan)`
        : cl === 'select' && hasGroupBy ? 'CASE in query with GROUP BY or DISTINCT … ORDER BY not measured (expressions must stay identical)' : '';
      if (skip || !c) {
        this.gap(tk.line, skip || 'CASE expression not understood, not measured');
        continue;
      }
      if (this.upAt(k + 1) === 'WHEN') this.caseExpr(c, ctx, cl);
      else this.simpleCaseExpr(c, ctx, cl);
      k = c.b - 1;
    }
  }

  private caseExpr(n: Node, ctx: 'plsql' | 'sql', clause: string) {
    const c = this.newConstruct('case-expr', ctx, this.t[n.a]);
    let last: Decision | null = null;
    for (const k of n.kids) {
      if (k.k === 'when') {
        const [cond, res] = k.kids;
        last = this.decision('case-expr-when', cond, ctx)!;
        c.branches.push(this.br(`WHEN ${this.label(cond.a, cond.b - 1)}`, this.t[k.a], { derived: { decision: last.id, outcome: 'T' } }));
        this.scanRegion(res.a, res.b, ctx, clause, [res]);
      } else if (k.k === 'else') {
        const res = k.kids[0];
        this.scanRegion(res.a, res.b, ctx, clause, [res]);
        c.branches.push(this.br('ELSE', this.t[k.a], { derived: { decision: last!.id, outcome: 'notT' } }));
        return;
      }
    }
    c.branches.push(this.br('ELSE (implicit → NULL)', this.t[n.b - 1], { derived: { decision: last!.id, outcome: 'notT' } }));
  }

  /** CASE x WHEN v THEN r …: a branch probe in front of every result, also for the implicit ELSE. */
  private simpleCaseExpr(n: Node, ctx: 'plsql' | 'sql', clause: string) {
    const c = this.newConstruct('case-expr', ctx, this.t[n.a]);
    const rt = this.rt;
    const bt = ctx === 'sql' ? `${this.q}bt` : 'bt';
    // A CASE whose results are all NULL does not compile (PLS-00617): a probe around a NULL
    // result, and the probe of the implicit ELSE, get a dead ELSE with the shortest real
    // result of this CASE for the type. It never runs, the probe is always TRUE. Tokens only:
    // no comments, no line breaks.
    const isNull = (r: Node) => r.b - r.a === 1 && this.t[r.a].up === 'NULL';
    const real = n.kids.flatMap((k) => (k.k === 'when' ? [k.kids[1]] : k.k === 'else' ? [k.kids[0]] : [])).filter((r) => !isNull(r));
    const typed = real.sort((x, y) => x.b - x.a - (y.b - y.a))[0];
    // tokens joined as in the source (:new.c stays :new.c), a space where the source had any
    const copy = typed
      ? this.t.slice(typed.a, typed.b).map((t, i, all) => t.text.replace(/[\r\n]+/g, ' ') + (i < all.length - 1 && all[i + 1].start > t.end ? ' ' : '')).join('')
      : 'null';
    const probe = (res: Node) => {
      const id = this.ids.branch++;
      this.ins(this.t[res.a].start, `case when ${rt}.${bt}(${id}) then `);
      this.scanRegion(res.a, res.b, ctx, clause, [res]);
      this.ins(this.t[res.b - 1].end, isNull(res) ? ` else ${copy} end` : ' end');
      return id;
    };
    for (const k of n.kids) {
      if (k.k === 'when') {
        const [val, res] = k.kids;
        this.scanRegion(val.a, val.b, ctx, clause, [val]);
        c.branches.push(this.br(`WHEN ${this.label(val.a, val.b - 1)}`, this.t[k.a], { probe: probe(res) }));
      } else if (k.k === 'else') {
        c.branches.push(this.br('ELSE', this.t[k.a], { probe: probe(k.kids[0]) }));
        return;
      } else {
        this.scanRegion(k.a, k.b, ctx, clause, [k]); // the operand
      }
    }
    const endTok = this.t[n.b - 1];
    const id = this.ids.branch++;
    this.ins(endTok.start, `else case when ${rt}.${bt}(${id}) then null else ${copy} end `);
    c.branches.push(this.br('ELSE (implicit → NULL)', endTok, { probe: id }));
  }

  // ------------------------------------------------------------------ edits

  applyEdits(): string {
    const sorted = [...this.edits].sort((x, y) => x.pos - y.pos || x.gen - y.gen);
    // Merge insertions per position, then keep tokens apart: "if(" or "not(" in the source must not
    // turn into "ifcov$…" / "notcov$…", and inserted text must not glue to a following identifier.
    const merged: { pos: number; text: string }[] = [];
    for (const e of sorted) {
      const lastM = merged[merged.length - 1];
      if (lastM && lastM.pos === e.pos) lastM.text += e.text;
      else merged.push({ pos: e.pos, text: e.text });
    }
    const word = /[A-Za-z0-9_$#]/;
    let out = '';
    let last = 0;
    for (const e of merged) {
      let text = e.text;
      if (e.pos > 0 && word.test(this.src[e.pos - 1]) && word.test(text[0])) text = ' ' + text;
      if (e.pos < this.src.length && word.test(this.src[e.pos]) && word.test(text[text.length - 1])) text += ' ';
      out += this.src.slice(last, e.pos) + text;
      last = e.pos;
    }
    return out + this.src.slice(last);
  }
}
