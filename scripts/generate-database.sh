#!/bin/sh
set -eu
cd "$(dirname -- "$0")/../packages/database"

# Stage on the destination filesystem; failures must leave the prior types intact.
staging=$(mktemp -d generated/.db-types-XXXXXX)
trap 'rm -rf "$staging"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# scripts/database-check.sh supplies a fresh database containing only this checkout's migrations.
bun x --no-install kysely-codegen --dialect postgres --default-schema public \
  --env-file /dev/null --include-pattern '{auth,product,execution}.*' --out-file "$staging/db.ts"

# Generated artifacts are formatted by their generator, not by the source formatter.
bun x --no-install prettier --write --ignore-path /dev/null "$staging/db.ts"
mv -f "$staging/db.ts" generated/db.ts
