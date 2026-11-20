#!/usr/bin/env bash
# Tests the npm package the way a user gets it: packed, installed from the tarball into an empty
# project, run through npx. Offline commands always; with PLGAUGE_PACK_DB (an oracle:// URL of a
# scratch schema: the order_pricing example is installed there) also a coverage run.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "pack test: $*" >&2; exit 1; }

cd "$root"
[ -f dist/plgauge.mjs ] || npm run -s build
tgz=$(npm pack --silent --pack-destination "$tmp" | tail -1)
echo "$tgz: $(tar -tzf "$tmp/$tgz" | sed 's#^package/##' | sort | tr '\n' ' ')"
tar -tzf "$tmp/$tgz" | grep -qE '^package/(packages|examples|node_modules)/' && fail "sources or examples in the package"

mkdir "$tmp/app"
cd "$tmp/app"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "$tmp/$tgz" >/dev/null
want=$(node -p "require('$root/package.json').version")
[ "$(npx --no -- plgauge --version)" = "$want" ] || fail "--version is not $want"
npx --no -- plgauge mutate points "$root/examples/shop_pricing" | tail -1 | grep -q '^ *81 ' || fail "mutate points: not 81 mutants"
npx --no -- plgauge instrument "$root/examples/order_pricing/src/03_order_pricing.pkb" | grep -qi 'cov\$' || fail "instrument: no probes"
[ -x node_modules/plgauge/ci/setup-db.sh ] || fail "ci/setup-db.sh missing or not executable"

if [ -n "${PLGAUGE_PACK_DB:-}" ]; then
  PLGAUGE_DB=$PLGAUGE_PACK_DB npx --no -- plgauge coverage "$root/examples/order_pricing" --out "$tmp/cov" > "$tmp/cov.log" 2>&1 \
    || { cat "$tmp/cov.log" >&2; fail "coverage run failed"; }
  grep -q 'Branches 65 % (13/20)' "$tmp/cov.log" || { cat "$tmp/cov.log" >&2; fail "coverage: unexpected result"; }
  [ -f "$tmp/cov/index.html" ] && [ -f "$tmp/cov/report.css" ] || fail "coverage: report incomplete"
  echo "coverage run against the database ok"
fi
echo "pack test ok: plgauge $want"
