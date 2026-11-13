CREATE OR REPLACE PACKAGE shop_pricing AS
  c_rabattgrenze CONSTANT NUMBER := 100;
  c_versandfrei  CONSTANT NUMBER := 50;

  FUNCTION rabatt(p_summe NUMBER) RETURN NUMBER;
  FUNCTION versandkosten(p_summe NUMBER, p_express BOOLEAN) RETURN NUMBER;
  FUNCTION endpreis(p_summe NUMBER, p_express BOOLEAN) RETURN NUMBER;
  PROCEDURE buche(p_kunde VARCHAR2, p_summe NUMBER);
  PROCEDURE storniere(p_id NUMBER, p_modus VARCHAR2);
  FUNCTION umsatz(p_kunde VARCHAR2) RETURN NUMBER;
  FUNCTION treuepunkte(p_n PLS_INTEGER) RETURN PLS_INTEGER;
  FUNCTION anteil(p_teil NUMBER, p_ganzes NUMBER) RETURN NUMBER;
  FUNCTION bestellnummer(p_id NUMBER) RETURN VARCHAR2;
  FUNCTION raten(p_summe NUMBER, p_rate NUMBER) RETURN PLS_INTEGER;
END shop_pricing;
/
