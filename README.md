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
| `packages/mutation` | Mutation Testing: Java-Finder-Adapter (bis Phase 4), Schema- und Orakel-Umschreiber, Lauf, Berichte |
| `packages/report` | HTML-Bericht |
| `packages/cli` | Befehl `pltest` |
| `examples/` | `order_pricing` (Coverage-Demo), `shop_pricing` (Mutation, mit `expected.tsv`) |
| `eval/` | Konfiguration für pljson (Auswertung auf fremdem Code) |
| `baseline/` | Ergebnisse der alten Fassungen für Paritätsprüfungen |

## Voraussetzungen und Befehle

Node.js 26 (LTS), eine Oracle-Datenbank 23ai/26ai (Coverage ab 19c) mit utPLSQL ≥ 3.2.2.

```bash
npm install
npm test                      # offline; mit PLCOV_DB=user/pw@host:port/service auch gegen die Datenbank
npm run typecheck
npx pltest coverage --config examples/order_pricing/plcov.json --out report
npx pltest restore --config examples/order_pricing/plcov.json --list
PLMUT_DB=oracle://user:pw@host:port/service npx pltest mutate run examples/shop_pricing
```

## Wiederherstellungs-Journal

Bevor pltest ein Objekt instrumentiert oder mutiert, sichert es den Originalquelltext und die
Compiler-Einstellungen in der Tabelle `pltest_journal` und schreibt den Eintrag sofort fest. Nach
dem Wiederherstellen wird der Eintrag gelöscht. Bricht ein Lauf hart ab, setzt
`pltest restore` alle Objekte aus dem Journal zurück; `--list` zeigt sie nur an.
