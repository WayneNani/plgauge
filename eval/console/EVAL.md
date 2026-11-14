# Auswertung an console (A11)

Stand 14.11.2026. Ersatz für M4 auf eurem Code: Mutation Testing auf einem fremden, gepflegten Projekt mit echter
Testsuite. Ergebnis: **89 von 100 überlebenden Mutanten zeigen eine echte Testlücke**; 11 sind äquivalent oder in der
Praxis bedeutungslos. Die Operatoren der Stufe 1 liefern also verwertbare Hinweise. Für Stufe 2 (SQL-Operatoren, A10)
gibt console keinen Anlass, weil nur 3 % seiner Mutanten in SQL liegen.

## Lauf

| | |
| --- | --- |
| Code | `CONSOLE.pkb` von [console](https://github.com/ogobrecht/console) (`72ff8f85`), rund 4 000 Zeilen |
| Tests | 258 utPLSQL-Tests; 2 scheitern schon ohne Mutanten, 11 sind unzuverlässig (Level-Prüfungen, die vom Konfigurationszustand abhängen) |
| Datenbank | Oracle 23.26.1 Free, utPLSQL 3.2.2, drei Worker |
| Modus | Schema, Aufzeichnung pro Test, Fail-Fast |
| Laufzeit | 271 s für 1 630 Mutanten (Baseline 4,9 s) |
| Mutation Score | **63,0 %**: 1 022 erkannt, 374 überlebt, 225 von keinem Test erreicht, 8 kompilieren nicht |

| Operator | Mutanten | erkannt | überlebt | nicht erreicht | Score |
| --- | --- | --- | --- | --- | --- |
| AOR | 246 | 132 | 74 | 38 | 54,1 % |
| CUR | 38 | 25 | 5 | 8 | 65,8 % |
| EXC | 6 | 3 | 0 | 3 | 50,0 % |
| LCR | 112 | 66 | 26 | 20 | 58,9 % |
| NUL | 118 | 83 | 24 | 11 | 70,3 % |
| RET | 294 | 248 | 4 | 36 | 86,1 % |
| ROR | 234 | 127 | 79 | 27 | 54,5 % |
| SBR | 582 | 338 | 162 | 82 | 58,1 % |

Die meisten Überlebenden sammeln sich in den Diagnosefunktionen: `user_env` (81), `console_env` (28),
`to_html_table` (34), `call_stack` (25), `status` (25), `utl_last_error` (22).

## 100 Überlebende von Hand eingeordnet

Stichprobe: 100 der 374 Überlebenden, zufällig mit festem Seed (11). Jede Zeile mit Begründung in
[`survivors-sample.tsv`](survivors-sample.tsv).

| Klasse | Anzahl | Typisches Beispiel |
| --- | --- | --- |
| Ergebnis oder Text ungeprüft | 67 | `user_env` ohne die Zeile `CURRENT_USER`; HTML von `to_html_table` ohne `<!-- header -->`; Zählermeldung ohne `' - ' \|\| p_message` |
| Fall oder Grenzwert fehlt | 18 | Grenze von genau 4 000 Byte für Client-Einstellungen; doppelte Fehlermeldungen werden nicht mehr unterdrückt; Logging im Exception-Handler bei niedrigem Level; Rechteprüfung nur mit dem Eigentümer |
| Zustand oder Ressource ungeprüft | 4 | Cursor bleibt offen (`close_cursor` entfernt); Parameterliste wird nicht geleert |
| praktisch äquivalent | 4 | `exit when n = p_max_rows` gegen `>=` (verschieden nur bei negativem Limit) |
| nur Laufzeit | 2 | Konfiguration wird bei jedem Aufruf statt nach Ablauf neu gelesen |
| Umgebung fehlt | 2 | CGI-Variablen gibt es nur in einer OWA-Session |
| äquivalent | 3 | `< 30` gegen `<= 30` vor `rpad(…, 30)`; Tiefe aus einer Variable, die nie negativ ist |

Was das für ein Team heißt: Die 18 Fälle der zweiten Zeile sind die wertvollsten Funde, echte fehlende Testfälle an
Grenzen und in Fehlerpfaden. Die 67 der ersten Zeile sind meist Diagnoseausgaben, deren Text niemand Wort für Wort
prüfen will. Für sie bietet sich an, solche Funktionen per Konfiguration auszuschließen oder als bekannt zu markieren.

## Was der Lauf am Werkzeug verbessert hat

Der erste echte Fremdcode hat vier Schwächen gezeigt, alle behoben und mit Tests abgesichert:

- **Tests, die selbst committen:** console schreibt Konfiguration fest. Die Commit-Erkennung hielt deshalb fast jeden
  Mutanten für eine Nebenwirkung und setzte die Datenbank jedes Mal zurück. Jetzt gilt: Committet schon die Baseline,
  gibt es eine Warnung und kein Zurücksetzen.
- **Absturz eines Serverprozesses** (ORA-07445 beim Abbrechen einer Anweisung): Ein Worker verlor seine Verbindungen und
  hakte danach 816 Mutanten als Fehler ab. Jetzt baut er sich neu auf, holt die Originale aus dem Journal und
  wiederholt den Mutanten; im zweiten Lauf geschah genau das einmal, ohne Folgen.
- **Kontextname global:** Zwei Benutzer, die gleichzeitig in einer Datenbank mutieren, nahmen sich den Kontext für die
  Schleifengrenzen weg. Er heißt jetzt pro Schema anders.
- **Unzuverlässige Tests:** Die 11 Level-Tests scheitern je nach Konfigurationszustand. Die Nachprüfung tötender Tests
  hat sie erkannt, ausgeschlossen und die betroffenen Mutanten ohne sie wiederholt.

## Entscheidung über Stufe 2 (A10)

Nachtrag: Stufe 2 ist inzwischen umgesetzt und an SQL-lastigem Code ausgewertet, siehe
[`eval/plscope-utils/EVAL.md`](../plscope-utils/EVAL.md). In console erzeugt sie 6 Mutanten.

Ursprünglich zurückgestellt. Gründe:

1. Nur 47 der 1 630 Mutanten liegen in SQL (2,9 %), davon überleben 7. SQL-Operatoren (DISTINCT, Joins, GROUP BY,
   Spalten tauschen) hätten in console kaum Angriffsfläche.
2. Die Operatoren der Stufe 1 liefern schon 89 % verwertbare Funde bei 3 % echten Äquivalenten. Mehr Operatoren hieße
   hier vor allem mehr Laufzeit.
3. Ob sich Stufe 2 lohnt, hängt am Anteil von SQL im Code. Das entscheidet ein Lauf auf SQL-lastigem Code, idealerweise
   eurem: `pltest mutate run <projekt>` und der Anteil `ctx = sql` im Bericht.

Eine kleine Verbesserung für Stufe 1 hat die Stichprobe gezeigt: Die Heuristik „nie negativ“ erkennt `x > 0` gegen
`x <> 0` nur bei direkten Ausdrücken wie `length(…)`, nicht bei einer Variable, der so ein Ausdruck zugewiesen wurde.
Das betrifft 1 von 100 Fällen und lohnt sich erst, wenn es auf anderem Code häufiger auftritt.

## Wiederholen

```bash
corpus/fetch.sh                                  # console nach corpus/.cache
# console in der Datenbank installieren: eval/console/README.md
PLMUT_DB=oracle://console_eval:…@…/FREEPDB1 npx pltest mutate run eval/console --json run.json --report run.html
npx tsx scripts/eval-summary.ts run.json survivors.tsv
```
