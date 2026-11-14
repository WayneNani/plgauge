# @pltest/mutation – Mutation Testing für PL/SQL (vormals plmut)

Portierung von plmut (Go) nach TypeScript. Abgeglichen gegen die Go-Fassung auf Stand `9bf5d68`
(Daten in `baseline/plmut/`): Beispielprojekt in beiden Modi und pljson-Volllauf.

## Ablauf

1. **Stellen finden** (`find.ts`): auf dem Syntaxbaum des gemeinsamen Parsers (`@pltest/core`).
   Bis Phase 4 kam das aus einem Java-Finder (IslandSQL); seine Ausgabe auf dem Korpus liegt
   eingefroren in `baseline/plmut/finder-corpus.json.gz`, Vergleich mit `npm run parity:finder`.
2. **Schema** (Standard, `--mode schema`): alle Mutanten hinter Schaltern in einem Build
   (`schema.ts`), Compiler-Filter über `ALL_ERRORS`, Aufzeichnungslauf mit Mutanten-ID −1,
   jeder Mutant nur gegen seine deckenden Tests, schnellster zuerst, Fail-Fast, Schleifenwächter.
3. **Orakel** (`--mode naive`): jeder Mutant einzeln kompiliert und gegen alle Tests geprüft.
4. Zeitgrenze in drei Stufen (`CANCEL SQL`, Treiber-`break()`, `KILL SESSION`), Ausschluss
   scheiternder und unzuverlässiger Tests, Commit-Erkennung über eine Marker-Zeile, mehrere
   Worker-Datenbanken mit Zurücksetzen nach Nebenwirkung (`--reset-cmd`).

Jede Änderung am Code läuft über das Wiederherstellungs-Journal des Kerns (`pltest restore`).

## Operatoren

| Stufe | Operator | Mutation |
| --- | --- | --- |
| 1 | ROR | Vergleich: `<` → `<=`, `<>`, `FALSE` usw. (hinreichende Menge nach Kaminski, Ammann, Offutt) |
| 1 | LCR | `AND`/`OR`: linker oder rechter Teil, `=`/`<>` beider Teile, `FALSE`/`TRUE` |
| 1 | AOR | `+` ↔ `-`, `*` ↔ `/`, `MOD` → `*`, `a \|\| b` → `a` |
| 1 | SBR | Anweisung (Zuweisung, SQL, Aufruf, RAISE, EXIT WHEN) → `NULL;` |
| 1 | RET | Unterprogramm kehrt sofort zurück oder wirft sofort |
| 1 | EXC | Exception-Handler verschluckt den Fehler |
| 1 | NUL | `IS NULL` ↔ `IS NOT NULL`; `NVL`/`COALESCE` auf ein Argument reduziert |
| 1 | CUR | `%FOUND` ↔ `%NOTFOUND`; FOR-Schleife ohne erste oder letzte Iteration |
| 2 | SEL | `DISTINCT`/`UNIQUE` entfernt; `FETCH FIRST …` entfernt |
| 2 | JOI | `LEFT`/`RIGHT`/`FULL JOIN` → `JOIN`; `[INNER] JOIN` → `LEFT JOIN`; `(+)` entfernt |
| 2 | ORD | `ORDER BY`: alle Elemente `ASC` ↔ `DESC`, ein Mutant pro Liste (auch in `OVER` und `WITHIN GROUP`) |
| 2 | UNI | `UNION` ↔ `UNION ALL`; `INTERSECT` ↔ `MINUS`/`EXCEPT` |
| 2 | AGR | `MIN` ↔ `MAX`; `SUM` ↔ `AVG`; `COUNT(DISTINCT x)` → `COUNT(x)`; `COUNT(x)` → `COUNT(*)` |
| 2 | SUB | `EXISTS` ↔ `NOT EXISTS`; `IN (Unterabfrage)` ↔ `NOT IN` |
| 2 | WHR | Bedingung von `WHERE`/`HAVING` → `TRUE` (Filter fällt weg) |
| 2 | COL | `UPDATE … SET`: eine Zuweisung weg; `INSERT (Spalten) VALUES (…)`: eine Spalte mit ihrem Wert weg |

Stufe 2 wirkt nur in statischem SQL (Abfragen, DML, Cursor) und folgt den SQL-Operatoren von Tuya, Suárez-Cabal und
de la Riva (2007), beschränkt auf Varianten, die selten äquivalent sind. Ausgelassen werden: `DISTINCT`, `UNION` und
`ORDER BY` in Unterabfragen von `IN`/`EXISTS`, `ORDER BY` eines einzeiligen `SELECT … INTO` ohne Zeilenlimit,
`[INNER] JOIN` → `LEFT JOIN`, wenn `WHERE` eine Spalte der verbundenen Tabelle vergleicht (die Nullzeilen fallen
ohnehin weg), `WHERE 1 = 1`, ein `WHERE`, für das ROR oder LCR schon `TRUE` liefern, `WHR` auf der Bedingung mit dem Bulk-Bind eines
`FORALL` (PLS-00435) und `UNION ALL` im Rumpf eines `WITH`-Elements mit Spaltenliste (rekursiv: ORA-32040).

Umschalten im Schema: Mutanten in SQL (beider Stufen) werden nicht per `CASE` im SQL geschaltet, denn ein Schalter um
eine Join-Bedingung nimmt dem Optimizer den Join (gemessen an plscope-utils: Minuten statt Millisekunden über
`DBA_IDENTIFIERS`). Stattdessen steht die PL/SQL-Anweisung (statisches SQL, `FORALL`, `OPEN … FOR`) einmal pro Variante
im Schema (`IF aktiv = id THEN <Variante> ELSIF … ELSE <Original> END IF;`); das Original behält seinen Plan. In
Cursor-Deklarationen und Cursor-FOR-Schleifen geht das nicht; diese Mutanten werden einzeln kompiliert.
Für sie gibt es
keine Aufzeichnung, welche Tests sie erreichen: Sie laufen gegen alle Tests, und ein Mutant, den kein Test erreicht, erscheint als überlebt statt als nicht erreicht. `--ops` wählt
Operatoren aus, z. B. `--ops ROR,LCR,AOR,SBR,RET,EXC,NUL,CUR` für nur Stufe 1.

Views: `CREATE VIEW` in einer Datei unter `mutate` wird mutiert wie das SQL in PL/SQL, mit beiden Stufen. Das Schema
schaltet sie blockweise; Blöcke sind die Abfrage der View, `WITH`-Elemente und Inline-Views in `FROM` (Unterabfragen in
Bedingungen bleiben in ihrem Block, damit der Optimizer sie weiter in Joins auflösen kann; rekursive `WITH`-Elemente
sind kein Block). Ein Block mit Mutanten wird zu

```sql
SELECT * FROM (<Block>) WHERE NVL(V, '0') NOT IN ('<IDs der Zweige>')
                          AND (NVL(V, '0') <> '-1' OR (SELECT plmut_ctl.hit(<IDs>) FROM dual) = 0)
UNION ALL SELECT * FROM (<Block mit Mutant 17>) WHERE V = '17' …
```

mit `V = SYS_CONTEXT(<Kontext des Laufs>, 'ACTIVE')`: Ein Filter auf eine Konstante schneidet alle Zweige bis auf
einen ab, und der Aufzeichnungslauf (`-1`) notiert, welcher Test den Block erreicht. Stellen in Select-Listen
ändern keinen Plan und werden an Ort und Stelle geschaltet (`CASE V WHEN '17' THEN (…) ELSE (…) END`, Bedingungen
dank SQL-Booleans von 23ai ebenso). Jeder Zweig ist eine Kopie, die der Optimizer neu plant, und `WITH`-Klauseln
in den Dictionary-Views einer Kopie werden vor allen Zweigen materialisiert, bei jeder Ausführung: Eine View bekommt
höchstens 20 Zweige (weniger, wenn `EXPLAIN PLAN` des Originals lange dauert), die übrigen Stellen laufen einzeln
kompiliert, aber nur gegen die Tests, die ihren Block laut Aufzeichnung erreichen. `WITH`-Elemente, die das Original
einmal referenziert, bekommen im Schema `/*+ INLINE */`, sonst würden die Kopien sie materialisieren. Stellen ohne eigenen
Block (rekursive `WITH`-Elemente) zeichnet der Hauptblock auf: Ein Test, der ihn nie ausführt, fragt die View nicht ab.
Abfragen mit eigenem `ORDER BY` bekommen keinen Wrapper, denn
sonst wäre ihre Reihenfolge nicht mehr garantiert (Top-N mit `ROWNUM`). Eine solche Inline-View gehört zum umgebenden
Block. Die Stellen einer sortierten Hauptabfrage laufen einzeln. Views mit `WITH FUNCTION` meldet der Finder als nicht
unterstützt. Das Original einer View kommt aus `DBMS_METADATA`, bei Views anderer Schemas ohne `SELECT_CATALOG_ROLE` aus
`ALL_VIEWS` und `ALL_TAB_COLUMNS`. Es steht im Restore-Journal wie jede Einheit. Fehler beim `CREATE VIEW` ordnet der Lauf
über die Fehlerposition des Servers einem Zweig zu. Scheitert der Wrapper eines Blocks, laufen dessen Stellen einzeln,
und der Block wird nicht noch einmal eingepackt.

Tests, die den Text einer View lesen (Quelltext, Lineage-Analysen), sehen im Schema die Kopien. Scheitern Tests mit
den geschalteten Views, aber nicht mit den Originalen, sucht der Lauf die View, an der es liegt; sie bleibt im
Original, ihre Mutanten laufen einzeln mit allen Tests. So geht kein Test für die übrigen Mutanten verloren.

## Benutzung

```bash
export PLMUT_DB=oracle://user:pw@host:port/service          # mehrere Worker: kommagetrennt
npx pltest mutate points examples/shop_pricing              # Mutanten anzeigen, offline
npx pltest mutate run examples/shop_pricing --report report.html
npx pltest mutate run eval/pljson --mode naive --sample 200 --seed 7 --json naive.json
npx pltest mutate compare a.json b.json                     # auch gegen JSON der Go-Fassung
```

Für die CI: `--diff origin/main` (nur Mutanten auf Zeilen, die sich seit der Merge-Basis geändert haben) und
`--min-score 60` (Exit-Code 3 darunter). Weitere Optionen: `--ops ROR,SBR`, `--timeout-factor 5`, `--skip-install`, `-q`,
`--coverage plcov-coverage.json` (Orakel-Modus: nur die Tests, die die Anweisung um den Mutanten
ausgeführt haben).
Projektdatei `pltest.json` (oder `plmut.json`): `install` (Skripte), `mutate` (Globs der Dateien),
`tests` (utPLSQL-Pfade).

Mehrere Schemas: Eine Einheit, die mit Schema geschrieben ist (`CREATE OR REPLACE PACKAGE BODY app_util.calc …`), wird in
diesem Schema mutiert. Das Laufzeitpaket `plmut_ctl` bleibt beim angemeldeten Benutzer und wird qualifiziert aufgerufen;
der Lauf vergibt `EXECUTE` darauf. Rechte wie bei der Coverage (`CREATE ANY PROCEDURE`, `EXECUTE ANY PROCEDURE`). Der
Kontext für Schleifengrenzen heißt pro Schema anders, so stören sich Läufe verschiedener Benutzer in einer Datenbank nicht.

## Zusammen mit Coverage

Coverage und Mutation lesen dieselbe Projektdatei, und die Ergebnisse passen zueinander:

```bash
npx pltest coverage examples/shop_pricing --out cov          # misst genau die Einheiten des Projekts
npx pltest mutate run examples/shop_pricing --json run.json
npx pltest crosscheck --coverage cov/plcov-coverage.json --mutation run.json
npx pltest report cov/coverage.json --mutation run.json --out joint
npx pltest mutate run examples/shop_pricing --mode naive --coverage cov/plcov-coverage.json
```

- **Gegenprobe** (`crosscheck`): Jeder Test, der im Aufzeichnungslauf einen Mutanten erreicht, muss
  laut Coverage die Anweisung um ihn ausgeführt haben. Ein Widerspruch zeigt einen Fehler in einem
  der beiden Werkzeuge.
- **Gemeinsamer Bericht**: Der Coverage-Bericht zeigt pro Zeile die Mutanten und ihre Urteile und
  führt jeden überlebenden Mutanten auf einer ausgeführten Zeile als Lücke: Die Tests laufen durch
  den Code, prüfen ihn aber nicht.
  Bekannter Effekt: Code, der nur beim ersten Aufruf pro Session läuft (Initialisierung von Paketzustand), gehört dem Test,
  der ihn zuerst auslöst. Laufen in beiden Werkzeugen nicht dieselben Tests (der Mutationslauf schließt scheiternde Tests
  aus), kann das als Widerspruch erscheinen. Tests mit Status `flaky` in der Coverage zählen nicht als Widerspruch.
- **Testauswahl im Orakel-Modus**: Statt aller Tests laufen nur die, die die Anweisung um den
  Mutanten ausgeführt haben, eine sichere Obermenge der Tests, die ihn erreichen. Mutanten in
  Deklarationen und Einheiten ohne passende Coverage (anderer Quelltext in der Datenbank) bekommen
  weiter alle Tests.

Zeilen: Ergebnisse tragen `unitLine`, die Dateizeile des Schlüsselworts der Einheit; die Zeile in
`ALL_SOURCE` ist `line - unitLine + 1`.

Unterschied zur Go-Fassung: `--sample` wählt mit einem eigenen Zufallsgenerator; gleiche Seeds
ergeben in Go und TypeScript verschiedene Stichproben. Paritätsvergleiche laufen deshalb auf
vollständigen Läufen, `compare` ordnet Mutanten über Datei, Position, Operator und Ersatztext zu.
