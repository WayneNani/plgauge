/**
 * Reports of a mutation run, ported from plmut (internal/run/report.go, schemajson.go):
 * console text, plmut JSON, the mutation-testing-report-schema (Stryker) and an HTML
 * page with the mutation-testing-elements viewer. `compare` puts two runs side by side.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve, basename } from 'node:path';
import type { Report, Result, Status } from './run.js';

export function counts(rep: Report): Map<Status, number> {
  const c = new Map<Status, number>();
  for (const r of rep.results) c.set(r.status, (c.get(r.status) ?? 0) + 1);
  return c;
}

/** Killed (including timeouts and memory) over all valid mutants. */
export function score(rep: Report): number {
  const c = counts(rep);
  const g = (s: Status) => c.get(s) ?? 0;
  const detected = g('KILLED') + g('TIMEOUT') + g('MEMORY');
  const valid = detected + g('SURVIVED') + g('NOT_COVERED');
  return valid ? (100 * detected) / valid : 0;
}

const catTitle: Record<string, string> = {
  fehlerpfad: 'Fehlerpfad, den kein Test auslöst',
  pruefung: 'Prüfung, die sich abschwächen lässt',
  funktion: 'Unterprogramm ohne wirksamen Test',
  '': 'Weitere',
};

function oneLine(s: string): string {
  const t = s.split(/\s+/).filter(Boolean).join(' ');
  return [...t].length > 60 ? [...t].slice(0, 57).join('') + '…' : t;
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 60_000 ? 0 : 3)}s` : `${Math.round(ms)}ms`);

/** Console report: survivors first, grouped by category. */
export function textReport(rep: Report): string {
  const out: string[] = [];
  const line = (r: Result) =>
    `  ${r.status.padEnd(11)} ${basename(r.file)}:${r.line}  ${r.op}  ${r.sub}  ${oneLine(r.original)} → ${oneLine(r.mutated)}`;
  const order = ['pruefung', 'fehlerpfad', 'funktion', ''];
  const surv = rep.results.filter((r) => r.status === 'SURVIVED' || r.status === 'NOT_COVERED');
  for (const cat of order) {
    const group = surv.filter((r) => (order.includes(r.category) ? r.category : '') === cat);
    if (!group.length) continue;
    out.push('', `${catTitle[cat]}:`, ...group.map(line));
  }
  const side = rep.results.filter((r) => r.sideEffect);
  if (side.length) out.push('', 'Nebenwirkung, ein Test hat committet:', ...side.map(line));
  const shaky = rep.results.filter((r) => r.unstable);
  if (shaky.length) out.push('', 'Urteil hängt von Umständen ab (Gegenprobe):', ...shaky.map((r) => `${line(r)}\n      ${r.unstable}`));
  const errs = rep.results.filter((r) => r.status === 'ERROR');
  if (errs.length) out.push('', 'Fehler des Werkzeugs:', ...errs.map((r) => `  ${basename(r.file)}:${r.line} ${r.op}: ${r.detail}`));
  const c = counts(rep);
  const parts = (['KILLED', 'SURVIVED', 'NOT_COVERED', 'TIMEOUT', 'MEMORY', 'COMPILE_ERROR', 'ERROR'] as Status[])
    .filter((s) => c.get(s)).map((s) => `${s} ${c.get(s)}`);
  out.push('', `${rep.results.length} Mutanten: ${parts.join(', ')}${shaky.length ? ` (${shaky.length} mit unsicherem Urteil)` : ''}`);
  out.push(`Mutation Score ${score(rep).toFixed(1)} % · ${rep.tests} Tests · Baseline ${fmt(rep.baselineMs)} · Laufzeit ${fmt(rep.elapsedMs)}`);
  for (const t of rep.flakyTests) out.push(`unzuverlässiger Test, nachträglich ausgeschlossen: ${t}`);
  if (rep.excludedTests > 0) out.push(`${rep.excludedTests} Tests ausgeschlossen, weil sie schon ohne Mutanten scheitern`);
  return out.join('\n') + '\n';
}

/** plmut JSON: the report without the internal mutant objects. */
export function jsonReport(rep: Report): string {
  return JSON.stringify(rep, (k, v) => (k === 'mutant' ? undefined : v), 2);
}

const mtStatus: Record<Status, string> = {
  KILLED: 'Killed', SURVIVED: 'Survived', TIMEOUT: 'Timeout', MEMORY: 'RuntimeError',
  NOT_COVERED: 'NoCoverage', COMPILE_ERROR: 'CompileError', ERROR: 'RuntimeError',
};

/** The mutation-testing-elements report format (schema version 2). */
export function mutationTestingReport(rep: Report, root: string): string {
  const files: Record<string, { language: string; source: string; mutants: unknown[] }> = {};
  for (const r of rep.results) {
    const rel = relative(root, r.file) || r.file;
    files[rel] ??= { language: 'plsql', source: r.mutant.sourceFile.src.toString('utf8'), mutants: [] };
    files[rel].mutants.push({
      id: String(r.id),
      mutatorName: r.op,
      replacement: r.mutated,
      location: { start: { line: r.line, column: r.col }, end: { line: r.endLine, column: r.endCol } },
      status: mtStatus[r.status],
      ...(r.detail || r.unstable ? { statusReason: [r.detail, r.unstable].filter(Boolean).join('; ') } : {}),
      description: r.category ? `${r.op} in ${r.sub}: ${r.category}` : `${r.op} in ${r.sub}`,
      ...(r.killedBy ? { killedBy: [r.killedBy] } : {}),
      duration: Math.round(r.durationMs),
    });
  }
  return JSON.stringify({
    schemaVersion: '2',
    thresholds: { high: 80, low: 60 },
    projectRoot: resolve(root),
    files,
    framework: { name: 'pltest mutate', version: '0.1' },
  }, null, 2);
}

/** A self-contained page that renders the report with the mutation-testing-elements web component. */
export function htmlReport(rep: Report, root: string): string {
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><title>pltest – Mutationsbericht</title>
<script src="https://cdn.jsdelivr.net/npm/mutation-testing-elements@3.5.1/dist/mutation-test-elements.js"></script>
</head><body>
<mutation-test-report-app titlePostfix="pltest"></mutation-test-report-app>
<script>document.querySelector('mutation-test-report-app').report = ${mutationTestingReport(rep, root)};</script>
<noscript>Der Bericht braucht JavaScript.</noscript>
</body></html>
`;
}

interface CompareRow {
  id: number;
  file: string;
  line: number;
  op: string;
  original: string;
  mutated: string;
  status: string;
  detail?: string;
}

/** Key of a mutant independent of numbering: file, position, operator, replacement. */
export const mutantKey = (r: { file: string; line: number; col?: number; op: string; original: string; mutated: string }) =>
  `${basename(r.file)}|${r.line}|${r.col ?? ''}|${r.op}|${r.original}|${r.mutated}`;

/**
 * Compares two runs (plmut JSON of the Go version or of pltest). Mutants are matched
 * by their key, not by ID. NOT_COVERED counts as SURVIVED; a mismatch that both runs
 * detect (killed, timeout, memory) is listed separately.
 */
export function compare(a: string, b: string): { text: string; same: number; diff: number; detected: number } {
  const load = (p: string) => {
    const rows = (JSON.parse(readFileSync(p, 'utf8')).results ?? []) as CompareRow[];
    return new Map(rows.map((r) => [mutantKey(r), r]));
  };
  const ra = load(a);
  const rb = load(b);
  const norm = (s: string) => (s === 'NOT_COVERED' ? 'SURVIVED' : s);
  const detectedSt = new Set(['KILLED', 'TIMEOUT', 'MEMORY']);
  const lines: string[] = [];
  let same = 0, diff = 0, detected = 0;
  for (const [k, x] of ra) {
    const y = rb.get(k);
    if (!y) {
      lines.push(`  nur in ${basename(a)}: ${basename(x.file)}:${x.line} ${x.op} ${x.original} → ${x.mutated}`);
      diff++;
      continue;
    }
    if (norm(x.status) === norm(y.status)) {
      same++;
      continue;
    }
    diff++;
    if (detectedSt.has(x.status) && detectedSt.has(y.status)) detected++;
    lines.push(`  ${basename(x.file)}:${x.line} ${x.op} ${JSON.stringify(x.original)} → ${JSON.stringify(x.mutated)}: ${x.status} / ${y.status}  (${x.detail ?? ''} | ${y.detail ?? ''})`);
  }
  for (const [k, y] of rb) {
    if (!ra.has(k)) {
      lines.push(`  nur in ${basename(b)}: ${basename(y.file)}:${y.line} ${y.op} ${y.original} → ${y.mutated}`);
      diff++;
    }
  }
  lines.push(`${same} gleich, ${diff} verschieden, davon ${detected} in beiden erkannt (getötet, Timeout oder Speicher)`);
  return { text: lines.join('\n'), same, diff, detected };
}
