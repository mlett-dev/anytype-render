#!/usr/bin/env bash
# Refuse to publish things that should not leave this machine.
#
# This repository is public and every push is immediate, so the check runs
# before the commit rather than after the fact. It scans the *staged* content
# by default, which is what a commit would actually record; pass --all to scan
# the whole working tree instead.
#
# Two layers, deliberately:
#
#   1. The generic patterns below. They describe shapes that are dangerous
#      anywhere — credentials, absolute home directories, real content IDs —
#      and are safe to keep in a public file because they name no secret.
#
#   2. An optional deny list in .private-patterns (git-ignored, one extended
#      regex per line, "#" comments allowed). Installation-specific strings —
#      host paths, container names, space names, network IDs — belong there
#      and NOT in this file, because writing them here would publish exactly
#      what they are meant to keep out.
#
# Exit code is 1 on any hit, so it works as a pre-commit hook and in CI.

set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1

MODE="staged"
[ "${1:-}" = "--all" ] && MODE="all"

# Placeholders that look like the real thing on purpose. Test fixtures need to
# resemble content IDs, or they would not exercise the code that parses them.
ALLOW='gibtesnicht|xxxxxxxx|EXAMPLE|example\.(com|test|org)'

# The IP rule needs a negative lookahead to spare the documented loopback
# defaults, which POSIX ERE cannot express — an -E run would match nothing and
# say so silently. Prefer PCRE and report when it is unavailable, rather than
# reporting "clean" for a rule that never ran.
if echo x | grep -qP x 2>/dev/null; then
  GREPFLAGS='-nIEHP'
  GREPFLAGS="${GREPFLAGS//E/}"
else
  GREPFLAGS='-nIEH'
  echo "check-private: warning — grep -P unavailable, the IP rule is skipped" >&2
  SKIP_PCRE_RULES=1
fi
SKIP_PCRE_RULES="${SKIP_PCRE_RULES:-0}"

# name<TAB>pattern
PATTERNS=$(cat <<'EOF'
Home-Verzeichnis	/(home|Users)/[a-zA-Z0-9._-]+/
GitHub-Token	gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}
API-Token	\b(sk|xoxb|xoxp|glpat)-[A-Za-z0-9_-]{16,}
AWS-Key	\bAKIA[0-9A-Z]{16}\b
Privater Schlüssel	-----BEGIN [A-Z ]*PRIVATE KEY-----
JWT	\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.
Zugewiesenes Geheimnis	\b(password|passwd|secret|api_?key|access_?token)\b[[:space:]]*[:=][[:space:]]*['\"][^'\"]{8,}['\"]
Echte Objekt-ID	\bbafyrei[a-z0-9]{20,}
Nicht-Loopback-IP	\b(?!127\.0\.0\.1|0\.0\.0\.0)([0-9]{1,3}\.){3}[0-9]{1,3}\b
E-Mail-Adresse	[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
EOF
)

if [ -f .private-patterns ]; then
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    PATTERNS="$PATTERNS
Lokale Deny-Liste	$line"
  done < .private-patterns
fi

# The set of files to scan. Binary files are skipped by grep -I.
if [ "$MODE" = "staged" ]; then
  mapfile -t FILES < <(git diff --cached --name-only --diff-filter=ACMR)
else
  mapfile -t FILES < <(git ls-files)
fi

# go.sum is a generated list of module hashes: long opaque strings that trip
# several patterns and can hold nothing of ours.
FILTERED=()
for f in "${FILES[@]}"; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  case "$f" in go.sum|*/go.sum|scripts/check-private.sh) continue ;; esac
  FILTERED+=("$f")
done

if [ ${#FILTERED[@]} -eq 0 ]; then
  echo "check-private: nothing to scan"
  exit 0
fi

FOUND=0
while IFS=$'\t' read -r NAME PATTERN; do
  [ -z "${PATTERN:-}" ] && continue
  if [ "$SKIP_PCRE_RULES" = "1" ] && [ "$NAME" = "Nicht-Loopback-IP" ]; then
    continue
  fi
  HITS=$(grep $GREPFLAGS --binary-files=without-match "$PATTERN" "${FILTERED[@]}" 2>/dev/null \
         | grep -vE "$ALLOW")
  if [ -n "$HITS" ]; then
    [ $FOUND -eq 0 ] && echo "check-private: refusing to publish the following." && echo
    FOUND=1
    printf '  [%s]\n' "$NAME"
    printf '%s\n' "$HITS" | sed 's/^/    /' | head -12
    echo
  fi
done <<< "$PATTERNS"

if [ $FOUND -ne 0 ]; then
  cat <<'MSG'
  Fix the lines above, or — if a hit is a false positive — add a narrower
  allowance rather than widening ALLOW. To commit anyway, deliberately:

      git commit --no-verify

MSG
  exit 1
fi

echo "check-private: clean (${#FILTERED[@]} files, $MODE)"
exit 0
