#!/bin/sh
set -eu
cd "$(dirname -- "$0")/../packages/database"

# scripts/database-check.sh supplies a fresh database containing only this checkout's migrations.
bun x --no-install kysely-codegen --dialect postgres --default-schema public \
  --env-file /dev/null --include-pattern 'product.*' --out-file generated/db.ts

# Generated artifacts are formatted by their generator, not by the source formatter.
bun x --no-install prettier --write --ignore-path /dev/null generated/db.ts
