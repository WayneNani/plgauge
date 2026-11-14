/**
 * Compile check for SQL mutants (stage 2 and stage-1 mutants inside SQL, views included) on the public corpus: every unit whose
 * original compiles gets each SQL mutant compiled on its own (oracle rewriter) and all of
 * them together as a schema (statement duplication, rounds as in a run). Reports how many
 * mutants do not compile, by operator, with samples.
 *
 *   tsx scripts/sql-compile-check.ts corpus/db.local.json dir… [--json out.json]
 *
 * The database user only needs CREATE PROCEDURE (and CREATE TYPE for the corpus specs).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import oracledb from 'oracledb';
import { extractUnits } from '../packages/coverage/src/corpus.ts';
import { buildSchema, expand, findInFile, locate, mutatedUnit, SQL_OPERATORS, switchable, type Mutant, type Point } from '../packages/mutation/src/index.ts';
import { CTL_SPEC } from '../packages/mutation/src/ddl.ts';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
const [cfgPath, ...dirs] = args;
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const EXT = /\.(sql|pks|pkb|pkg|tps|tpb|typ|prc|fnc|trg|bdy|spc|plb|pls)$/i;
const BODY = /^(PACKAGE BODY|TYPE BODY|PROCEDURE|FUNCTION|TRIGGER|VIEW)$/;
const UNIT = /^\s*create\s+(?:or\s+replace\s+)?(?:(?:editionable|noneditionable)\s+)?(package\s+body|type\s+body|package|type|procedure|function|trigger)\s+((?:"[^"]+"|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|[\w$#]+))?)/i;

const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d)) {
    if (e === '.git' || e === 'node_modules') continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(e)) out.push(p);
  }
  return out;
};

const conn = await oracledb.getConnection({ user: cfg.user, password: cfg.password, connectString: cfg.connectString });
const unqualified = (text: string) => text.replace(UNIT, (m) => m.replace(/(?:"[^"]+"|[\w$#]+)\s*\.\s*(?=(?:"[^"]+"|[\w$#]+)\s*$)/, ''));
const dictName = (n: string) => {
  const last = n.split('.').pop()!.trim();
  return /^".*"$/.test(last) ? last.replace(/"/g, '') : last.toUpperCase();
};
async function compile(type: string, name: string, text: string, skip = 0): Promise<{ line: number; col: number; text: string }[]> {
  const stmt = unqualified(text).replace(/\s*$/, '');
  try {
    await conn.execute(stmt);
  } catch (e) {
    const msg = (e as Error).message;
    const off = (e as { offset?: number }).offset;
    if (!msg.includes('ORA-24344')) {
      // views are rejected at once: position from the server's offset (skip: the CREATE in front of the schema text)
      if (typeof off !== 'number' || off < skip) return [{ line: 0, col: 0, text: msg.split('\n')[0] }];
      const before = stmt.slice(skip, off);
      return [{ line: before.split('\n').length, col: [...before.slice(before.lastIndexOf('\n') + 1)].length + 1, text: msg.split('\n')[0] }];
    }
  }
  const r = await conn.execute<[number, number, string]>(
    `select line, position, text from user_errors where name = :n and type = :t and attribute = 'ERROR' order by sequence`,
    { n: dictName(name), t: type },
  );
  return (r.rows ?? []).map(([line, col, text]) => ({ line, col, text: text.trim().split('\n')[0] }));
}

const sqlOps = new Set(SQL_OPERATORS);
const files = dirs.flatMap((d) => walk(d));
// specs first (twice), so that bodies find their dependencies
const specs = files.flatMap((f) => extractUnits(f, '/')).filter((u) => !BODY.test(u.kind.toUpperCase()));
await conn.execute(CTL_SPEC.replace(/PLMUT_CTX/g, 'PLMUT_CTX'));
for (let pass = 0; pass < 2; pass++) for (const u of specs) await compile(u.kind.toUpperCase(), u.name, u.text);

const res = {
  units: 0, unitsCompiling: 0, mutants: 0,
  oracle: { ok: 0, failed: [] as { op: string; at: string; orig: string; mutated: string; error: string }[] },
  schema: { units: 0, rounds: 0, dropped: 0, naivePoints: 0, switched: 0, unassigned: [] as string[] },
  byOp: {} as Record<string, { mutants: number; oracleFailed: number }>,
};
for (const path of files) {
  const f = findInFile(path, readFileSync(path));
  // stage 2 and every stage-1 mutant inside SQL: all of them are switched by duplicating the statement
  const ms = expand([f]).filter((m) => sqlOps.has(m.op) || m.ctx === 'sql');
  const byUnit = new Map<number, Mutant[]>();
  for (const m of ms) byUnit.set(m.point.unit, [...(byUnit.get(m.point.unit) ?? []), m]);
  for (const [ui, ums] of byUnit) {
    const u = f.units[ui];
    if (!BODY.test(u.type)) continue;
    res.units++;
    const orig = f.src.subarray(u.start, u.end).toString('utf8');
    if ((await compile(u.type, u.name, orig)).length) continue; // missing objects: not comparable
    res.unitsCompiling++;
    res.mutants += ums.length;
    // oracle rewriter: each mutant on its own
    for (const m of ums) {
      const s = (res.byOp[m.op] ??= { mutants: 0, oracleFailed: 0 });
      s.mutants++;
      const errs = await compile(u.type, u.name, mutatedUnit(m));
      if (!errs.length) res.oracle.ok++;
      else {
        s.oracleFailed++;
        res.oracle.failed.push({ op: m.op, at: `${path}:${m.line}`, orig: m.original, mutated: m.mutated, error: `${errs[0].line}:${errs[0].col} ${errs[0].text}` });
      }
    }
    // schema rewriter: all SQL mutants of the unit at once, errors charged as in a run
    res.schema.units++;
    const dropped = new Set<number>();
    const naive = new Set<Point>(ums.filter((m) => !switchable(m.point)).map((m) => m.point));
    for (let round = 1; round <= 20; round++) {
      res.schema.rounds++;
      const su = buildSchema(ums, dropped, naive)[0];
      const errs = await compile(u.type, u.name, `CREATE OR REPLACE ${su.text}`, 'CREATE OR REPLACE '.length);
      if (!errs.length) break;
      for (const e of errs) {
        const rg = e.line > 0 ? locate(su, e.line, e.col) : undefined;
        if (rg?.mutantId) dropped.add(rg.mutantId);
        else if (rg) for (const q of rg.points ?? [rg.point]) naive.add(q);
        else {
          res.schema.unassigned.push(`${path} ${u.name}: ${e.line}:${e.col} ${e.text}`);
          for (const m of ums) naive.add(m.point);
        }
      }
    }
    res.schema.dropped += dropped.size;
    res.schema.naivePoints += [...naive].filter((p) => switchable(p)).length;
    res.schema.switched += ums.filter((m) => switchable(m.point) && !naive.has(m.point) && !dropped.has(m.id)).length;
    await compile(u.type, u.name, orig); // restore
  }
}
await conn.close();
console.log(`Units mit SQL-Mutanten: ${res.units}, davon kompilieren im Original ${res.unitsCompiling}`);
console.log(`SQL-Mutanten darin: ${res.mutants}; einzeln kompiliert: ${res.oracle.ok} ok, ${res.oracle.failed.length} Fehler`);
for (const [op, s] of Object.entries(res.byOp).sort()) console.log(`  ${op}: ${s.mutants} Mutanten, ${s.oracleFailed} kompilieren nicht`);
console.log(`Schema: ${res.schema.units} Units, ${res.schema.rounds} Runden, ${res.schema.switched} Mutanten umgeschaltet, ${res.schema.dropped} verworfen, ${res.schema.naivePoints} umschaltbare Stellen ohne Schema, ${res.schema.unassigned.length} Fehler ohne Zuordnung`);
for (const x of res.oracle.failed.slice(0, 30)) console.log(`  ${x.op} ${x.at}: ${x.orig.replace(/\s+/g, ' ').slice(0, 50)} → ${x.mutated.replace(/\s+/g, ' ').slice(0, 50)}: ${x.error}`);
for (const x of res.schema.unassigned.slice(0, 10)) console.log(`  ohne Zuordnung: ${x}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(res, null, 1));
