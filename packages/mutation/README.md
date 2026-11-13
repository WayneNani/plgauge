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
