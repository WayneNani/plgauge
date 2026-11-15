#!/usr/bin/env bash
# Starts Oracle AI Database Free (23ai/26ai, gvenzl image), installs utPLSQL 3.2.2 and creates
# an application user with the rights plgauge needs. For CI jobs and local setups.
#
#   ci/setup-db.sh                      # container "plgauge-db" on port 1521, user "app"
#   PLGAUGE_PORT=15299 PLGAUGE_NAME=x PLGAUGE_USER=demo ci/setup-db.sh
#
# Prints the connection URL for plgauge (oracle://user:pw@host:port/FREEPDB1) as the last line.
# Passwords are generated unless ORACLE_PASSWORD / PLGAUGE_PASSWORD are set; in GitHub Actions
# mask them with ::add-mask:: (done below when GITHUB_ACTIONS is set).
set -euo pipefail
NAME=${PLGAUGE_NAME:-plgauge-db}
PORT=${PLGAUGE_PORT:-1521}
APP=${PLGAUGE_USER:-app}
IMAGE=${PLGAUGE_IMAGE:-docker.io/gvenzl/oracle-free:23-slim}
UTPLSQL=${PLGAUGE_UTPLSQL:-v3.2.2}
pw() { head -c18 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 16; }
ORACLE_PASSWORD=${ORACLE_PASSWORD:-$(pw)}
APP_PASSWORD=${PLGAUGE_PASSWORD:-$(pw)}
UT3_PASSWORD=$(pw)
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$ORACLE_PASSWORD"; echo "::add-mask::$APP_PASSWORD"; echo "::add-mask::$UT3_PASSWORD"; fi

# docker or podman (also from a distrobox through host-spawn)
if [ -n "${CONTAINER_CMD:-}" ]; then C=$CONTAINER_CMD
elif type -P docker >/dev/null; then C=docker
elif type -P podman >/dev/null; then C=podman
elif type -P host-spawn >/dev/null; then C="host-spawn podman"
else echo "weder docker noch podman gefunden" >&2; exit 1; fi

$C run -d --name "$NAME" -p "127.0.0.1:$PORT:1521" -e ORACLE_PASSWORD="$ORACLE_PASSWORD" \
  -e APP_USER="$APP" -e APP_USER_PASSWORD="$APP_PASSWORD" "$IMAGE" >/dev/null
echo "warte auf die Datenbank …" >&2
for _ in $(seq 1 120); do
  if [ "$($C logs "$NAME" 2>&1 | grep -c 'DATABASE IS READY')" -gt 0 ]; then break; fi
  sleep 5
done
[ "$($C logs "$NAME" 2>&1 | grep -c 'DATABASE IS READY')" -gt 0 ] || { echo "Datenbank nicht bereit" >&2; exit 1; }

src=$(mktemp -d)
git clone -q --depth 1 --branch "$UTPLSQL" https://github.com/utPLSQL/utPLSQL.git "$src/utPLSQL"
$C cp "$src/utPLSQL/source" "$NAME:/tmp/utplsql"
rm -rf "$src"
# Rights: utPLSQL; V$SESSION and ALTER SYSTEM for the time limit of mutation runs (CANCEL SQL,
# KILL SESSION of the own test session); CREATE ANY CONTEXT for loop limits.
# install_headless.sql ends SQL*Plus itself: the grants need a session of their own.
$C exec -w /tmp/utplsql "$NAME" bash -c "sqlplus -s -L / as sysdba <<SQL >/tmp/utplsql.log 2>&1
whenever sqlerror exit failure
alter session set container=FREEPDB1;
@install_headless.sql ut3 $UT3_PASSWORD users
SQL" || { $C exec "$NAME" tail -30 /tmp/utplsql.log >&2; exit 1; }
$C exec "$NAME" bash -c "sqlplus -s -L / as sysdba <<SQL >/tmp/grants.log 2>&1
whenever sqlerror exit failure
alter session set container=FREEPDB1;
grant select on v_\\\$session to $APP;
grant alter system to $APP;
grant create any context to $APP;
grant create view, create synonym, create materialized view, create job to $APP;
-- a second schema for the tests with several schemas (PLCOV_LIB_SCHEMA / PLMUT_LIB_SCHEMA=${APP}_LIB)
create user ${APP}_lib no authentication quota unlimited on users;
grant create any procedure, execute any procedure to $APP;
exit
SQL" || { $C exec "$NAME" cat /tmp/grants.log >&2; exit 1; }
echo "utPLSQL $UTPLSQL installiert" >&2
echo "oracle://$APP:$APP_PASSWORD@127.0.0.1:$PORT/FREEPDB1"
