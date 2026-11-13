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
