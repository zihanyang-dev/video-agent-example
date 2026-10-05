#!/bin/sh
set -eu

mode=${1:-test}
case "$mode" in test|generate|verify) ;; *) echo 'Usage: sh scripts/database-check.sh [test|generate|verify]' >&2; exit 2 ;; esac
if [ "$#" -gt 0 ]; then shift; fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
. "$root/scripts/check-lifecycle.sh"
staging=$(mktemp -d)
owner="vid-database-$$-$(basename "$staging")"
network="$owner"
database="postgres-$owner"
generator="generator-$owner"
runner="runner-$owner"
redis_server="redis-$owner"
has_redis=0
has_network=0
has_database=0
has_generator=0
has_runner=0
postgres='postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
redis_image='redis:8.10.2-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0'

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  failed=0
  # The client may already have exited; container removal is the authoritative cleanup.
  if [ -n "$client" ]; then
    kill "$client" 2>/dev/null || :
    settle_cleanup "$client" 2>/dev/null || failed=1
    client=''
  fi
  if [ "$has_generator" -eq 1 ]; then remove_owned container "$generator" || failed=1; fi
  if [ "$has_runner" -eq 1 ]; then remove_owned container "$runner" || failed=1; fi
  if [ "$has_database" -eq 1 ]; then remove_owned container "$database" || failed=1; fi
  if [ "$has_redis" -eq 1 ]; then remove_owned container "$redis_server" || failed=1; fi
  if [ "$has_network" -eq 1 ]; then
    remove_owned network "$network" || failed=1
  fi
  rm -rf "$staging" || failed=1
  if [ "$failed" -ne 0 ]; then echo "Cleanup incomplete for owned network $network" >&2; fi
  if [ "$status" -eq 0 ]; then status=$failed; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

ready() {
  ready_end=$(($(date +%s) + ${VID_READY_TIMEOUT:-30}))
  until run_stage 1 docker exec "$@" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$ready_end" ]; then
      echo "Service did not become ready: $1" >&2
      return 1
    fi
    sleep 0.1
  done
}

run_stage "$setup_timeout" docker build --quiet -f "$root/deploy/docker/checks.Dockerfile" "$root" > "$staging/image"
image=$(cat "$staging/image")
has_network=1
run_stage "$setup_timeout" docker network create --label "vid.check.owner=$owner" "$network" >/dev/null
has_database=1
run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$database" --network "$network" \
  --env POSTGRES_PASSWORD=integration-only --env POSTGRES_DB=vid_test "$postgres" >/dev/null
run_stage "$setup_timeout" docker start "$database" >/dev/null
ready "$database" pg_isready -U postgres -d vid_test
url="postgres://postgres:integration-only@$database:5432/vid_test?sslmode=disable"

# This container has no Docker socket, operator configuration, or access to existing databases.
has_runner=1
run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$runner" --network "$network" --env "DATABASE_URL=$url" "$image" \
  sh -ec 'cd packages/database; bun run db:migrate; bun run db:migrate' >/dev/null
run_stage "$run_timeout" docker start -a "$runner"
remove_owned container "$runner"
has_runner=0

if [ "$mode" = test ]; then
  has_redis=1
  run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$redis_server" --network "$network" "$redis_image" >/dev/null
  run_stage "$setup_timeout" docker start "$redis_server" >/dev/null
  ready "$redis_server" redis-cli ping
  if [ "$#" -eq 0 ]; then set -- run test:integration; fi
  has_runner=1
  run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$runner" --network "$network" --env "DATABASE_URL=$url" \
    --env "REDIS_URL=redis://$redis_server:6379" "$image" bun "$@" >/dev/null
  run_stage "$run_timeout" docker start -a "$runner"
  exit 0
fi

has_generator=1
run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$generator" --network "$network" --env "DATABASE_URL=$url" "$image" \
  bun run --cwd packages/database db:generate >/dev/null
run_stage "$run_timeout" docker start -a "$generator"
run_stage "$setup_timeout" docker cp "$generator:/app/packages/database/generated/db.ts" "$staging/db.ts"
run_stage "$setup_timeout" docker exec "$database" pg_dump -U postgres -d vid_test --schema-only --schema=auth --schema=product --schema=execution \
  --no-comments --no-owner --no-privileges --restrict-key=vid > "$staging/schema.raw.sql"
# Normalize only trailing blank lines at generation time; preserve the dump body verbatim.
awk 'NF { printf "%s", pending; print; pending=""; next } { pending=pending $0 ORS }' \
  "$staging/schema.raw.sql" > "$staging/schema.sql"

if [ "$mode" = verify ]; then
  cmp "$staging/db.ts" "$root/packages/database/generated/db.ts"
  cmp "$staging/schema.sql" "$root/packages/database/generated/schema.sql"
  echo 'Generated database artifacts match migrations.'
else
  cp "$staging/db.ts" "$staging/schema.sql" "$root/packages/database/generated/"
fi
