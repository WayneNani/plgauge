# console as a test case

[console](https://github.com/ogobrecht/console) by Ottmar Gobrecht (MIT): logging for PL/SQL with 258 utPLSQL tests.
Source code comes from the corpus (`corpus/fetch.sh`); `src` points there.

Setup per database: as SYSDBA, create a user with `connect, resource, create view, create job`, plus, for mutation,
`select on v_$session`, `alter system`, `create any context`. Then, as that user:

```bash
sqlplus user/pw@db @install/create_console_objects.sql      # in the console directory
cd tests && sqlplus user/pw@db @compile_and_run_unit_tests.sql
```

Run: `PLGAUGE_DB=oracle://console_eval:…@…/FREEPDB1,… bin/plgauge mutate run eval/console --json run.json`.
Evaluation: `eval/console/EVAL.md`.
