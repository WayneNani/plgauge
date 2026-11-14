# SQL-Operatoren (A10): Auswertung an plscope-utils

Stand 14.11.2026. Stufe 2 der Mutationsoperatoren wirkt auf statisches SQL. Geprüft wurde sie an
[plscope-utils](https://github.com/PhilippSalvisberg/plscope-utils) (`dc22daf`), einem gepflegten Projekt mit viel SQL auf
dem Data Dictionary und echten utPLSQL-Tests, dazu mit einem Kompiliertest auf dem SQL von utPLSQL.

Ergebnis: **Die 30 SQL-Mutanten in plscope-utils zeigen 7 echte Testlücken, und keiner ist äquivalent.** Im Korpus
kompilieren 1 190 von 1 193 SQL-Mutanten beider Stufen. Der Lauf hat vor allem das Werkzeug verbessert: Schalter in SQL
zerstörten Ausführungspläne, PL/Scope-Daten gingen verloren, und Tests mit DDL scheiterten an fehlenden Rollen. Alle drei
Fehler sind behoben (siehe unten).

## Operatoren

| Operator | Mutation |
| --- | --- |
| SEL | `DISTINCT`/`UNIQUE` entfernt; `FETCH FIRST …` entfernt |
| JOI | `LEFT`/`RIGHT`/`FULL JOIN` → `JOIN`; `[INNER] JOIN` → `LEFT JOIN`; `(+)` entfernt |
| ORD | `ORDER BY`: alle Elemente `ASC` ↔ `DESC`, ein Mutant pro Liste |
| UNI | `UNION` ↔ `UNION ALL`; `INTERSECT` ↔ `MINUS` |
| AGR | `MIN` ↔ `MAX`; `SUM` ↔ `AVG`; `COUNT(DISTINCT x)` → `COUNT(x)`; `COUNT(x)` → `COUNT(*)` |
| SUB | `EXISTS` ↔ `NOT EXISTS`; `IN (Unterabfrage)` ↔ `NOT IN` |
| WHR | Bedingung von `WHERE`/`HAVING` → `TRUE` |
| COL | `UPDATE … SET`: eine Zuweisung weg; `INSERT (Spalten) VALUES (…)`: eine Spalte samt Wert weg |

Grundlage sind die SQL-Operatoren von Tuya, Suárez-Cabal und de la Riva (2007). Ausgewählt wurden nur Varianten, die
selten äquivalent sind; die Regeln zum Auslassen stehen in `packages/mutation/README.md`.

## Lauf

| | |
| --- | --- |
| Code | 7 Package Bodies (5 Werkzeuge, 2 Demo-Pakete), rund 1 100 Zeilen |
| Tests | 36 utPLSQL-Tests; 1 ausgeschlossen (prüft die PL/Scope-Daten des Codes selbst, also auch die des mutierten Schemas) |
| Datenbank | Oracle 23.26.1 Free, utPLSQL 3.2.2, drei Worker |
| Laufzeit | 208 s für 504 Mutanten (Baseline 3,9 s); 194 Mutanten in Cursor-Deklarationen einzeln kompiliert |
| Mutation Score | **62,1 %**: 313 erkannt, 169 überlebt, 22 von keinem Test erreicht |

| Teil | Mutanten | erkannt | überlebt | nicht erreicht | Score |
| --- | --- | --- | --- | --- | --- |
| Stufe 2 (SQL-Operatoren) | 30 | 23 | 7 | 0 | 76,7 % |
| Stufe 1 in SQL | 200 | 103 | 97 | 0 | 51,5 % |
| Stufe 1 in PL/SQL | 274 | 187 | 65 | 22 | 68,2 % |

| Operator | Mutanten | erkannt | überlebt |
| --- | --- | --- | --- |
| AGR | 2 | 2 | 0 |
| COL | 6 | 6 | 0 |
| JOI | 3 | 2 (1 durch Zeitgrenze) | 1 |
| ORD | 5 | 1 | 4 |
| SEL | 3 | 3 | 0 |
| WHR | 11 | 9 (1 durch Zeitgrenze) | 2 |

UNI und SUB kommen in plscope-utils nicht vor; sie sind durch die Kompiliertests unten und die Unit-Tests abgedeckt.

## Alle 7 Überlebenden eingeordnet

Jede Zeile mit Begründung in [`survivors-sql.tsv`](survivors-sql.tsv).

| Klasse | Anzahl | Beispiel |
| --- | --- | --- |
| Fall fehlt | 4 | Synonym auf ein fehlendes Objekt; Name, der zu mehreren Objekttypen gehört (dann entscheidet die Reihenfolge); nur eine Materialized View in der Datenbank; kein Testdatensatz vor der Datumsgrenze |
| Reihenfolge ungeprüft | 3 | `dedup` sortiert, die Tests prüfen die Reihenfolge nicht |
| äquivalent | 0 | |

Die 4 fehlenden Fälle sind dieselbe Art Fund wie die wertvollsten 18 % bei console: Grenzen und Sonderfälle der Daten,
die Stufe 1 nicht sichtbar macht. Bei Stufe 1 liegt der Score in SQL mit 51,5 % deutlich unter dem in PL/SQL. Viele
Bedingungen auf dem Dictionary (Eigentümer, Typ, Name) prüfen die Tests nur mit eindeutigen Namen.

## Was der Lauf am Werkzeug verbessert hat

- **Schalter in SQL zerstören Ausführungspläne.** Stufe 1 schaltete Mutanten in SQL per `CASE` im Ausdruck. Um eine
  Join-Bedingung herum nimmt das dem Optimizer den Join: Eine Abfrage über zwei `DBA_IDENTIFIERS` lief minutenlang statt
  in Millisekunden, und der Lauf blieb in der Baseline hängen. Jetzt steht die PL/SQL-Anweisung einmal pro Variante im
  Schema (`IF aktiv = id THEN <Variante> ELSIF … ELSE <Original> END IF;`). Das Original bleibt unverändert und behält
  seinen Plan. Das gilt für beide Stufen; SQL in Cursor-Deklarationen wird einzeln kompiliert.
- **PL/Scope-Einstellung beim Neukompilieren.** Mutierte und wiederhergestellte Einheiten wurden ohne ihre
  `PLSCOPE_SETTINGS` übersetzt, ihre PL/Scope-Daten verschwanden, und 3 Tests scheiterten. Jetzt übernimmt der Kern die
  Einstellung wie schon Optimierungsstufe und `PLSQL_CCFLAGS`.
- **Rollen im Testlauf.** Der Testläufer `plmut_rt` hatte Definer-Rechte, darin sind Rollen abgeschaltet. 7 Tests, deren
  Setup per DDL eine Prozedur anlegt (`CREATE PROCEDURE` über die Rolle RESOURCE), scheiterten mit ORA-01031, direkt mit
  `ut.run` dagegen nicht. `plmut_rt` hat jetzt Invoker-Rechte.
- **Zwei Regeln gegen Äquivalente**, beide aus diesem Lauf. Ein innerer Join wird nicht zu `LEFT JOIN`, wenn `WHERE` eine
  Spalte der verbundenen Tabelle vergleicht (die Nullzeilen fallen sowieso weg). `ORDER BY` wird als Ganzes umgedreht
  statt pro Element. Pro Element war ein konstanter erster Schlüssel äquivalent, und von 22 Überlebenden kamen 15 aus
  einem einzigen Muster.

## Gegenprobe an console

Die neue Schaltung von SQL betrifft auch Stufe 1. console wurde deshalb vor und nach der Änderung gelaufen (1 630
gemeinsame Mutanten), dazu ein zweites Mal auf identischem Code, um das Rauschen zu messen:

| Vergleich | abweichende Urteile in PL/SQL | in SQL |
| --- | --- | --- |
| vorher gegen nachher | 46 | 25 |
| nachher gegen nachher (gleicher Code) | 37 | 4 |

Die Abweichungen in PL/SQL sind Rauschen in derselben Größe wie zwischen zwei gleichen Läufen. console schreibt
Konfiguration fest, und welche Tests einen Mutanten zuerst prüfen, ändert das Ergebnis der Konfigurationstests. In SQL
sind 20 der 25 Abweichungen die erwartete Folge der Einzelkompilierung: Mutanten einer nie geöffneten
Cursor-Deklaration erscheinen als überlebt statt als nicht erreicht. Score vorher 63,0 %, nachher 63,8 % und 63,9 %;
die 6 neuen Mutanten der Stufe 2: 4 erkannt, 2 überlebt.

## Kompiliertest

`scripts/sql-compile-check.ts` kompiliert jede Einheit mit SQL-Mutanten erst im Original. Kompiliert sie, werden
danach jeder Mutant einzeln und alle zusammen als Schema übersetzt, mit Zuordnung der Fehler wie in einem echten Lauf.

| Korpus | Einheiten | SQL-Mutanten | einzeln kompiliert | Schema: geschaltet / verworfen / ohne Zuordnung |
| --- | --- | --- | --- | --- |
| utPLSQL 3.2.2 (`source`, in eigenem Schema installiert), beide Stufen | 19 | 1 193 | 1 190 | 1 142 / 3 / 0, mit Cursorn und Schleifen (Nachtrag 2) 1 175 / 3 / 0 |
| übriger Korpus (nur Stufe 2, nur Einheiten ohne fehlende Objekte) | 18 | 111 | 111 | 72 / 0 / 0 |
| Views von plscope-utils ohne `plscope_col_usage`, beide Stufen | 6 | 1 007 | 1 007 | 748 / 0 / 0 |

Die 3 Fehler gehören zu Stufe 1 und gab es schon vorher; im Lauf werden sie als nicht kompilierbar verworfen. Es sind
`FALSE` für die Bedingung mit dem Bulk-Bind eines `FORALL` (PLS-00435) und zwei LCR-Vergleiche `(a) = (b)` auf
Bedingungen, die Oracle in SQL nicht vergleicht (ORA-00932). Der erste Kompiliertest hatte 2 Fehler in Stufe 2 gezeigt,
`WHR` in `FORALL` und `UNION ALL` → `UNION` in rekursivem `WITH` (ORA-32040). Beide werden jetzt ausgelassen.

## Wie viel SQL gibt es zu mutieren?

Anteil der Mutanten der Stufe 2 an allen Mutanten, pro Projekt im Korpus:

| Projekt | Mutanten | Stufe 1 in SQL | Stufe 2 | Anteil |
| --- | --- | --- | --- | --- |
| plscope-utils | 860 | 250 | 77 | 9,0 % |
| oracle-db-examples | 17 311 | 2 338 | 434 | 2,5 % |
| utPLSQL 3.2.2 | 21 283 | 2 081 | 478 | 2,2 % |
| logger | 1 139 | 172 | 21 | 1,8 % |
| console | 4 052 | 207 | 49 | 1,2 % |
| plex | 3 084 | 80 | 26 | 0,8 % |
| oos-utils | 5 605 | 261 | 27 | 0,5 % |
| alexandria | 13 895 | 248 | 33 | 0,2 % |
| pljson | 6 376 | 7 | 9 | 0,1 % |

(Ganze Repositories einschließlich Tests und Beispielen; der Lauf oben mutiert nur die 7 Pakete.) In öffentlichem Code
liegt viel SQL in Views und in dynamischem SQL (Zeichenketten), beides erreicht der Finder nicht. Code, der
Geschäftslogik in statischem SQL hält, hat einen höheren Anteil. Dort lohnt Stufe 2 am meisten.

## Grenzen

- **Cursor-Deklarationen** lassen sich im Schema nicht verdoppeln; ihre Mutanten werden einzeln kompiliert (hier 194 von
  504). Das kostet Laufzeit und die Angabe „nicht erreicht“: Ohne Aufzeichnung erscheint ein Mutant, den kein Test
  erreicht, als überlebt (in console 20 Mutanten einer Cursor-Deklaration).
- **Zeitgrenze als Urteil:** Fällt ein Filter auf einer Dictionary-Abfrage weg, explodiert das Ergebnis. 2 SQL-Mutanten
  enden so; sie zählen wie in Stufe 1 als erkannt.
- **Views** mutiert das Werkzeug seit dem Nachtrag unten; dort stehen auch ihre eigenen Grenzen.

## Nachtrag: Views

In plscope-utils stehen mehr SQL-Zeilen in den 7 Views (1 411) als in den 7 Package Bodies (908). Seit dem Nachtrag
mutiert das Werkzeug auch `CREATE VIEW`, mit beiden Stufen (Umschaltung: `packages/mutation/README.md`). Die Views
kommen per Glob in `pltest.json` dazu.

| | |
| --- | --- |
| Mutanten | 1 634 (504 in den Packages wie oben, 1 130 in den Views; 677 davon in Select-Listen, an Ort und Stelle geschaltet) |
| Laufzeit | 611 s mit drei Workern, Baseline 1,4 s mit 35 Tests (wie oben: nur der PL/Scope-Modelltest fehlt) |
| Schema | 2 Runden, 0 Mutanten verworfen; 382 Stellen einzeln kompiliert (Cursor-Deklarationen, Views über der Zweig-Grenze und die zwei Views unten) |

| Teil | Mutanten | erkannt | überlebt | nicht erreicht | Score |
| --- | --- | --- | --- | --- | --- |
| Packages, PL/SQL | 274 | 187 | 65 | 22 | 68,2 % |
| Packages, SQL | 230 | 127 | 103 | 0 | 55,2 % |
| `plscope_identifiers` | 408 | 72 | 336 | 0 | 17,6 % |
| `source_view` (Demo) | 12 | 9 | 3 | 0 | 75,0 % |
| 5 Views ohne Test (`plscope_naming`, `_col_usage`, `_tab_usage`, `_statements`, `_ins_lineage`) | 710 | 0 | 0 | 710 | – |

Die Packages haben dieselben Urteile wie ohne Views (68,2 % und 54,8 % oben, ein Mutant Unterschied). Kein Test fragt
5 der 7 Views ab. Das zeigt der Aufzeichnungslauf, der auch in Views notiert, welcher Test welchen Block erreicht.
`plscope_identifiers` prüfen 2 Tests direkt (der dritte ist ausgeschlossen, s. o.), dazu Tests von `dd_util`. Sie vergleichen nur wenige Spalten. Deshalb überleben dort 336
Mutanten, die meisten in den Ausdrücken, aus denen die View Pfade, Namen und Ebenen berechnet.

Die 13 überlebenden SQL-Mutanten (Stufe 2) in getesteten Views, vorläufig eingeordnet:

| Klasse | Anzahl | Beispiel |
| --- | --- | --- |
| Fall fehlt | 12 | Filter `owner like coalesce(sys_context('PLSCOPE', 'OWNER'), user)` entfällt (kein zweites Schema im Test); Outer Join ohne Partnerzeile (3); `ORDER BY` in analytischen Funktionen, die nur kaputte Hierarchien reparieren (4); berechnete Spalten `count(…) over`, `max(line) over`, die kein Test vergleicht (2); kein Datensatz vor der Datumsgrenze in `source_view` |
| äquivalent | 1 | `UNION ALL` → `UNION` zwischen PL/SQL- und SQL-Bezeichnern: die Zweige sind über `is_sql_stmt` disjunkt, die Zeilen über `usage_id` eindeutig |

**Gegenprobe der Umschaltung:** In einem Lauf ohne die Zuordnung unten lief `plscope_identifiers` im Schema (259
Mutanten geschaltet, 149 einzeln), in einem zweiten vollständig einzeln. Alle 408 Urteile stimmen überein (71 erkannt,
337 überlebt).

Was die Views am Werkzeug gezeigt haben:

- **Zweige sind teuer, aber anders als gedacht.** Mit 116 `UNION ALL`-Zweigen brauchte `CREATE VIEW` für
  `plscope_col_usage` Minuten. `EXPLAIN PLAN` zeigte: Das Planen selbst ist billig (0,4 s ohne, 0,8 s mit 10
  Zweigen), teuer ist die Ausführung. Oracle materialisiert `WITH`-Klauseln, die die Kopien mehrfach referenzieren,
  und zieht sie vor alle Zweige. Sie laufen also bei jeder Abfrage, auch für abgeschaltete Zweige (120 statt 13
  `LOAD AS SELECT`). Abhilfe: `/*+ INLINE */` für `WITH`-Elemente, die das Original einmal referenziert (damit gleicht
  der Plan ohne Zweige dem Original), und höchstens 20 Zweige pro View. Die übrigen Stellen laufen einzeln, aber nur
  gegen die Tests, die ihren Block erreichen.
- **Rekursive `WITH`-Elemente** lassen sich nicht einpacken (ORA-32040). Ihre Stellen laufen einzeln, ihre Testauswahl
  kommt vom Hauptblock der View.
- **Tests, die den Text einer View lesen,** sahen die Kopien. `test_get_view_source` liest `PLSCOPE_IDENTIFIERS` in eine
  Variable (zu lang: ORA-06502), drei Lineage-Tests zählen die Spalten von `SOURCE_VIEW` doppelt. Ohne Gegenmaßnahme
  fehlten diese 4 Tests allen Mutanten (Packages 49 % statt 68 %). Jetzt sucht der Lauf die View, an der es liegt, und
  lässt sie im Original.

Grenzen bei Views:

- **Zweig-Grenze:** Views mit vielen Bedingungen über Dictionary-Views laufen großteils einzeln, die Laufzeit steigt.
- **Views, die ihr eigener Code liest,** laufen ganz einzeln und mit allen Tests (hier 420 Mutanten).
- **Planvergleich** (seit Nachtrag 2): Ändern die Kopien den Plan einer View, laufen ihre Mutanten einzeln. Bei
  plscope-utils trifft das alle Views mit Zweigen; der Gewinn der Zweige bleibt dort aus.

## Nachtrag 2: Cursor, dynamisches SQL, Gegenprobe, Planvergleich

Vier Erweiterungen, geprüft an plscope-utils (Packages und Views wie oben):

1. **Cursor schaltbar.** Die Abfrage einer Cursor-Deklaration ohne `ORDER BY`, `FOR UPDATE` und `WITH` wird wie ein
   View-Block mit `UNION ALL`-Zweigen geschaltet. Eine Cursor-FOR-Schleife über eine Abfrage wird samt Rumpf pro
   Variante verdoppelt. Im Korpus fallen die SQL-Mutanten in Packages, die nicht geschaltet werden konnten, von 1 610
   auf 298, vor allem sortierte Cursor. In plscope-utils sind es 76 statt 194.
2. **Dynamisches SQL.** Literale, die `EXECUTE IMMEDIATE`, `OPEN … FOR` oder `DBMS_SQL.PARSE` erreichen, werden als
   SQL mutiert. In plscope-utils ist das ein Literal in `etl.load_from_dyn_sql` mit 12 Mutanten. 9 werden erkannt; die 3 überlebenden betreffen die Datumsgrenze `hiredate > date '1980-01-01'`, vor der kein Testdatensatz liegt (dieselbe Lücke wie bei den statischen Varianten).
   Im Korpus sind es 56 Literale mit 1 493 Mutanten, fast alle in Testpaketen.
3. **Gegenprobe.** Erkannte Mutanten laufen mit dem erkennenden Test allein noch einmal. Nach Mutanten, unter denen
   committende Tests liefen, schreiben diese Tests ihre Daten auf dem Original neu.
4. **Planvergleich** für Views mit `EXPLAIN PLAN` vor und nach dem Schalten.

| | Lauf 11 (vorher) | Lauf 16 (nachher) |
| --- | --- | --- |
| Mutanten | 1 634 | 1 646 (12 aus dynamischem SQL) |
| Baseline mit Schema | 1,5 s | 1,8 s |
| Laufzeit, drei Worker | 611 s | 1 035 s (Views laufen einzeln, siehe Planvergleich) |
| Packages, PL/SQL: erkannt / überlebt / nicht erreicht / Zeit | 187 / 64 / 22 / 1 | 179 / 72 / 22 / 1 |
| Packages, SQL: erkannt / überlebt / Zeit | 116 / 104 / 10 | 126 / 107 / 9 |
| Urteile mit Vermerk der Gegenprobe | – | 7 |

**Gegencheck der Cursor-Schaltung:** Die Packages liefen zusätzlich vollständig einzeln (Orakel-Modus). 509 von 516
Urteilen stimmen überein. Die 7 Abweichungen: 2 Mutanten in `example`, die nur der PL/Scope-Modelltest erreicht (im
Orakel-Lauf bestand er die Baseline, im Schema-Lauf nicht); 3 Zeitüberschreitungen, die im anderen Lauf als
Fehlschlag endeten; 1 Verbindungsabbruch; 1 ROR in `lineage_util` (Zeile 283), dessen Ergebnis schwankt.

**Was die Gegenprobe fand:**

- Die drei Urteile, die zwischen Lauf 10 und 11 kippten, haben verschiedene Ursachen. `etl` Zeile 140 (`RETURN;` vor
  dem Laden) überlebt nur, wenn `deptsal` noch korrekte Daten eines früheren Tests enthält. Die Tests committen, also
  hing das Urteil vom vorigen Mutanten ab. Mit dem Zurückschreiben der Daten überlebt der Mutant jetzt immer. Das ist
  eine echte Lücke: Der Test prüft Daten, die er nicht selbst erzeugt haben muss. `dd_util` Zeile 19
  (`o.owner <= s.table_owner`) holt die erste Zeile eines Cursors ohne `ORDER BY`. Welche das ist, hängt von Plan und
  Datenbank ab. Dasselbe gilt für die anderen Mutanten, die die Join-Bedingung dieses Cursors abschwächen: Sie kippen
von Lauf zu Lauf, je nach Worker. Im Schema-Modus markiert die Gegenprobe ihre Erkennungen jedes Mal als nicht
wiederholbar, weil sie auf einem anderen Worker prüft; im Orakel-Modus prüft sie auf demselben und kann das nicht. Der dritte Fall (`LCR` in
  `plscope_identifiers`) ist eine knappe Zeitüberschreitung; mit doppelter Zeit endet sie als Fehlschlag.
- `plscope_context.set_attr` (2 Mutanten): `test_set_attr` erkennt sie im Verbund, allein nicht. Der Test liest einen
  Kontextwert, den ein vorheriger Test gesetzt hat.
- **Eine verdorbene Worker-Datenbank.** In einem Lauf waren 489 Erkennungen nicht wiederholbar, alle auf Worker 3
  entstanden. Dort hatte ein Messskript (nicht das Werkzeug) Packages ohne ihre PL/Scope-Einstellungen neu
  kompiliert. Damit fehlte die Anweisung in `USER_STATEMENTS`, die `test_get_dep_cols_from_insert` liest. Ohne
  Gegenprobe wären das 489 falsche Erkennungen gewesen (Score 52 % statt 24 %).

Das Zurückschreiben kostet zunächst viel: Alle Tests erneut nach jedem Mutanten, unter dem committet wurde, waren
1 468 zusätzliche Testläufe. Die Baseline ermittelt deshalb, welche Tests selbst committen (hier 17, die meisten über
DDL). Nur diese laufen erneut, im Orakel-Modus nur bei ausgewählten Tests. Das sind noch 271 Läufe. Die Gegenprobe
über einen anderen Worker kostete im Orakel-Modus mehr als der Lauf selbst, weil jeder Mutant dort neu kompiliert
werden muss. Sie geschieht dort jetzt gleich nach dem Urteil auf demselben Worker.

**Was der Planvergleich fand:** Alle fünf Views, die das Schema mit Zweigen versah, hatten danach einen anderen Plan
als das Original:

| View | Abweichung mit Zweigen | nur mit Aufzeichnungs-Wrapper |
| --- | --- | --- |
| `plscope_tab_usage` | 104 Lesezugriffe auf materialisierte Temp-Tabellen | anderer Join (Merge statt Hash) |
| `plscope_col_usage` | 125 zusätzliche `WINDOW SORT` | anderer Join |
| `plscope_statements` | 16 zusätzliche `WINDOW SORT` | ein `WINDOW SORT` mehr |
| `plscope_naming` | andere Joins, 7 weitere Scans | gleich |
| `plscope_ins_lineage` | `WITH` materialisiert | gleich |

Der Grund ist meist, dass Oracle den Filter eines Zweigs nicht als Startfilter vor den Zweig setzt, sondern auf die
Zeilen einer View über analytischen Funktionen. Dann rechnet die Abfrage jeden toten Zweig mit. Das erklärt die
frühere Messung, nach der eine View mit 20 Zweigen 131 s statt 9 s brauchte. Die Annahme „ein Filter auf eine
Konstante schneidet tote Zweige ab“ gilt also nicht allgemein. Der Planvergleich fängt das ab. Die Mutanten dieser
Views laufen einzeln, `plscope_naming` und `plscope_ins_lineage` behalten den Aufzeichnungs-Wrapper (ihre 497
Mutanten bleiben „nicht erreicht“), die anderen drei laufen im Original. Ihre 213 Mutanten fragt kein Test ab, sie
erscheinen aber als überlebt, weil ohne Aufzeichnung alle Tests laufen.

Zwei weitere Fehler zeigten sich erst in den Läufen. Erstens: Mit 20 Zweigen sprengte schon das `EXPLAIN PLAN` von
`plscope_col_usage` den Cursor-Heap des Servers (ORA-00600 `KGL-heap-size-exceeded`). Der Prozess starb und mit ihm
die Verbindung, über die der Lauf seinen Code verwaltet. `EXPLAIN PLAN` hat jetzt eine eigene Verbindung. Zweitens
blieben nach diesem Absturz geschaltete Packages zurück. Der nächste Lauf las sie als Original und spielte am Ende
genau diesen Code zurück; die richtigen Originale im Journal löschte er dabei. Jetzt stellt jeder Lauf beim Start
zuerst wieder her, was ein abgebrochener Lauf im Journal hinterlassen hat.

Die Cursor-Zweige in Packages prüft kein Planvergleich: Ihre Abfragen enthalten PL/SQL-Variablen, `EXPLAIN PLAN`
kann sie so nicht erklären. Gemessen wurde die Laufzeit. Das erste Ausführen parst alle Kopien (`dd_util`: 3,6 s
statt 0,3 s), danach laufen die Tests so schnell wie im Original. Ohne Aufwärmlauf ging das in die Baseline ein, und
die Zeitgrenze stieg von 9 auf 53 s.

## Wiederholen

```bash
corpus/fetch.sh                                  # plscope-utils nach corpus/.cache
# Installation pro Datenbank: eval/plscope-utils/README.md
PLMUT_DB=oracle://plscope_eval:…@…/FREEPDB1,… npx pltest mutate run eval/plscope-utils --json run.json --report run.html
npx tsx scripts/eval-summary.ts run.json survivors.tsv
npx tsx scripts/sql-compile-check.ts db.json corpus/.cache/utplsql-3.2.2/source   # db.json: {user, password, connectString}
```
