#!/usr/bin/env bash
# Which anytype-ts release fits the running anytype-cli?
#
# anytype-cli pins a heart version in its go.mod; every anytype-ts release
# names the heart it was built against in middleware.version. The fitting
# release is the newest stable one whose middleware shares heart's
# major.minor. Prints the recommendation and what is built now.
#
# Needs gh (GitHub API). Read-only.
set -euo pipefail
. "$(dirname "$0")/config.sh"
require AR_CLI_CONTAINER
cd "$AR_ROOT"
CLI="$AR_CLI_CONTAINER"
SCAN="${AR_SCAN_TAGS:-60}"

cli_tag="$(docker exec "$CLI" /usr/local/bin/anytype version 2>/dev/null | grep -o 'v[0-9][0-9.]*' | head -1)"
heart="$(gh api "repos/anyproto/anytype-cli/contents/go.mod?ref=${cli_tag}" --jq .content | base64 -d \
  | awk '$1=="github.com/anyproto/anytype-heart"{print $2}' | head -1)"
minor="$(echo "${heart#v}" | cut -d. -f1,2)"
echo "anytype-cli ${cli_tag} runs heart ${heart}"

best=""; best_mw=""
for tag in $(gh api "repos/anyproto/anytype-ts/tags?per_page=${SCAN}" --jq '.[].name' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'); do
  mw="$(gh api "repos/anyproto/anytype-ts/contents/middleware.version?ref=${tag}" --jq .content 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [ "$(echo "$mw" | cut -d. -f1,2)" = "$minor" ]; then
    best="$tag"; best_mw="$mw"
    break   # tags come newest first
  fi
done

built="$(docker run --rm --entrypoint cat anytype-render:local /web/ANYTYPE_TS_REF 2>/dev/null || echo none)"
if [ -z "$best" ]; then
  echo "no stable anytype-ts release among the last ${SCAN} tags uses heart ${minor}.x" >&2
  echo "built now: ${built}"
  exit 1
fi
echo "fitting anytype-ts: ${best} (middleware ${best_mw})"
echo "built now (anytype-render:local): ${built}"
if [ "$best" != "$built" ]; then
  echo "update: scripts/build.sh ${best} test && scripts/smoke.sh, then retag :local"
fi
