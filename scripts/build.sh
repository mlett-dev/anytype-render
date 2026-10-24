#!/usr/bin/env bash
# Build the frontend for one anytype-ts release and the render image on top.
#   scripts/build.sh v0.56.1 [tag]
# The image is tagged anytype-render:<ref>; pass a second argument to add a
# tag (e.g. "test" or "local"). scripts/pairing.sh says which ref fits the
# running anytype-cli.
set -euo pipefail
. "$(dirname "$0")/config.sh"
cd "$AR_ROOT"
REF="${1:?anytype-ts ref, e.g. v0.56.1}"
EXTRA="${2:-}"
OUT="build/web-${REF}"

rm -rf "$OUT"
docker build --build-arg ANYTYPE_TS_REF="$REF" --target out --output "type=local,dest=$OUT" frontend
test -f "$OUT/index.html" || { echo "frontend build produced no index.html" >&2; exit 1; }
echo "frontend $REF, middleware $(cat "$OUT/MIDDLEWARE_VERSION")"

docker build --build-context web="$OUT" -t "anytype-render:$REF" service
if [ -n "$EXTRA" ]; then
  docker tag "anytype-render:$REF" "anytype-render:$EXTRA"
fi
echo "built anytype-render:$REF${EXTRA:+ (also :$EXTRA)}"
