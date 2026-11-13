# console als Prüfstein (A11)

[console](https://github.com/ogobrecht/console) von Ottmar Gobrecht (MIT): Logging für PL/SQL mit 258 utPLSQL-Tests.
Quelltext aus dem Korpus (`corpus/fetch.sh`), `src` zeigt dorthin.

Einrichtung pro Datenbank (als SYSDBA ein Benutzer mit `connect, resource, create view, create job`, dazu für
Mutation `select on v_$session`, `alter system`, `create any context`), dann als dieser Benutzer:

```bash
sqlplus user/pw@db @install/create_console_objects.sql      # im console-Verzeichnis
cd tests && sqlplus user/pw@db @compile_and_run_unit_tests.sql
```

Lauf: `PLMUT_DB=oracle://console_eval:…@…/FREEPDB1,… npx pltest mutate run eval/console --json run.json`.
Auswertung: `eval/console/EVAL.md`.
