CREATE OR REPLACE PACKAGE BODY shop_pricing AS

  -- 10 % Rabatt ab der Rabattgrenze.
  FUNCTION rabatt(p_summe NUMBER) RETURN NUMBER IS
  BEGIN
    IF p_summe >= c_rabattgrenze THEN
      RETURN p_summe * 0.1;
    END IF;
    RETURN 0;
  END rabatt;

  -- Versand ist ab c_versandfrei kostenlos, außer bei Express.
  FUNCTION versandkosten(p_summe NUMBER, p_express BOOLEAN) RETURN NUMBER IS
    l_kosten NUMBER := 0;
  BEGIN
    IF p_express THEN
      l_kosten := 15;
    ELSIF p_summe < c_versandfrei THEN
      l_kosten := 5;
    END IF;
    RETURN l_kosten;
  END versandkosten;

  FUNCTION endpreis(p_summe NUMBER, p_express BOOLEAN) RETURN NUMBER IS
  BEGIN
    IF p_summe IS NULL OR p_summe <= 0 THEN
      RAISE_APPLICATION_ERROR(-20001, 'Summe muss positiv sein');
    END IF;
    RETURN p_summe - rabatt(p_summe) + versandkosten(p_summe, p_express);
  END endpreis;

  PROCEDURE buche(p_kunde VARCHAR2, p_summe NUMBER) IS
    l_rabatt NUMBER;
  BEGIN
    l_rabatt := rabatt(p_summe);
    INSERT INTO bestellungen (kunde, summe, rabatt, versand)
    VALUES (p_kunde, p_summe, l_rabatt, versandkosten(p_summe, FALSE));
  END buche;

  -- Löscht eine Bestellung; im Modus 'final' wird sofort festgeschrieben.
  PROCEDURE storniere(p_id NUMBER, p_modus VARCHAR2) IS
  BEGIN
    DELETE FROM bestellungen WHERE id = p_id;
    IF p_modus = 'final' THEN
      COMMIT;
    END IF;
  END storniere;

  -- Umsatz eines Kunden; unbekannte Kunden haben 0 Umsatz.
  FUNCTION umsatz(p_kunde VARCHAR2) RETURN NUMBER IS
    CURSOR c IS SELECT summe FROM bestellungen WHERE kunde = p_kunde;
    l_summe  NUMBER;
    l_gesamt NUMBER := 0;
  BEGIN
    OPEN c;
    LOOP
      FETCH c INTO l_summe;
      EXIT WHEN c%NOTFOUND;
      l_gesamt := l_gesamt + NVL(l_summe, 0);
    END LOOP;
    CLOSE c;
    RETURN l_gesamt;
  END umsatz;

  -- Treuepunkte: für die k-te Bestellung gibt es k Punkte.
  FUNCTION treuepunkte(p_n PLS_INTEGER) RETURN PLS_INTEGER IS
    l PLS_INTEGER := 0;
  BEGIN
    FOR k IN 1 .. p_n LOOP
      l := l + k;
    END LOOP;
    RETURN l;
  END treuepunkte;

  FUNCTION anteil(p_teil NUMBER, p_ganzes NUMBER) RETURN NUMBER IS
  BEGIN
    RETURN p_teil / p_ganzes;
  EXCEPTION
    WHEN ZERO_DIVIDE THEN
      DBMS_OUTPUT.PUT_LINE('anteil: Ganzes ist 0');
      RAISE_APPLICATION_ERROR(-20002, 'Ganzes ist 0');
  END anteil;

  -- Kurze Bestellnummer: die letzten vier Stellen der ID.
  FUNCTION bestellnummer(p_id NUMBER) RETURN VARCHAR2 IS
  BEGIN
    RETURN 'B-' || LPAD(MOD(p_id, 10000), 4, '0');
  END bestellnummer;

  -- Anzahl der Raten, bis die Summe abbezahlt ist.
  FUNCTION raten(p_summe NUMBER, p_rate NUMBER) RETURN PLS_INTEGER IS
    l_rest NUMBER := p_summe;
    l_n    PLS_INTEGER := 0;
  BEGIN
    WHILE l_rest > 0 LOOP
      l_rest := l_rest - p_rate;
      l_n := l_n + 1;
    END LOOP;
    RETURN l_n;
  END raten;

END shop_pricing;
/
