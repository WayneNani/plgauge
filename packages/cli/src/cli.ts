#!/usr/bin/env -S npx tsx
/**
 * pltest – coverage and mutation testing for PL/SQL
 *
 *   pltest coverage --config plcov.json [--out report]  measure coverage, write report ("run" is the old name)
 *   pltest instrument <file.sql> [--no-sql]             print instrumented source (offline)
 *   pltest deploy <file.sql ...> --config plcov.json    run SQL*Plus-style scripts (demo setup)
 *   pltest report <coverage.json> [--out report]        re-render HTML from saved JSON
 *   pltest export <coverage.json> [--out file]          write the exchange format plcov-coverage/1
 *   pltest corpus <dir ...> [--db plcov.json]           robustness check on a corpus of PL/SQL files
 *   pltest restore --config plcov.json [--list]         put back code left changed by a killed run (journal)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, ensureJournal, journalEntries, preprocess, restoreAll, splitScript } from '@pltest/core';
import { instrument, newIds, runCoverage, toCoverageExport, runCorpus, type RunConfig, type RunReport } from '@pltest/coverage';
import { renderHtml } from '@pltest/report';

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name: string) => {
  const k = args.indexOf(`--${name}`);
  if (k < 0) return undefined;
  const v = args[k + 1];
  args.splice(k, 2);
  return v;
};
const flag = (name: string) => {
  const k = args.indexOf(`--${name}`);
  if (k < 0) return false;
  args.splice(k, 1);
  return true;
};

function loadConfig(path: string | undefined): RunConfig {
  if (!path) throw new Error('--config fehlt');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as RunConfig;
  cfg.password = process.env.PLTEST_PASSWORD ?? process.env.PLCOV_PASSWORD ?? cfg.password;
  return cfg;
}

async function main() {
  switch (cmd) {
    case 'coverage':
    case 'run': {
      const cfg = loadConfig(opt('config'));
      const out = resolve(opt('out') ?? 'plcov-report');
      const report = await runCoverage(cfg);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'coverage.json'), JSON.stringify(report, null, 1));
      writeFileSync(join(out, 'plcov-coverage.json'), JSON.stringify(toCoverageExport(report), null, 1));
      writeFileSync(join(out, 'index.html'), renderHtml(report));
      console.error(`Bericht: ${join(out, 'index.html')}`);
      break;
    }
    case 'report': {
      const file = args.shift();
      if (!file) throw new Error('coverage.json fehlt');
      const out = resolve(opt('out') ?? 'plcov-report');
      const report = JSON.parse(readFileSync(file, 'utf8')) as RunReport;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'index.html'), renderHtml(report));
      console.error(`Bericht: ${join(out, 'index.html')}`);
      break;
    }
    case 'export': {
      const file = args.shift();
      if (!file) throw new Error('coverage.json fehlt');
      const out = resolve(opt('out') ?? 'plcov-coverage.json');
      writeFileSync(out, JSON.stringify(toCoverageExport(JSON.parse(readFileSync(file, 'utf8')) as RunReport), null, 1));
      console.error(`Export: ${out}`);
      break;
    }
    case 'corpus': {
      const dbCfg = opt('db');
      const out = opt('out');
      const cfg = dbCfg ? loadConfig(dbCfg) : undefined;
      const r = await runCorpus(args, cfg && { user: cfg.user, password: cfg.password, connectString: cfg.connectString });
      const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)} %` : '–');
      console.log(`Dateien ${r.files} · Bodies ${r.units.body} · Spezifikationen ${r.units.spec} · Latin-1-Dateien ${r.latin1Files.length}`);
      console.log(`Geparst und instrumentiert: ${r.parsed}/${r.units.body} (${pct(r.parsed, r.units.body)}) in ${r.ms.toFixed(0)} ms`);
      console.log(`Anweisungen ${r.statements} · Entscheidungen ${r.decisions} · Teilbedingungen ${r.conditions} · nicht gemessen ${r.gaps}`);
      for (const f of r.failures) console.log(`  ✗ ${f.unit}: ${f.error}`);
      if (r.db) {
        console.log(`DB: Original kompiliert ${r.db.originalOk} · instrumentiert kompiliert ${r.db.instrumentedOk}/${r.db.originalOk} (${pct(r.db.instrumentedOk, r.db.originalOk)})`);
        for (const f of r.db.failures) console.log(`  ✗ ${f.unit}: ${f.error}`);
      }
      if (out) writeFileSync(out, JSON.stringify(r, null, 1));
      break;
    }
    case 'instrument': {
      const noSql = flag('no-sql');
      const file = args.shift();
      if (!file) throw new Error('Datei fehlt');
      for (const stmt of splitScript(readFileSync(file, 'utf8'))) {
        const r = instrument(preprocess(stmt + '\n'), 'SCHEMA', newIds(), { sqlProbes: !noSql });
        process.stdout.write(r.instrumented + '/\n');
      }
      break;
    }
    case 'deploy': {
      const cfg = loadConfig(opt('config'));
      const conn = await connect(cfg);
      try {
        for (const file of args) {
          for (const stmt of splitScript(readFileSync(file, 'utf8'))) {
            try {
              await conn.execute(stmt);
            } catch (e) {
              const msg = (e as Error).message;
              if (/ORA-00955|ORA-02260|ORA-02275/.test(msg)) continue; // already exists
              throw new Error(`${file}: ${msg}`);
            }
          }
          console.error(`✓ ${file}`);
        }
        const inv = await conn.execute<[string, string]>(`select object_name, object_type from user_objects where status = 'INVALID'`);
        if (inv.rows?.length) console.error(`Ungültige Objekte: ${inv.rows.map((r) => r.join(' ')).join(', ')}`);
      } finally {
        await conn.close();
      }
      break;
    }
    case 'restore': {
      const cfg = loadConfig(opt('config'));
      const listOnly = flag('list');
      const conn = await connect(cfg);
      try {
        await ensureJournal(conn);
        const entries = await journalEntries(conn);
        if (!entries.length) {
          console.error('Journal leer: kein Objekt ist verändert.');
          break;
        }
        for (const e of entries) console.error(`  ${e.type} ${e.owner}.${e.name} (${e.tool}, seit ${e.createdAt.toISOString()})`);
        if (!listOnly) await restoreAll(conn, entries.map((e) => e.object), (m) => console.error(m));
      } finally {
        await conn.close();
      }
      break;
    }
    default:
      console.error('Verwendung: pltest coverage|report|export|instrument|deploy|corpus|restore …  (siehe README.md)');
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
