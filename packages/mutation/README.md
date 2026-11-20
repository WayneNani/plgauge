# @plgauge/mutation – mutation testing for PL/SQL

This package is the mutation testing part of plgauge. It makes small changes (mutants) to your
PL/SQL code, runs your existing utPLSQL tests against each one and reports which changes the tests
do not notice. It is a TypeScript port of the earlier Go tool plmut.

Contents:

- [Quick start](#quick-start)
- [Project file `plgauge.json`](#project-file-plgaugejson)
- [Commands and options](#commands-and-options)
- [How a run works](#how-a-run-works)
- [Verdicts and score](#verdicts-and-score)
- [Mutation operators](#mutation-operators)
- [Switching SQL mutants in schema mode](#switching-sql-mutants-in-schema-mode)
- [Second look at verdicts](#second-look-at-verdicts)
- [Safety: restore journal and run lock](#safety-restore-journal-and-run-lock)
- [Several schemas](#several-schemas)
- [Working with coverage](#working-with-coverage)
- [Limitations](#limitations)

## Quick start

plgauge is not published on npm; run it from a checkout with `bin/plgauge`.

```bash
export PLGAUGE_DB=oracle://user:pw@host:port/service          # several workers: comma-separated
bin/plgauge mutate points examples/shop_pricing              # list mutants, offline
bin/plgauge mutate run examples/shop_pricing --report report.html
bin/plgauge mutate run examples/shop_pricing --mode naive --sample 20 --seed 7 --json naive.json
bin/plgauge mutate compare a.json b.json                     # also against JSON from the Go plmut
```

For CI, combine `--diff` and `--min-score`:

```bash
bin/plgauge mutate run examples/shop_pricing --diff origin/main --min-score 60
```

`--diff origin/main` keeps only mutants on lines that changed since the merge base. `--min-score 60`
makes the run exit with code 3 if the mutation score is below 60.

## Project file `plgauge.json`

A project is a directory with a `plgauge.json`. Coverage and mutation read the same file.

| Key | Content |
| --- | --- |
| `install` | Scripts, in order, relative to the project (see below for how they are read). |
| `mutate` | Globs of the files whose units are mutated. |
| `tests` | utPLSQL paths. Empty runs the whole schema. |
| `beforeTests` | Scripts, relative to the project, run once per worker database before the first test run, after the install (and again after a `--reset-cmd` reset). For test seams: synonyms to mocks, say. A failing script fails the run. |
| `afterTests` | Scripts run once per worker database at the very end, after the originals are restored, also when the run fails or is cancelled. A failing script does not stop the later ones; it is reported and the run exits with code 1. |

The `install` scripts are read like SQL*Plus with default settings:

- `/` and `RUN` execute the last statement, also a second time.
- A blank line or `.` ends SQL input without executing it, except with `SET SQLBLANKLINES ON`.
- `EXIT` ends the script.
- Substitution variables (`&x`, `DEFINE`) are not replaced.

`beforeTests` and `afterTests` are read the same way. They run on a connection of their own as the
connected user and are committed at the end. The tests run in another session, so what they need must
persist: DDL or committed data, not session state.

## Commands and options

| Command | Purpose |
| --- | --- |
| `mutate run [dir]` | Mutation testing of the project in `dir` (default `.`). Needs a database. |
| `mutate points [dir]` | List the mutants (id, position, operator, original → mutated). Offline. |
| `mutate schema [dir]` | Print the schema rewrite. Offline. |
| `mutate compare a.json b.json` | Compare two runs. Mutants are matched by file, position, operator and replacement text. Also works with JSON from the Go plmut. |

Options of `mutate run`:

| Option | Meaning |
| --- | --- |
| `--db URL` | Database URL(s), comma-separated for several workers. Default: `PLGAUGE_DB`. |
| `--mode schema\|naive` | `schema` (default) or `naive` (oracle mode), see [How a run works](#how-a-run-works). |
| `--ops LIST` | Operators to use, e.g. `--ops ROR,SBR`. `--ops ROR,LCR,AOR,SBR,RET,EXC,NUL,CUR` runs level 1 only. Default: all. |
| `--diff REF` | Only mutants on lines changed since the merge base with `REF`. |
| `--min-score N` | Exit code 3 if the mutation score is below `N`. |
| `--timeout-factor F` | Time limit for a mutant: `F` × baseline duration + 2 s. Default 5. |
| `--sample N` | Run only `N` mutants, chosen at random. |
| `--seed S` | Seed for `--sample`. Default 1. |
| `--json FILE` | Write the results as JSON. |
| `--report FILE` | Write a report: HTML if the name ends in `.html`, otherwise JSON in the mutation-testing-report-schema (Stryker). |
| `--coverage FILE` | Measured coverage (`plgauge-coverage.json`). Oracle mode: run only the tests that executed the statement around the mutant. |
| `--reset-cmd CMD` | Shell command that resets a worker database after a side effect; `{port}` is replaced by the worker's port. |
| `--skip-install` | Do not run the `install` scripts. |
| `--no-confirm` | Turn off the second attempt of the [second look at verdicts](#second-look-at-verdicts). |
| `-q` | No progress output. |

The text report goes to stdout. The run exits with code 1 if it was aborted, if originals could not
be restored or if an `afterTests` script failed.

Environment variables:

- `PLGAUGE_DB`: `oracle://user:pw@host:port/service`; several worker databases comma-separated.
- `PLGAUGE_LIB_SCHEMA`: only used by the tests.

## How a run works

1. **Find mutation points** (`find.ts`) on the syntax tree of the shared parser (`@plgauge/core`).
2. **Run the mutants**, in one of two modes:
   - **Schema mode** (default, `--mode schema`): see below.
   - **Oracle mode** (`--mode naive`): each mutant is compiled on its own and checked against all
     tests.
3. **Second look** (second attempt can be turned off with `--no-confirm`): verdicts that may depend
   on circumstances run a second time, see [Second look at verdicts](#second-look-at-verdicts).

### Schema mode

All mutants sit behind switches in a single build (`schema.ts`):

- A compiler filter over `ALL_ERRORS` removes mutants that do not compile.
- A recording run with mutant ID −1 notes which tests reach which mutant.
- Each mutant runs only against the tests that reach it, fastest test first, and stops at the first
  failure (fail-fast).
- Loop guards stop endless loops.

### Common to both modes

- **Time limit** in three stages: `CANCEL SQL`, driver `break()`, `KILL SESSION`.
- **Excluded tests:** tests that fail already without mutants, and unreliable tests, are excluded.
- **Commit detection** via a marker row (table `plgauge_marker`).
- **Several worker databases**, reset after a side effect with `--reset-cmd`.

## Verdicts and score

| Verdict | Meaning |
| --- | --- |
| `KILLED` | A test failed under the mutant. |
| `SURVIVED` | All tests that ran passed. |
| `NOT_COVERED` | No test reaches the mutant. |
| `TIMEOUT` | The time limit or a loop guard stopped the run. |
| `MEMORY` | The run ran out of memory (ORA-04030, ORA-04036). |
| `COMPILE_ERROR` | The mutant does not compile. |
| `ERROR` | The tool failed (e.g. lost connection). |

The mutation score is (`KILLED` + `TIMEOUT` + `MEMORY`) / (those + `SURVIVED` + `NOT_COVERED`).
`COMPILE_ERROR` and `ERROR` do not count.

Results carry `unitLine`, the file line of the unit's keyword. The line in `ALL_SOURCE` is
`line - unitLine + 1`.

## Mutation operators

| Level | Operator | Mutation |
| --- | --- | --- |
| 1 | ROR | Comparison: `<` → `<=`, `<>`, `FALSE` etc. (sufficient set after Kaminski, Ammann, Offutt) |
| 1 | LCR | `AND`/`OR`: left or right operand, `=`/`<>` of both operands, `FALSE`/`TRUE` |
| 1 | AOR | `+` ↔ `-`, `*` ↔ `/`, `MOD` → `*`, `a \|\| b` → `a` |
| 1 | SBR | Statement (assignment, SQL, call, RAISE, EXIT WHEN) → `NULL;` |
| 1 | RET | Subprogram returns immediately or raises immediately |
| 1 | EXC | Exception handler swallows the error |
| 1 | NUL | `IS NULL` ↔ `IS NOT NULL`; `NVL`/`COALESCE` reduced to one argument |
| 1 | CUR | `%FOUND` ↔ `%NOTFOUND`; FOR loop without its first or last iteration |
| 2 | SEL | `DISTINCT`/`UNIQUE` removed; `FETCH FIRST …` removed |
| 2 | JOI | `LEFT`/`RIGHT`/`FULL JOIN` → `JOIN`; `[INNER] JOIN` → `LEFT JOIN`; `(+)` removed |
| 2 | ORD | `ORDER BY`: all items `ASC` ↔ `DESC`, one mutant per list (also in `OVER` and `WITHIN GROUP`) |
| 2 | UNI | `UNION` ↔ `UNION ALL`; `INTERSECT` ↔ `MINUS`/`EXCEPT` |
| 2 | AGR | `MIN` ↔ `MAX`; `SUM` ↔ `AVG`; `COUNT(DISTINCT x)` → `COUNT(x)`; `COUNT(x)` → `COUNT(*)` |
| 2 | SUB | `EXISTS` ↔ `NOT EXISTS`; `IN (subquery)` ↔ `NOT IN` |
| 2 | WHR | Condition of `WHERE`/`HAVING` → `TRUE` (the filter is dropped) |
| 2 | COL | `UPDATE … SET`: one assignment removed; `INSERT (columns) VALUES (…)`: one column removed with its value |

Level 2 applies to static SQL (queries, DML, cursors), to views and to dynamic SQL built from
literals (see below). It follows the SQL operators of Tuya, Suárez-Cabal and de la Riva (2007),
limited to variants that are rarely equivalent. Left out are:

- `DISTINCT`, `UNION` and `ORDER BY` in subqueries of `IN`/`EXISTS`
- `ORDER BY` of a single-row `SELECT … INTO` without a row limit
- `[INNER] JOIN` → `LEFT JOIN` when `WHERE` compares a column of the joined table (the null rows are
  dropped anyway)
- `WHERE 1 = 1`
- a `WHERE` for which ROR or LCR already produce `TRUE`
- `WHR` on the condition with the bulk bind of a `FORALL` (PLS-00435)
- `UNION ALL` in the body of a `WITH` element with a column list (recursive: ORA-32040)

## Switching SQL mutants in schema mode

### Static SQL in PL/SQL

Mutants in SQL (of both levels) are not switched with a `CASE` inside the SQL. A switch around a join
condition takes the join away from the optimizer; measured on plscope-utils, that meant minutes
instead of milliseconds over `DBA_IDENTIFIERS`.

Instead, the PL/SQL statement (static SQL, `FORALL`, `OPEN … FOR`) appears once per variant in the
schema:

```sql
IF active = id THEN <variant> ELSIF … ELSE <original> END IF;
```

The original keeps its plan.

- A cursor FOR loop over a query is duplicated as a whole, including its body. The copies keep the
  loop guards of the loop and its body.
- The copies of one statement may total 256 KB; beyond that, the remaining points run one by one.

### Cursor declarations

The query of a cursor declaration is switched like a block of a view (`UNION ALL`, see
[Views](#views)), with at most 20 branches per cursor.

- The first execution parses all branches; for cursors over dictionary views that takes seconds. If
  there are branches, a warm-up run on all workers before the baseline keeps this out of the time
  limit.
- Excluded, and compiled one mutant at a time instead:
  - cursors with `ORDER BY` or `CONNECT BY` (wrapped, their order would no longer be guaranteed)
  - cursors with `FOR UPDATE` or `WITH`
  - cursor FOR loops with a label (the copies compile neither with nor without the label)
- For these excluded cases there is no recording of which tests reach them. They run against all
  tests, and a mutant that no test reaches shows up as `SURVIVED` instead of `NOT_COVERED`.

### Dynamic SQL

A string literal that reaches `EXECUTE IMMEDIATE`, `OPEN … FOR` or `DBMS_SQL.PARSE` (also in
parentheses) is parsed as SQL and mutated with both levels.

Through a variable only if the variable is declared in the subprogram's own declaration section and
every mention of it is one of:

- its declaration;
- an assignment `v := …;` (a literal is recorded; any other value not built from `v` replaces it);
- a use in one of the three sinks above;
- an argument of a logging call (`DBMS_OUTPUT`, `LOGGER`, procedures named `LOG…`, `DEBUG…`,
  `TRACE…`).

Anything else can make the executed statement differ from the literal, and the variable is left
alone. Examples: `v := v || …`, `w := v || …`, a `CASE` branch, passing it to a procedure, or an
identifier of the same name in a nested block.

Variants are dropped if they would

- be longer than the declared length (`VARCHAR2(n)`; otherwise ORA-06502), or
- lose a bind placeholder (`USING` still passes it; otherwise ORA-01006).

The mutant is the literal with one change (quotes doubled again; `q'[…]'` literals unchanged). The
schema switches the whole literal in place:

```sql
CASE active WHEN 17 THEN '<variant>' … ELSE '<original>' END
```

The copies of one literal total at most 256 KB. Each variant is a separate statement that is parsed
only when executed, so no plan suffers.

### Views

`CREATE VIEW` in a file under `mutate` is mutated like SQL in PL/SQL, with both levels.

Views that are not touched:

- Views with an INSTEAD OF trigger. `CREATE OR REPLACE VIEW` drops the trigger, and restoring the
  original does not bring it back.
- Views that cannot be rebuilt faithfully without DBMS_METADATA: editioning, object and duality
  views, named constraints, invisible columns.
- Views with `WITH FUNCTION`: the finder reports them as unsupported.

Anything else that `CREATE OR REPLACE` loses is restored by every compile: table and column comments
of a view, and the DISABLED status of a trigger. Materialized views on a restored view are
recompiled.

The original of a view comes from `DBMS_METADATA`; for views in other schemas without
`SELECT_CATALOG_ROLE`, from `ALL_VIEWS` and `ALL_TAB_COLUMNS`. It goes into the restore journal like
every unit.

#### Blocks and the `UNION ALL` wrapper

The schema switches views block by block. Blocks are the query of the view, `WITH` elements and
inline views in `FROM`. Subqueries in conditions stay in their block, so the optimizer can still
unnest them into joins. Recursive `WITH` elements are not a block.

A block with mutants becomes

```sql
SELECT * FROM (<block>) WHERE NVL(V, '0') NOT IN ('<branch IDs>')
                          AND (NVL(V, '0') <> '-1' OR (SELECT plgauge_ctl.hit(<IDs>) FROM dual) = 0)
UNION ALL SELECT * FROM (<block with mutant 17>) WHERE V = '17' …
```

with `V = SYS_CONTEXT(<context of the run>, 'ACTIVE')`. A filter on a constant cuts off all branches
but one, and the recording run (`-1`) notes which test reaches the block.

- Points in select lists do not change a plan and are switched in place
  (`CASE V WHEN '17' THEN (…) ELSE (…) END`). Thanks to SQL booleans in 23ai, the same works for
  conditions.
- Each branch is a copy that the optimizer plans anew, and `WITH` clauses in the dictionary views of
  a copy are materialized before all branches, on every execution. So a view gets at most 20 branches
  (fewer if `EXPLAIN PLAN` of the original takes long). The remaining points are compiled one by one,
  but run only against the tests that reach their block according to the recording.
- `WITH` elements that the original references once get `/*+ INLINE */` in the schema; otherwise the
  copies would materialize them.
- Points without their own block (recursive `WITH` elements) are recorded by the main block: a test
  that never executes it does not query the view.
- Queries with their own `ORDER BY` get no wrapper, since their order would no longer be guaranteed
  (top-N with `ROWNUM`). Such an inline view belongs to the surrounding block. The points of a sorted
  main query run one by one.
- Errors from `CREATE VIEW` are mapped to a branch via the server's error position. If the wrapper of
  a block fails, its points run one by one, and the block is not wrapped again.

#### Plan comparison

Before switching, the run takes the plan of each view with `EXPLAIN PLAN`, and afterwards the plan of
the switched view. After removing dead branches (under a filter that requires a specific mutant,
including the copy that 23ai OR expansion creates for the recording run) and the schema's own steps,
the same operations on the same objects must remain. Otherwise the copies have changed the plan (a
materialized `WITH` clause, a branch filter pushed into a table scan, a different join order), and
every test that queries the view would run differently.

- `EXPLAIN PLAN` runs on its own connection. A view with many heavy copies can blow the server's
  cursor heap (ORA-00600 `KGL-heap-size-exceeded`) and take the process down with it; the view then
  counts as not checkable.
- If the plan differs, the view's mutants run one by one, and its main block gets only the wrapper
  that records which tests query the view.
- If that wrapper also changes the plan, the view stays entirely original.

A common cause: a branch filter lands on a view row instead of as a start filter before the branch,
for example above analytic functions. Oracle then computes the dead branches on every query.

#### Tests that fail on switched views

Tests that read the text of a view (source code, lineage analyses) see the copies in the schema. If
tests fail with the switched views but not with the originals, the run finds the view responsible.
That view stays original, and its mutants run one by one against all tests. This way no test is lost
for the other mutants.

### Other effects of schema mode

- **Line numbers:** variants of multi-line statements and expressions stand before the original, so
  line numbers (`$$PLSQL_LINE`, error backtraces) shift after them. Tests that check them should run
  with `--mode naive`.
- **SQL macros and result cache:** points in SQL macros (`SQL_MACRO`; their body runs only at hard
  parse of the calling statement) and in RESULT_CACHE functions run one by one, since the result
  cache is shared by all sessions and survives switching. Mutants in code that such a function calls
  can be hidden by its cache in schema mode.
- **`PRAGMA RESTRICT_REFERENCES`:** `plgauge_ctl` carries `PRAGMA RESTRICT_REFERENCES(… TRUST)`, so
  units with this pragma can be switched.

## Second look at verdicts

Some verdicts depend on more than the mutant. A test can read data that another test committed
earlier, or depend on the content of the worker database. A mutant can produce a query without
`ORDER BY` whose first row depends on the plan. Two measures address this:

**Restoring data.** If the tests commit already without mutants, the baseline determines which tests
do so (each one alone, once). After every mutant under which a commit happened, the committing tests
among its tests run once more on the original (in oracle mode after the unit is restored). So no
mutant starts with data written by another mutant.

**Second attempt** (turn off with `--no-confirm`). Every killed mutant runs once more with the
killing test alone.

- In schema mode this happens after the run, on the next worker (on the same one if there is only one
  worker).
- In oracle mode it happens right after the verdict, while the mutant is still compiled. Another
  worker would have to recompile it; measured on plscope-utils, that cost more than the run itself.
- If the first run committed, the data is restored and the mutant recompiled first, so the second
  attempt also starts with data as without mutants.
- If the test passes, the mutant stays killed but is marked as unstable: the kill depended on test
  order, on data or (checkable only in schema mode) on the database.
- A timeout (not one from a loop guard) runs again with twice the time. If it then finishes, the new
  verdict applies, also marked.

The text report lists the marked mutants with the reason; the JSON has it in the field `unstable`.
Survivors are not repeated: that would cost as much as the run itself.

Limit of commit detection: it sees a commit through a marker row inserted before the test run. If a
test rolls back the whole transaction, the row is gone, and a later commit in the same run goes
unnoticed.

## Safety: restore journal and run lock

### Restore journal

Every code change goes through the core's restore journal (table `PLGAUGE_JOURNAL`, command
`plgauge restore`).

- If an aborted run left units changed, the next run restores them from the journal at start, before
  it installs anything or reads originals.
- If someone has since compiled a newer version (text neither from plgauge nor the original, without
  switch calls) or dropped the object, that is left as it is: the entry is discarded with a warning.
- If a leftover cannot be restored (for example because a session of the dead run still holds the
  unit), the run aborts instead of taking the changed code for the original.

To restore by hand:

```bash
bin/plgauge restore            # every database in PLGAUGE_DB (or --db)
bin/plgauge restore --list     # only show the entries
bin/plgauge restore --forget   # delete entries that cannot be restored from the journal
```

### Do not change the schema during a run

Every mutant, and the restore at the end, compile over the schema's objects. Changes made by someone
else during a mutation run can be overwritten. (A coverage run, by contrast, leaves alone at the end what
someone else compiled or dropped in the meantime.)

### Run lock

So that this never hits a run that is still going, each run holds a row lock in `PLGAUGE_LOCK` for
its whole duration (own connection, never committed).

- A second run on the same schema aborts at once. This includes a coverage run: both tools take the
  same lock, and at start both restore what an aborted run of either tool left in the journal.
- The lock ends with the session, even if the process dies.
- Lock and journal live in the schema of the run. A coverage run over several schemas locks only its
  runtime schema; mutation runs on the measured schemas must then not run at the same time.

### Objects the tool creates

| Object | Purpose |
| --- | --- |
| `plgauge_ctl` | Runtime package: active mutant, recording of reached points per test, loop guards |
| `plgauge_rt` | Runs utPLSQL and detects commits |
| `plgauge_marker` | Marker table for commit detection |
| `PLGAUGE_CTX_<hash>` | Application context holding the active mutant, one per schema |
| `PLGAUGE_JOURNAL` | Restore journal |
| `PLGAUGE_LOCK` | Run lock |

## Several schemas

A unit written with a schema (`CREATE OR REPLACE PACKAGE BODY app_util.calc …`) is mutated in that
schema.

- The runtime package `plgauge_ctl` stays with the logged-in user and is called qualified; the run
  grants `EXECUTE` on it.
- Privileges are the same as for coverage (`CREATE ANY PROCEDURE`, `EXECUTE ANY PROCEDURE`).
- The context for loop limits has a different name per schema, so runs of different users in one
  database do not interfere.

That holds only as long as they do not mutate the same foreign units. Lock and journal live in the
run's schema, so a run of another user on `app_util.calc` does not see them. The following must
therefore not run at the same time:

- two such runs on the same foreign units (worker URLs of one run need the same user and schema
  anyway, otherwise the run aborts);
- a coverage run with `schema: app_util` and a mutation run that mutates `app_util.…` (they lock
  different schemas).

## Working with coverage

Coverage and mutation read the same project file, and their results fit together:

```bash
bin/plgauge coverage examples/shop_pricing --out cov          # measures exactly the project's units
bin/plgauge mutate run examples/shop_pricing --json run.json
bin/plgauge crosscheck --coverage cov/plgauge-coverage.json --mutation run.json
bin/plgauge report cov/coverage.json --mutation run.json --out joint
bin/plgauge mutate run examples/shop_pricing --mode naive --coverage cov/plgauge-coverage.json
```

The coverage exchange format is `plgauge-coverage/1`, written to `plgauge-coverage.json`.

**Cross-check** (`crosscheck`). Every test that reaches a mutant in the recording run must, according
to coverage, have executed the statement around it. A contradiction points to a bug in one of the two
tools (exit code 1). Needs a schema-mode run, since only that records tests.

- Known effect: code that runs only on the first call per session (initialization of package state)
  belongs to the test that triggers it first. If the two tools do not run the same tests (the
  mutation run excludes failing tests), this can appear as a contradiction.
- Tests with status `flaky` in the coverage do not count as a contradiction.

**Joint report.** The coverage report shows the mutants and their verdicts per line, and lists every
surviving mutant on an executed line as a gap: the tests run through the code but do not check it.

**Test selection in oracle mode.** Instead of all tests, only those run that executed the statement
around the mutant: a safe superset of the tests that reach it. Mutants in declarations, and units
without matching coverage (different source in the database), still get all tests.

## Limitations

- In schema mode, line numbers (`$$PLSQL_LINE`, error backtraces) shift; tests that check them need
  `--mode naive`.
- Tests that read the text of a view see the schema copies (the run detects failures and keeps such
  views original).
- Excluded cursors (`ORDER BY`, `CONNECT BY`, `FOR UPDATE`, `WITH`, labelled cursor FOR loops) have no
  recording: unreached mutants there show up as `SURVIVED`, not `NOT_COVERED`.
- RESULT_CACHE functions can hide mutants in code they call, in schema mode.
- Views with an INSTEAD OF trigger, views that need DBMS_METADATA to rebuild, and views with
  `WITH FUNCTION` are not mutated.
- Dynamic SQL is mutated only from literals, directly or through a local variable used in the
  restricted ways listed above.
- Commit detection misses a commit after a test rolled back the whole transaction.
- Survivors are not re-run in the second look.
- Do not change the schema's objects during a run, and do not run mutation and coverage runs on the
  same foreign schema at the same time.
