#!/usr/bin/env bash
# Compiles the finder into classes/.
set -euo pipefail
cd "$(dirname "$0")"
[ -f lib/islandsql-0.26.0.jar ] || ./fetch-deps.sh
rm -rf classes && mkdir classes
javac -nowarn -encoding UTF-8 -cp 'lib/*' -d classes $(find src -name '*.java')
