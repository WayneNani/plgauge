CREATE OR REPLACE PACKAGE BODY shop_pricing AS

  -- 10 % discount from the discount threshold on.
  FUNCTION discount(p_amount NUMBER) RETURN NUMBER IS
  BEGIN
    IF p_amount >= c_discount_threshold THEN
      RETURN p_amount * 0.1;
    END IF;
    RETURN 0;
  END discount;

  -- Shipping is free from c_free_shipping on, except for express.
  FUNCTION shipping_cost(p_amount NUMBER, p_express BOOLEAN) RETURN NUMBER IS
    l_cost NUMBER := 0;
  BEGIN
    IF p_express THEN
      l_cost := 15;
    ELSIF p_amount < c_free_shipping THEN
      l_cost := 5;
    END IF;
    RETURN l_cost;
  END shipping_cost;

  FUNCTION final_price(p_amount NUMBER, p_express BOOLEAN) RETURN NUMBER IS
  BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
      RAISE_APPLICATION_ERROR(-20001, 'Amount must be positive');
    END IF;
    RETURN p_amount - discount(p_amount) + shipping_cost(p_amount, p_express);
  END final_price;

  PROCEDURE place_order(p_customer VARCHAR2, p_amount NUMBER) IS
    l_discount NUMBER;
  BEGIN
    l_discount := discount(p_amount);
    INSERT INTO shop_orders (customer, amount, discount, shipping)
    VALUES (p_customer, p_amount, l_discount, shipping_cost(p_amount, FALSE));
  END place_order;

  -- Deletes an order; in mode 'final' it commits at once.
  PROCEDURE cancel_order(p_id NUMBER, p_mode VARCHAR2) IS
  BEGIN
    DELETE FROM shop_orders WHERE id = p_id;
    IF p_mode = 'final' THEN
      COMMIT;
    END IF;
  END cancel_order;

  -- Revenue of a customer; unknown customers have 0 revenue.
  FUNCTION revenue(p_customer VARCHAR2) RETURN NUMBER IS
    CURSOR c IS SELECT amount FROM shop_orders WHERE customer = p_customer;
    l_amount  NUMBER;
    l_total NUMBER := 0;
  BEGIN
    OPEN c;
    LOOP
      FETCH c INTO l_amount;
      EXIT WHEN c%NOTFOUND;
      l_total := l_total + NVL(l_amount, 0);
    END LOOP;
    CLOSE c;
    RETURN l_total;
  END revenue;

  -- Loyalty points: the k-th order earns k points.
  FUNCTION loyalty_points(p_n PLS_INTEGER) RETURN PLS_INTEGER IS
    l PLS_INTEGER := 0;
  BEGIN
    FOR k IN 1 .. p_n LOOP
      l := l + k;
    END LOOP;
    RETURN l;
  END loyalty_points;

  FUNCTION ratio(p_part NUMBER, p_whole NUMBER) RETURN NUMBER IS
  BEGIN
    RETURN p_part / p_whole;
  EXCEPTION
    WHEN ZERO_DIVIDE THEN
      DBMS_OUTPUT.PUT_LINE('ratio: whole is 0');
      RAISE_APPLICATION_ERROR(-20002, 'whole is 0');
  END ratio;

  -- Short order number: the last four digits of the ID.
  FUNCTION order_number(p_id NUMBER) RETURN VARCHAR2 IS
  BEGIN
    RETURN 'O-' || LPAD(MOD(p_id, 10000), 4, '0');
  END order_number;

  -- Number of installments until the amount is paid off.
  FUNCTION installments(p_amount NUMBER, p_rate NUMBER) RETURN PLS_INTEGER IS
    l_remaining NUMBER := p_amount;
    l_n    PLS_INTEGER := 0;
  BEGIN
    WHILE l_remaining > 0 LOOP
      l_remaining := l_remaining - p_rate;
      l_n := l_n + 1;
    END LOOP;
    RETURN l_n;
  END installments;

END shop_pricing;
/
