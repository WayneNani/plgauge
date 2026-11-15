/**
 * Schema rewriter, ported from plmut (internal/mutant/schema.go). All mutants of a
 * unit are compiled into one body; every point becomes a switch on the active ID:
 *
 *   bool, value (PL/SQL): (CASE CASE A WHEN -1 THEN plmut_ctl.hit(b, n) ELSE A END
 *                          WHEN b THEN (m1) … ELSE (orig) END)
 *   stmt:                 IF A = -1 THEN plmut_ctl.reach(b, 1); END IF; IF A <> b THEN stmt END IF;
 *   insert:               IF A = -1 THEN reach; END IF; IF A = id THEN <variant> END IF; …
 *   loop guard:           IF A <> 0 THEN plmut_ctl.tick(loop); END IF;
 *   SQL (any kind):       the enclosing PL/SQL statement, once per variant:
 *                         IF A = -1 THEN reach; END IF; IF A = id THEN <stmt'> ELSIF … ELSE stmt END IF;
 *                         A switch inside the SQL would hide predicates from the optimizer
 *                         (a CASE around a join condition turns a hash join into nested
 *                         loops); the duplicated statement keeps the original plan. A cursor
 *                         FOR loop over a query is duplicated as a whole, body and all.
 *   dynamic SQL:          a string literal that becomes SQL, switched in place:
 *                         (CASE CASE A WHEN -1 THEN hit ELSE A END WHEN id THEN 'lit'' … ELSE 'lit' END);
 *                         every variant is a statement of its own, parsed when executed.
 *   views, cursors:       every query block (the view's query, WITH elements, inline views
 *                         in FROM; the query of an unordered cursor declaration) with mutants becomes
 *                           SELECT * FROM (block) WHERE NVL(V, '0') NOT IN (ids of branches)
 *                             AND (NVL(V, '0') <> '-1' OR (SELECT plmut_ctl.hit(b, n) FROM dual) = 0)
 *                           UNION ALL SELECT * FROM (block') WHERE V = 'id' …
 *                         with V = SYS_CONTEXT(<context of the runtime schema>, 'ACTIVE'). Every branch but one is
 *                         cut off by a filter on a constant. Points in select lists cannot
 *                         change the plan and are switched in place, (CASE V WHEN 'id' THEN
 *                         (m) … ELSE (orig) END), also conditions (23ai has SQL booleans).
 *
 * A is the package constant plmut$a in package bodies (read once per instantiation,
 * so the worker resets package state when it switches mutants), plmut_ctl.active()
 * elsewhere. ID -1 is the recording run.
 */
import { contextName } from './ddl.js';
import { objectName, objectOwner, withoutCreate, type Mutant, type Point, type SourceFile, type Unit } from './mutant.js';

export interface Region {
  start: number;
  end: number;
  point: Point;
  /** Set when the region is one branch (variant) of the point. */
  mutantId: number;
  /** Duplicated statements, view blocks: every point in it, all of them unswitchable if the scaffold fails. */
  points?: Point[];
  /** View blocks: key of the block (see blockKey); a block whose wrapper failed is not wrapped again. */
  block?: string;
}

/** Key of a view block for the broken set of buildSchema. */
export const blockKey = (unitKey: string, scope: [number, number]) => `${unitKey}@${scope[0]}:${scope[1]}`;

export interface SchemaUnit {
  key: string;
  type: string;
  /** Data dictionary name. */
  name: string;
  /** Schema of a qualified unit (CREATE … other_schema.name); else the connected user's. */
  owner?: string;
  /** Generated text without CREATE, as Oracle stores it: compile error positions refer to it. */
  text: string;
  /** The unit's original text without CREATE. */
  original: string;
  regions: Region[];
  mutants: Mutant[];
  loops: number;
  /**
   * Views: IDs whose reach the recording run notes although they are not switched (points
   * left to the oracle rewriter inside a switched block): their covering tests are known.
   */
  recorded: number[];
  /**
   * Has UNION ALL branches (views, cursor declarations): the first query parses all of them
   * at once, which the run takes out of the baseline with a warm-up.
   */
  branched?: boolean;
}

interface Node {
  p: Point;
  ms: Mutant[];
  kids: Node[];
  loop: number;
  order: number;
  /** A statement duplicated for the clause points in it (their mutants are in ms). */
  dup?: { points: Point[]; /** views: all mutants of the block, for the recording run */ reach: Mutant[]; all: Point[] };
  /** A string literal with dynamic SQL: its points (their mutants are in ms). */
  lit?: Point[];
}

/**
 * Rewrites every unit that has mutants. Mutants in dropped are left out (they did not
 * compile); points in naive are not switched (their mutants run with the oracle rewriter).
 * runtimeOwner: the schema of plmut_ctl. Units of other schemas call it qualified (A4).
 * broken: view blocks (blockKey) whose wrapper did not compile; they get none, not even
 * the one that only records.
 * plain: views (unit keys) that go in exactly as written, without even the recording wrapper
 * (tests read their text, or the wrapper changed their plan).
 */
export function buildSchema(ms: Mutant[], dropped: Set<number> = new Set(), naive: Set<Point> = new Set(), runtimeOwner?: string, broken: Set<string> = new Set(), plain: Set<string> = new Set()): SchemaUnit[] {
  const byUnit = new Map<Unit, { f: SourceFile; points: Map<Point, Mutant[]> }>();
  for (const m of ms) {
    let e = byUnit.get(m.unitRef);
    if (!e) byUnit.set(m.unitRef, (e = { f: m.sourceFile, points: new Map() }));
    const list = e.points.get(m.point) ?? [];
    list.push(m);
    e.points.set(m.point, list);
  }
  const out: SchemaUnit[] = [];
  let loopId = 0;
  for (const [u, { f, points }] of byUnit) {
    const fullOriginal = f.src.subarray(u.start, u.end).toString('utf8');
    const su: SchemaUnit = {
      key: `${f.path}#${u.type} ${u.name}`, type: u.type, name: objectName(u.name), owner: objectOwner(u.name),
      text: '', original: withoutCreate(fullOriginal), regions: [], mutants: [], loops: 0, recorded: [],
    };
    const nodes: Node[] = [];
    let order = 0;
    const dups = new Map<string, Node>();
    // blocks without wrapper: failed before, or the view's ordered main block
    const isBroken = (scope: [number, number]) =>
      broken.has(blockKey(su.key, scope)) || (!!u.ordered && !!u.main && scope[0] === u.main[0] && scope[1] === u.main[1]);
    const unrecorded: Mutant[] = [];
    const lits = new Map<string, Node>();
    const dupNode = (p: Point, scope: [number, number], ctx: Point['ctx']) => {
      const g: Node = { p: { ...p, op: '', kind: 'clause', ctx, start: scope[0], end: scope[1], orig: '', mutants: [], scope }, ms: [], kids: [], loop: 0, order: -1 - dups.size, dup: { points: [], reach: [], all: [] } };
      dups.set(scope.join(':'), g);
      nodes.push(g);
      return g;
    };
    for (const [p, pm] of points) {
      const live = pm.filter((m) => !dropped.has(m.id));
      if (p.dyn && !naive.has(p)) {
        // one node per literal
        const key = p.dyn.join(':');
        let g = lits.get(key);
        if (!g) {
          g = { p: { ...p, op: '', kind: 'value', ctx: 'plsql', start: p.dyn[0], end: p.dyn[1], orig: '', mutants: [] }, ms: [], kids: [], loop: 0, order: order++, lit: [] };
          lits.set(key, g);
          nodes.push(g);
        }
        g.lit!.push(p);
        g.ms.push(...live);
        su.mutants.push(...live);
        continue;
      }
      if (p.scope && switchable(p) && !naive.has(p) && !isBroken(p.scope)) {
        // one node per statement; it comes before an SBR point with the same range
        const g = dups.get(p.scope.join(':')) ?? dupNode(p, p.scope, 'plsql');
        g.dup!.reach.push(...live);
        g.dup!.all.push(p);
        // inline: switched in place, inside the block's original branch
        if (p.inline) nodes.push({ p, ms: live, kids: [], loop: 0, order: order++ });
        else {
          g.dup!.points.push(p);
          g.ms.push(...live);
        }
        su.mutants.push(...live);
        continue;
      }
      const n: Node = { p, ms: [], kids: [], loop: 0, order: order++ };
      if (u.type === 'VIEW') unrecorded.push(...pm);
      if (!naive.has(p) && switchable(p) && !(u.type === 'VIEW' && p.scope && isBroken(p.scope))) {
        n.ms.push(...live);
        su.mutants.push(...live);
      }
      nodes.push(n);
    }
    su.mutants.sort((a, b) => a.id - b.id);
    // a view without switched mutants and without a recording wrapper goes in as it is (no INLINE hints)
    const records = !!u.main && unrecorded.length > 0 && !dups.has(u.main.join(':')) && !isBroken(u.main);
    if (u.type === 'VIEW' && (plain.has(su.key) || (!su.mutants.length && !records))) {
      su.mutants = [];
      su.text = su.original;
      out.push(su);
      continue;
    }
    // view points left out of a switched block: the block's recording notes their reach too.
    // Without one (a recursive WITH element, a block left out), the view's main block: a test
    // that never runs it never queries the view.
    // the main block records even without switched points of its own (a view whose points all run
    // with the oracle rewriter still notes which test queries it)
    // (no points of its own: if it fails, only the block is marked broken)
    if (u.type === 'VIEW' && records && u.main) dupNode(points.keys().next().value!, u.main, 'sql');
    const top = u.main && dups.get(u.main.join(':'));
    for (const m of unrecorded) {
      const g = (m.point.scope && dups.get(m.point.scope.join(':'))) || top;
      if (!g) continue;
      g.dup!.reach.push(m);
      su.recorded.push(m.id);
    }
    for (const l of f.loops) {
      if (f.units[l.unit] === u) {
        loopId++;
        su.loops++;
        nodes.push({ p: { unit: l.unit, op: '', kind: 'guard', sub: '', ctx: 'plsql', cat: '', start: l.at, end: l.at, orig: '', mutants: [] }, ms: [], kids: [], loop: loopId, order: order++ });
      }
    }
    const roots = nest(nodes);
    const ctl = su.owner && runtimeOwner && su.owner !== runtimeOwner.toUpperCase() ? `${runtimeOwner.toLowerCase()}.plmut_ctl` : 'plmut_ctl';
    const r = new Renderer(f.src, su, `${ctl}.active()`, ctl, runtimeOwner ? contextName(runtimeOwner) : 'PLMUT_CTX', [...(u.inserts ?? [])].sort((a, b) => a.at - b.at));
    let start = u.start;
    if (u.decl >= 0) {
      r.active = 'plmut$a';
      r.write(f.src.subarray(u.start, u.decl).toString('utf8'));
      // on the same line: line numbers ($$PLSQL_LINE, error backtraces) stay those of the original
      r.write(` plmut$a CONSTANT PLS_INTEGER := ${ctl}.active;`);
      start = u.decl;
    }
    r.rangeWith(start, u.end, roots);
    // Strip CREATE … so that positions match what Oracle reports.
    const full = r.b;
    const text = withoutCreate(full);
    const shift = full.length - text.length;
    su.text = text;
    su.regions = su.regions.map((g) => ({ ...g, start: g.start - shift, end: g.end - shift }));
    out.push(su);
  }
  return out;
}

/** Orders points into a tree by containment. */
function nest(nodes: Node[]): Node[] {
  nodes.sort((a, b) => a.p.start - b.p.start || b.p.end - a.p.end || a.order - b.order);
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const n of nodes) {
    while (stack.length && stack[stack.length - 1].p.end <= n.p.start) stack.pop();
    if (!stack.length) roots.push(n);
    else stack[stack.length - 1].kids.push(n);
    stack.push(n);
  }
  return roots;
}

const identByte = (c: number) =>
  c === 0x5f || c === 0x24 || c === 0x23 || (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c >= 0x80;
const identChar = (s: string) => s.length > 0 && identByte(s.charCodeAt(0));

class Renderer {
  b = '';
  constructor(private src: Buffer, private su: SchemaUnit, public active: string, private ctl = 'plmut_ctl', private ctx = 'PLMUT_CTX', private inserts: NonNullable<Unit['inserts']> = []) {}

  write(s: string) {
    this.b += s;
  }

  /** Source text of [a, b), with the unit's inserts (views). */
  raw(a: number, b: number): string {
    const ins = this.inserts.filter((i) => a <= i.at && i.at < b);
    if (!ins.length) return this.src.subarray(a, b).toString('utf8');
    let out = '';
    let cur = a;
    for (const i of ins) {
      out += this.src.subarray(cur, i.at).toString('utf8') + i.text;
      cur = i.at;
    }
    return out + this.src.subarray(cur, b).toString('utf8');
  }

  rangeWith(start: number, end: number, kids: Node[]) {
    let cur = start;
    for (const k of kids) {
      this.write(this.raw(cur, k.p.start));
      this.point(k);
      cur = k.p.end;
    }
    this.write(this.raw(cur, end));
  }

  orig(n: Node) {
    this.rangeWith(n.p.start, n.p.end, n.kids);
  }

  region(start: number, point: Point, mutantId: number) {
    this.su.regions.push({ start, end: this.b.length, point, mutantId });
  }

  /** Writes one variant's text as the region of that mutant. */
  variantRegion(text: string, point: Point, mutantId: number) {
    const start = this.b.length;
    this.write(text);
    this.region(start, point, mutantId);
  }

  /** Keeps tokens apart: an identifier right before a switch must not fuse with it. */
  spaceBefore() {
    if (identChar(this.b.slice(-1))) this.write(' ');
  }

  /** Keeps tokens apart after a switch that ends where the source goes on with an identifier. */
  spaceAfter(end: number) {
    if (end < this.src.length && identByte(this.src[end])) this.write(' ');
  }

  /** Source text of the node n with mutant m in place. */
  spliced(n: Node, m: Mutant): string {
    return this.raw(n.p.start, m.point.start) + m.mutated + this.raw(m.point.end, n.p.end);
  }

  /** Clause points: the statement once per variant, the original (with its own switches) last. */
  dup(n: Node) {
    const a = this.active;
    this.spaceBefore();
    const start = this.b.length;
    this.write(`IF ${a} = -1 THEN`);
    for (const q of n.dup!.points) {
      const ids = n.ms.filter((m) => m.point === q).map((m) => m.id);
      if (ids.length) this.write(` ${this.ctl}.reach(${ids[0]}, ${ids[ids.length - 1] - ids[0] + 1});`);
    }
    this.write(' END IF;');
    let first = true;
    for (const m of [...n.ms].sort((x, y) => x.id - y.id)) {
      this.write(` ${first ? 'IF' : 'ELSIF'} ${a} = ${m.id} THEN `);
      first = false;
      this.variantRegion(this.variant(n, m), m.point, m.id);
    }
    this.write(' ELSE ');
    this.orig(n);
    this.write(' END IF;');
    this.su.regions.push({ start, end: this.b.length, point: n.dup!.points[0], mutantId: 0, points: n.dup!.all });
  }

  /**
   * A copy of a duplicated statement with one mutant in place. Other switches stay out (only
   * this mutant is active in it), loop guards stay in: a copied cursor FOR loop and the loops
   * in its body must still stop when the mutant makes them run away.
   */
  variant(n: Node, m: Mutant): string {
    const guards: Node[] = [];
    const walk = (k: Node) => {
      for (const c of k.kids) {
        if (c.loop > 0) guards.push(c);
        else walk(c);
      }
    };
    walk(n);
    const edits = guards
      .filter((g) => g.p.start <= m.point.start || g.p.start >= m.point.end)
      .map((g) => ({ at: g.p.start, end: g.p.start, text: this.guard(g) }));
    edits.push({ at: m.point.start, end: m.point.end, text: m.mutated });
    edits.sort((x, y) => x.at - y.at || x.end - y.end);
    let out = '';
    let cur = n.p.start;
    for (const e of edits) {
      out += this.raw(cur, e.at) + e.text;
      cur = e.end;
    }
    return out + this.raw(cur, n.p.end);
  }

  /** Counts iterations in the recording run and while a mutant is active; beyond the recorded maximum ×10 it aborts. */
  guard(n: Node): string {
    return ` IF ${this.active} <> 0 THEN ${this.ctl}.tick(${n.loop}); END IF;`;
  }

  /** hit() calls for a set of IDs: one per run of consecutive IDs, summed (each returns 0). */
  hits(ids: number[], fn = 'hit'): string {
    ids = [...new Set(ids)].sort((x, y) => x - y);
    const out: string[] = [];
    for (let i = 0; i < ids.length;) {
      let j = i;
      while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
      out.push(`${this.ctl}.${fn}(${ids[i]}, ${j - i + 1})`);
      i = j + 1;
    }
    return out.join(' + ');
  }

  /** (CASE head WHEN id THEN variant … ELSE orig END), every variant the region of its mutant; paren: around orig too. */
  cases(n: Node, head: string, ms: Mutant[], id: (m: Mutant) => string, variant: (m: Mutant) => string, paren = true) {
    this.write(`(CASE ${head}`);
    for (const m of ms) {
      this.write(` WHEN ${id(m)} THEN `);
      this.variantRegion(variant(m), m.point, m.id);
    }
    this.write(paren ? ' ELSE (' : ' ELSE ');
    this.orig(n);
    this.write(paren ? ') END)' : ' END)');
  }

  /** Dynamic SQL: the literal once per variant, switched in place; see the header. */
  lit(n: Node) {
    const a = this.active;
    this.spaceBefore();
    const start = this.b.length;
    const ms = [...n.ms].sort((x, y) => x.id - y.id);
    this.cases(n, `CASE ${a} WHEN -1 THEN ${this.hits(ms.map((m) => m.id))} ELSE ${a} END`, ms, (m) => `${m.id}`, (m) => this.spliced(n, m), false);
    this.su.regions.push({ start, end: this.b.length, point: n.lit![0], mutantId: 0, points: n.lit });
    this.spaceAfter(n.p.end);
  }

  /** Views and cursor declarations: one UNION ALL branch per variant of the block; see the header. */
  viewDup(n: Node) {
    const V = `SYS_CONTEXT('${this.ctx}', 'ACTIVE')`;
    const p = n.p;
    this.spaceBefore();
    const start = this.b.length;
    const branches = [...n.ms].sort((x, y) => x.id - y.id);
    const conds: string[] = [];
    for (let i = 0; i < branches.length; i += 900) {
      conds.push(`NVL(${V}, '0') NOT IN (${branches.slice(i, i + 900).map((m) => `'${m.id}'`).join(', ')})`);
    }
    // views: hit_sql, never in parallel slaves (see plmut_ctl); cursor declarations in PL/SQL:
    // hit, whose purity a subprogram under PRAGMA RESTRICT_REFERENCES may rely on
    const fn = this.su.type === 'VIEW' ? 'hit_sql' : 'hit';
    conds.push(`(NVL(${V}, '0') <> '-1' OR (SELECT ${this.hits(n.dup!.reach.map((m) => m.id), fn)} FROM dual) = 0)`);
    if (branches.length) this.su.branched = true;
    // the block is a WITH element: its query is now the wrapper, which takes the INLINE hint
    this.write(this.inserts.some((i) => i.block === p.start) ? 'SELECT /*+ INLINE */ * FROM (' : 'SELECT * FROM (');
    this.orig(n);
    this.write(`) WHERE ${conds.join(' AND ')}`);
    for (const m of branches) {
      this.write(' UNION ALL SELECT * FROM (');
      this.variantRegion(this.spliced(n, m), m.point, m.id);
      this.write(`) WHERE ${V} = '${m.id}'`);
    }
    // a failing wrapper takes the block's points out of the schema and marks the block broken
    this.su.regions.push({ start, end: this.b.length, point: n.dup!.all[0] ?? n.p, mutantId: 0, points: n.dup!.all, block: blockKey(this.su.key, [p.start, p.end]) });
    this.spaceAfter(p.end);
  }

  /** Views and cursor declarations: a point in a select list, switched in place. */
  viewInline(n: Node) {
    const p = n.p;
    this.spaceBefore();
    const start = this.b.length;
    this.cases(n, `SYS_CONTEXT('${this.ctx}', 'ACTIVE')`, n.ms, (m) => `'${m.id}'`, (m) => `(${m.mutated})`);
    this.region(start, p, 0);
    this.spaceAfter(p.end);
  }

  point(n: Node) {
    const a = this.active;
    if (n.dup && (this.su.type === 'VIEW' || n.p.union)) {
      if (n.dup.reach.length) this.viewDup(n);
      else this.orig(n);
      return;
    }
    if (n.ms.length && n.p.inline) {
      this.viewInline(n);
      return;
    }
    if (n.lit) {
      if (n.ms.length) this.lit(n);
      else this.orig(n);
      return;
    }
    if (n.loop > 0) {
      // deterministic timeout instead of the wall clock
      this.write(this.guard(n));
      return;
    }
    if (!n.ms.length) {
      this.orig(n);
      return;
    }
    if (n.dup) {
      this.dup(n);
      return;
    }
    const p = n.p;
    const base = n.ms[0].id;
    const count = n.ms[n.ms.length - 1].id - base + 1;
    // Keep tokens apart: "ELSE" directly before a switch must not fuse into "ELSEIF".
    if (p.kind !== 'insert') this.spaceBefore();
    const start = this.b.length;
    switch (true) {
      case p.kind === 'stmt': {
        const id = n.ms[0].id;
        this.write(`IF ${a} = -1 THEN ${this.ctl}.reach(${id}, 1); END IF; IF ${a} <> ${id} THEN `);
        this.orig(n);
        this.write(' END IF;');
        break;
      }
      case p.kind === 'insert': {
        this.write(` IF ${a} = -1 THEN ${this.ctl}.reach(${base}, ${count}); END IF;`);
        for (const m of n.ms) {
          this.write(` IF ${a} = ${m.id} THEN `);
          this.variantRegion(m.mutated.trim(), p, m.id);
          this.write(' END IF;');
        }
        break;
      }
      default: {
        // bool in PL/SQL, value anywhere
        this.cases(n, `CASE ${a} WHEN -1 THEN ${this.ctl}.hit(${base}, ${count}) ELSE ${a} END`, n.ms, (m) => `${m.id}`, (m) => `(${m.mutated})`);
      }
    }
    this.region(start, p, 0);
    this.spaceAfter(p.end);
  }
}

/** Whether the schema rewriter can switch a point; the others run with the oracle rewriter. */
export function switchable(p: Point): boolean {
  // the function result cache is shared by all sessions and outlives the switch of the active mutant
  if (p.naiveOnly) return false;
  if (p.dyn) return true;
  switch (p.kind) {
    case 'stmt':
      return p.mutants.length === 1 && p.mutants[0] === 'NULL;';
    case 'bool':
    case 'value':
      return p.ctx !== 'sql' || !!p.scope;
    case 'insert':
      return true;
    case 'clause':
      return !!p.scope;
  }
  return false;
}

/**
 * Maps a compile error position (1-based line and column in characters, as in
 * USER_ERRORS) to the innermost region containing it, or else the last whole-point
 * region that ends before it on the same line.
 */
export function locate(su: SchemaUnit, line: number, col: number): Region | undefined {
  const off = offsetOf(su.text, line, col);
  if (off === undefined) return undefined;
  let best: Region | undefined;
  for (const rg of su.regions) {
    if (rg.start <= off && off < rg.end && (!best || rg.end - rg.start < best.end - best.start)) best = rg;
  }
  if (best) return best;
  const lineStart = su.text.lastIndexOf('\n', off - 1) + 1;
  for (const rg of su.regions) {
    if (rg.mutantId === 0 && rg.end <= off && rg.end >= lineStart && (!best || rg.end > best.end)) best = rg;
  }
  return best;
}

/**
 * Line and column (1-based, column in code points, as in USER_ERRORS) of a character offset:
 * a statement that Oracle rejects at once (CREATE VIEW) reports only the offset.
 */
export function positionOf(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length, col: [...before.slice(before.lastIndexOf('\n') + 1)].length + 1 };
}

function offsetOf(text: string, line: number, col: number): number | undefined {
  let off = 0;
  for (let l = 1; l < line; l++) {
    const i = text.indexOf('\n', off);
    if (i < 0) return undefined;
    off = i + 1;
  }
  for (let c = 1; c < col && off < text.length && text[off] !== '\n'; c++) {
    off += text.codePointAt(off)! > 0xffff ? 2 : 1;
  }
  return off;
}

/** A row of PLAN_TABLE: op is operation, options and object name. */
export interface PlanRow {
  id: number;
  parent: number | null;
  op: string;
  filter: string | null;
}

/** A predicate of the schema: it mentions the switch context or the control package. */
const SCAFFOLD = /PLMUT_CT[XL]/i;
/**
 * A conjunct that holds only under one mutant (V = 'id') or only in the recording run (what
 * OR expansion makes of the original branch's recording condition: LNNVL(NVL(V, '0') <> '-1')).
 */
const DEAD = /^(NVL\()?SYS_CONTEXT\('PLMUT_CTX[^']*','ACTIVE'\)(,'0'\))?='-?\d+'$|^LNNVL\(NVL\(SYS_CONTEXT\('PLMUT_CTX[^']*','ACTIVE'\),'0'\)<>'-1'\)$/;

/** The top-level AND terms of a predicate, outer parentheses removed (and split again). */
function conjuncts(f: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  for (let i = 0; i < f.length; i++) {
    const c = f[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /^ AND /i.test(f.slice(i, i + 5))) {
      out.push(f.slice(from, i));
      from = i + 5;
    }
  }
  out.push(f.slice(from));
  /** The term without parentheses around all of it, or undefined if there are none. */
  const inner = (t: string): string | undefined => {
    if (!t.startsWith('(') || !t.endsWith(')')) return undefined;
    let d = 0;
    let q = '';
    for (let i = 0; i < t.length - 1; i++) {
      const c = t[i];
      if (q) {
        if (c === q) q = '';
      } else if (c === "'" || c === '"') q = c;
      else if (c === '(') d++;
      else if (c === ')') d--;
      if (!q && d === 0) return undefined; // (a) AND (b)
    }
    return t.slice(1, -1);
  };
  return out.flatMap((t) => {
    const x = inner(t.trim());
    return x === undefined ? (t.trim() ? [t.trim()] : []) : conjuncts(x);
  });
}

/**
 * The operations of a plan that run without a mutant, each as its path from the root
 * ("0:HASH JOIN / 1:TABLE ACCESS FULL T"), sorted: the shape counts (join order, build and
 * probe side, which join a table belongs to). Left out:
 * - dead branches: a FILTER with a top-level AND term that needs one mutant kills the whole
 *   UNION ALL branch it lies in (Oracle may push the branch's condition below an aggregate
 *   or into one side of a join);
 * - the schema's own steps: filters made only of its terms, the dual of the recording (the
 *   last child of a filter whose recording subquery reads DUAL), views (not VIEW PUSHED
 *   PREDICATE) and UNION ALL, which wrapping adds or merges; their children hang on the
 *   nearest kept ancestor.
 * A filter that also has terms of the original stays. Names of temporary tables and parallel
 * table queues are normalized. The plan of a switched view must give what the original gives.
 */
export function livePlan(rows: PlanRow[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map<number, number[]>();
  for (const r of rows) kids.set(r.parent ?? -1, [...(kids.get(r.parent ?? -1) ?? []), r.id].sort((x, y) => x - y));
  const dead = new Set<number>();
  const recordingDual = new Set<number>();
  const unionAll = (op?: string) => /^UNION[- ]ALL\b/.test(op ?? '');
  const scaffolded = (id: number): boolean => SCAFFOLD.test(byId.get(id)?.filter ?? '') || (kids.get(id) ?? []).some(scaffolded);
  for (const r of rows) {
    if (r.op !== 'FILTER' || !SCAFFOLD.test(r.filter ?? '')) continue;
    // the recording's subquery (… <> '-1' OR (SELECT … FROM DUAL) = 0) brings one FAST DUAL
    // child; which one of several is dropped does not matter, they are alike
    if (/'-1'/.test(r.filter!) && /"DUAL"/.test(r.filter!)) {
      const dual = kids.get(r.id)?.filter((k) => byId.get(k)!.op === 'FAST DUAL').at(-1);
      if (dual !== undefined) recordingDual.add(dual);
    }
    if (!conjuncts(r.filter!).some((t) => DEAD.test(t))) continue;
    // the branch below the nearest UNION ALL (OR expansion makes one too)
    let branch = r.id;
    let up = r.parent;
    while (up !== null && up !== undefined && !unionAll(byId.get(up)?.op)) {
      branch = up;
      up = byId.get(up)?.parent ?? null;
    }
    if (up === null || up === undefined) {
      dead.add(r.id);
      continue;
    }
    dead.add(branch);
    // the branch's scalar subqueries come before its top row: the siblings back to the
    // previous branch (one with a schema predicate somewhere in it), if there is one to bound them
    const sib = kids.get(up)!;
    const at = sib.indexOf(branch);
    let prev = at - 1;
    while (prev >= 0 && !scaffolded(sib[prev])) prev--;
    if (prev >= 0) for (let i = prev + 1; i < at; i++) dead.add(sib[i]);
  }
  /** Nearest kept ancestor (or itself) of every row; -1 = the root. */
  const anchor = new Map<number, number>();
  const kept = new Map<number, { op: string; parent: number }>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const parent = r.parent ?? -1;
    if (dead.has(parent)) dead.add(r.id);
    if (dead.has(r.id)) continue;
    const up = anchor.get(parent) ?? -1;
    const drop = /^(SELECT STATEMENT|UNION[- ]ALL)\b/.test(r.op) || (/^VIEW\b/.test(r.op) && !r.op.startsWith('VIEW PUSHED PREDICATE'))
      || recordingDual.has(r.id)
      || (r.op === 'FILTER' && SCAFFOLD.test(r.filter ?? '') && conjuncts(r.filter!).every((t) => SCAFFOLD.test(t)));
    if (drop) {
      anchor.set(r.id, up);
      continue;
    }
    anchor.set(r.id, r.id);
    kept.set(r.id, { op: r.op.replace(/SYS_TEMP_\w+/g, 'SYS_TEMP').replace(/:TQ\d+/g, ':TQ'), parent: up });
  }
  const pos = new Map<number, number>();
  const seen = new Map<number, number>();
  for (const [id, k] of kept) {
    const i = seen.get(k.parent) ?? 0;
    pos.set(id, i);
    seen.set(k.parent, i + 1);
  }
  const path = (id: number): string => {
    const k = kept.get(id)!;
    const own = `${pos.get(id)}:${k.op}`;
    return kept.has(k.parent) ? `${path(k.parent)} / ${own}` : own;
  };
  return [...kept.keys()].map(path).sort();
}

/**
 * What a live plan has more (+n) or less (-n) than the original, as "operation ← parent"
 * (undefined if they are the same).
 */
export function planDiff(orig: string[], now: string[]): string | undefined {
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const a = count(orig);
  const b = count(now);
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const d = (b.get(k) ?? 0) - (a.get(k) ?? 0);
    if (!d) continue;
    const segs = k.split(' / ').map((x) => x.replace(/^\d+:/, ''));
    const op = segs.pop()!;
    const parent = segs.pop();
    out.push(`${d > 0 ? '+' : ''}${d} ${op}${parent ? ` ← ${parent}` : ''}`);
  }
  if (!out.length) return undefined;
  out.sort();
  return out.slice(0, 4).join(', ') + (out.length > 4 ? ', …' : '');
}
