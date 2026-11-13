/**
 * Links mutation results with measured coverage (exchange format plcov-coverage/1).
 *
 * Coordinates: mutants have file lines; coverage has ALL_SOURCE lines, where line 1 is
 * the line of the unit keyword (PACKAGE BODY ..., without CREATE OR REPLACE). Every
 * result carries `unitLine`, the file line of that keyword, so
 * ALL_SOURCE line = line - unitLine + 1.
 *
 * A mutant is executed by a test at most when the test executed the innermost
 * statement around it. So the tests of that statement are a safe superset of the tests
 * that reach the mutant: good enough to select tests in the oracle mode, and the
 * yardstick for the cross-check against the recording run of the schema mode.
 */
import type { CoverageExport } from '@pltest/coverage';
import { objectName, withoutCreate, lineCol, type Mutant } from './mutant.js';

export type CoverageObject = CoverageExport['objects'][number];

/** The file line of the unit keyword: ALL_SOURCE line 1. */
export function unitLineOf(m: Mutant): number {
  const text = m.sourceFile.src.subarray(m.unitRef.start, m.unitRef.end).toString('utf8');
  const skip = Buffer.byteLength(text.slice(0, text.length - withoutCreate(text).length), 'utf8');
  return lineCol(m.sourceFile.src, m.unitRef.start + skip)[0];
}

/** "PACKAGE BODY shop_pricing" → type and dictionary name. */
export function splitUnit(unit: string): { type: string; name: string } {
  const m = /^(PACKAGE BODY|TYPE BODY|PROCEDURE|FUNCTION|TRIGGER) (.+)$/.exec(unit);
  if (!m) return { type: '', name: unit };
  return { type: m[1], name: objectName(m[2]) };
}

export class CoverageIndex {
  private objects = new Map<string, CoverageObject>();
  /** Tests marked flaky by the coverage run. */
  flaky: Set<string>;

  constructor(public exp: CoverageExport) {
    if (exp.format !== 'plcov-coverage/1') throw new Error(`unbekanntes Coverage-Format: ${exp.format}`);
    this.flaky = new Set(exp.tests.filter((t) => t.status === 'flaky').map((t) => t.path));
    for (const o of exp.objects) this.objects.set(`${o.type} ${o.name}`, o);
  }

  object(unit: string): CoverageObject | undefined {
    const { type, name } = splitUnit(unit);
    return this.objects.get(`${type} ${name}`);
  }

  /**
   * Test paths that executed the innermost statement around an ALL_SOURCE position;
   * null if no measured statement contains it (declarations, the line of BEGIN) or if
   * suite setup code was involved (then nobody can tell which tests depend on it).
   * Without a column (or without statement columns in older exports) the outermost
   * statement on the line is taken: a condition and the statements of its branch can
   * share a line, and the condition runs more often.
   */
  testsAt(obj: CoverageObject, line: number, col?: number): string[] | null {
    if (!obj.instrumented || !obj.statements) return null;
    type St = NonNullable<CoverageObject['statements']>[number];
    const before = (l1: number, c1: number, l2: number, c2: number) => l1 < l2 || (l1 === l2 && c1 <= c2);
    let best: St | undefined;
    for (const s of obj.statements) {
      if (s.line > line || s.endLine < line) continue;
      if (col !== undefined && s.col !== undefined && s.endCol !== undefined) {
        if (!before(s.line, s.col, line, col) || !before(line, col, s.endLine, s.endCol)) continue;
        if (!best || before(best.line, best.col ?? 0, s.line, s.col)) best = s;
      } else if (!best || (s.line < line && (best.line === line || s.line > best.line))) {
        // line only: innermost statement starting above the line, else one starting on it
        best = s;
      }
    }
    if (!best) return null;
    const tests = best.tests.map((k) => this.exp.tests[k]);
    if (tests.some((t) => !t || t.setup)) return null;
    return tests.map((t) => t.path);
  }
}

export interface LinkedResult {
  unit: string;
  file: string;
  line: number;
  col?: number;
  unitLine: number;
  op: string;
  original: string;
  mutated: string;
  status: string;
  coveredBy?: string[];
}

export interface CrossCheck {
  /** Results with a recorded test list that could be checked. */
  checked: number;
  consistent: number;
  /** No coverage for the unit, or no statement around the mutant (declarations, RET). */
  unknown: number;
  /** The recording run saw a test reach the mutant, coverage says the test never ran the statement. */
  contradictions: { r: LinkedResult; test: string; statementTests: string[] }[];
  /** Coverage ran the statement, the recording saw no test reach the mutant (other branch of an expression, say). */
  executedNotReached: number;
}

/**
 * Cross-check of the two tools on one project and database: every test that reached a
 * mutant in the recording run must also have executed the statement around it.
 */
export function crossCheck(results: LinkedResult[], idx: CoverageIndex): CrossCheck {
  const out: CrossCheck = { checked: 0, consistent: 0, unknown: 0, contradictions: [], executedNotReached: 0 };
  for (const r of results) {
    const obj = idx.object(r.unit);
    const line = r.line - r.unitLine + 1;
    const tests = obj ? idx.testsAt(obj, line, line > 1 ? r.col : undefined) : null;
    if (r.status === 'NOT_COVERED') {
      if (tests?.length) out.executedNotReached++;
      continue;
    }
    if (!r.coveredBy) continue;
    if (!tests) {
      out.unknown++;
      continue;
    }
    out.checked++;
    // flaky tests take other paths from run to run: no evidence either way
    const missing = r.coveredBy.filter((t) => !tests.includes(t) && !idx.flaky.has(t));
    if (missing.length) for (const t of missing) out.contradictions.push({ r, test: t, statementTests: tests });
    else out.consistent++;
  }
  return out;
}

export function crossCheckText(c: CrossCheck): string {
  const lines = [
    `${c.checked} Mutanten geprüft: ${c.consistent} stimmig, ${c.contradictions.length} Widersprüche; ${c.unknown} ohne Vergleich (keine Anweisung drumherum oder keine Coverage)`,
    `${c.executedNotReached} nicht erreichte Mutanten liegen in ausgeführten Anweisungen (z. B. nicht gewählter Zweig eines Ausdrucks)`,
  ];
  for (const x of c.contradictions.slice(0, 50)) {
    lines.push(`  ${x.r.file.split('/').pop()}:${x.r.line} ${x.r.op} ${x.r.original.replace(/\s+/g, ' ').slice(0, 50)}: ${x.test} erreicht den Mutanten, führt laut Coverage die Anweisung aber nicht aus`);
  }
  return lines.join('\n') + '\n';
}
