CREATE OR REPLACE PACKAGE shop_pricing AS
  c_discount_threshold CONSTANT NUMBER := 100;
  c_free_shipping      CONSTANT NUMBER := 50;

  FUNCTION discount(p_amount NUMBER) RETURN NUMBER;
  FUNCTION shipping_cost(p_amount NUMBER, p_express BOOLEAN) RETURN NUMBER;
  FUNCTION final_price(p_amount NUMBER, p_express BOOLEAN) RETURN NUMBER;
  PROCEDURE place_order(p_customer VARCHAR2, p_amount NUMBER);
  PROCEDURE cancel_order(p_id NUMBER, p_mode VARCHAR2);
  FUNCTION revenue(p_customer VARCHAR2) RETURN NUMBER;
  FUNCTION loyalty_points(p_n PLS_INTEGER) RETURN PLS_INTEGER;
  FUNCTION ratio(p_part NUMBER, p_whole NUMBER) RETURN NUMBER;
  FUNCTION order_number(p_id NUMBER) RETURN VARCHAR2;
  FUNCTION installments(p_amount NUMBER, p_rate NUMBER) RETURN PLS_INTEGER;
END shop_pricing;
/
