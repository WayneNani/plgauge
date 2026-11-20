/**
 * Exchange format "plgauge-coverage/1": per-test coverage for other tools (e.g. the oracle mode of plgauge mutate).
 *
 * Coordinates: lines and columns are 1-based and refer to the unit's source as stored in
 * ALL_SOURCE (line 1 = "package body …", without CREATE OR REPLACE). The post-processed text
 * (conditional compilation resolved) has the same line structure; `rawSha256` is the hash of
 * the unprocessed ALL_SOURCE text so that consumers working on repository files can verify
 * they look at the same code. Test paths are lower case: owner.package.procedure.
 * Probes reached outside any test (suite beforeall/afterall) are attributed to explicit
 * setup entries ("#owner.package", setup: true) instead of to a test.
 * Optional since plgauge: `statements` with their line range, so that a consumer can find
 * the statement around a position (mutation testing selects tests with it); per test the
 * `message` of a failure.
 */
import type { RunReport } from './run.js';
import type { Span } from './model.js';

export interface CoverageExport {
  format: 'plgauge-coverage/1';
  generated: string;
  database: string;
  schema: string;
  coordinates: 'all_source';
  tests: {
    path: string;
    setup: boolean;
    /** Result with instrumentation; "excluded" = already failing without instrumentation. */
    status: 'passed' | 'failed' | 'error' | 'skipped' | 'excluded' | 'flaky' | 'unknown';
    ms: number;
    baselineRuns: number;
    /** Optional: why the test failed (first line of utPLSQL's report). */
    message?: string;
  }[];
  objects: {
    owner: string;
    name: string;
    type: string;
    sourceSha256?: string;
    rawSha256?: string;
    instrumented: boolean;
    lines: Record<string, { hits: number; tests: number[] }>;
    statements?: { line: number; endLine: number; col?: number; endCol?: number; hits: number; tests: number[] }[];
    branches: { line: number; col: number; label: string; kind: string; hits: number; tests: number[]; condition?: Range; construct?: number; nf?: boolean }[];
    conditions: {
      decision: number; index: number; text: string; context: 'plsql' | 'sql'; range: Range; tests: { T: number[]; F: number[]; N: number[] };
      t?: number; f?: number; n?: number; mcdc?: 'yes' | 'no' | 'na'; nf?: boolean;
    }[];
    /** Quotas as measured (plgauge). Missing after merging runs: recomputed from hits. */
    metrics?: Record<'stmt' | 'branch' | 'cond' | 'mcdc' | 'loop', { covered: number; total: number }>;
    notMeasured: { line: number; reason: string }[];
  }[];
}

type Range = { line: number; col: number; endLine: number; endCol: number };
const range = (s: Span): Range => ({ line: s.line, col: s.col, endLine: s.endLine, endCol: s.endCol });

export function toCoverageExport(r: RunReport): CoverageExport {
  return {
    format: 'plgauge-coverage/1',
    generated: r.generated,
    database: r.database,
    schema: r.schema,
    coordinates: 'all_source',
    tests: (r.tests ?? []).map((t) => ({
      path: t.path,
      setup: t.setup,
      status: t.setup ? 'unknown' : t.status === 'flaky' ? 'flaky' : t.baselineStatus !== 'passed' && t.baselineStatus !== 'unknown' ? 'excluded' : t.status,
      ms: Math.round(t.ms * 1000) / 1000,
      baselineRuns: r.baselineRuns ?? 1,
      ...(t.message ? { message: t.message } : {}),
    })),
    objects: r.objects.map((o) => {
      const lines: Record<string, { hits: number; tests: number[] }> = {};
      for (const s of o.statements) {
        const e = (lines[s.line] ??= { hits: 0, tests: [] });
        e.hits = Math.max(e.hits, s.hits);
        e.tests = [...new Set([...e.tests, ...(s.tests ?? [])])].sort((a, b) => a - b);
      }
      return {
        owner: o.owner,
        name: o.name,
        type: o.type,
        sourceSha256: o.sourceSha256,
        rawSha256: o.rawSha256,
        instrumented: !o.instrumentError,
        lines,
        statements: o.statements.filter((s) => !s.nf).map((s) => ({ line: s.line, endLine: s.endLine, col: s.col, endCol: s.endCol, hits: s.hits, tests: s.tests ?? [] })),
        branches: o.branches.map((b) => ({
          line: b.line, col: b.col, label: b.label, kind: b.constructKind, hits: b.hits, tests: b.tests ?? [],
          ...(b.condition ? { condition: range(b.condition) } : {}), construct: b.construct, nf: b.nf,
        })),
        conditions: o.decisions.flatMap((d) => d.conds.map((c) => ({
          decision: d.id, index: c.i, text: c.text, context: d.ctx, range: range(c.span), tests: c.tests ?? { T: [], F: [], N: [] },
          t: c.t, f: c.f, n: c.n, mcdc: c.mcdc, nf: d.nf,
        }))),
        notMeasured: o.gaps,
        ...(o.instrumentError ? {} : { metrics: o.metrics }),
      };
    }),
  };
}
