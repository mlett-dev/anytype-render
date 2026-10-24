#!/usr/bin/env bash
# Start the render daemon in the anytype-cli container's network namespace.
# Meant for systemd (Restart=always): the daemon exits when heart becomes
# unreachable or stops accepting the token, and a restart here fetches a
# fresh token and joins the new namespace.
#
# Secrets go to the container through the environment (-e NAME), never on
# the command line, which every local user can read through ps.
set -euo pipefail
. "$(dirname "$0")/config.sh"
require AR_CLI_CONTAINER
cd /

CLI="$AR_CLI_CONTAINER"
TAG="${AR_TAG:-local}"
NAME="${AR_NAME:-anytype-render}"

# A test instance next to the production one: its own name and ports
# (AR_NAME, AR_APP_PORT, AR_API_PORT), and with AR_DEV_SRC=1 this checkout's
# service/src mounted over the image's, so a restart replaces a rebuild.
EXTRA=()
if [ -n "${AR_APP_PORT:-}" ]; then APP_PORT="$AR_APP_PORT"; export APP_PORT; EXTRA+=(-e APP_PORT); fi
if [ -n "${AR_API_PORT:-}" ]; then API_PORT="$AR_API_PORT"; export API_PORT; EXTRA+=(-e API_PORT); fi
if [ "${AR_DEV_SRC:-}" = 1 ]; then EXTRA+=(-v "$AR_ROOT/service/src:/app/src:ro"); fi

SESSION_TOKEN="$(docker exec "$CLI" /usr/local/bin/print-session-token)"
ACCOUNT_ID="$(docker exec "$CLI" /usr/local/bin/anytype auth status 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | sed -n 's/.*Logged in to account \([A-Za-z0-9]*\).*/\1/p' | head -1)"
if [ -z "$ACCOUNT_ID" ] || [ -z "$SESSION_TOKEN" ]; then
  echo "anytype-cli gave no account id or token" >&2
  exit 1
fi
export SESSION_TOKEN ACCOUNT_ID

docker rm -f "$NAME" >/dev/null 2>&1 || true
exec docker run --rm --init --name "$NAME" \
  --network "container:${CLI}" \
  --memory 2g --shm-size 512m \
  -e SESSION_TOKEN -e ACCOUNT_ID \
  "${EXTRA[@]}" \
  "anytype-render:${TAG}"
