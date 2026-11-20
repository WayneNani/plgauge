# Changelog

All notable changes to plgauge are listed here. Versions follow [Semantic Versioning](https://semver.org/);
until 1.0, a minor version may change options, file formats and output.

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

[0.1.1]: https://github.com/WayneNani/plgauge/releases/tag/v0.1.1
[0.1.0]: https://github.com/WayneNani/plgauge/releases/tag/v0.1.0
