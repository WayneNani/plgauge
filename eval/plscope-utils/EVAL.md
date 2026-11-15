# SQL operators: evaluation on plscope-utils

As of 14 Nov 2026. Level 2 of the mutation operators acts on static SQL. It was tested on
[plscope-utils](https://github.com/PhilippSalvisberg/plscope-utils) (`dc22daf`), a maintained project with a lot of SQL on
the data dictionary and real utPLSQL tests, plus a compile test on the SQL of utPLSQL.

Result: **the 30 SQL mutants in plscope-utils show 7 real test gaps, and none is equivalent.** In the corpus,
1 190 of 1 193 SQL mutants of both levels compile. Above all, the run improved the tool: switches in SQL destroyed
execution plans, PL/Scope data got lost, and tests with DDL failed because of missing roles. All three bugs are fixed
(see below).

## Operators

| Operator | Mutation |
| --- | --- |
| SEL | `DISTINCT`/`UNIQUE` removed; `FETCH FIRST …` removed |
| JOI | `LEFT`/`RIGHT`/`FULL JOIN` → `JOIN`; `[INNER] JOIN` → `LEFT JOIN`; `(+)` removed |
| ORD | `ORDER BY`: all elements `ASC` ↔ `DESC`, one mutant per list |
| UNI | `UNION` ↔ `UNION ALL`; `INTERSECT` ↔ `MINUS` |
| AGR | `MIN` ↔ `MAX`; `SUM` ↔ `AVG`; `COUNT(DISTINCT x)` → `COUNT(x)`; `COUNT(x)` → `COUNT(*)` |
| SUB | `EXISTS` ↔ `NOT EXISTS`; `IN (subquery)` ↔ `NOT IN` |
| WHR | condition of `WHERE`/`HAVING` → `TRUE` |
| COL | `UPDATE … SET`: one assignment removed; `INSERT (columns) VALUES (…)`: one column and its value removed |

The basis is the SQL operators of Tuya, Suárez-Cabal and de la Riva (2007). Only variants that are rarely equivalent
were selected; the rules for skipping are in `packages/mutation/README.md`.

## Run

| | |
| --- | --- |
| Code | 7 package bodies (5 tools, 2 demo packages), about 1 100 lines |
| Tests | 36 utPLSQL tests; 1 excluded (it checks the PL/Scope data of the code itself, and so also that of the mutated schema) |
| Database | Oracle 23.26.1 Free, utPLSQL 3.2.2, three workers |
| Run time | 208 s for 504 mutants (baseline 3.9 s); 194 mutants in cursor declarations compiled one at a time |
| Mutation score | **62.1 %**: 313 killed, 169 survived, 22 not reached by any test |

| Part | Mutants | killed | survived | not reached | Score |
| --- | --- | --- | --- | --- | --- |
| Level 2 (SQL operators) | 30 | 23 | 7 | 0 | 76.7 % |
| Level 1 in SQL | 200 | 103 | 97 | 0 | 51.5 % |
| Level 1 in PL/SQL | 274 | 187 | 65 | 22 | 68.2 % |

| Operator | Mutants | killed | survived |
| --- | --- | --- | --- |
| AGR | 2 | 2 | 0 |
| COL | 6 | 6 | 0 |
| JOI | 3 | 2 (1 by time limit) | 1 |
| ORD | 5 | 1 | 4 |
| SEL | 3 | 3 | 0 |
| WHR | 11 | 9 (1 by time limit) | 2 |

UNI and SUB do not occur in plscope-utils; they are covered by the compile tests below and by the unit tests.

## All 7 survivors classified

Each row with its reason in [`survivors-sql.tsv`](survivors-sql.tsv).

| Class | Count | Example |
| --- | --- | --- |
| Case missing | 4 | synonym for a missing object; name that belongs to several object types (then the order decides); only one materialized view in the database; no test record before the date boundary |
| Order unchecked | 3 | `dedup` sorts, the tests do not check the order |
| Equivalent | 0 | |

The 4 missing cases are the same kind of finding as the most valuable 18 % in console: boundaries and special cases of
the data that level 1 does not reveal. For level 1, the score in SQL, at 51.5 %, is clearly below the one in PL/SQL.
The tests check many conditions on the dictionary (owner, type, name) only with unique names.

## What the run improved in the tool

- **Switches in SQL destroy execution plans.** Level 1 switched mutants in SQL by a `CASE` in the expression. Around a
  join condition, this takes the join away from the optimizer: a query over two `DBA_IDENTIFIERS` ran for minutes
  instead of milliseconds, and the run hung in the baseline. Now the PL/SQL statement appears once per variant in the
  schema (`IF active = id THEN <variant> ELSIF … ELSE <original> END IF;`). The original stays unchanged and keeps its
  plan. This applies to both levels; SQL in cursor declarations is compiled one mutant at a time.
- **PL/Scope setting on recompilation.** Mutated and restored units were compiled without their `PLSCOPE_SETTINGS`,
  their PL/Scope data disappeared, and 3 tests failed. Now the core carries the setting over, as it already did for the
  optimization level and `PLSQL_CCFLAGS`.
- **Roles in the test run.** The test runner `plgauge_rt` had definer rights, under which roles are disabled. 7 tests
  whose setup creates a procedure via DDL (`CREATE PROCEDURE` through the RESOURCE role) failed with ORA-01031, but not
  when run directly with `ut.run`. `plgauge_rt` now has invoker rights.
- **Two rules against equivalents**, both from this run. An inner join does not become a `LEFT JOIN` if `WHERE`
  compares a column of the joined table (the null rows drop out anyway). `ORDER BY` is reversed as a whole instead of
  per element. Per element, a constant first key was equivalent, and 15 of 22 survivors came from a single pattern.

## Cross-check on console

The new switching of SQL also affects level 1. So console was run before and after the change (1 630 mutants in
common), plus a second time on identical code to measure the noise:

| Comparison | differing verdicts in PL/SQL | in SQL |
| --- | --- | --- |
| before vs. after | 46 | 25 |
| after vs. after (same code) | 37 | 4 |

The differences in PL/SQL are noise of the same size as between two identical runs. console commits configuration,
and which tests check a mutant first changes the result of the configuration tests. In SQL, 20 of the 25 differences
are the expected consequence of compiling one mutant at a time: mutants of a cursor declaration that is never opened
appear as survived instead of not reached. Score before 63.0 %, after 63.8 % and 63.9 %; the 6 new level 2 mutants:
4 killed, 2 survived.

## Compile test

`scripts/sql-compile-check.ts` first compiles each unit with SQL mutants in its original form. If it compiles, each
mutant is then compiled on its own and all of them together as a schema, with errors mapped as in a real run.

| Corpus | Units | SQL mutants | compiled on their own | Schema: switched / discarded / unmapped |
| --- | --- | --- | --- | --- |
| utPLSQL 3.2.2 (`source`, installed in its own schema), both levels | 19 | 1 193 | 1 190 | 1 142 / 3 / 0; with cursors and loops (Addendum 2) 1 175 / 3 / 0 |
| rest of the corpus (level 2 only, only units without missing objects) | 18 | 111 | 111 | 72 / 0 / 0 |
| views of plscope-utils without `plscope_col_usage`, both levels | 6 | 1 007 | 1 007 | 748 / 0 / 0 |

The 3 errors belong to level 1 and existed before; in a run they are discarded as not compilable. They are `FALSE`
for the condition with the bulk bind of a `FORALL` (PLS-00435) and two LCR comparisons `(a) = (b)` on conditions that
Oracle does not compare in SQL (ORA-00932). The first compile test had shown 2 errors in level 2: `WHR` in `FORALL`
and `UNION ALL` → `UNION` in a recursive `WITH` (ORA-32040). Both are now skipped.

## How much SQL is there to mutate?

Share of level 2 mutants among all mutants, per project in the corpus:

| Project | Mutants | Level 1 in SQL | Level 2 | Share |
| --- | --- | --- | --- | --- |
| plscope-utils | 860 | 250 | 77 | 9.0 % |
| oracle-db-examples | 17 311 | 2 338 | 434 | 2.5 % |
| utPLSQL 3.2.2 | 21 283 | 2 081 | 478 | 2.2 % |
| logger | 1 139 | 172 | 21 | 1.8 % |
| console | 4 052 | 207 | 49 | 1.2 % |
| plex | 3 084 | 80 | 26 | 0.8 % |
| oos-utils | 5 605 | 261 | 27 | 0.5 % |
| alexandria | 13 895 | 248 | 33 | 0.2 % |
| pljson | 6 376 | 7 | 9 | 0.1 % |

(Whole repositories including tests and examples; the run above mutates only the 7 packages.) In public code, a lot of
SQL is in views and in dynamic SQL (strings); the finder reaches neither. Code that keeps business logic in static SQL
has a higher share. That is where level 2 pays off most.

## Limitations

- **Cursor declarations** cannot be duplicated in the schema; their mutants are compiled one at a time (here 194 of
  504). This costs run time and the "not reached" verdict: without recording, a mutant that no test reaches appears as
  survived (in console, 20 mutants of one cursor declaration).
- **Time limit as verdict:** if a filter on a dictionary query is dropped, the result explodes. 2 SQL mutants end this
  way; as in level 1, they count as killed.
- **Views** are mutated by the tool since the addendum below; their own limitations are listed there.

## Addendum: views

In plscope-utils, the 7 views contain more SQL lines (1 411) than the 7 package bodies (908). Since this addendum, the
tool also mutates `CREATE VIEW`, with both levels (switching: `packages/mutation/README.md`). The views are added by a
glob in `plgauge.json`.

| | |
| --- | --- |
| Mutants | 1 634 (504 in the packages as above, 1 130 in the views; 677 of those in select lists, switched in place) |
| Run time | 611 s with three workers, baseline 1.4 s with 35 tests (as above: only the PL/Scope model test is missing) |
| Schema | 2 rounds, 0 mutants discarded; 382 points compiled one at a time (cursor declarations, views above the branch limit, and the two views below) |

| Part | Mutants | killed | survived | not reached | Score |
| --- | --- | --- | --- | --- | --- |
| Packages, PL/SQL | 274 | 187 | 65 | 22 | 68.2 % |
| Packages, SQL | 230 | 127 | 103 | 0 | 55.2 % |
| `plscope_identifiers` | 408 | 72 | 336 | 0 | 17.6 % |
| `source_view` (demo) | 12 | 9 | 3 | 0 | 75.0 % |
| 5 views without a test (`plscope_naming`, `_col_usage`, `_tab_usage`, `_statements`, `_ins_lineage`) | 710 | 0 | 0 | 710 | – |

The packages have the same verdicts as without views (68.2 % and 54.8 % above, a difference of one mutant). No test
queries 5 of the 7 views. This is shown by the recording run, which also notes in views which test reaches which
block. `plscope_identifiers` is checked directly by 2 tests (the third is excluded, see above), plus tests of
`dd_util`. They compare only a few columns. That is why 336 mutants survive there, most of them in the expressions from
which the view computes paths, names and levels.

The 13 surviving SQL mutants (level 2) in tested views, provisionally classified:

| Class | Count | Example |
| --- | --- | --- |
| Case missing | 12 | filter `owner like coalesce(sys_context('PLSCOPE', 'OWNER'), user)` dropped (no second schema in the test); outer join without a matching row (3); `ORDER BY` in analytic functions that only repair broken hierarchies (4); computed columns `count(…) over`, `max(line) over` that no test compares (2); no record before the date boundary in `source_view` |
| Equivalent | 1 | `UNION ALL` → `UNION` between PL/SQL and SQL identifiers: the branches are disjoint via `is_sql_stmt`, the rows are unique via `usage_id` |

**Cross-check of the switching:** in a run without the mapping described below, `plscope_identifiers` ran in the schema
(259 mutants switched, 149 one at a time), and in a second run entirely one at a time. All 408 verdicts agree (71
killed, 337 survived).

What the views revealed about the tool:

- **Branches are expensive, but not in the way expected.** With 116 `UNION ALL` branches, `CREATE VIEW` for
  `plscope_col_usage` took minutes. `EXPLAIN PLAN` showed that planning itself is cheap (0.4 s without, 0.8 s with 10
  branches); execution is what is expensive. Oracle materializes `WITH` clauses that the copies reference several
  times, and pulls them in front of all branches. So they run on every query, even for switched-off branches (120
  instead of 13 `LOAD AS SELECT`). Remedy: `/*+ INLINE */` for `WITH` elements that the original references once (so
  the plan without branches matches the original), and at most 20 branches per view. The remaining points run one at a
  time, but only against the tests that reach their block.
- **Recursive `WITH` elements** cannot be wrapped (ORA-32040). Their points run one at a time; their test selection
  comes from the main block of the view.
- **Tests that read the text of a view** saw the copies. `test_get_view_source` reads `PLSCOPE_IDENTIFIERS` into a
  variable (too long: ORA-06502), three lineage tests count the columns of `SOURCE_VIEW` twice. Without a
  countermeasure, these 4 tests were missing for all mutants (packages 49 % instead of 68 %). Now the run finds the
  view responsible and leaves it in its original form.

Limitations for views:

- **Branch limit:** views with many conditions over dictionary views mostly run one mutant at a time, and run time
  goes up.
- **Views that their own code reads** run entirely one at a time and with all tests (here 420 mutants).
- **Plan comparison** (since Addendum 2): if the copies change the plan of a view, its mutants run one at a time. In
  plscope-utils this applies to all views with branches; the gain from branches does not materialize there.

## Addendum 2: cursors, dynamic SQL, second look, plan comparison

Four extensions, tested on plscope-utils (packages and views as above):

1. **Switchable cursors.** The query of a cursor declaration without `ORDER BY`, `FOR UPDATE` and `WITH` is switched
   like a view block with `UNION ALL` branches. A cursor FOR loop over a query is duplicated, body included, per
   variant. In the corpus, the SQL mutants in packages that could not be switched drop from 1 610 to 298, mostly
   sorted cursors. In plscope-utils it is 76 instead of 194.
2. **Dynamic SQL.** Literals that reach `EXECUTE IMMEDIATE`, `OPEN … FOR` or `DBMS_SQL.PARSE` are mutated as SQL. In
   plscope-utils this is one literal in `etl.load_from_dyn_sql` with 12 mutants. 9 are killed; the 3 survivors concern
   the date boundary `hiredate > date '1980-01-01'`, before which there is no test record (the same gap as with the
   static variants). In the corpus there are 56 literals with 1 493 mutants, almost all in test packages.
3. **Second look.** Killed mutants run once more with the killing test alone. After mutants under which committing
   tests ran, these tests rewrite their data on the original.
4. **Plan comparison** for views with `EXPLAIN PLAN` before and after switching.

| | Run 11 (before) | Run 16 (after) |
| --- | --- | --- |
| Mutants | 1 634 | 1 646 (12 from dynamic SQL) |
| Baseline with schema | 1.5 s | 1.8 s |
| Run time, three workers | 611 s | 1 035 s (views run one at a time, see plan comparison) |
| Packages, PL/SQL: killed / survived / not reached / timeout | 187 / 64 / 22 / 1 | 179 / 72 / 22 / 1 |
| Packages, SQL: killed / survived / timeout | 116 / 104 / 10 | 126 / 107 / 9 |
| Verdicts with a second-look note | – | 7 |

**Cross-check of the cursor switching:** the packages were also run entirely one mutant at a time (oracle mode). 509 of
516 verdicts agree. The 7 differences: 2 mutants in `example` that only the PL/Scope model test reaches (it passed the
baseline in the oracle run but not in the schema run); 3 timeouts that ended as failures in the other run; 1 lost
connection; 1 ROR in `lineage_util` (line 283) whose result varies.

**What the second look found:**

- The three verdicts that flipped between run 10 and run 11 have different causes.
  - `etl` line 140 (`RETURN;` before loading) survives only if `deptsal` still contains correct data from an earlier
    test. The tests commit, so the verdict depended on the previous mutant. With the data rewritten, the mutant now
    always survives. This is a real gap: the test checks data that it need not have produced itself.
  - `dd_util` line 19 (`o.owner <= s.table_owner`) fetches the first row of a cursor without `ORDER BY`. Which row that
    is depends on the plan and the database. The same applies to the other mutants that weaken the join condition of
    this cursor: they flip from run to run, depending on the worker. In schema mode the second look marks their kills
    as not reproducible every time, because it checks on a different worker; in oracle mode it checks on the same one
    and cannot do so.
  - The third case (`LCR` in `plscope_identifiers`) is a narrow timeout; with double the time it ends as a failure.
- `plscope_context.set_attr` (2 mutants): `test_set_attr` kills them in combination with other tests, but not alone.
  The test reads a context value that a previous test set.
- **A corrupted worker database.** In one run, 489 kills were not reproducible, all of them produced on worker 3.
  There, a measurement script (not the tool) had recompiled packages without their PL/Scope settings. As a result, the
  statement in `USER_STATEMENTS` that `test_get_dep_cols_from_insert` reads was missing. Without the second look these
  would have been 489 false kills (score 52 % instead of 24 %).

Rewriting the data is expensive at first: rerunning all tests after every mutant under which a commit happened came to
1 468 extra test runs. The baseline therefore determines which tests commit themselves (here 17, most of them via
DDL). Only these run again, and in oracle mode only for selected tests. That leaves 271 runs. In oracle mode, the
second look on a different worker cost more than the run itself, because every mutant has to be recompiled there. It
now happens right after the verdict on the same worker.

**What the plan comparison found:** all five views to which the schema added branches had a different plan from the
original afterwards:

| View | Difference with branches | with recording wrapper only |
| --- | --- | --- |
| `plscope_tab_usage` | 104 reads of materialized temp tables | different join (merge instead of hash) |
| `plscope_col_usage` | 125 extra `WINDOW SORT` | different join |
| `plscope_statements` | 16 extra `WINDOW SORT` | one more `WINDOW SORT` |
| `plscope_naming` | different joins, 7 more scans | same |
| `plscope_ins_lineage` | `WITH` materialized | same |

The reason is mostly that Oracle does not place the filter of a branch as a start filter in front of the branch, but
on the rows of a view over analytic functions. The query then computes every dead branch as well. This explains the
earlier measurement in which a view with 20 branches took 131 s instead of 9 s. So the assumption "a filter on a
constant cuts off dead branches" does not hold in general. The plan comparison catches this. The mutants of these views
run one at a time; `plscope_naming` and `plscope_ins_lineage` keep the recording wrapper (their 497 mutants stay "not
reached"), the other three run in their original form. No test queries their 213 mutants, but they appear as survived
because all tests run when there is no recording.

Two more bugs only showed up in the runs. First: with 20 branches, the `EXPLAIN PLAN` of `plscope_col_usage` alone
blew the server's cursor heap (ORA-00600 `KGL-heap-size-exceeded`). The process died, and with it the connection
through which the run manages its code. `EXPLAIN PLAN` now has its own connection. Second: after this crash, switched
packages were left behind. The next run read them as the original and at the end restored exactly this code; in doing
so, it deleted the correct originals in the journal. Now every run first restores, at startup, whatever an aborted run
left in the journal.

No plan comparison checks the cursor branches in packages: their queries contain PL/SQL variables, so `EXPLAIN PLAN`
cannot explain them as they are. Run time was measured instead. The first execution parses all copies (`dd_util`:
3.6 s instead of 0.3 s); after that, the tests run as fast as on the original. Without a warm-up run this went into
the baseline, and the time limit rose from 9 to 53 s.

## Addendum 3: fixes after review

A review of Addendum 2 found ten weaknesses, a second review of the fixes five more. Fixed:

- **Dynamic SQL via variables:** a literal counts only if the variable is declared in the subprogram and its value is
  never built from itself (`v := v || …`, `replace(v, …)`), embedded in another statement, passed to a procedure or
  filled via `INTO`. Otherwise the literal would only be a fragment, and mutants that only become invalid together with
  the rest would count as killed. Variants that would be longer than `VARCHAR2(n)` are dropped (ORA-06502). The corpus
  now has 51 instead of 57 literals; the templates of PLEX, whose placeholders are substituted by `replace`, drop out.
- **Rewriting data in oracle mode** also when all tests run, and before the second look (after it, the mutant is
  recompiled). Here the number of repair runs went up from 271 to 967, and the run time by 27 s.
- **View isolation** also checks views that only carry the recording wrapper. In run 17 this found
  `plscope_identifiers`: `test_get_view_source` reads its text.
- Own `statement_id` for `EXPLAIN PLAN`, loop guards in duplicated loops, 256 KB limit for the copies of a literal,
  warm-up run only with branches.
- **Run lock:** every run holds a row lock in `PLGAUGE_LOCK`; a second run on the same schema aborts instead of
  restoring the first run's code as the leftovers of a crash.

Run 17 (everything else as in run 16): 1 062 s, score 24.1 % (run 16: 24.0 %). Four verdicts differ, all at known
places: the join weakening in the `dd_util` cursor (line 19), the ROR/WHR in `lineage_util` line 283, and a timeout in
`plscope_identifiers`. The second look marks 6 verdicts (`set_attr` twice, four narrow time limits).

## Reproducing

```bash
corpus/fetch.sh                                  # plscope-utils into corpus/.cache
# installation per database: eval/plscope-utils/README.md
PLGAUGE_DB=oracle://plscope_eval:…@…/FREEPDB1,… bin/plgauge mutate run eval/plscope-utils --json run.json --report run.html
npx tsx scripts/eval-summary.ts run.json survivors.tsv
npx tsx scripts/sql-compile-check.ts db.json corpus/.cache/utplsql-3.2.2/source   # db.json: {user, password, connectString}
```
