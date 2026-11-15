# Parity of the TypeScript mutation with Go plmut (`9bf5d68`)

As of 13 Nov 2026, Oracle 23.26.1 Free, utPLSQL 3.2.2.

| Comparison | Result |
| --- | --- |
| Mutants of the example (`mutate points`) | identical, including numbers (75) |
| Schema text of the example (`mutate schema`) | identical except for the missing `CREATE OR REPLACE` |
| Example, naive mode | 75/75 verdicts equal; all as in `expected.tsv` |
| Example, schema mode | 75/75 verdicts equal; all as in `expected.tsv` |
| pljson, schema mode, three databases | 2 658/2 664 equal, score 48.3 % (Go 48.2 %), 314 s (Go 290 s) |

The six differences on pljson come from the tests, not from the port. The parser suite sets the
package variable `pljson_parser.json_strict := true` in `beforeall` and does not reset it. If its tests
run in the same `ut_runner.run` before `utplsql_pljson_ext_test.test_date_1`, that test misses the
mutants on `json_strict` (lines 312, 506, 511, 521). Which tests share a call depends on the measured
run times, so the verdict varies in both versions. Two of the six cases are detected in both
(timeout vs. killed).

Files: `example-*.json`, `pljson-schema.json` (Go output); comparison with `plgauge mutate compare`.

## Own parser instead of the Java finder

As of 13 Nov 2026. The finder (`packages/mutation/src/find.ts`) works on the syntax tree of the
core parser. The reference is the frozen output of the Java finder on the corpus
(`finder-corpus.json.gz`, 790 files including console); comparison with `npm run parity:finder`.

| Comparison | Result |
| --- | --- |
| Points of the Java finder that the new finder finds the same way | 33 202 of 33 219 (position, operator, replacement texts equal; 4 375 of them now with subprogram names) |
| Java only (17) | 8 points in anonymous blocks outside any unit, 7 LCR and 1 ROR from IslandSQL misreadings (`0 and 255` from BETWEEN, `$if` condition), 1 SBR from a misread q-string |
| New only (1 540) | 888 RET in type methods and standalone procedures/functions, 338 SBR for `SELECT … INTO`, 289 LCR/NUL that IslandSQL nested incorrectly for `IS NULL`, `BETWEEN`, `IS OF`, `LIKE … ESCAPE`, 18 `assert(…)` calls, 7 after a misread q-string |
| Example project | 48 points, all identical; 75/75 verdicts in both modes as in `expected.tsv` |
| pljson, schema mode, three databases | all 2 664 Go mutants present again, 2 657 verdicts equal; plus 391 new mutants; 332 s (`pljson-schema-ts.json`) |

The seven pljson differences: four are the known `json_strict` state (see above), three are
detected in both runs (timeout from a loop guard vs. killed).

Coverage on the same parser: for all 295 bodies of the corpus, the instrumented text and the probe
map are identical to those of plcov's token parser (`baseline/plcov/corpus-instrumented.tsv`,
`npm run parity:coverage`); the corpus figures stay at 280/280, 25 496 statements, 2 891
decisions, 3 383 conditions.

## Coverage and mutation together

| Check | Example project | pljson |
| --- | --- | --- |
| Cross-check of recording run against coverage | 51 of 51 checked mutants consistent (23 without an enclosing statement) | 1 632 of 1 636 consistent; the remaining 4: per-session initialization, triggered by a different first test because the mutation run excludes two failing tests |
| Oracle mode with test selection from coverage | 75/75 verdicts as in Go and `expected.tsv`; on average 5.6 instead of 14 tests per mutant | sample of 150: 149 verdicts as in schema mode, 1 detected in both (timeout vs. killed) |

The cross-check found two real bugs, both fixed. The coverage test catalog did not recognize utPLSQL
paths without a schema (no per-test mapping). And mapping by lines alone went wrong when a condition and
the statements of its branch are on one line (`when buf = '{' then …`), so statements now also have
columns. Coverage starts every test run with fresh package state; before that, a pljson test that
otherwise only passed on freshly compiled code seemed to deviate because of the instrumentation.

## Deliberate changes since parity was reached

`baseline/plcov/corpus-instrumented.tsv` recorded the results of the old token parser until coverage
and mutation were combined (295 of 295 equal). Since then it tracks the last checked state
(`npm run parity:coverage -- --accept`):

| Change | Bodies affected | Check |
| --- | --- | --- |
| Simple CASE expressions measured (probe before each result) | 13 | Corpus compile test: 330 of 332 bodies that compile in the original also compile instrumented; the remaining 2 are name clashes between example scripts (ORA-00955) |
| Statements with columns in the probe map | all (hidden in the comparison) | – |
| Branch labels and gap reasons in English | all (texts only) | With labels and reasons left out, instrumented code and probe map are identical to the previous state for all 295 bodies |

### Mutation since the SQL operators

| Change | Check |
| --- | --- |
| New level 2 operators (SEL, JOI, ORD, UNI, AGR, SUB, WHR, COL) | `npm run parity:finder` compares only level 1 with the Java finder, unchanged |
| SQL mutants of both levels are switched in the schema by duplicating the PL/SQL statement instead of by `CASE` in the SQL; SQL in cursor declarations is compiled one mutant at a time | Example project: all 81 verdicts as expected by hand, in both modes; cross-check against coverage without contradiction |
| `PLSCOPE_SETTINGS` is kept on recompilation; `plmut_rt` with invoker rights | plscope-utils: 35 of 36 tests run under the tool as they do directly (previously 26) |
