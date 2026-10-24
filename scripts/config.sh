# Sourced by the scripts. Installation-specific values (container names,
# host paths) live in local.env next to this repository's root, which git
# ignores, and are never defaulted here: a default would carry the layout of
# whatever machine it was written on. See local.env.example.
AR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "${AR_ENV:-$AR_ROOT/local.env}" ]; then
  # shellcheck disable=SC1090
  . "${AR_ENV:-$AR_ROOT/local.env}"
fi

require () {
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      echo "$name is not set; put it in local.env (see local.env.example)" >&2
      exit 2
    fi
  done
}
