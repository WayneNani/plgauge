CREATE OR REPLACE PACKAGE test_shop_pricing AS
  --%suite(Preise im Shop)

  --%test(Rabatt über der Grenze)
  PROCEDURE rabatt_ueber_grenze;
  --%test(Kein Rabatt unter der Grenze)
  PROCEDURE kein_rabatt_unter_grenze;
  --%test(Express kostet 15)
  PROCEDURE express;
  --%test(Kleine Bestellung kostet Versand)
  PROCEDURE versand_klein;
  --%test(Endpreis lehnt null ab)
  --%throws(-20001)
  PROCEDURE endpreis_null;
  --%test(Endpreis für eine große Bestellung)
  PROCEDURE endpreis_gross;
  --%test(Buchung legt eine Zeile an)
  PROCEDURE buche_legt_an;
  --%test(Probestorno löscht die Bestellung)
  PROCEDURE storno_probe;
  --%test(Unbekannter Kunde hat keinen Umsatz)
  PROCEDURE umsatz_unbekannt;
  --%test(Umsatz über zwei Bestellungen)
  PROCEDURE umsatz_zwei;
  --%test(Treuepunkte für vier Bestellungen)
  PROCEDURE treuepunkte_vier;
  --%test(Anteil am Ganzen 0 wirft)
  --%throws(-20002)
  PROCEDURE anteil_null;
  --%test(Bestellnummer aus langer ID)
  PROCEDURE bestellnummer_lang;
  --%test(Raten mit Rest)
  PROCEDURE raten_mit_rest;
END test_shop_pricing;
/
