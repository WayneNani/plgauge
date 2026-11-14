# @pltest/coverage – Branch-, Bedingungs- und MC/DC-Coverage für PL/SQL (vormals plcov)

utPLSQL misst Coverage heute über `DBMS_PROFILER` und `DBMS_PLSQL_CODE_COVERAGE` und meldet daraus eine **Zeilen**-Quote.
plcov ist ein Prototyp, der stattdessen den Quellcode **instrumentiert**, wie JaCoCo oder Istanbul. So misst er Anweisungen, Branches
(auch implizite `ELSE`-Zweige), Teilbedingungen (WAHR / FALSCH / **NULL**), MC/DC und Schleifen (0 / 1 / n Durchläufe).
Als Test-Runner dienen die vorhandenen utPLSQL-Tests.

Ein Beispielbericht liegt in [`examples/order_pricing/report/index.html`](../../examples/order_pricing/report/index.html).

## Was die Demo zeigt

Gemessen wird dieselbe Testsuite (10 utPLSQL-Tests) auf Oracle AI Database 26ai Free (23.26):

| Objekt | Zeilen (utPLSQL) | Anweisungen | Branches | Bedingungen | MC/DC |
|---|---|---|---|---|---|
| `order_pricing` | **100 %** (23/23) | 84 % | **61 %** (11/18) | 50 % | **33 %** |
| `archive_orders` | 60 % | 100 % | 100 % | 100 % | 100 % |

- `order_pricing`: utPLSQL meldet 100 %, obwohl die Zweige `WHEN 'AT'` und `WHEN 'CH'` nie liefen und
  `if p_weight_kg > 20 then … end if;` (eine Zeile) nie WAHR war. Der Profiler zählt die Zeile schon, wenn nur die Bedingung ausgewertet wird.
- MC/DC findet fehlende Testfälle und schlägt sie konkret vor, z. B. „`p_vip` = WAHR, `p_amount > 1000` = FALSCH → Ergebnis FALSCH“.
- `archive_orders`: Der Exception-Handler ist mit `pragma coverage('NOT_FEASIBLE')` markiert. plcov rechnet ihn heraus, utPLSQL zählt ihn als nicht abgedeckt.
- Alle 10 Tests liefern mit und ohne Instrumentierung dasselbe Ergebnis. plcov prüft das bei jedem Lauf automatisch.

## Schnellstart

Voraussetzungen: Node.js 22 und Docker.

```bash
# 1. Datenbank (Oracle 23ai/26ai Free) starten
docker run -d --name ora23 -p 1521:1521 -e ORACLE_PASSWORD=Oracle123 \
  -e APP_USER=demo -e APP_USER_PASSWORD=demo gvenzl/oracle-free:23-slim-faststart

# 2. utPLSQL installieren (aus diesem Repository)
docker cp ../source ora23:/tmp/utplsql_source
docker exec ora23 bash -lc 'cd /tmp/utplsql_source && echo exit | sqlplus -S sys/Oracle123@localhost:1521/FREEPDB1 as sysdba @install_headless.sql'

# 3. Demo-Code und Tests einspielen, messen
npm install
npx pltest deploy --config examples/order_pricing/plcov.json examples/order_pricing/src/*.sql examples/order_pricing/src/*.pks examples/order_pricing/src/*.pkb examples/order_pricing/src/*.prc examples/order_pricing/test/*.pks examples/order_pricing/test/*.pkb
npm run demo -- --out examples/order_pricing/report
```

## Befehle

Seit der Zusammenführung heißt der Befehl `pltest` (`npx pltest …` oder `bin/pltest …`); `run` ist der alte Name von `coverage`.

| Befehl | Zweck |
|---|---|
| `pltest coverage --config plcov.json [--out dir]` | Kompletter Lauf: Baseline, utPLSQL-Coverage, Instrumentieren, Testlauf, Wiederherstellen, Bericht |
| `pltest coverage <projekt> --db oracle://…` | Dasselbe für ein Projekt mit `pltest.json`: genau dessen Einheiten und Tests |
| `pltest instrument datei.sql [--no-sql]` | Zeigt offline, wie instrumentierter Code aussieht |
| `pltest report coverage.json [--mutation run.json] [--out dir]` | Bericht neu erzeugen; mit Mutationsergebnissen der gemeinsame Bericht |
| `pltest export coverage.json --format json\|cobertura\|sonar\|lcov\|junit [--src dir]` | Austauschformat oder CI-Formate; `--src` ordnet Objekte den Quelldateien zu |
| `pltest merge a.json b.json … --out merged.json` | Läufe zusammenführen (z. B. Unit- und Integrationstests) |
| `pltest check datei --min-stmt N --min-branch N --min-cond N --min-mcdc N` | Schwellen für die CI, Exit-Code 3 bei Unterschreitung (auch direkt bei `coverage`) |
| `--diff origin/main` (bei `coverage`, `check`) | Schwellen nur auf den seit der Merge-Basis geänderten Zeilen |
| `pltest corpus verzeichnis… [--db plcov.json]` | Robustheitstest des Parsers auf einem Korpus, optional mit Kompilierprüfung |
| `pltest deploy --config plcov.json dateien…` | SQL*Plus-artige Skripte einspielen (für die Demo) |
| `pltest restore --config plcov.json [--list]` | Code zurücksetzen, den ein abgebrochener Lauf verändert hinterlassen hat |

`plcov.json`: `user`, `password` (oder Umgebungsvariable `PLCOV_PASSWORD`), `connectString`, `schema`, `tests` (utPLSQL-Pfade),
optional `include` / `exclude` (Regex auf Objektnamen), `sqlProbes` (`"auto"` = ab 23ai), `perTest` (Standard `true`) und
`baselineRuns` (Standard 2).

## CI

- **Formate:** Cobertura (GitLab, Jenkins, Azure DevOps), SonarQube Generic Coverage, LCOV und JUnit. Sie kennen nur Zeilen
  und Branches: Anweisungszeilen werden Zeilen, die Zweige von IF, CASE, Schleifen und Handlern Branches. Abgeleitete Zweige
  (THEN und das implizite ELSE) stehen an der Zeile ihrer Bedingung. Teilbedingungen und MC/DC bleiben im JSON und im Bericht.
- **Pfade:** Gemessen wird auf Datenbankobjekten. `--src` sucht die Einheiten in den Quelldateien (mit dem Parser) und rechnet
  ALL_SOURCE-Zeilen in Dateizeilen um. Ohne Zuordnung bekommen Objekte virtuelle Pfade wie `schema/package_body/name.sql`.
- **Zusammenführen:** Objekte müssen denselben Quelltext haben (`rawSha256`); Treffer addieren sich, Testlisten werden
  vereinigt. MC/DC nach dem Zusammenführen gilt als erfüllt, wenn ein Lauf es erfüllt hat (die Vektoren beider Läufe werden
  nicht kombiniert).
- **Diff-Modus:** Eine geänderte Zeile gehört zur innersten Anweisung um sie, nicht zum IF darum.
- **Vorlagen:** `ci/templates/github-actions.yml` und `ci/templates/gitlab-ci.yml`; `ci/setup-db.sh` startet Oracle 23ai Free
  mit utPLSQL 3.2.2 und einem Benutzer mit den nötigen Rechten.

## Unzuverlässige Tests

Vor dem Messen laufen die Tests zweimal ohne Coverage (`baselineRuns`), danach einmal mit utPLSQL-Coverage. Jeder Lauf startet
mit frischem Paketzustand (`DBMS_SESSION.RESET_PACKAGE`), wie der Lauf auf dem frisch kompilierten instrumentierten Code. Ein Test,
dessen Ergebnis zwischen diesen Läufen wechselt, gilt als unzuverlässig: Er steht im Export mit Status `flaky` und zählt nicht
für die Prüfung „gleiches Verhalten mit und ohne Instrumentierung“. Abweichende Tests nennt der Lauf mit Namen.

## Coverage pro Test und Austauschformat

plcov ordnet jeden Treffer dem laufenden utPLSQL-Test zu. Die Zuordnung läuft über `SYS_CONTEXT('UT3_INFO', 'TEST_NAME')`, gelesen einmal pro
Anweisungssonde, in einem einzigen `ut_runner.run`. Treffer außerhalb eines Tests (`beforeall`/`afterall`) landen in einem eigenen
Setup-Eintrag `#owner.package`. Im Bericht zeigt die Trefferzahl einer Zeile per Tooltip die Tests, die sie erreichen.

`plcov-coverage.json` (Format `plcov-coverage/1`) ist für andere Werkzeuge gedacht, z. B. das Mutation-Testing-Projekt plmut:
- **Koordinaten:** wie in ALL_SOURCE, 1-basiert. Zeile 1 ist die Zeile mit dem Typ-Schlüsselwort (`package body …`), ohne `CREATE`.
- **Tests:** Pfade klein geschrieben (`owner.package.procedure`). Mögliche Status: passed, failed, error, skipped, excluded (schon ohne Instrumentierung rot), flaky (Ergebnis wechselt ohne Instrumentierung) und unknown.
- **Pro Objekt:**
  - `sourceSha256` (post-processed) und `rawSha256` (ALL_SOURCE roh)
  - `lines` (Treffer und Test-Indizes)
  - `branches` (mit Bereich der Bedingung)
  - `conditions` (Spaltenbereich, Tests getrennt nach WAHR, FALSCH und NULL)
  - `notMeasured`
- **Ergänzt von pltest** (optional, ältere Leser ignorieren es): `statements` mit Zeilen- und Spaltenbereich und Tests (die
  Mutation wählt damit Tests aus), bei `branches` die Konstrukt-ID und `nf`, bei `conditions` die Trefferzahlen und MC/DC,
  pro Objekt `metrics` mit den gemessenen Quoten.

## Robustheit: Korpus

`corpus/fetch.sh` lädt öffentlichen PL/SQL-Code auf festen Commits nach `corpus/.cache/`: utPLSQL 3.1.14, Logger, alexandria-plsql-utils
und pljson, dieselbe Auswahl wie bei plmut. Lizenzen bitte pro Datei prüfen, der Code wird nicht eingecheckt.

```bash
corpus/fetch.sh
npx pltest corpus corpus/.cache/*                        # offline: parsen, instrumentieren, Zeilenzahl prüfen
npx pltest corpus corpus/.cache/* --db corpus/db.json    # zusätzlich: instrumentiert kompiliert, wo das Original kompiliert
```

Stand: 747 Dateien, **280/280 Bodies** offline instrumentiert (0,6 s), darunter zwei Latin-1-Dateien. In der Datenbank kompilieren
**174/174** Bodies auch instrumentiert; das sind alle Bodies, deren Original im leeren Testschema kompiliert. Für Dateien gibt es einen
eigenen Präprozessor (`packages/core/src/preprocess.ts`), der wie plmut den letzten `$IF`-Zweig behält und den Rest durch Leerzeichen ersetzt. Im
Datenbank-Ablauf wird weiterhin `DBMS_PREPROCESSOR` verwendet. Der Korpus hat zwei Fehler gefunden (`if(`/`not(` direkt vor einer Klammer),
die jetzt als Tests abgesichert sind.

## Ablauf eines Laufs

1. Aufwärmlauf, dann Testlauf **ohne** Coverage (Referenz für Ergebnisse und Laufzeit)
2. Testlauf **mit** utPLSQL-Coverage (Zeilenquote zum Vergleich)
3. Quelltext über `DBMS_PREPROCESSOR` holen (bedingte Kompilierung ist aufgelöst), instrumentieren, mit den Originaleinstellungen kompilieren
   (`plsql_optimize_level`, `plsql_code_type`, `plsql_ccflags`, …). Kompiliert ein Objekt nicht, bleibt das Original aktiv.
4. Testlauf auf instrumentiertem Code, Sonden einsammeln
5. Original wiederherstellen (auch bei Fehlern, `finally`), ungültige Abhängigkeiten neu kompilieren
6. Testergebnisse aus 1 und 4 vergleichen, Bericht schreiben

## So sieht instrumentierter Code aus

```sql
-- Original
if p_vip and p_amount > 1000 then

-- Instrumentiert (gleiche Zeile, keine Zeilenumbrüche eingefügt)
cov$.s(1);if cov$.d(1,cov$.o(1) and (cov$.c(1,1,p_vip) and cov$.c(1,2,p_amount > 1000))) then
```

- `s` zählt Anweisungen, `o` / `d` öffnen und schließen eine Entscheidung (Wahrheitsvektor für MC/DC), `c` / `n` zeichnen eine Teilbedingung auf.
- **Kurzschluss bleibt exakt erhalten.** Oracle wertet Bedingungen in `IF`/`WHILE`/`WHEN` als Sprungcode aus: NULL bricht ein `AND` ab
  wie FALSCH. Die Sonden zeichnen den echten Wert (auch NULL) auf und geben ihn polaritätsgerecht zurück: `c` bildet NULL auf FALSCH ab,
  `n` (unter `NOT`) auf WAHR. Ohne diesen Schritt würden Funktionen mit Seiteneffekten öfter aufgerufen. Der Äquivalenztest
  (`packages/coverage/test/db.test.ts`) hat genau diesen Fehler gefunden.
- **SQL-Sonden (nur 23ai/26ai):** `CASE` in Select-Liste, `SET` und `VALUES` wird mit `BOOLEAN`-Sonden in SQL instrumentiert.
  Bedingungen in `WHERE`/`ON`/`HAVING` bewusst nicht, weil das den Ausführungsplan ändern würde. Bei `GROUP BY` ebenfalls nicht,
  weil die Ausdrücke identisch bleiben müssen.

## Technik und Performance

- **TypeScript passt.** Parsen und Instrumentieren der Demo dauert ~5 ms. Die Laufzeit entsteht ausschließlich in der Datenbank
  (Kompilieren ~50–120 ms, Testlauf). Die Sprache ist für die Performance nicht entscheidend.
- **Coverage pro Test** kostet zusätzlich etwa 50 % im Lasttest (103–133 ms statt 78–84 ms), weil pro Anweisung einmal `SYS_CONTEXT` gelesen wird.
- **Datenbank-Overhead:** Probes zählen nur in Package-Speicher (assoziative Arrays mit Ganzzahl-Schlüsseln). Geschrieben wird einmal am
  Ende per autonomer Transaktion. Im sondenreichsten Test (20 000 Aufrufe einer trivialen Funktion) liegt plcov bei 48–90 ms gegenüber
  6 ms ohne und 30–50 ms mit utPLSQL-eigener Coverage. Bei Code mit echtem SQL-Anteil fällt der relative Overhead deutlich kleiner aus.
- Laufzeit-Package `cov$` wird mit `plsql_optimize_level = 3` kompiliert, wenn erlaubt nativ.

## Tests

```bash
npm test                                                   # Parser, Instrumentierung, MC/DC (offline)
PLCOV_DB=demo/demo@localhost:1521/FREEPDB1 npm test        # zusätzlich Äquivalenztest gegen echte DB
npm run typecheck
```

## Mehrere Schemas

Mit `"schemas": ["APP_CORE", "APP_UTIL"]` misst ein Lauf die Objekte mehrerer Schemas. Die Laufzeit `cov$` und die
Treffertabelle bleiben im Schema des angemeldeten Benutzers (oder `runtimeSchema`); instrumentierter Code anderer Schemas
ruft sie qualifiziert auf (`benutzer.cov$`), und der Lauf vergibt `EXECUTE` auf `cov$` an diese Schemas. Kompiliert wird
im Schema des Objekts. Mindestrechte des angemeldeten Benutzers:

| Recht | Wofür |
|---|---|
| `CREATE ANY PROCEDURE` (`CREATE ANY TYPE`, `CREATE ANY TRIGGER` für Type Bodies und Trigger) | instrumentierten Code und das Original in fremden Schemas kompilieren |
| `EXECUTE ANY PROCEDURE` oder `EXECUTE` auf den Objekten | Quelltext in `ALL_SOURCE` sehen und die Tests ausführen lassen |
| eigene: `CREATE PROCEDURE`, `CREATE TABLE` | `cov$`, Treffertabelle, Wiederherstellungs-Journal |

Die Tests (`tests`) laufen mit den Rechten ihres Besitzers wie sonst auch. Ohne `schemas` gilt das bisherige Verhalten:
Laufzeit und Objekte liegen in `schema`.

## Grenzen

- Treffer aus anderen Sessions: Während des Messlaufs steht der Lauf in `plcov_runs`. Eine andere Session des
  Schema-Benutzers, die instrumentierten Code ausführt (ein Scheduler-Job, den ein Test startet), zählt unter dem Eintrag
  `#background` und schreibt ihre Treffer beim Abmelden (Trigger `cov$_logoff`, nur während des Laufs vorhanden, braucht
  `CREATE TRIGGER`) und alle 1000 Anweisungen. Der Lauf wartet bis zu einer Minute auf laufende Jobs. Sessions anderer
  Benutzer und Parallel-Query-Slaves, die weniger als 1000 Anweisungen ausführen, gehen weiterhin verloren.
- Nicht gemessen: dynamisches SQL (die Anweisung `EXECUTE IMMEDIATE` selbst zählt), mit `wrap` verschlüsselter Code und
  Trigger-`WHEN`-Klauseln (Oracle erlaubt dort keine PL/SQL-Aufrufe; ob der Rumpf lief, zeigt seine erste Anweisung). Der
  Bericht listet solche Stellen unter „Nicht gemessen“.
- Gemessen seit pltest: Compound-Trigger (jeder Zeitpunkt wie ein Block), einfache `CASE x WHEN …`-Ausdrücke (eine
  Zweigsonde vor jedem Ergebnis: `THEN CASE WHEN cov$.bt(id) THEN ergebnis END`; die Sonde liefert immer WAHR, Typ und
  Auswertungsreihenfolge bleiben) und die `WHEN`/`WHILE`-Filter von FOR-Schleifen (21c) als Entscheidungen.
- Der Parser (`@pltest/core`) liest Struktur, SQL und Ausdrücke; Unverstandenes wird als undurchsichtiger Bereich behandelt.
  Kann er die Struktur eines Objekts nicht verstehen, wird es übersprungen und im Bericht markiert.
- Rekursion innerhalb derselben Schleife zählt Iterationen ungenau (der Zähler gilt pro Schleife, nicht pro Aufruf: ein
  rekursiver Aufruf im Rumpf schließt den äußeren Zählerstand ab). Schleifenmetriken sind eine Näherung. Bei einer
  expliziten Cursor-Schleife (`LOOP FETCH …; EXIT WHEN c%NOTFOUND; …`) zählt jeder Eintritt in den Rumpf, auch der, der
  gleich beim ersten `EXIT` endet: „einmal“ heißt dort „keine Zeile“.
- Funktionen mit `RESULT_CACHE` (und Ergebnisse, die Oracle für `DETERMINISTIC`-Funktionen innerhalb einer Anweisung
  wiederverwendet): Kommt das Ergebnis aus dem Cache, laufen ihre Sonden nicht; die Treffer fallen zu niedrig aus.
- Ruft ein Test `DBMS_SESSION.RESET_PACKAGE` auf, sind die bis dahin gesammelten Treffer weg; der Lauf warnt dann.
- CASE-Ausdrücke in Bedingungen und in Schleifengrenzen werden nicht gemessen (Eintrag unter „Nicht gemessen“).
