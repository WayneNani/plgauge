#!/usr/bin/env bash
# Downloads the public PL/SQL robustness corpus at fixed commits (same set as plmut).
# Nothing of it is checked in; it lands in corpus/.cache/. Check licences per file before redistributing.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .cache
fetch() { # name url commit
  local dir=".cache/$1"
  if [ ! -d "$dir/.git" ]; then git clone --quiet --filter=blob:none "$2" "$dir"; fi
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "$3"
  echo "$1 @ $(git -C "$dir" rev-parse --short HEAD)"
}
fetch utplsql-3.1.14 https://github.com/utPLSQL/utPLSQL.git          072dfbc1   # Apache 2.0
fetch logger         https://github.com/OraOpenSource/Logger.git     600f0c44   # MIT
fetch alexandria     https://github.com/mortenbra/alexandria-plsql-utils.git ada48755  # per-file licences
fetch pljson         https://github.com/pljson/pljson.git            09a54e4e   # MIT
fetch console        https://github.com/ogobrecht/console.git        72ff8f85   # MIT
# added for A5 (larger corpus), plgauge
fetch utplsql-3.2.2      https://github.com/utPLSQL/utPLSQL.git                  5852e44d   # Apache 2.0
fetch oos-utils          https://github.com/OraOpenSource/oos-utils.git          b6217292   # MIT
fetch plex               https://github.com/ogobrecht/plex.git                   3b13e44d   # MIT
fetch oracle-db-examples https://github.com/oracle-samples/oracle-db-examples.git f02e504e   # UPL / per directory
# added for A10 (SQL operators): SQL-heavy code with utPLSQL tests
fetch plscope-utils      https://github.com/PhilippSalvisberg/plscope-utils.git  dc22daf    # Apache 2.0
