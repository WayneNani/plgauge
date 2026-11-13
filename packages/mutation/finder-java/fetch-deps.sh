#!/usr/bin/env bash
# Fetches the parser jars from Maven Central into lib/ and checks their SHA-1.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p lib
fetch() { # group artifact version
  local path="${1//.//}/$2/$3/$2-$3.jar" f="lib/$2-$3.jar"
  [ -f "$f" ] || curl -fsSL "https://repo1.maven.org/maven2/$path" -o "$f"
  local want; want=$(curl -fsSL "https://repo1.maven.org/maven2/$path.sha1" | cut -c1-40)
  echo "$want  $f" | sha1sum -c --quiet
}
fetch org.antlr antlr4-runtime 4.13.2
fetch ch.islandsql islandsql 0.26.0
