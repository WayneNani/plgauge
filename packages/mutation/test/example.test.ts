/**
 * The example project against a real database, in both modes: every verdict must
 * match examples/shop_pricing/expected.tsv, written by hand before the first run of
 * plmut. Needs PLMUT_DB (oracle://user:pw@host:port/service); skipped otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import oracledb from 'oracledb';
import { journalEntries, loadObject, replaceSource } from '@pltest/core';
import { CoverageIndex, crossCheck, parseDbUrl, projectCoverageConfig, runMutation, type Result } from '@pltest/mutation';
import { runCoverage, toCoverageExport } from '@pltest/coverage';

const db = process.env.PLMUT_DB?.split(',')[0];
const dir = fileURLToPath(new URL('../../../examples/shop_pricing', import.meta.url));

function expected(): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(`${dir}/expected.tsv`, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    m.set(`${f[0]}|${f[1]}|${f[2].replaceAll('\\n', '\n')}|${f[3].replaceAll('\\n', '\n')}`, f[4]);
  }
  return m;
}

function check(results: Result[]) {
  const want = expected();
  assert.equal(results.length, want.size, 'Zahl der Mutanten');
  const wrong: string[] = [];
  for (const r of results) {
    const key = `${r.sub}|${r.op}|${r.original}|${r.mutated}`;
    const w = want.get(key);
    const got = r.status === 'NOT_COVERED' ? 'SURVIVED' : r.status; // no test reaches it: survives every run
    if (w === undefined) wrong.push(`unerwartet: ${key}`);
    else if (!w.split('|').includes(got)) wrong.push(`${r.line} ${r.op} ${r.original} → ${r.mutated}: ${r.status}, erwartet ${w} (${r.detail ?? ''})`);
  }
  assert.deepEqual(wrong, []);
}

test('example: coverage, cross-check with the recording run, oracle mode with coverage selection', { skip: !db && 'PLMUT_DB nicht gesetzt', timeout: 900_000 }, async () => {
  const cov = toCoverageExport(await runCoverage(await projectCoverageConfig(dir, db!, true), () => {}));
  assert.ok(cov.tests.filter((t) => !t.setup).length >= 14, 'Tests mit Einzelzuordnung');
  const schema = await runMutation({ dir, dbUrls: [db!], mode: 'schema' });
  const c = crossCheck(schema.results, new CoverageIndex(cov));
  assert.ok(c.checked > 40, `geprüft: ${c.checked}`);
  assert.deepEqual(c.contradictions.map((x) => `${x.r.line} ${x.r.op} ${x.test}`), []);
  const naive = await runMutation({ dir, dbUrls: [db!], mode: 'naive', coverage: cov });
  check(naive.results);
  const selected = naive.results.filter((r) => r.coveredBy).map((r) => r.coveredBy!.length);
  assert.ok(selected.length > 40 && selected.reduce((a, b) => a + b, 0) / selected.length < 10, 'weniger Tests pro Mutant');
});

for (const mode of ['naive', 'schema'] as const) {
  test(`example verdicts as expected (${mode})`, { skip: !db && 'PLMUT_DB nicht gesetzt', timeout: 600_000 }, async () => {
    const want = expected();
    const rep = await runMutation({ dir, dbUrls: [db!], mode });
    assert.equal(rep.results.length, want.size, 'Zahl der Mutanten');
    const wrong: string[] = [];
    for (const r of rep.results) {
      const key = `${r.sub}|${r.op}|${r.original}|${r.mutated}`;
      const w = want.get(key);
      const got = r.status === 'NOT_COVERED' ? 'SURVIVED' : r.status; // no test reaches it: survives every run
      if (w === undefined) wrong.push(`unerwartet: ${key}`);
      else if (!w.split('|').includes(got)) wrong.push(`${r.line} ${r.op} ${r.original} → ${r.mutated}: ${r.status}, erwartet ${w} (${r.detail ?? ''})`);
      const side = r.sub === 'storniere' && r.original === "p_modus = 'final'" && r.mutated === 'TRUE';
      if (!!r.sideEffect !== side) wrong.push(`${r.line} ${r.mutated}: Nebenwirkung ${!!r.sideEffect}, erwartet ${side}`);
    }
    assert.deepEqual(wrong, []);
  });
}

// Several schemas (A4): units written as other_schema.name. Needs CREATE ANY PROCEDURE and
// EXECUTE ANY PROCEDURE for the user of PLMUT_DB and a second schema, e.g. PLMUT_LIB_SCHEMA=DEMO_LIB.
const lib = process.env.PLMUT_LIB_SCHEMA;
test('several schemas: a unit of another schema is mutated in both modes', { skip: (!db || !lib) && 'PLMUT_DB / PLMUT_LIB_SCHEMA nicht gesetzt', timeout: 600_000 }, async () => {
  const L = lib!.toLowerCase();
  const p = mkdtempSync(join(tmpdir(), 'pltest-multi-'));
  mkdirSync(join(p, 'src'));
  writeFileSync(join(p, 'src', 'calc.sql'), `CREATE OR REPLACE PACKAGE ${L}.pltest_mcalc AS
  FUNCTION fee(n NUMBER) RETURN NUMBER;
END;
/
CREATE OR REPLACE PACKAGE BODY ${L}.pltest_mcalc AS
  FUNCTION fee(n NUMBER) RETURN NUMBER IS
  BEGIN
    IF n > 100 THEN
      RETURN n * 0.02;
    END IF;
    RETURN 2;
  END;
END;
/
`);
  writeFileSync(join(p, 'src', 'test.sql'), `CREATE OR REPLACE PACKAGE pltest_mcalc_test AS
  --%suite

  --%test
  PROCEDURE big;
  --%test
  PROCEDURE small;
END;
/
CREATE OR REPLACE PACKAGE BODY pltest_mcalc_test AS
  PROCEDURE big IS BEGIN ut.expect(${L}.pltest_mcalc.fee(1000)).to_equal(20); END;
  PROCEDURE small IS BEGIN ut.expect(${L}.pltest_mcalc.fee(50)).to_equal(2); END;
END;
/
`);
  writeFileSync(join(p, 'pltest.json'), JSON.stringify({ install: ['src/calc.sql', 'src/test.sql'], mutate: ['src/calc.sql'], tests: ['pltest_mcalc_test'] }));
  const verdict = (rs: Result[]) => rs.map((r) => `${r.op} ${r.original.trim()} → ${r.mutated.trim()}: ${r.status === 'NOT_COVERED' ? 'SURVIVED' : r.status}`).sort();
  const schema = await runMutation({ dir: p, dbUrls: [db!], mode: 'schema' });
  const naive = await runMutation({ dir: p, dbUrls: [db!], mode: 'naive', skipInstall: true });
  assert.equal(schema.results.length, 6); // RET ×2, ROR ×3 on n > 100, AOR on n * 0.02
  assert.deepEqual(verdict(schema.results), verdict(naive.results));
  // the boundary n > 100 → n >= 100 is not tested: survives; everything else is killed
  assert.deepEqual(schema.results.filter((r) => r.status === 'SURVIVED').map((r) => r.mutated.trim()), ['n >= 100']);
});

// Cursor declarations (UNION ALL), cursor FOR loops (duplicated) and dynamic SQL (literal switched in place)
test('cursors, cursor FOR loops and dynamic SQL: everything switched, same verdicts in both modes', { skip: !db && 'PLMUT_DB nicht gesetzt', timeout: 900_000 }, async () => {
  const p = mkdtempSync(join(tmpdir(), 'pltest-qsql-'));
  mkdirSync(join(p, 'src'));
  writeFileSync(join(p, 'src', 'q.sql'), `CREATE TABLE IF NOT EXISTS pltest_q_t (id NUMBER, v NUMBER)
/
CREATE OR REPLACE PACKAGE pltest_qsql AS
  FUNCTION total(p_min NUMBER) RETURN NUMBER;
  FUNCTION cnt(p_min NUMBER) RETURN NUMBER;
  FUNCTION dyn(p_max NUMBER) RETURN NUMBER;
END;
/
CREATE OR REPLACE PACKAGE BODY pltest_qsql AS
  FUNCTION total(p_min NUMBER) RETURN NUMBER IS
    CURSOR c IS SELECT v * 2 AS w FROM pltest_q_t WHERE v > p_min;
    s NUMBER := 0;
  BEGIN
    FOR r IN c LOOP
      s := s + r.w;
    END LOOP;
    RETURN s;
  END;
  FUNCTION cnt(p_min NUMBER) RETURN NUMBER IS
    n NUMBER := 0;
  BEGIN
    FOR r IN (SELECT id FROM pltest_q_t WHERE v >= p_min) LOOP
      n := n + 1;
    END LOOP;
    RETURN n;
  END;
  FUNCTION dyn(p_max NUMBER) RETURN NUMBER IS
    l_sql VARCHAR2(200) := 'select count(*) from pltest_q_t where v < :m';
    n NUMBER;
  BEGIN
    EXECUTE IMMEDIATE l_sql INTO n USING p_max;
    RETURN n;
  END;
END;
/
`);
  writeFileSync(join(p, 'src', 'test.sql'), `CREATE OR REPLACE PACKAGE pltest_qsql_test AS
  --%suite

  --%beforeeach
  PROCEDURE rows;
  --%test
  PROCEDURE total;
  --%test
  PROCEDURE cnt;
  --%test
  PROCEDURE dyn;
END;
/
CREATE OR REPLACE PACKAGE BODY pltest_qsql_test AS
  PROCEDURE rows IS
  BEGIN
    DELETE FROM pltest_q_t;
    INSERT INTO pltest_q_t VALUES (1, 10);
    INSERT INTO pltest_q_t VALUES (2, 20);
    INSERT INTO pltest_q_t VALUES (3, 30);
  END;
  PROCEDURE total IS BEGIN ut.expect(pltest_qsql.total(15)).to_equal(100); END;
  PROCEDURE cnt IS BEGIN ut.expect(pltest_qsql.cnt(20)).to_equal(2); END;
  PROCEDURE dyn IS BEGIN ut.expect(pltest_qsql.dyn(20)).to_equal(1); END;
END;
/
`);
  writeFileSync(join(p, 'pltest.json'), JSON.stringify({ install: ['src/q.sql', 'src/test.sql'], mutate: ['src/q.sql'], tests: ['pltest_qsql_test'] }));
  const verdict = (rs: Result[]) => rs.map((r) => `${r.line} ${r.op} ${r.original.trim()} → ${r.mutated.trim()}: ${r.status === 'NOT_COVERED' ? 'SURVIVED' : r.status}`).sort();
  const log: string[] = [];
  const schema = await runMutation({ dir: p, dbUrls: [db!], mode: 'schema', log: (m) => log.push(m) });
  const naive = await runMutation({ dir: p, dbUrls: [db!], mode: 'naive', skipInstall: true });
  assert.ok(log.some((l) => /0 Mutanten verworfen, 0 Stellen ohne Schema/.test(l)), log.join('\n'));
  assert.ok(schema.results.some((r) => r.mutant.point.dyn) && schema.results.some((r) => r.mutant.point.union), 'dynamic SQL and cursor points');
  assert.deepEqual(verdict(schema.results), verdict(naive.results));
  // the boundaries v > 15, v >= 20 and v < 20 are tested by the data: their ROR variants are killed
  assert.ok(schema.results.filter((r) => r.op === 'ROR' && r.status === 'KILLED').length >= 6);
});

test('a run first puts back what a crashed run left in the journal', { skip: !db && 'PLMUT_DB nicht gesetzt', timeout: 600_000 }, async () => {
  const conn = await oracledb.getConnection(parseDbUrl(db!));
  try {
    const owner = (await conn.execute<[string]>(`select user from dual`)).rows![0][0];
    const before = await loadObject(conn, owner, 'SHOP_PRICING', 'PACKAGE BODY');
    // as a crashed run leaves it: changed code, the original in the journal
    await replaceSource(conn, before, `${before.original.trimEnd()}\n-- left by a crashed run\n`, 'mutation');
    await runMutation({ dir, dbUrls: [db!], mode: 'schema', skipInstall: true, sample: 2, seed: 3 });
    const after = await loadObject(conn, owner, 'SHOP_PRICING', 'PACKAGE BODY');
    assert.equal(after.original, before.original);
    assert.deepEqual((await journalEntries(conn)).filter((e) => e.name === 'SHOP_PRICING'), []);
  } finally {
    await conn.close();
  }
});
