/**
 * Mutation points and mutants, ported from plmut (internal/mutant/mutant.go).
 * The points come from find.ts, which walks the syntax tree of the core parser.
 */

/** A compilation unit (CREATE … statement) in a source file. Offsets are UTF-8 bytes, end exclusive. */
export interface Unit {
  type: string; // PACKAGE BODY, PROCEDURE, FUNCTION, TYPE BODY, TRIGGER, VIEW
  name: string;
  start: number;
  end: number;
  /** Package bodies: offset right after IS/AS, where declarations may go; else -1. */
  decl: number;
  /**
   * Views: text the schema inserts into every copy (INLINE hints for WITH elements that
   * the original references once: copies would reference them more often, and Oracle
   * would then materialize them in front of every branch). block: start of the element's
   * query, whose UNION ALL wrapper takes the hint.
   */
  inserts?: { at: number; text: string; block: number }[];
  /** Views: byte range of the main query block (the scope of its points). */
  main?: [number, number];
}

/** One place in the source with one or more mutants. */
export interface Point {
  unit: number;
  op: string;
  /** clause: a structural SQL change (DISTINCT, join type, ORDER BY …) that no expression switch can express. */
  kind: 'bool' | 'value' | 'stmt' | 'insert' | 'guard' | 'clause';
  sub: string;
  ctx: 'plsql' | 'sql';
  cat: string;
  start: number;
  end: number;
  orig: string;
  mutants: string[];
  /**
   * SQL points inside a PL/SQL statement (static SQL, FORALL, OPEN FOR): the statement's
   * byte range. The schema rewriter switches such points by duplicating the statement, so
   * the original SQL keeps its execution plan; SQL points without it (cursor declarations,
   * cursor FOR loops) run with the oracle rewriter.
   */
  scope?: [number, number];
  /**
   * Views: the point is in a select list, where an in-place switch (CASE on the active
   * ID) cannot change the execution plan. Other view points get a UNION ALL branch each.
   */
  inline?: boolean;
}

/** Position right after a LOOP keyword, where the schema puts a loop guard. */
export interface Loop {
  unit: number;
  at: number;
}

/** A parsed source file. */
export interface SourceFile {
  path: string;
  errors: string[];
  units: Unit[];
  points: Point[];
  loops: Loop[];
  /** Variants the finder left out as equivalent or meaningless. */
  skipped: number;
  /** File content, UTF-8 bytes. */
  src: Buffer;
}

/** A single first-order mutant. */
export interface Mutant {
  id: number;
  op: string;
  file: string;
  /** e.g. "PACKAGE BODY shop_pricing" */
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
  sourceFile: SourceFile;
  point: Point;
  unitRef: Unit;
}

/**
 * Turns the points of all files into numbered mutants, ordered by file and position.
 * IDs start at 1; 0 means "no mutant" at runtime, -1 the recording run.
 */
export function expand(files: SourceFile[], ops?: Set<string>): Mutant[] {
  const ms: Mutant[] = [];
  for (const f of files) {
    const pts = f.points.filter((p) => !ops || ops.has(p.op));
    // stable sort by start offset
    const sorted = pts.map((p, i) => ({ p, i })).sort((a, b) => a.p.start - b.p.start || a.i - b.i).map((x) => x.p);
    for (const p of sorted) {
      const u = f.units[p.unit];
      const [line, col] = lineCol(f.src, p.start);
      const [endLine, endCol] = lineCol(f.src, p.end);
      for (const m of p.mutants) {
        ms.push({
          id: 0, op: p.op, file: f.path, unit: `${u.type} ${u.name}`, line, col, endLine, endCol,
          sub: p.sub, ctx: p.ctx, category: p.cat, original: p.orig, mutated: m,
          sourceFile: f, point: p, unitRef: u,
        });
      }
    }
  }
  ms.forEach((m, i) => (m.id = i + 1));
  return ms;
}

/** Converts a byte offset into a 1-based line and column (in code points). */
export function lineCol(src: Buffer, off: number): [number, number] {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < off; i++) {
    if (src[i] === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return [line, [...src.subarray(lineStart, off).toString('utf8')].length + 1];
}

/** Identifies the unit a mutant belongs to. */
export function unitKey(m: Mutant): string {
  return `${m.file}#${m.unit}`;
}

export function originalUnit(m: Mutant): string {
  return m.sourceFile.src.subarray(m.unitRef.start, m.unitRef.end).toString('utf8');
}

/**
 * The CREATE statement with only this mutant applied: the oracle rewriter. It shares
 * the point list with the schema rewriter but nothing else.
 */
export function mutatedUnit(m: Mutant): string {
  const src = m.sourceFile.src;
  return Buffer.concat([
    src.subarray(m.unitRef.start, m.point.start),
    Buffer.from(m.mutated, 'utf8'),
    src.subarray(m.point.end, m.unitRef.end),
  ]).toString('utf8');
}

/** The schema of a qualified unit name (dictionary form), or undefined. */
export function objectOwner(name: string): string | undefined {
  const i = name.lastIndexOf('.');
  if (i < 0) return undefined;
  const o = name.slice(0, i).trim();
  return o.startsWith('"') ? o.replace(/"/g, '') : o.toUpperCase();
}

/** The unit name as stored in the data dictionary: without schema, upper case unless quoted. */
export function objectName(name: string): string {
  const i = name.lastIndexOf('.');
  if (i >= 0) name = name.slice(i + 1);
  if (name.startsWith('"')) return name.replace(/"/g, '');
  return name.toUpperCase();
}

/**
 * Removes "CREATE [OR REPLACE] [EDITIONABLE|NONEDITIONABLE]" from a unit's text. The
 * rest is what Oracle stores in ALL_SOURCE (line 1 = the line of the type keyword),
 * so compile error positions refer to this text.
 */
export function withoutCreate(text: string): string {
  return text.replace(/^\s*create\s+(or\s+replace\s+)?((non)?editionable\s+)?/i, '');
}
