# Changelog

All notable changes to plgauge are listed here. Versions follow [Semantic Versioning](https://semver.org/);
until 1.0, a minor version may change options, file formats and output.

## [Unreleased]

### Fixed

- A `NONEDITIONABLE` unit (utPLSQL's own packages, say) lost the property when plgauge compiled its instrumented
  or mutated code, and Oracle refused that (`ORA-38824`): nothing could be measured. It is kept now, also on
  restore.
- Mutation testing with `--coverage`: tests the coverage file does not know (another schema's tests, tests
  added since) ran against no mutant, so mutants they would kill survived. They now run against every mutant,
  and the run says how many there are.
- Schema mode: the mutant "a || b → a" made the unmutated code a number when a is one. The switch is a CASE,
  whose first branch gives it its type, so without any active mutant the concatenation failed with
  `ORA-06502` and the tests that check it left the run. The branch is now `a || NULL`, text as before.
- Mutation testing: a test that failed only in the first baseline run after an install, with an error of state
  left from replaced code (`ORA-21700` when type or package specs were created anew, `ORA-04068`, …), was left
  out of the whole run. It counts when the second baseline run passes.

## [0.2.0] - 2026-11-25

### Added

- Coverage: `runCommand` measures tests that run elsewhere (Playwright against APEX, say): the measuring run starts
  that command instead of utPLSQL and counts what other sessions execute until it ends. `coverage.json` records
  the command and its exit code.
- Coverage: `backgroundProgram`, a regular expression on `CLIENT_PROGRAM_NAME`, limits other sessions to one client
  program (`^Oracle REST Data Services$`: APEX and ORDS requests, not the scripts that prepare their data).

### Changed

- Coverage: with `CREATE ANY CONTEXT` and `SELECT` on `V_$GLOBALCONTEXT`, other sessions keep their probe keys in
  the global context `PLGAUGE_COV_<hash>`, read at the end of the run. Pooled sessions that reset their package state after a
  request lose nothing, and the probes no longer commit while instrumented code runs. Hit counts of other sessions
  are 1. Without the privileges they flush as before. `plgauge uninstall` drops the context. `ci/setup-db.sh`
  grants `SELECT` on `V_$GLOBALCONTEXT`.

### Fixed

- Coverage: a periodic write of another session (every 1000 statements) committed in the middle of instrumented
  code and set `SQL%ROWCOUNT` to 0, so `update …; if sql%rowcount = 0 then` took the wrong branch. With the
  global context the probes no longer write.

## [0.1.1] - 2026-11-20

### Added

- plgauge is on npm: `npm install -g plgauge` or `npx plgauge`. The package is one bundled JavaScript file plus
  the Oracle driver in thin mode; `ci/setup-db.sh` comes with it.
- `plgauge --version`.

### Changed

- The CI templates install plgauge from npm (`PLGAUGE_VERSION`) instead of cloning the repository.

## [0.1.0] - 2026-11-20

First public release. plgauge merges two earlier prototypes, plcov (coverage) and plmut (mutation testing),
onto one TypeScript core with a single PL/SQL parser.

### Coverage

- Statement, branch, sub-condition (TRUE/FALSE/NULL), MC/DC and loop coverage by source instrumentation,
  also inside SQL statements on 23ai and later.
- Per-test coverage. Every test must give the same result with and without instrumentation.
- Comparison with utPLSQL's own line coverage. The comparison run and the warm-up run are optional
  (`--no-utplsql-compare`, `--no-warmup`).
- Multiple schemas, triggers, code started in background sessions (scheduler jobs).
- Exchange format `plgauge-coverage/1`, export to Cobertura, Sonar, LCOV and JUnit, thresholds
  (`plgauge check`), merging of runs (`plgauge merge`).

### Mutation testing

- Operators for PL/SQL and for embedded SQL: comparisons, logic, arithmetic, statements, `WHERE`, joins,
  `DISTINCT`, `ORDER BY`, aggregates, set operators. Also views, cursors and dynamic SQL.
- Two modes: `schema` compiles all mutants once behind switches, `naive` compiles each mutant on its own.
- Each mutant runs only against the tests that reach it. Flaky tests are detected and left out.
- Text, JSON, HTML and Stryker (mutation-testing-elements) reports, and `--min-score` as a CI gate.

### Both tools

- Joint HTML report of coverage and mutation results: an overview page plus one page per object.
- Diff mode (`--diff origin/main`) that looks only at lines changed in a pull request.
- Project file `plgauge.json` with install scripts, mutated files, tests and optional
  `beforeTests` / `afterTests` scripts around the test runs.
- Restore journal and run lock: changed objects go back after the run, also after a crash
  (`plgauge restore`). `plgauge uninstall` removes the runtime objects from a schema.
- Failing tests are reported with utPLSQL's message. `--fail-on-test-errors` fails the build when tests are
  already red without instrumentation.
- `ci/setup-db.sh` starts Oracle Free with utPLSQL 3.2.2 for local use and CI. Templates for GitHub
  Actions and GitLab CI.

### Known limits

- Oracle Database 23ai/26ai only.
- Not on npm yet: run it from a checkout (`bin/plgauge`).

[0.2.0]: https://github.com/WayneNani/plgauge/releases/tag/v0.2.0
[0.1.1]: https://github.com/WayneNani/plgauge/releases/tag/v0.1.1
[0.1.0]: https://github.com/WayneNani/plgauge/releases/tag/v0.1.0
