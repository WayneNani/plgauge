CREATE OR REPLACE PACKAGE BODY test_shop_pricing AS

  PROCEDURE discount_above_threshold IS
  BEGIN
    ut.expect(shop_pricing.discount(200)).to_equal(20);
  END;

  PROCEDURE no_discount_below_threshold IS
  BEGIN
    ut.expect(shop_pricing.discount(50)).to_equal(0);
  END;

  PROCEDURE express IS
  BEGIN
    ut.expect(shop_pricing.shipping_cost(200, TRUE)).to_equal(15);
  END;

  PROCEDURE shipping_small_order IS
  BEGIN
    ut.expect(shop_pricing.shipping_cost(20, FALSE)).to_equal(5);
  END;

  PROCEDURE final_price_null IS
    l NUMBER;
  BEGIN
    l := shop_pricing.final_price(NULL, FALSE);
  END;

  PROCEDURE final_price_large IS
  BEGIN
    ut.expect(shop_pricing.final_price(200, FALSE)).to_equal(180);
  END;

  PROCEDURE place_order_inserts IS
    l_count NUMBER;
  BEGIN
    shop_pricing.place_order('Anna', 200);
    SELECT COUNT(*) INTO l_count FROM shop_orders WHERE customer = 'Anna';
    ut.expect(l_count).to_equal(1);
  END;

  PROCEDURE trial_cancel IS
    l_id     NUMBER;
    l_count NUMBER;
  BEGIN
    shop_pricing.place_order('Bert', 10);
    SELECT id INTO l_id FROM shop_orders WHERE customer = 'Bert';
    shop_pricing.cancel_order(l_id, 'trial');
    SELECT COUNT(*) INTO l_count FROM shop_orders WHERE customer = 'Bert';
    ut.expect(l_count).to_equal(0);
  END;

  PROCEDURE revenue_unknown_customer IS
  BEGIN
    ut.expect(shop_pricing.revenue('Nobody')).to_equal(0);
  END;

  PROCEDURE revenue_two_orders IS
  BEGIN
    shop_pricing.place_order('Clara', 100);
    shop_pricing.place_order('Clara', 50);
    ut.expect(shop_pricing.revenue('Clara')).to_equal(150);
  END;

  PROCEDURE loyalty_points_four IS
  BEGIN
    ut.expect(shop_pricing.loyalty_points(4)).to_equal(10);
  END;

  PROCEDURE ratio_zero_whole IS
    l NUMBER;
  BEGIN
    l := shop_pricing.ratio(1, 0);
  END;

  PROCEDURE order_number_long_id IS
  BEGIN
    ut.expect(shop_pricing.order_number(12345)).to_equal('O-2345');
  END;

  PROCEDURE installments_with_rest IS
  BEGIN
    ut.expect(shop_pricing.installments(100, 30)).to_equal(4);
  END;

END test_shop_pricing;
/
