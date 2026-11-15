# Developing plgauge

## Layout

plgauge is a TypeScript monorepo (npm workspaces). It runs straight from the sources with `tsx`, so there is
no build step.

| Path | Content |
|---|---|
| `packages/core` | Lexer, preprocessor (`$IF`), parser, SQL*Plus script splitting, database access (load, compile, restore objects), restore journal and run lock, utPLSQL runner |
| `packages/coverage` | Instrumentation, runtime package `cov$`, metrics and MC/DC, exchange format `plgauge-coverage/1`, CI formats, corpus check |
| `packages/mutation` | Mutation point finder on the core parser, schema and naive rewriters, runs, reports |
| `packages/report` | HTML report (coverage, optionally joined with mutation results) |
| `packages/cli` | The `plgauge` command |
| `bin/plgauge` | Wrapper that runs the CLI from a checkout |
| `examples/` | `order_pricing` (coverage demo) and `shop_pricing` (mutation, with the expected verdicts in `expected.tsv`) |
| `eval/` | Runs on public open-source code (write-ups in German); `src` links into `corpus/.cache` |
| `corpus/` | `fetch.sh` downloads the robustness corpus at fixed commits into `corpus/.cache` (not checked in) |
| `ci/` | `setup-db.sh` (Oracle Free plus utPLSQL in a container) and CI templates for users |
| `baseline/` | Frozen output of the earlier prototypes (plcov, plmut in Go) for the parity checks |
| `scripts/` | Parity checks and debugging helpers |

## One parser for both tools

`packages/core/src/parser.ts` reads units, declarations, statements, embedded SQL and expressions with
Oracle's precedence. Coverage places its probes on that tree, and mutation testing places its mutants there.

When the parser does not understand a region, it treats the region as opaque. That costs the measuring
points inside the region, but it never produces wrong ones.

## Restore journal and run lock

Before plgauge instruments or mutates an object, it saves the original source and the compiler settings in
the table `PLGAUGE_JOURNAL` and commits that entry at once. The entry is deleted after the object is restored.

After every compile, the entry records a fingerprint of the code as the data dictionary shows it. A later run
can then tell its own leftovers from code that someone compiled since. If a run dies hard, the next run puts
the objects back from the journal. `plgauge restore` does the same on demand, and `--list` only shows the
entries.

Every run holds a row lock in `PLGAUGE_LOCK` on its own connection. A second run on the same schema stops at
once. The lock ends with the session, even if the process is killed.

## Tests

Offline (parser, instrumentation, finder, rewriters, reports):

```bash
npm ci
npm run typecheck
npm test
```

Against a database, most easily one started by `ci/setup-db.sh`:

```bash
url=$(PLGAUGE_USER=plmut ci/setup-db.sh | tail -1)
export PLGAUGE_DB=$url                         # mutation tests, oracle://user:pw@host:port/service
export PLGAUGE_COV_DB=$(echo "$url" | sed -E 's#^oracle://([^:]+):([^@]+)@(.*)$#\1/\2@\3#')   # coverage and journal tests, user/pw@host:port/service
export PLGAUGE_LIB_SCHEMA=PLMUT_LIB            # second schema for the multi-schema tests (setup-db.sh creates <user>_LIB)
npm test
```

The database tests take about seven minutes. They are skipped when the variables are not set. The project's
own CI (`.github/workflows/ci.yml`) runs the offline tests on Node 22 and 26, then the database tests.

Do not run two database test runs against the same schema at the same time. The run lock stops the second
one, and its tests fail.

## Parity and robustness checks

These need the corpus (`corpus/fetch.sh`, about 250 MB):

```bash
npm run parity:finder      # finder against the frozen output of the earlier Java finder
npm run parity:coverage    # instrumenter against the frozen results of the plcov prototype
bin/plgauge corpus corpus/.cache            # offline robustness check over all files
```

Intended differences from the earlier versions are listed in `baseline/plmut/PARITY.md` (in German).

`scripts/sql-compile-check.ts` compiles the schema rewrite of a corpus in a scratch schema. It checks that
switched SQL mutants are valid SQL.

## History

plgauge merges two prototypes:

- **plcov** (coverage, TypeScript).
- **plmut** (mutation testing, Go, with a Java finder based on IslandSQL).

Both were ported onto a common core with a single parser. Their outputs on the example projects and on the
corpus are kept in `baseline/` and serve as the reference for the parity checks.
