#!/usr/bin/env bash
# Smoke test against the running daemon (container name in AR_NAME, default
# anytype-render). Drives the anytype-extension-mcp live-test harness, so it
# needs that checkout and the MCP launcher; both come from local.env.
set -euo pipefail
. "$(dirname "$0")/config.sh"
require AEM_LIVETEST_DIR ANYTYPE_MCP_LAUNCHER ANYTYPE_LIVETEST_SHARED_ROOT
export AEM_LIVETEST_DIR ANYTYPE_MCP_LAUNCHER ANYTYPE_LIVETEST_SHARED_ROOT
cd "$(dirname "$0")"
exec python3 -I smoke.py
