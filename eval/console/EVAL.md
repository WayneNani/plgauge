# Evaluation on console

As of 14 Nov 2026. A stand-in for a run on your own code: mutation testing on a third-party, maintained project with a
real test suite. Result: **89 of 100 surviving mutants show a real test gap**; 11 are equivalent or meaningless in
practice. So the level 1 operators produce usable findings. console gives no reason for level 2 (SQL operators),
because only 3 % of its mutants are in SQL.

## Run

| | |
| --- | --- |
| Code | `CONSOLE.pkb` from [console](https://github.com/ogobrecht/console) (`72ff8f85`), about 4 000 lines |
| Tests | 258 utPLSQL tests; 2 already fail without mutants, 11 are unreliable (level checks that depend on the configuration state) |
| Database | Oracle 23.26.1 Free, utPLSQL 3.2.2, three workers |
| Mode | schema, recording per test, fail-fast |
| Run time | 271 s for 1 630 mutants (baseline 4.9 s) |
| Mutation score | **63.0 %**: 1 022 killed, 374 survived, 225 not reached by any test, 8 do not compile |

| Operator | Mutants | killed | survived | not reached | Score |
| --- | --- | --- | --- | --- | --- |
| AOR | 246 | 132 | 74 | 38 | 54.1 % |
| CUR | 38 | 25 | 5 | 8 | 65.8 % |
| EXC | 6 | 3 | 0 | 3 | 50.0 % |
| LCR | 112 | 66 | 26 | 20 | 58.9 % |
| NUL | 118 | 83 | 24 | 11 | 70.3 % |
| RET | 294 | 248 | 4 | 36 | 86.1 % |
| ROR | 234 | 127 | 79 | 27 | 54.5 % |
| SBR | 582 | 338 | 162 | 82 | 58.1 % |

Most survivors cluster in the diagnostic functions: `user_env` (81), `console_env` (28),
`to_html_table` (34), `call_stack` (25), `status` (25), `utl_last_error` (22).

## 100 survivors classified by hand

Sample: 100 of the 374 survivors, chosen at random with a fixed seed (11). Each row with its reason in
[`survivors-sample.tsv`](survivors-sample.tsv).

| Class | Count | Typical example |
| --- | --- | --- |
| Result or text unchecked | 67 | `user_env` without the `CURRENT_USER` row; HTML from `to_html_table` without `<!-- header -->`; counter message without `' - ' \|\| p_message` |
| Case or boundary value missing | 18 | boundary of exactly 4 000 bytes for client preferences; duplicate error messages are no longer suppressed; logging in the exception handler at a low level; privilege check only with the owner |
| State or resource unchecked | 4 | cursor stays open (`close_cursor` removed); parameter list is not cleared |
| Practically equivalent | 4 | `exit when n = p_max_rows` vs. `>=` (differs only for a negative limit) |
| Run time only | 2 | configuration is re-read on every call instead of after expiry |
| Environment missing | 2 | CGI variables only exist in an OWA session |
| Equivalent | 3 | `< 30` vs. `<= 30` before `rpad(…, 30)`; depth from a variable that is never negative |

What this means for a team: the 18 cases in the second row are the most valuable findings, real missing test cases at
boundaries and in error paths. The 67 in the first row are mostly diagnostic output whose text nobody wants to check
word for word. For these, it makes sense to exclude such functions by configuration or mark them as known.

## What the run improved in the tool

The first real third-party code exposed four weaknesses, all fixed and covered by tests:

- **Tests that commit themselves:** console commits configuration. The commit detection therefore took almost every
  mutant for a side effect and reset the database each time. Now, if the baseline already commits, there is a warning
  and no reset.
- **Crash of a server process** (ORA-07445 when cancelling a statement): a worker lost its connections and then
  marked 816 mutants as errors. Now it rebuilds itself, fetches the originals from the journal and repeats the
  mutant; in the second run exactly this happened once, without consequences.
- **Global context name:** two users mutating in one database at the same time took the context for the loop limits
  away from each other. Its name is now different per schema.
- **Unreliable tests:** the 11 level tests fail depending on the configuration state. Re-checking the killing tests
  detected them, excluded them and repeated the affected mutants without them.

## Decision on level 2

Addendum: level 2 has since been implemented and evaluated on SQL-heavy code, see
[`eval/plscope-utils/EVAL.md`](../plscope-utils/EVAL.md). In console it produces 6 mutants.

Originally postponed. Reasons:

1. Only 47 of the 1 630 mutants are in SQL (2.9 %), and 7 of them survive. SQL operators (DISTINCT, joins, GROUP BY,
   swapping columns) would have hardly any surface to attack in console.
2. The level 1 operators already produce 89 % usable findings with 3 % real equivalents. More operators would mainly
   mean more run time here.
3. Whether level 2 pays off depends on the share of SQL in the code. A run on SQL-heavy code decides that, ideally on
   your own: `plgauge mutate run <project>` and the share of `ctx = sql` in the report.

The sample showed one small improvement for level 1: the "never negative" heuristic recognizes `x > 0` vs. `x <> 0`
only for direct expressions such as `length(…)`, not for a variable that was assigned such an expression. This affects
1 of 100 cases and only pays off if it occurs more often on other code.

## Reproducing

```bash
corpus/fetch.sh                                  # console into corpus/.cache
# install console in the database: eval/console/README.md
PLGAUGE_DB=oracle://console_eval:…@…/FREEPDB1 bin/plgauge mutate run eval/console --json run.json --report run.html
npx tsx scripts/eval-summary.ts run.json survivors.tsv
```
