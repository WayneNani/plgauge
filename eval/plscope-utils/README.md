# plscope-utils as a test case for the SQL operators

[plscope-utils](https://github.com/PhilippSalvisberg/plscope-utils) by Philipp Salvisberg (Apache 2.0): tools built on
PL/Scope, with a lot of SQL on the data dictionary and 36 utPLSQL tests. Source code comes from the corpus
(`corpus/fetch.sh`); `src` points to `corpus/.cache/plscope-utils/database`.

Setup per database, as SYSDBA in the directory `database/utils/user`:

```sql
@plscope.sql plscope_eval <password> users     -- user with the privileges from plscope.sql
grant create job, alter system to plscope_eval;
grant select on v_$session to plscope_eval;
```

Then, as `plscope_eval` in the directory `database`: `@install.sql` and `@install_test.sql` (runs all 36 tests).

Run: `PLGAUGE_DB=oracle://plscope_eval:…@…/FREEPDB1,… bin/plgauge mutate run eval/plscope-utils --json run.json`.
Evaluation: [`EVAL.md`](EVAL.md).
