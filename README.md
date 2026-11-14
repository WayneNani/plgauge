# pltest – Coverage und Mutation Testing für PL/SQL

Ein Repository für zwei Werkzeuge, die auf denselben Kern bauen und getrennt aufrufbar bleiben:

- **Coverage** (`pltest coverage`): Anweisungen, Branches, Teilbedingungen, MC/DC und Schleifen durch
  Instrumentierung des Quelltexts, gemessen mit den vorhandenen utPLSQL-Tests. Vormals plcov,
  Dokumentation in [`packages/coverage/README.md`](packages/coverage/README.md).
- **Mutation Testing** (`pltest mutate`): Mutanten-Schema, Aufzeichnung pro Test, Orakel-Modus, Worker.
  Vormals plmut (Go), nach TypeScript portiert; Dokumentation in
  [`packages/mutation/README.md`](packages/mutation/README.md).

Umsetzungsplan: Claude Doc „PL/SQL-Testwerkzeuge – Umsetzungsplan für das gemeinsame Repository“.

## Aufbau

| Paket | Inhalt |
| --- | --- |
| `packages/core` | Lexer, Präprozessor, Skripte, Datenbank (Objekte laden, kompilieren, wiederherstellen), Wiederherstellungs-Journal, utPLSQL-Lauf |
| `packages/coverage` | Instrumentierung, Laufzeitpaket `cov$`, Metriken und MC/DC, Export `plcov-coverage/1`, Korpus-Prüfung |
| `packages/mutation` | Mutation Testing: Stellen-Finder auf dem Kernparser, Schema- und Orakel-Umschreiber, Lauf, Berichte |
| `packages/report` | HTML-Bericht |
| `packages/cli` | Befehl `pltest` |
| `examples/` | `order_pricing` (Coverage-Demo), `shop_pricing` (Mutation, mit `expected.tsv`) |
| `eval/` | Auswertungen auf fremdem Code: pljson, console (A11), plscope-utils (A10) |
| `baseline/` | Ergebnisse der alten Fassungen für Paritätsprüfungen |

## Voraussetzungen und Befehle

Node.js 26 (LTS), eine Oracle-Datenbank 23ai/26ai (Coverage ab 19c) mit utPLSQL ≥ 3.2.2.

```bash
npm install
npm test                      # offline; mit PLCOV_DB=user/pw@host:port/service auch gegen die Datenbank
npm run typecheck
npx pltest coverage --config examples/order_pricing/plcov.json --out report
npx pltest restore --config examples/order_pricing/plcov.json --list
export PLMUT_DB=oracle://user:pw@host:port/service
npx pltest mutate run examples/shop_pricing --json run.json
npx pltest coverage examples/shop_pricing --out cov          # Coverage eines Projekts, ohne plcov.json
npx pltest report cov/coverage.json --mutation run.json      # gemeinsamer Bericht
npx pltest crosscheck --coverage cov/plcov-coverage.json --mutation run.json
npm run parity:finder && npm run parity:coverage             # Abgleich mit den alten Fassungen (Korpus nötig)
```

Ein Projekt ist ein Verzeichnis mit `pltest.json` (früher `plmut.json`): Installationsskripte, die
Dateien, deren Einheiten gemessen und mutiert werden, und die utPLSQL-Tests. Beide Werkzeuge lesen
dieselbe Datei; `pltest coverage <projekt>` misst genau diese Einheiten.

## Ein Parser für beide Werkzeuge

`packages/core/src/parser.ts` liest Einheiten, Deklarationen, Anweisungen, eingebettetes SQL und
Ausdrücke mit Oracles Rangfolge. Coverage setzt darauf ihre Sonden, Mutation ihre Mutanten. Was
der Parser nicht versteht, wird als undurchsichtiger Bereich behandelt: Er kostet die Messstellen
darin, erzeugt aber nie falsche. Abgleich mit den alten Fassungen: `baseline/plmut/PARITY.md`.

## Stand

Alle Phasen des Umsetzungsplans sind abgeschlossen, dazu aus der Ausbaustufe: CI-Formate und Schwellen mit Vorlagen
(A1, A2), größerer Korpus mit 898 Bodies (A5), Compound-Trigger, einfache CASE-Ausdrücke und FOR-Filter (A6),
Diff-Modus (A7), Treffer aus Scheduler-Jobs (A8), unzuverlässige Tests in der Coverage (A9) und mehrere Schemas (A4).
Dazu SQL-Operatoren als Stufe 2 der Mutation (A10: DISTINCT, Joins, ORDER BY, Mengenoperatoren, Aggregate,
Unterabfragen, WHERE, DML-Spalten). Zurückgestellt: die Versionsmatrix mit 19c (A3). Auswertungen an echtem Code:
`eval/console/EVAL.md` (A11) und `eval/plscope-utils/EVAL.md` (A10).

## Wiederherstellungs-Journal

Bevor pltest ein Objekt instrumentiert oder mutiert, sichert es den Originalquelltext und die
Compiler-Einstellungen in der Tabelle `pltest_journal` und schreibt den Eintrag sofort fest. Nach
dem Wiederherstellen wird der Eintrag gelöscht. Bricht ein Lauf hart ab, setzt
`pltest restore` alle Objekte aus dem Journal zurück; `--list` zeigt sie nur an.
