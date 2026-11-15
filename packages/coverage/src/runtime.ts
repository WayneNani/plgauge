/**
 * The in-database runtime: a hit table and the probe package cov$.
 *
 * Probes only count in package memory (associative arrays); nothing is written
 * per hit. flush() persists the counters in one autonomous transaction.
 *
 * Other sessions (A8): while a run is registered in plcov_runs, a session that is not the
 * runner (a scheduler job started by a test, say) records its hits under the test name
 * "#background" and writes them itself: every 1000 statements and at logoff (trigger
 * cov$_logoff, only present during the run).
 */

export const RUNS_TABLE = `
create table plcov_runs (
  run_id  varchar2(64) primary key,
  started timestamp default systimestamp
)`;

export const LOGOFF_TRIGGER = `
create or replace trigger cov$_logoff before logoff on schema
begin
  cov$.flush_background;
exception when others then null;
end;`;

export const HITS_TABLE = `
create table plcov_hits (
  run_id  varchar2(64)  not null,
  kind    varchar2(1)   not null,
  k       varchar2(200) not null,
  hits    number        not null,
  test    varchar2(400),
  sid     number        default sys_context('userenv', 'sid'),
  created timestamp     default systimestamp
)`;

export const RUNTIME_SPEC = `
create or replace package cov$ authid definer is
  /* plcov runtime: probe functions called by instrumented code. */
  -- callable from code under PRAGMA RESTRICT_REFERENCES (PLS-00452 otherwise)
  pragma restrict_references(default, rnds, wnds, rnps, wnps, trust);
  function o(p_d pls_integer) return boolean;
  function c(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean;
  function n(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean;
  function d(p_d pls_integer, p_v boolean) return boolean;
  procedure s(p_s pls_integer);
  procedure b(p_b pls_integer);
  /* Branch probe inside an expression (simple CASE): counts like b and returns TRUE. */
  function bt(p_b pls_integer) return boolean;
  /* The probes in SQL (conditions and CASE in queries): without the package-state purity of
     DEFAULT below, so Oracle never runs a query with them in parallel slaves, whose package
     state (the counters) is their own. */
  function qd(p_d pls_integer, p_v boolean) return boolean;
  function qc(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean;
  function qn(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean;
  function qbt(p_b pls_integer) return boolean;
  pragma restrict_references(qd, wnds, rnds, trust);
  pragma restrict_references(qc, wnds, rnds, trust);
  pragma restrict_references(qn, wnds, rnds, trust);
  pragma restrict_references(qbt, wnds, rnds, trust);
  procedure le(p_l pls_integer);
  procedure li(p_l pls_integer);
  procedure lx(p_l pls_integer);
  /* Record which utPLSQL test reaches which probe (via SYS_CONTEXT('UT3_INFO', 'TEST_NAME')). */
  procedure per_test(p_on boolean);
  procedure reset;
  procedure flush(p_run varchar2);
  /* Runner: makes the run visible to other sessions / ends that. */
  procedure start_run(p_run varchar2);
  -- 1 while the state of start_run is there (a DBMS_SESSION.RESET_PACKAGE in a test wipes it)
  function intact return pls_integer;
  procedure stop_run(p_run varchar2);
  /* Other sessions: write their hits (called by the logoff trigger). */
  procedure flush_background;
end cov$;`;

/* Recording logic shared by the condition probes c and n (inlined: one call less per condition). */
const PROBE_DECL = `l_v pls_integer; k pls_integer; b pls_integer;`;
const PROBE_BODY = `if p_v then l_v := 0; elsif not p_v then l_v := 1; else l_v := 2; end if;
    k := p_d * 256 + p_i * 4 + l_v;
    if g_c.exists(k) then g_c(k) := g_c(k) + 1; else g_c(k) := 1; end if;
    if g_top > 0 and p_i <= 30 then
      if g_fd(g_top) = p_d then
        b := g_pow(p_i);
        g_fe(g_top) := g_fe(g_top) + b;
        if l_v = 0 then g_ft(g_top) := g_ft(g_top) + b; elsif l_v = 2 then g_fn(g_top) := g_fn(g_top) + b; end if;
      end if;
    end if;
    if g_pt and g_tid > 0 then g_pc(g_tid)(k) := 1; end if;`;

export const RUNTIME_BODY = `
create or replace package body cov$ is
  /*
    Hot path uses integer keys only:
      conditions  d*256 + i*4 + v      (v: 0 = TRUE, 1 = FALSE, 2 = NULL)
      decisions   d*4 + v
    Condition vectors (for MC/DC) are kept as three bit masks per open frame
    (evaluated / true / null) and turned into one string key per decision outcome.
  */
  type t_num is table of pls_integer index by pls_integer;
  type t_str is table of pls_integer index by varchar2(200);
  type t_set is table of t_num index by pls_integer;
  type t_names is table of varchar2(400) index by pls_integer;

  g_s  t_num;   -- statement hits
  g_b  t_num;   -- explicit branch hits
  g_c  t_num;   -- condition values
  g_d  t_num;   -- decision outcomes
  g_v  t_str;   -- condition vectors  d|evaluated|true|null|outcome
  g_l  t_str;   -- loop iterations    l:0|1|n
  g_li t_num;   -- open loop iteration counters
  g_fd t_num;   -- frame stack: decision id
  g_fe t_num;   -- frame stack: evaluated mask
  g_ft t_num;   -- frame stack: true mask
  g_fn t_num;   -- frame stack: null mask
  g_pow t_num;
  g_top pls_integer := 0;

  -- per-test attribution: the current test is looked up once per statement probe
  g_pt    boolean := false;
  g_tid   pls_integer := 0;
  g_tname varchar2(400);
  g_tids  t_str;     -- test name -> id
  g_names t_names;   -- id -> test name ('#owner.package' = suite setup outside a test)
  g_ps t_set; g_pb t_set; g_pc t_set; g_pd t_set;

  -- other sessions during a run
  g_runner boolean := false;
  g_bg     boolean := false;
  g_bg_run varchar2(64);
  g_bg_cnt pls_integer := 0;
  g_partial boolean := false;   -- periodic flush of another session: keep open loops

  procedure set_test is
    l_name varchar2(400) := case when g_bg then '#background' else sys_context('UT3_INFO', 'TEST_NAME') end;
    l_empty t_num;
  begin
    if l_name is null then
      l_name := '#' || sys_context('UT3_INFO', 'SUITE_PACKAGE');
    end if;
    if g_tid > 0 and l_name = g_tname then
      return;
    end if;
    g_tname := l_name;
    if not g_tids.exists(l_name) then
      g_tid := g_names.count + 1;
      g_tids(l_name) := g_tid;
      g_names(g_tid) := l_name;
      g_ps(g_tid) := l_empty; g_pb(g_tid) := l_empty; g_pc(g_tid) := l_empty; g_pd(g_tid) := l_empty;
    end if;
    g_tid := g_tids(l_name);
  end;

  function o(p_d pls_integer) return boolean is
    pragma udf;
  begin
    if g_top >= 1000 then g_top := 0; end if;   -- leaked frames after exceptions
    g_top := g_top + 1;
    g_fd(g_top) := p_d;
    g_fe(g_top) := 0;
    g_ft(g_top) := 0;
    g_fn(g_top) := 0;
    return true;
  exception when others then return true;
  end;

  /*
    Conditions are evaluated in a jumping-code context (IF, WHILE, WHEN): only "is it TRUE?"
    matters, and Oracle short-circuits NULL like FALSE. To keep exactly that evaluation order
    (and therefore all side effects), probes record the real value but return it mapped:
      c: positive polarity, NULL -> FALSE
      n: under an odd number of NOTs, NULL -> TRUE
  */
  function c(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean is
    pragma udf;
    ${PROBE_DECL}
  begin
    ${PROBE_BODY}
    return case when p_v then true else false end;   -- NULL -> FALSE
  exception when others then return case when p_v then true else false end;
  end;

  function n(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean is
    pragma udf;
    ${PROBE_DECL}
  begin
    ${PROBE_BODY}
    return case when not p_v then false else true end; -- NULL -> TRUE
  exception when others then return case when not p_v then false else true end;
  end;

  function d(p_d pls_integer, p_v boolean) return boolean is
    pragma udf;
    l_v pls_integer;
    k   pls_integer;
    ks  varchar2(200);
  begin
    if p_v then l_v := 0; elsif not p_v then l_v := 1; else l_v := 2; end if;
    k := p_d * 4 + l_v;
    if g_d.exists(k) then g_d(k) := g_d(k) + 1; else g_d(k) := 1; end if;
    if g_pt and g_tid > 0 then g_pd(g_tid)(k) := 1; end if;
    k := g_top;
    while k > 0 and g_fd(k) != p_d loop
      k := k - 1;
    end loop;
    if k > 0 then
      ks := p_d || '|' || g_fe(k) || '|' || g_ft(k) || '|' || g_fn(k) || '|' || l_v;
      if g_v.exists(ks) then g_v(ks) := g_v(ks) + 1; else g_v(ks) := 1; end if;
      g_top := k - 1;
    end if;
    return p_v;
  exception when others then return p_v;
  end;

  procedure s(p_s pls_integer) is
  begin
    if g_s.exists(p_s) then g_s(p_s) := g_s(p_s) + 1; else g_s(p_s) := 1; end if;
    if g_pt then
      set_test;
      g_ps(g_tid)(p_s) := 1;
    end if;
    if g_bg then
      g_bg_cnt := g_bg_cnt + 1;
      if g_bg_cnt >= 1000 then
        g_partial := true;
        flush_background;
        g_partial := false;
      end if;
    end if;
  exception when others then null;
  end;

  procedure b(p_b pls_integer) is
  begin
    if g_b.exists(p_b) then g_b(p_b) := g_b(p_b) + 1; else g_b(p_b) := 1; end if;
    if g_pt and g_tid > 0 then g_pb(g_tid)(p_b) := 1; end if;
  exception when others then null;
  end;

  function qd(p_d pls_integer, p_v boolean) return boolean is begin return d(p_d, p_v); end;
  function qc(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean is begin return c(p_d, p_i, p_v); end;
  function qn(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean is begin return n(p_d, p_i, p_v); end;
  function qbt(p_b pls_integer) return boolean is begin return bt(p_b); end;

  function bt(p_b pls_integer) return boolean is
  begin
    b(p_b);
    return true;
  end;

  procedure close_loop(p_l pls_integer) is
    ks varchar2(30);
  begin
    if g_li.exists(p_l) then
      ks := p_l || ':' || case when g_li(p_l) = 0 then '0' when g_li(p_l) = 1 then '1' else 'n' end;
      if g_l.exists(ks) then g_l(ks) := g_l(ks) + 1; else g_l(ks) := 1; end if;
      g_li.delete(p_l);
    end if;
  end;

  procedure le(p_l pls_integer) is
  begin
    close_loop(p_l);
    g_li(p_l) := 0;
  exception when others then null;
  end;

  procedure li(p_l pls_integer) is
  begin
    if g_li.exists(p_l) then g_li(p_l) := g_li(p_l) + 1; else g_li(p_l) := 1; end if;
  exception when others then null;
  end;

  procedure lx(p_l pls_integer) is
  begin
    close_loop(p_l);
  exception when others then null;
  end;

  procedure per_test(p_on boolean) is
  begin
    g_pt := nvl(p_on, false);
  end;

  procedure reset is
  begin
    g_s.delete; g_b.delete; g_c.delete; g_d.delete; g_v.delete; g_l.delete; g_li.delete;
    g_fd.delete; g_fe.delete; g_ft.delete; g_fn.delete; g_top := 0;
    g_ps.delete; g_pb.delete; g_pc.delete; g_pd.delete; g_tids.delete; g_names.delete;
    g_tid := 0; g_tname := null;
  end;

  procedure flush(p_run varchar2) is
    pragma autonomous_transaction;
    k  pls_integer;
    ks varchar2(200);
    l_li t_num;   -- variables before the nested subprograms
    procedure put(p_kind varchar2, p_k varchar2, p_hits pls_integer, p_test varchar2 := null) is
    begin
      insert into plcov_hits (run_id, kind, k, hits, test) values (p_run, p_kind, p_k, p_hits, p_test);
    end;
    function tfn(p pls_integer) return varchar2 is
    begin
      return case p when 0 then 'T' when 1 then 'F' else 'N' end;
    end;
  begin
    if g_partial then
      l_li := g_li;
    else
      k := g_li.first;
      while k is not null loop
        close_loop(k);
        k := g_li.first;
      end loop;
    end if;
    k := g_s.first; while k is not null loop put('S', k, g_s(k)); k := g_s.next(k); end loop;
    k := g_b.first; while k is not null loop put('B', k, g_b(k)); k := g_b.next(k); end loop;
    k := g_c.first;
    while k is not null loop
      put('C', trunc(k / 256) || ':' || trunc(mod(k, 256) / 4) || ':' || tfn(mod(k, 4)), g_c(k));
      k := g_c.next(k);
    end loop;
    k := g_d.first;
    while k is not null loop
      put('D', trunc(k / 4) || ':' || tfn(mod(k, 4)), g_d(k));
      k := g_d.next(k);
    end loop;
    ks := g_v.first; while ks is not null loop put('V', ks, g_v(ks)); ks := g_v.next(ks); end loop;
    ks := g_l.first; while ks is not null loop put('L', ks, g_l(ks)); ks := g_l.next(ks); end loop;
    -- per test: lower-case kinds, hits = 1 ("reached")
    for t in 1 .. g_names.count loop
      k := g_ps(t).first; while k is not null loop put('s', k, 1, g_names(t)); k := g_ps(t).next(k); end loop;
      k := g_pb(t).first; while k is not null loop put('b', k, 1, g_names(t)); k := g_pb(t).next(k); end loop;
      k := g_pc(t).first;
      while k is not null loop
        put('c', trunc(k / 256) || ':' || trunc(mod(k, 256) / 4) || ':' || tfn(mod(k, 4)), 1, g_names(t));
        k := g_pc(t).next(k);
      end loop;
      k := g_pd(t).first;
      while k is not null loop
        put('d', trunc(k / 4) || ':' || tfn(mod(k, 4)), 1, g_names(t));
        k := g_pd(t).next(k);
      end loop;
    end loop;
    commit;
    reset;
    if g_partial then g_li := l_li; end if;
  end;

  procedure start_run(p_run varchar2) is
    pragma autonomous_transaction;
  begin
    delete from plcov_runs;
    insert into plcov_runs (run_id) values (p_run);
    commit;
    g_runner := true;
    g_bg := false;
  end;

  function intact return pls_integer is
  begin
    return case when g_runner then 1 else 0 end;
  end;

  procedure stop_run(p_run varchar2) is
    pragma autonomous_transaction;
  begin
    delete from plcov_runs where run_id = p_run;
    commit;
  end;

  procedure flush_background is
  begin
    if g_bg and not g_runner and g_bg_run is not null then
      g_bg_cnt := 0;
      flush(g_bg_run);
      g_tid := 0;
    end if;
  exception when others then null;
  end;

  -- autonomous: a query of the session's own would replace SQL%ROWCOUNT and SQL%FOUND of the
  -- instrumented code's last statement (the first probe may come between it and their read)
  function registered_run return varchar2 is
    pragma autonomous_transaction;
    l_run plcov_runs.run_id%type;
  begin
    select max(run_id) into l_run from plcov_runs;
    commit;
    return l_run;
  end;

begin
  -- a session that loads cov$ while a run is registered is not the runner: record for it
  begin
    g_bg_run := registered_run;
    if g_bg_run is not null then
      g_bg := true;
      g_pt := true;
    end if;
  exception when others then null;
  end;
  for i in 1 .. 30 loop
    g_pow(i) := power(2, i - 1);
  end loop;
end cov$;`;
