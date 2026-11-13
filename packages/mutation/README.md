# @pltest/mutation – Mutation Testing für PL/SQL (vormals plmut)

Portierung von plmut (Go) nach TypeScript. Abgeglichen gegen die Go-Fassung auf Stand `9bf5d68`
(Daten in `baseline/plmut/`): Beispielprojekt in beiden Modi und pljson-Volllauf.

## Ablauf

1. **Stellen finden:** Bis Phase 4 des Umsetzungsplans liefert der Java-Finder (`finder-java/`,
   IslandSQL) die Mutationsstellen als JSON; `finder.ts` ist der Adapter. Bauen mit
   `packages/mutation/finder-java/build.sh` (lädt IslandSQL von Maven Central, braucht Java 21+).
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

Weitere Optionen: `--ops ROR,SBR`, `--timeout-factor 5`, `--skip-install`, `-q`.
Projektdatei `plmut.json`: `install` (Skripte), `mutate` (Globs der Dateien), `tests` (utPLSQL-Pfade).

Unterschied zur Go-Fassung: `--sample` wählt mit einem eigenen Zufallsgenerator; gleiche Seeds
ergeben in Go und TypeScript verschiedene Stichproben. Paritätsvergleiche laufen deshalb auf
vollständigen Läufen, `compare` ordnet Mutanten über Datei, Position, Operator und Ersatztext zu.
