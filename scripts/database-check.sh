#!/bin/sh
set -eu

mode=${1:-test}
case "$mode" in test|generate|verify) ;; *) echo 'Usage: sh scripts/database-check.sh [test|generate|verify]' >&2; exit 2 ;; esac
if [ "$#" -gt 0 ]; then shift; fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
network="vid-database-$$"
database="vid-database-postgres-$$"
generator="vid-database-generator-$$"
runner="vid-database-runner-$$"
redis_server="vid-database-redis-$$"
has_redis=0
has_network=0
has_database=0
has_generator=0
has_runner=0
client=''
staging=$(mktemp -d)
postgres='postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
redis_image='redis:8.10.2-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0'

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  failed=0
  # The client may already have exited; container removal is the authoritative cleanup.
  if [ -n "$client" ]; then kill "$client" 2>/dev/null || :; fi
  if [ "$has_generator" -eq 1 ]; then remove_container "$generator" || failed=1; fi
  if [ "$has_runner" -eq 1 ]; then remove_container "$runner" || failed=1; fi
  if [ "$has_database" -eq 1 ]; then remove_container "$database" || failed=1; fi
  if [ "$has_redis" -eq 1 ]; then remove_container "$redis_server" || failed=1; fi
  if [ -n "$client" ]; then settle_cleanup "$client" 2>/dev/null || :; fi
  if [ "$has_network" -eq 1 ]; then
    docker network rm "$network" >/dev/null &
    settle_cleanup "$!" || failed=1
  fi
  rm -rf "$staging" || failed=1
  if [ "$status" -eq 0 ]; then status=$failed; fi
  exit "$status"
}
# Cleanup cannot rely on an unresponsive daemon eventually returning.
settle_cleanup() {
  attempt=0
  while kill -0 "$1" 2>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 50 ]; then
      echo "Cleanup timed out; resources in network $network may require operator removal" >&2
      kill -KILL "$1" 2>/dev/null || :
      wait "$1" 2>/dev/null || :
      return 1
    fi
    sleep 0.1
  done
  wait "$1"
}

remove_container() {
  docker rm -f -v "$1" >/dev/null &
  settle_cleanup "$!"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

start_container() {
  docker start -a "$1" &
  client=$!
  wait "$client"
  client=''
}

image=$(docker build --quiet -f "$root/deploy/docker/checks.Dockerfile" "$root")
docker network create "$network" >/dev/null
has_network=1
docker create --name "$database" --network "$network" \
  --env POSTGRES_PASSWORD=integration-only --env POSTGRES_DB=vid_test "$postgres" >/dev/null
has_database=1
docker start "$database" >/dev/null
attempt=0
until docker exec "$database" pg_isready -U postgres -d vid_test >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then echo 'Test database did not become ready' >&2; exit 1; fi
  sleep 1
done
url="postgres://postgres:integration-only@$database:5432/vid_test?sslmode=disable"

# This container has no Docker socket, operator configuration, or access to existing databases.
docker create --name "$runner" --network "$network" --env "DATABASE_URL=$url" "$image" \
  sh -ec 'cd packages/database; bun run db:migrate; bun run db:migrate' >/dev/null
has_runner=1
start_container "$runner"
docker rm -v "$runner" >/dev/null
has_runner=0

if [ "$mode" = test ]; then
  docker create --name "$redis_server" --network "$network" "$redis_image" >/dev/null
  has_redis=1
  docker start "$redis_server" >/dev/null
  attempt=0
  until docker exec "$redis_server" redis-cli ping >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then echo 'Test Redis did not become ready' >&2; exit 1; fi
    sleep 1
  done
  if [ "$#" -eq 0 ]; then set -- run test:integration; fi
  docker create --name "$runner" --network "$network" --env "DATABASE_URL=$url" \
    --env "REDIS_URL=redis://$redis_server:6379" "$image" bun "$@" >/dev/null
  has_runner=1
  start_container "$runner"
  exit 0
fi

docker create --name "$generator" --network "$network" --env "DATABASE_URL=$url" "$image" \
  bun run --cwd packages/database db:generate >/dev/null
has_generator=1
start_container "$generator"
docker cp "$generator:/app/packages/database/generated/db.ts" "$staging/db.ts"
docker exec "$database" pg_dump -U postgres -d vid_test --schema-only --schema=product \
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
