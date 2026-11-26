#!/usr/bin/env bash
# Refuse to publish things that should not leave this machine.
#
# This repository is public and every push is immediate, so the checks run
# automatically from the git hooks in .githooks (core.hooksPath):
#
#   pre-commit   check-private.sh              the staged content (what the
#                                              commit records, not the worktree)
#   commit-msg   check-private.sh --msg FILE   the commit message
#   pre-push     check-private.sh --range A..B every commit about to be pushed:
#                                              added lines and messages, so a
#                                              commit made with --no-verify or
#                                              before the hooks existed is
#                                              still caught
#
# By hand: --all scans every tracked file.
#
# Three layers, deliberately:
#
#   1. The generic patterns below. They describe shapes that are dangerous
#      anywhere (credentials, absolute host paths, real content IDs, identity
#      keys) and are safe to keep in a public file because they name no secret.
#
#   2. An optional deny list in .private-patterns (git-ignored, one extended
#      regex per line, "#" comments allowed, matched case-insensitively).
#      Installation-specific strings (host and person names, space names,
#      container names, network IDs) belong there and NOT in this file,
#      because writing them here would publish exactly what they keep out.
#
#   3. Known secrets in .private-secrets (git-ignored). One entry per line:
#        label<TAB>file:/path/to/secret
#        label<TAB>cmd:command that prints the secret
#      The actual values are compared as fixed strings and never printed, so
#      even a secret of no recognisable shape is caught.
#
# Exit code is 1 on any hit.

set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1

MODE="staged"
ARG=""
case "${1:-}" in
  --all) MODE="all" ;;
  --msg) MODE="msg"; ARG="${2:?--msg needs the message file}" ;;
  --range) MODE="range"; ARG="${2:?--range needs A..B}" ;;
  "") ;;
  *) echo "usage: $0 [--all | --msg FILE | --range A..B]" >&2; exit 2 ;;
esac

# /root/.anytype is the account directory inside the server container (the
# documented mount point) and /opt/protoc the compiler inside a build image,
# not host paths; an assignment from "$(command)" or "${VAR}" holds no secret; Participant-IDs carry a full space
# ID after the prefix, so short test stand-ins like _participant_abc pass.
#
# Placeholders that look like the real thing on purpose. Test fixtures need to
# resemble content IDs, or they would not exercise the code that parses them.
ALLOW='gibtesnicht|xxxxxxxx|EXAMPLE|example\.(com|test|org)|noreply@anthropic\.com|git@mlett\.dev'

# Several rules need PCRE (lookahead). Refuse to report "clean" for rules that
# never ran.
if ! echo x | grep -qP x 2>/dev/null; then
  echo "check-private: grep -P is unavailable; refusing to run a partial check" >&2
  exit 1
fi

# name<TAB>pattern (PCRE)
PATTERNS=$(cat <<'EOF'
Host-Pfad	/(home|Users|srv|mnt)/[A-Za-z0-9._-]+|/opt/(?!protoc\b)[A-Za-z0-9._-]+|/root/(?!\.anytype\b)[A-Za-z0-9._-]+
GitHub-Token	gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}
API-Token	\b(sk|xoxb|xoxp|xoxa|xoxr|glpat)-[A-Za-z0-9_-]{16,}|\bsk-(ant|proj)-[A-Za-z0-9_-]{8,}
Google-API-Key	\bAIza[0-9A-Za-z_-]{35}\b
Telegram-Bot-Token	\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,40}\b
AWS-Key	\bAKIA[0-9A-Z]{16}\b
Privater Schlüssel	-----BEGIN [A-Z ]*PRIVATE KEY-----
JWT	\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.
Bearer-Token	(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{20,}
Zugewiesenes Geheimnis	(?i)\b(password|passwd|secret|api_?key|access_?token|session_?token)\b\s*[:=]\s*['"](?!\$[({])[^'"]{8,}['"]
Echte Content-ID	\bbaf[ky][a-z2-7]{20,}
Participant-ID	_participant_[a-z0-9]{20,}
Anytype-Identity	\bA[1-9A-HJ-NP-Za-km-z]{47}\b
Tunnel-ID	\btunnel_[0-9a-f]{24,}
Nicht-Loopback-IP	\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)([0-9]{1,3}\.){3}[0-9]{1,3}\b
IPv6-Adresse	(?i)\b(?:2[0-9a-f]{3}|f[cd][0-9a-f]{2}):(?:[0-9a-f]{0,4}:){2,6}[0-9a-f]{1,4}\b
E-Mail-Adresse	[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
Sitzungs-URL	(?i)claude-session:|claude\.ai/code/session|chatgpt\.com/(c|share)/
EOF
)

if [ -f .private-patterns ]; then
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    PATTERNS="$PATTERNS
Lokale Deny-Liste	(?i)$line"
  done < .private-patterns
else
  echo "check-private: warning: no .private-patterns, installation-specific names are not checked" >&2
fi

WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT

# Collect the text to scan as files under $WORK, named after their source so a
# hit says where it is. Binary content is skipped by grep -I.
add_text() {  # label, then content on stdin
  cat > "$WORK/$(printf '%s' "$1" | tr '/ ' '__')"
}
skip() {
  case "$1" in go.sum|*/go.sum|scripts/check-private.sh) return 0 ;; esac
  return 1
}

case "$MODE" in
  staged)
    while IFS= read -r f; do
      [ -n "$f" ] && ! skip "$f" && git show ":$f" 2>/dev/null | add_text "staged:$f"
    done < <(git diff --cached --name-only --diff-filter=ACMR)
    ;;
  all)
    while IFS= read -r f; do
      [ -f "$f" ] && ! skip "$f" && add_text "tracked:$f" < "$f"
    done < <(git ls-files)
    ;;
  msg)
    # Comment lines are dropped by git; scan what is recorded.
    grep -v '^#' "$ARG" | add_text "commit-message"
    ;;
  range)
    while IFS= read -r c; do
      git log -1 --format='%B' "$c" | add_text "message:$c"
      # Only added lines, without the diff's "+" (it would join a match, e.g.
      # "+@file" reads as an e-mail address); removed lines are already public.
      git show --format= --no-color --unified=0 "$c" -- . ':(exclude)go.sum' ':(exclude)*/go.sum' ':(exclude)scripts/check-private.sh' \
        | grep '^+' | grep -v '^+++ ' | sed 's/^+//' | add_text "commit:$c"
    done < <(git rev-list "$ARG")
    ;;
esac

if [ -z "$(ls -A "$WORK")" ]; then
  echo "check-private: nothing to scan"
  exit 0
fi

FOUND=0
report() {  # name, hits
  [ $FOUND -eq 0 ] && echo "check-private: refusing to publish the following." && echo
  FOUND=1
  printf '  [%s]\n' "$1"
  printf '%s\n' "$2" | sed "s|^$WORK/||; s/^/    /" | cut -c1-200 | head -12
  echo
}

while IFS=$'\t' read -r NAME PATTERN; do
  [ -z "${PATTERN:-}" ] && continue
  HITS=$(grep -rnIHP --binary-files=without-match -- "$PATTERN" "$WORK" 2>/dev/null | grep -vE "$ALLOW")
  [ -n "$HITS" ] && report "$NAME" "$HITS"
done <<< "$PATTERNS"

# Known secrets: compare values, report only labels and locations.
if [ -f .private-secrets ]; then
  while IFS=$'\t' read -r LABEL SOURCE; do
    case "$LABEL" in ''|'#'*) continue ;; esac
    VALUE=""
    case "${SOURCE:-}" in
      file:*) VALUE=$(tr -d '\r\n' < "${SOURCE#file:}" 2>/dev/null) ;;
      cmd:*)  VALUE=$(bash -c "${SOURCE#cmd:}" 2>/dev/null | tr -d '\r\n') ;;
    esac
    if [ ${#VALUE} -lt 8 ]; then
      echo "check-private: warning: secret '$LABEL' could not be read, not checked" >&2
      continue
    fi
    WHERE=$(grep -rlF -- "$VALUE" "$WORK" 2>/dev/null | sed "s|^$WORK/||")
    [ -n "$WHERE" ] && report "Bekanntes Geheimnis: $LABEL" "$WHERE"
  done < .private-secrets
  unset VALUE
else
  echo "check-private: warning: no .private-secrets, known secret values are not checked" >&2
fi

if [ $FOUND -ne 0 ]; then
  cat <<'MSG'
  Fix the lines above, or, if a hit is a false positive, add a narrower
  allowance rather than widening ALLOW. A commit message is fixed with
  `git commit --amend`; an unpushed commit with `git rebase`.

MSG
  exit 1
fi

echo "check-private: clean ($(ls "$WORK" | wc -l) items, $MODE)"
exit 0
