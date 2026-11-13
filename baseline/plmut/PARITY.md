# Parität der TypeScript-Mutation mit Go-plmut (`9bf5d68`)

Stand 13.11.2026, Oracle 23.26.1 Free, utPLSQL 3.2.2.

| Vergleich | Ergebnis |
| --- | --- |
| Mutanten des Beispiels (`mutate points`) | identisch, einschließlich Nummern (75) |
| Schema-Text des Beispiels (`mutate schema`) | identisch bis auf das fehlende `CREATE OR REPLACE` |
| Beispiel, naiver Modus | 75/75 Urteile gleich; alle wie `expected.tsv` |
| Beispiel, Schema-Modus | 75/75 Urteile gleich; alle wie `expected.tsv` |
| pljson, Schema-Modus, drei Datenbanken | 2 658/2 664 gleich, Score 48,3 % (Go 48,2 %), 314 s (Go 290 s) |

Die sechs Abweichungen auf pljson gehen auf die Tests zurück, nicht auf die Portierung: Die
Parser-Suite setzt in `beforeall` die Paketvariable `pljson_parser.json_strict := true` und setzt sie
nicht zurück. Laufen ihre Tests im selben `ut_runner.run` vor `utplsql_pljson_ext_test.test_date_1`,
übersieht dieser Test die Mutanten an `json_strict` (Zeilen 312, 506, 511, 521). Welche Tests sich
einen Aufruf teilen, hängt von den gemessenen Laufzeiten ab; deshalb schwankt das Urteil in beiden
Fassungen. Zwei der sechs Fälle sind in beiden erkannt (Timeout gegen getötet).

Dateien: `example-*.json`, `pljson-schema.json` (Go-Ausgaben); Vergleich mit `pltest mutate compare`.

## Phase 3 und 4: eigener Parser statt Java-Finder

Stand 13.11.2026. Der Finder (`packages/mutation/src/find.ts`) arbeitet auf dem Syntaxbaum des
Kernparsers. Referenz ist die eingefrorene Ausgabe des Java-Finders auf dem Korpus
(`finder-corpus.json.gz`, 790 Dateien inklusive console); Vergleich mit `npm run parity:finder`.

| Vergleich | Ergebnis |
| --- | --- |
| Stellen des Java-Finders, die der neue Finder genauso findet | 33 202 von 33 219 (Position, Operator, Ersatztexte gleich; 4 375 davon jetzt mit Unterprogrammnamen) |
| nur Java (17) | 8 Stellen in anonymen Blöcken außerhalb jeder Einheit, 7 LCR und 1 ROR aus IslandSQL-Fehllesungen (`0 and 255` aus BETWEEN, `$if`-Bedingung), 1 SBR aus einem falsch gelesenen q-String |
| nur neu (1 540) | 888 RET in Type-Methoden und eigenständigen Prozeduren/Funktionen, 338 SBR für `SELECT … INTO`, 289 LCR/NUL, die IslandSQL bei `IS NULL`, `BETWEEN`, `IS OF`, `LIKE … ESCAPE` falsch schachtelte, 18 `assert(…)`-Aufrufe, 7 nach falsch gelesenem q-String |
| Beispielprojekt | 48 Stellen, alle identisch; 75/75 Urteile in beiden Modi wie `expected.tsv` |
| pljson, Schema-Modus, drei Datenbanken | alle 2 664 Go-Mutanten wieder vorhanden, 2 657 Urteile gleich; dazu 391 neue Mutanten; 332 s (`pljson-schema-ts.json`) |

Die sieben pljson-Abweichungen: vier sind der bekannte `json_strict`-Zustand (siehe oben), drei
sind in beiden Läufen erkannt (Timeout durch Schleifenwächter gegen getötet).

Coverage auf demselben Parser: Für alle 295 Bodies des Korpus sind instrumentierter Text und
Sondenkarte identisch mit dem Token-Parser von plcov (`baseline/plcov/corpus-instrumented.tsv`,
`npm run parity:coverage`); die Korpuszahlen bleiben 280/280, 25 496 Anweisungen, 2 891
Entscheidungen, 3 383 Teilbedingungen.
