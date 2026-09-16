#!/bin/sh
set -eu

# Fail loudly and immediately on missing configuration rather than starting a
# half-configured instance. Every one of these is a secret or a deployment fact
# that has no sane default.
missing=''

for var in DATABASE_URL BETTER_AUTH_SECRET BETTER_AUTH_URL; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    missing="$missing $var"
  fi
done

if [ -n "$missing" ]; then
  echo "clewwiki: refusing to start, missing required environment:$missing" >&2
  echo "clewwiki: copy .env.example to .env and fill every value." >&2
  exit 1
fi

case "$BETTER_AUTH_SECRET" in
  *build-time-placeholder*|change-me*|changeme*)
    echo "clewwiki: BETTER_AUTH_SECRET is still a placeholder." >&2
    echo "clewwiki: generate one with: openssl rand -base64 48" >&2
    exit 1
    ;;
esac

# Migrations are applied by the application on start-up; see
# apps/web/src/instrumentation.ts.
exec "$@"
