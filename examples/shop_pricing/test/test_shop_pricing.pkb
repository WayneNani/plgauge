CREATE OR REPLACE PACKAGE BODY test_shop_pricing AS

  PROCEDURE rabatt_ueber_grenze IS
  BEGIN
    ut.expect(shop_pricing.rabatt(200)).to_equal(20);
  END;

  PROCEDURE kein_rabatt_unter_grenze IS
  BEGIN
    ut.expect(shop_pricing.rabatt(50)).to_equal(0);
  END;

  PROCEDURE express IS
  BEGIN
    ut.expect(shop_pricing.versandkosten(200, TRUE)).to_equal(15);
  END;

  PROCEDURE versand_klein IS
  BEGIN
    ut.expect(shop_pricing.versandkosten(20, FALSE)).to_equal(5);
  END;

  PROCEDURE endpreis_null IS
    l NUMBER;
  BEGIN
    l := shop_pricing.endpreis(NULL, FALSE);
  END;

  PROCEDURE endpreis_gross IS
  BEGIN
    ut.expect(shop_pricing.endpreis(200, FALSE)).to_equal(180);
  END;

  PROCEDURE buche_legt_an IS
    l_anzahl NUMBER;
  BEGIN
    shop_pricing.buche('Anna', 200);
    SELECT COUNT(*) INTO l_anzahl FROM bestellungen WHERE kunde = 'Anna';
    ut.expect(l_anzahl).to_equal(1);
  END;

  PROCEDURE storno_probe IS
    l_id     NUMBER;
    l_anzahl NUMBER;
  BEGIN
    shop_pricing.buche('Bert', 10);
    SELECT id INTO l_id FROM bestellungen WHERE kunde = 'Bert';
    shop_pricing.storniere(l_id, 'probe');
    SELECT COUNT(*) INTO l_anzahl FROM bestellungen WHERE kunde = 'Bert';
    ut.expect(l_anzahl).to_equal(0);
  END;

  PROCEDURE umsatz_unbekannt IS
  BEGIN
    ut.expect(shop_pricing.umsatz('Niemand')).to_equal(0);
  END;

  PROCEDURE umsatz_zwei IS
  BEGIN
    shop_pricing.buche('Clara', 100);
    shop_pricing.buche('Clara', 50);
    ut.expect(shop_pricing.umsatz('Clara')).to_equal(150);
  END;

  PROCEDURE treuepunkte_vier IS
  BEGIN
    ut.expect(shop_pricing.treuepunkte(4)).to_equal(10);
  END;

  PROCEDURE anteil_null IS
    l NUMBER;
  BEGIN
    l := shop_pricing.anteil(1, 0);
  END;

  PROCEDURE bestellnummer_lang IS
  BEGIN
    ut.expect(shop_pricing.bestellnummer(12345)).to_equal('B-2345');
  END;

  PROCEDURE raten_mit_rest IS
  BEGIN
    ut.expect(shop_pricing.raten(100, 30)).to_equal(4);
  END;

END test_shop_pricing;
/
