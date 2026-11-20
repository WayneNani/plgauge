# plgauge

**How good are your utPLSQL tests?** plgauge measures it for Oracle PL/SQL: branch, condition and MC/DC
coverage, plus mutation testing. It runs your existing utPLSQL tests. It does not replace utPLSQL; it tells
you what your tests actually check.

![Joint report: coverage and mutation score of the shop_pricing example](docs/images/joint-report.png)

## Why

Line coverage looks better than the tests are. On the `order_pricing` example, utPLSQL reports **87.9 %** line
coverage. plgauge shows that the same ten tests reach only **65 %** of the branches and **42.9 %** MC/DC:

- A whole `IF` on one line counts as covered as soon as its condition is evaluated, even if it is never TRUE.
- `CASE` branches that never run hide behind lines that did.

Coverage only says which code ran, not whether a test would notice if it were wrong. Mutation testing checks
that. plgauge plants small bugs (mutants) in your code, one at a time: `>` becomes `>=`, `AND` becomes `OR`, a
`RETURN` value changes. Then it runs your tests. A mutant that no test catches **survives**, and it points to
a check that is missing. On the `shop_pricing` example, 17 of 81 mutants survive although every test passes.

## What you get

- **Coverage** of statements, branches, sub-conditions (TRUE/FALSE/NULL), MC/DC and loops (0, 1, many
  iterations), per test. plgauge instruments the source and checks that every test gives the same result with
  and without instrumentation.
- **Mutation testing** with operators for PL/SQL and for the SQL inside it: comparisons, logic, arithmetic,
  statements, `WHERE`, joins, `DISTINCT`, `ORDER BY`, aggregates and set operators. It also covers views,
  cursors and dynamic SQL. By default all mutants are compiled once behind switches, and each mutant runs only
  against the tests that reach it.
- **One HTML report** that combines both, next to what utPLSQL itself reports.
- **CI support:**
  - Cobertura, Sonar, LCOV and JUnit output.
  - Thresholds that fail the build.
  - A diff mode that looks only at lines changed in a pull request.
  - Templates for GitHub Actions and GitLab CI.
- **Safe on a shared dev schema.** Every changed object is saved in a journal before it is touched and is put
  back afterwards. A killed run is repaired by the next run or by `plgauge restore`. A run lock stops two runs
  on one schema.

## Requirements

- Node.js 22 or newer.
- Oracle Database 23ai/26ai with utPLSQL 3.2.2 or newer. The Free edition is enough. Other versions are not
  tested.
- For the quick start: Docker or Podman.

> **Use a development or test schema, never production.** plgauge recompiles the code it measures. Mutation
> testing also needs strong rights: `CREATE ANY CONTEXT`, and `ALTER SYSTEM` to end a hung test session.
> [`ci/setup-db.sh`](ci/setup-db.sh) shows exactly what it grants.

## Quick start

This takes about five minutes, most of it while the database starts.

```bash
git clone https://github.com/WayneNani/plgauge.git && cd plgauge
npm ci

# Oracle Free with utPLSQL in a container (port 1521, user "app"); prints the connection URL
export PLGAUGE_DB=$(ci/setup-db.sh | tail -1)

# Coverage of the order_pricing example: writes out/order/index.html
bin/plgauge coverage examples/order_pricing --out out/order

# Mutation testing of the shop_pricing example
bin/plgauge mutate run examples/shop_pricing --json out/shop.json --report out/shop.html

# Coverage of the same project, then one report with both
bin/plgauge coverage examples/shop_pricing --out out/shop-cov
bin/plgauge report out/shop-cov/coverage.json --mutation out/shop.json --out out/shop-joint
```

Open the `index.html` files in a browser. The mutation run also lists its survivors in the terminal and ends
like this:

```text
Other:
  SURVIVED    shop_pricing.pkb:6  ROR  discount  p_amount >= c_discount_threshold → p_amount > c_discount_threshold
  SURVIVED    shop_pricing.pkb:44  ROR  cancel_order  p_mode = 'final' → TRUE
  …

81 mutants: KILLED 59, SURVIVED 17, NOT_COVERED 1, TIMEOUT 4
Mutation Score 77.8 % · 14 Tests · Baseline 77ms · run time 19.929s
```

When you are done, remove the database with `docker rm -f plgauge-db` (or `podman rm -f plgauge-db`).

`bin/plgauge` runs the tool from the checkout; plgauge is not on npm yet. To call it from anywhere, put the
`bin` directory on your `PATH` or create a symlink to `bin/plgauge`.

## Use it on your own code

Put a `plgauge.json` next to your sources:

```json
{
  "install": ["src/tables.sql", "src/pricing.pks", "src/pricing.pkb", "test/test_pricing.pks", "test/test_pricing.pkb"],
  "mutate": ["src/*.pkb"],
  "tests": ["test_pricing"]
}
```

- **`install`** lists your install scripts in order. They are read the way SQL*Plus reads them: statements end
  with `;`, PL/SQL units with a `/` on its own line.
- **`mutate`** lists the files whose units are measured and mutated.
- **`tests`** lists utPLSQL paths (packages or suite paths).

Then:

```bash
export PLGAUGE_DB=oracle://user:password@host:1521/service
bin/plgauge coverage path/to/project --out coverage
bin/plgauge mutate run path/to/project --json mutation.json --report mutation.html
```

If the code is already installed, add `--skip-install`. For a faster run without utPLSQL's own line rate, add
`--no-utplsql-compare --no-warmup` (two test runs fewer). To measure an existing schema without a project file,
use a connection config instead. See [`examples/order_pricing/coverage-config.json`](examples/order_pricing/coverage-config.json)
and the [coverage documentation](packages/coverage/README.md#configuration).

## In CI

Copy [`ci/templates/github-actions.yml`](ci/templates/github-actions.yml) or
[`ci/templates/gitlab-ci.yml`](ci/templates/gitlab-ci.yml) into your project. They start a database with
`ci/setup-db.sh` and then:

- measure coverage and fail below the thresholds (`--min-stmt`, `--min-branch`, `--min-cond`, `--min-mcdc`);
- check only the changed lines in pull requests (`--diff origin/main`);
- run mutation testing on the changed code, with `--min-score`;
- export Cobertura, Sonar and JUnit files;
- upload the reports.

## Commands

| Command | What it does |
|---|---|
| `plgauge coverage <dir>` | Install a project and measure its coverage (`--config file` for an existing schema) |
| `plgauge mutate run <dir>` | Mutation testing (`--mode schema` by default; `--mode naive` compiles each mutant on its own) |
| `plgauge report <coverage.json> --mutation <run.json>` | Joint HTML report |
| `plgauge export <coverage.json> --format cobertura\|sonar\|lcov\|junit` | Files for CI and code-quality tools |
| `plgauge check <file> --min-branch 70 …` | Thresholds on saved results (exit code 3 if one is missed) |
| `plgauge merge a.json b.json --out all.json` | Merge the coverage of several runs |
| `plgauge restore --config <file> [--list]` | Put back code that a killed run left changed |
| `plgauge mutate points <dir>` | List the mutants without a database |
| `plgauge instrument <file.sql>` | Show the instrumented source without a database |

All options are described in the package documentation:

- [Coverage](packages/coverage/README.md): metrics, configuration, per-test coverage, CI formats, limitations.
- [Mutation testing](packages/mutation/README.md): operators, modes, verdicts, safety, limitations.

## Evaluations on real code

plgauge was run on public open-source PL/SQL projects:

- [console](eval/console/EVAL.md): mutation testing of an instrumentation and logging package.
- [plscope-utils](eval/plscope-utils/EVAL.md): the SQL operators on a larger code base.

The parser is also checked offline on a corpus of about 900 PL/SQL bodies from ten open-source projects
(`corpus/fetch.sh`, `bin/plgauge corpus`).

## Status

plgauge is young (version 0.1). There are 153 automated tests, 25 of them against a real Oracle database,
including full mutation runs in both modes. Known gaps:

- **Distribution:** plgauge is not on npm; run it from a checkout.
- **Versions:** only Oracle 23ai/26ai is tested.

How the code is organised, how to run the tests against a database and how parity with the earlier prototypes
was checked is in [DEVELOPMENT.md](DEVELOPMENT.md).

## License

[Apache License 2.0](LICENSE)
