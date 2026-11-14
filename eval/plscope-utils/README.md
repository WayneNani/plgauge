# plscope-utils als Prüfstein für die SQL-Operatoren (A10)

[plscope-utils](https://github.com/PhilippSalvisberg/plscope-utils) von Philipp Salvisberg (Apache 2.0): Werkzeuge über
PL/Scope, viel SQL auf dem Data Dictionary, 36 utPLSQL-Tests. Quelltext aus dem Korpus (`corpus/fetch.sh`), `src` zeigt
auf `corpus/.cache/plscope-utils/database`.

Einrichtung pro Datenbank, als SYSDBA im Verzeichnis `database/utils/user`:

```sql
@plscope.sql plscope_eval <passwort> users     -- Benutzer mit den Rechten aus plscope.sql
grant create job, alter system to plscope_eval;
grant select on v_$session to plscope_eval;
```

Dann als `plscope_eval` im Verzeichnis `database`: `@install.sql` und `@install_test.sql` (läuft alle 36 Tests).

Lauf: `PLMUT_DB=oracle://plscope_eval:…@…/FREEPDB1,… npx pltest mutate run eval/plscope-utils --json run.json`.
Auswertung: [`EVAL.md`](EVAL.md).
