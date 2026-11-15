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
5. **Gegenprobe** (abschaltbar mit `--no-confirm`): Urteile, die von Umständen abhängen können, laufen ein zweites
   Mal (siehe unten).

Jede Änderung am Code läuft über das Wiederherstellungs-Journal des Kerns (`pltest restore`). Hat ein abgebrochener
Lauf Einheiten verändert zurückgelassen, stellt der nächste Lauf sie beim Start aus dem Journal wieder her, bevor er
installiert oder Originale liest. Hat seitdem jemand eine neuere Fassung kompiliert (Text weder von pltest noch das Original, ohne
Schaltaufrufe) oder das Objekt gelöscht, bleibt das so: der Eintrag wird mit Warnung verworfen. Während eines Laufs ändert man die Objekte des Schemas besser nicht: jeder Mutant und das
Zurückspielen am Ende kompilieren über sie hinweg (ein Coverage-Lauf lässt am Ende stehen, was inzwischen jemand
anderes kompiliert oder gelöscht hat). Damit das nicht einen noch laufenden Lauf trifft, hält jeder Lauf für seine Dauer
eine Zeilensperre in `PLTEST_LOCK` (eigene Verbindung, nie committet); ein zweiter Lauf auf demselben Schema bricht
sofort ab, auch ein Coverage-Lauf (beide Werkzeuge nehmen dieselbe Sperre und stellen beim Start wieder her, was ein
abgebrochener Lauf des einen oder anderen im Journal hinterlassen hat). Die Sperre endet mit der Sitzung, auch wenn der Prozess stirbt. Lässt sich ein Rest nicht zurückspielen (etwa weil eine Sitzung des toten Laufs die Einheit noch hält), bricht der Lauf ab, statt den veränderten Code für das Original zu halten. Sperre und Journal liegen im Schema des Laufs; ein Coverage-Lauf über mehrere Schemas sperrt nur sein Laufzeitschema, Mutationsläufe auf den gemessenen Schemas dürfen dann nicht gleichzeitig laufen.

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

Stufe 2 wirkt in statischem SQL (Abfragen, DML, Cursor), in Views und in dynamischem SQL aus Literalen (unten). Sie folgt den SQL-Operatoren von Tuya, Suárez-Cabal und
de la Riva (2007), beschränkt auf Varianten, die selten äquivalent sind. Ausgelassen werden: `DISTINCT`, `UNION` und
`ORDER BY` in Unterabfragen von `IN`/`EXISTS`, `ORDER BY` eines einzeiligen `SELECT … INTO` ohne Zeilenlimit,
`[INNER] JOIN` → `LEFT JOIN`, wenn `WHERE` eine Spalte der verbundenen Tabelle vergleicht (die Nullzeilen fallen
ohnehin weg), `WHERE 1 = 1`, ein `WHERE`, für das ROR oder LCR schon `TRUE` liefern, `WHR` auf der Bedingung mit dem Bulk-Bind eines
`FORALL` (PLS-00435) und `UNION ALL` im Rumpf eines `WITH`-Elements mit Spaltenliste (rekursiv: ORA-32040).

Umschalten im Schema: Mutanten in SQL (beider Stufen) werden nicht per `CASE` im SQL geschaltet, denn ein Schalter um
eine Join-Bedingung nimmt dem Optimizer den Join (gemessen an plscope-utils: Minuten statt Millisekunden über
`DBA_IDENTIFIERS`). Stattdessen steht die PL/SQL-Anweisung (statisches SQL, `FORALL`, `OPEN … FOR`) einmal pro Variante
im Schema (`IF aktiv = id THEN <Variante> ELSIF … ELSE <Original> END IF;`); das Original behält seinen Plan. Eine
Cursor-FOR-Schleife über eine Abfrage wird als Ganzes verdoppelt, mit Rumpf; die Kopien einer Anweisung zusammen
dürfen 256 KB groß sein, darüber laufen die übrigen Stellen einzeln. Die Kopien behalten die Schleifenwächter der
Schleife und ihres Rumpfs. Die Abfrage einer Cursor-Deklaration wird wie
ein Block einer View geschaltet (`UNION ALL`, unten), mit höchstens 20 Zweigen pro Cursor. Das erste Ausführen
parst alle Zweige (bei Cursorn über Dictionary-Views Sekunden); gibt es Zweige, hält ein Aufwärmlauf auf allen
Workern vor der Baseline das aus der Zeitgrenze heraus. Ausgenommen sind Cursor
mit `ORDER BY` oder `CONNECT BY` (eingepackt wäre ihre Reihenfolge nicht mehr garantiert), mit `FOR UPDATE` und mit
`WITH`, ebenso Cursor-FOR-Schleifen mit Label (die Kopien kompilieren weder mit noch ohne Label); ihre
Mutanten werden einzeln kompiliert. Für sie gibt es keine Aufzeichnung, welche Tests sie erreichen: Sie laufen gegen
alle Tests, und ein Mutant, den kein Test erreicht, erscheint als überlebt statt als nicht erreicht. `--ops` wählt
Operatoren aus, z. B. `--ops ROR,LCR,AOR,SBR,RET,EXC,NUL,CUR` für nur Stufe 1.

Dynamisches SQL: Ein String-Literal, das `EXECUTE IMMEDIATE`, `OPEN … FOR` oder `DBMS_SQL.PARSE` erreicht (auch in
Klammern), wird als SQL geparst und mit beiden Stufen mutiert. Über eine Variable nur, wenn sie im Deklarationsteil
des Unterprogramms selbst steht und jede Erwähnung eine dieser ist: ihre Deklaration, eine Zuweisung `v := …;` (ein
Literal wird notiert, jeder andere Wert, der nicht aus `v` gebaut ist, ersetzt es), eine Senke oder ein Argument eines
Protokollaufrufs (`DBMS_OUTPUT`, `LOGGER`, Prozeduren namens `LOG…`, `DEBUG…`, `TRACE…`). Alles andere, etwa
`v := v || …`, `w := v || …`, ein `CASE`-Zweig, die Übergabe an eine Prozedur oder ein gleichnamiger Bezeichner in einem
verschachtelten Block, kann die ausgeführte Anweisung vom Literal unterscheiden; die Variable bleibt außen vor.
Varianten entfallen, wenn sie länger würden als die deklarierte Länge (`VARCHAR2(n)`, sonst ORA-06502) oder einen
Bind-Platzhalter verlören (`USING` übergibt ihn weiter, sonst ORA-01006). Der Mutant ist das Literal mit einer Änderung
(Anführungszeichen wieder verdoppelt, bei `q'[…]'` unverändert). Das Schema schaltet das ganze Literal an Ort und Stelle
(`CASE aktiv WHEN 17 THEN '<Variante>' … ELSE '<Original>' END`, die Kopien eines Literals zusammen höchstens 256 KB);
jede Variante ist eine eigene Anweisung, die erst beim Ausführen geparst wird, also leidet kein Plan.

Views: `CREATE VIEW` in einer Datei unter `mutate` wird mutiert wie das SQL in PL/SQL, mit beiden Stufen. Ausgenommen sind Views mit INSTEAD-OF-Trigger: `CREATE OR REPLACE VIEW` löscht den Trigger, und das Zurückspielen des Originals bringt ihn nicht wieder. Was `CREATE OR REPLACE` sonst verliert, stellt jedes Kompilieren wieder her: Tabellen- und Spaltenkommentare einer View, den Status DISABLED eines Triggers; Materialized Views auf einer zurückgespielten View werden neu kompiliert. Im Schema-Modus stehen die Varianten mehrzeiliger Anweisungen und Ausdrücke vor dem Original: Zeilennummern (`$$PLSQL_LINE`, Fehler-Backtraces) verschieben sich dahinter; Tests, die sie prüfen, laufen mit `--mode naive`. Stellen in SQL-Makros (`SQL_MACRO`: ihr Rumpf läuft nur beim harten Parsen der aufrufenden Anweisung) und in RESULT_CACHE-Funktionen laufen einzeln (der Ergebnis-Cache gilt für alle Sitzungen und überdauert das Umschalten); Mutanten in Code, den eine solche Funktion aufruft, kann ihr Cache im Schema-Modus verdecken. `plmut_ctl` trägt `PRAGMA RESTRICT_REFERENCES(… TRUST)`, damit Einheiten mit diesem Pragma geschaltet werden können. Eine View, die sich ohne DBMS_METADATA nicht originalgetreu nachbauen lässt (Editioning-, Objekt-, Duality-View, benannte Constraints, unsichtbare Spalten), wird nicht angefasst. Das Schema
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

Planvergleich: Vor dem Schalten nimmt der Lauf mit `EXPLAIN PLAN` den Plan jeder View auf, danach den der
geschalteten. Ohne tote Zweige (unter einem Filter, der einen bestimmten Mutanten verlangt, auch die Kopie, die die
OR-Expansion von 23ai für den Aufzeichnungslauf anlegt) und ohne die Schritte des Schemas selbst müssen dieselben
Operationen auf denselben Objekten übrig bleiben. Sonst haben die Kopien den Plan verändert (eine materialisierte
`WITH`-Klausel, ein in einen Tabellenscan geschobener Zweigfilter, eine andere Join-Reihenfolge), und jeder Test,
der die View abfragt, liefe anders. `EXPLAIN PLAN` läuft dafür in einer eigenen Verbindung: Eine View mit vielen
schweren Kopien kann den Cursor-Heap des Servers sprengen (ORA-00600 `KGL-heap-size-exceeded`), und der Prozess
stirbt mit; die View gilt dann als nicht prüfbar. Bei einem abweichenden Plan laufen die Mutanten der View einzeln, und ihr Hauptblock bekommt nur noch
den Wrapper, der aufzeichnet, welche Tests die View abfragen. Ändert auch der den Plan, bleibt die View ganz im
Original. Ein häufiger Grund: Ein Zweigfilter landet auf einer View-Zeile statt als Startfilter vor dem Zweig, etwa
über analytischen Funktionen. Dann rechnet Oracle die toten Zweige bei jeder Abfrage mit.

Tests, die den Text einer View lesen (Quelltext, Lineage-Analysen), sehen im Schema die Kopien. Scheitern Tests mit
den geschalteten Views, aber nicht mit den Originalen, sucht der Lauf die View, an der es liegt; sie bleibt im
Original, ihre Mutanten laufen einzeln mit allen Tests. So geht kein Test für die übrigen Mutanten verloren.

## Gegenprobe

Manche Urteile hängen nicht nur vom Mutanten ab. Ein Test kann Daten lesen, die ein anderer Test vorher committet hat,
oder vom Inhalt der Worker-Datenbank abhängen. Ein Mutant kann eine Abfrage ohne `ORDER BY` liefern, deren erste Zeile
vom Plan abhängt. Zwei Maßnahmen:

- **Daten zurückschreiben:** Committen die Tests schon ohne Mutanten, stellt die Baseline fest, welche Tests das tun
  (jeder einmal allein). Nach jedem Mutanten, unter dem committet wurde, laufen von seinen Tests die committenden noch
  einmal auf dem Original (im Orakel-Modus nach dem Zurückspielen der Einheit). So beginnt kein Mutant mit Daten, die
  ein anderer Mutant geschrieben hat.
- **Zweiter Versuch:** Jeder erkannte Mutant läuft noch einmal mit dem erkennenden Test allein. Im Schema-Modus geschieht
  das nach dem Lauf auf dem nächsten Worker (mit nur einem Worker auf demselben), im Orakel-Modus gleich nach dem
  Urteil, solange der Mutant noch kompiliert ist (ein anderer Worker müsste ihn neu kompilieren; gemessen an
  plscope-utils kostete das mehr als der Lauf selbst). Hat der erste Lauf committet, werden vorher die Daten
  zurückgeschrieben und der Mutant neu kompiliert: Auch der zweite Versuch beginnt mit Daten wie ohne Mutanten. Besteht der Test, bleibt der Mutant erkannt, wird aber als
  unsicher markiert: Die Erkennung hing an der Reihenfolge der Tests, an Daten oder (nur im Schema-Modus prüfbar) an
  der Datenbank. Eine Zeitüberschreitung (nicht die des Schleifenwächters) läuft mit doppelter Zeit noch einmal.
  Endet sie dann, gilt das neue Urteil, ebenfalls markiert.

Grenze der Commit-Erkennung: Sie sieht einen Commit an einer Markierungszeile, die vor dem Testlauf eingefügt wird. Rollt ein Test die ganze Transaktion zurück, ist die Zeile weg, und ein späterer Commit im selben Lauf bleibt unerkannt.

Der Textbericht listet die markierten Mutanten mit Grund, das JSON trägt ihn im Feld `unstable`. Überlebende werden
nicht wiederholt: Das kostete so viel wie der Lauf selbst.

## Benutzung

```bash
export PLMUT_DB=oracle://user:pw@host:port/service          # mehrere Worker: kommagetrennt
npx pltest mutate points examples/shop_pricing              # Mutanten anzeigen, offline
npx pltest mutate run examples/shop_pricing --report report.html
npx pltest mutate run eval/pljson --mode naive --sample 200 --seed 7 --json naive.json
npx pltest mutate compare a.json b.json                     # auch gegen JSON der Go-Fassung
```

Für die CI: `--diff origin/main` (nur Mutanten auf Zeilen, die sich seit der Merge-Basis geändert haben) und
`--min-score 60` (Exit-Code 3 darunter). Weitere Optionen: `--ops ROR,SBR`, `--timeout-factor 5`, `--skip-install`, `-q`, `--no-confirm`,
`--coverage plcov-coverage.json` (Orakel-Modus: nur die Tests, die die Anweisung um den Mutanten
ausgeführt haben).
Projektdatei `pltest.json` (oder `plmut.json`): `install` (Skripte, gelesen wie von SQL*Plus mit Standardeinstellungen:
`/` und `RUN` führen die letzte Anweisung aus, auch ein zweites Mal; eine Leerzeile oder `.` beendet die Eingabe von SQL
ohne Ausführung, außer bei `SET SQLBLANKLINES ON`; `EXIT` beendet das Skript; Substitutionsvariablen – `&x`, `DEFINE` – werden nicht ersetzt), `mutate` (Globs der Dateien),
`tests` (utPLSQL-Pfade).

Mehrere Schemas: Eine Einheit, die mit Schema geschrieben ist (`CREATE OR REPLACE PACKAGE BODY app_util.calc …`), wird in
diesem Schema mutiert. Das Laufzeitpaket `plmut_ctl` bleibt beim angemeldeten Benutzer und wird qualifiziert aufgerufen;
der Lauf vergibt `EXECUTE` darauf. Rechte wie bei der Coverage (`CREATE ANY PROCEDURE`, `EXECUTE ANY PROCEDURE`). Der
Kontext für Schleifengrenzen heißt pro Schema anders, so stören sich Läufe verschiedener Benutzer in einer Datenbank
nicht – solange sie nicht dieselben fremden Einheiten mutieren: Sperre und Journal liegen im Schema des Laufs, ein Lauf
eines anderen Benutzers auf `app_util.calc` sieht sie nicht. Zwei solche Läufe (oder Worker-URLs mit verschiedenen
Benutzern auf einer Datenbank) dürfen nicht gleichzeitig laufen; ebenso wenig ein Coverage-Lauf mit `schema: app_util`
und ein Mutationslauf, der `app_util.…` mutiert (sie sperren verschiedene Schemas).

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
