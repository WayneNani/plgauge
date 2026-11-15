CREATE OR REPLACE PACKAGE test_shop_pricing AS
  --%suite(Shop prices)

  --%test(Discount above the threshold)
  PROCEDURE discount_above_threshold;
  --%test(No discount below the threshold)
  PROCEDURE no_discount_below_threshold;
  --%test(Express costs 15)
  PROCEDURE express;
  --%test(A small order pays shipping)
  PROCEDURE shipping_small_order;
  --%test(Final price rejects null)
  --%throws(-20001)
  PROCEDURE final_price_null;
  --%test(Final price of a large order)
  PROCEDURE final_price_large;
  --%test(Placing an order inserts a row)
  PROCEDURE place_order_inserts;
  --%test(A trial cancellation deletes the order)
  PROCEDURE trial_cancel;
  --%test(An unknown customer has no revenue)
  PROCEDURE revenue_unknown_customer;
  --%test(Revenue over two orders)
  PROCEDURE revenue_two_orders;
  --%test(Loyalty points for four orders)
  PROCEDURE loyalty_points_four;
  --%test(Ratio of a whole of 0 raises)
  --%throws(-20002)
  PROCEDURE ratio_zero_whole;
  --%test(Order number from a long ID)
  PROCEDURE order_number_long_id;
  --%test(Installments with a remainder)
  PROCEDURE installments_with_rest;
END test_shop_pricing;
/
