#!/bin/sh
set -eu

mode=${1:-test}
case "$mode" in test|check|generate|verify) ;; *) echo 'Usage: sh scripts/database-check.sh [test|check|generate|verify]' >&2; exit 2 ;; esac
if [ "$#" -gt 0 ]; then shift; fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
. "$root/scripts/check-lifecycle.sh"
staging=$(mktemp -d)
owner="vid-database-$$-$(basename "$staging")"
test_owner=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
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
  # Container removal is the authoritative cleanup, not Docker client exit.
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

image=${VID_CHECK_IMAGE:-}
if [ -z "$image" ]; then
  run_stage "$setup_timeout" docker build --quiet -f "$root/deploy/docker/checks.Dockerfile" "$root" > "$staging/image"
  image=$(cat "$staging/image")
fi
cat > "$staging/compose.yaml" <<YAML
services:
  postgres:
    image: $postgres
    container_name: $database
    labels:
      vid.check.owner: $owner
    environment:
      POSTGRES_PASSWORD: integration-only
      POSTGRES_DB: vid_test
    healthcheck:
      test: [CMD, pg_isready, -h, 127.0.0.1, -U, postgres, -d, vid_test]
      interval: 1s
      timeout: 5s
      retries: 60
  redis:
    image: $redis_image
    container_name: $redis_server
    labels:
      vid.check.owner: $owner
    healthcheck:
      test: [CMD, redis-cli, ping]
      interval: 1s
      timeout: 5s
      retries: 60
networks:
  default:
    external: true
    name: $network
YAML
compose() { run_stage "$setup_timeout" docker compose --project-name "$owner" -f "$staging/compose.yaml" "$@"; }
has_network=1
run_stage "$setup_timeout" docker network create --label "vid.check.owner=$owner" "$network" >/dev/null
has_database=1
compose up -d --wait --wait-timeout "$ready_timeout" postgres
# Only this fresh, labelled database receives the per-launch admission marker.
run_stage "$setup_timeout" docker exec "$database" psql -X -v ON_ERROR_STOP=1 -U postgres -d vid_test \
  -c "COMMENT ON DATABASE vid_test IS 'vid-test-database:$test_owner'" >/dev/null
url="postgres://postgres:integration-only@$database:5432/vid_test?sslmode=disable"
DATABASE_URL=$url
VID_TEST_DATABASE_OWNER=$test_owner
export DATABASE_URL VID_TEST_DATABASE_OWNER

# This container has no Docker socket, operator configuration, or access to existing databases.
has_runner=1
run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$runner" --network "$network" --env DATABASE_URL "$image" \
  sh -ec 'cd packages/database; bun run db:migrate; bun run db:migrate' >/dev/null
run_stage "$run_timeout" docker start -a "$runner"
remove_owned container "$runner"
has_runner=0

generate_artifacts() {
  has_generator=1
  run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$generator" --network "$network" --env DATABASE_URL "$image" \
    bun run --cwd packages/database db:generate >/dev/null
  run_stage "$run_timeout" docker start -a "$generator"
  run_stage "$setup_timeout" docker cp "$generator:/app/packages/database/generated/db.ts" "$staging/db.ts"
  run_stage "$setup_timeout" docker exec "$database" pg_dump -U postgres -d vid_test --schema-only --schema=auth --schema=product --schema=execution \
    --no-comments --no-owner --no-privileges --restrict-key=vid > "$staging/schema.raw.sql"
  # Preserve the dump body, normalizing only trailing blank lines.
  awk 'NF { printf "%s", pending; print; pending=""; next } { pending=pending $0 ORS }' \
    "$staging/schema.raw.sql" > "$staging/schema.sql"
  if [ "$mode" = generate ]; then
    cp "$staging/db.ts" "$root/packages/database/generated/db.ts"
    cp "$staging/schema.sql" "$root/packages/database/generated/schema.sql"
  else
    cmp "$staging/db.ts" "$root/packages/database/generated/db.ts"
    cmp "$staging/schema.sql" "$root/packages/database/generated/schema.sql"
    echo 'Generated database artifacts match migrations.'
  fi
}

if [ "$mode" != test ]; then generate_artifacts; fi
if [ "$mode" = test ] || [ "$mode" = check ]; then
  has_redis=1
  compose up -d --wait --wait-timeout "$ready_timeout" redis
  # Runtime uses DB0; only execution-transport tests may consume reserved DB15.
  # Seed the capability on this exact newly created, labelled Redis instance.
  run_stage "$setup_timeout" docker exec "$redis_server" redis-cli -n 15 SET vid:test:owner "$test_owner" >/dev/null
  VID_TEST_REDIS_OWNER=$test_owner
  VID_TEST_REDIS_TRANSPORT_URL="redis://$redis_server:6379/15"
  export VID_TEST_REDIS_OWNER VID_TEST_REDIS_TRANSPORT_URL
  if [ "$#" -eq 0 ]; then set -- run test:integration; fi
  has_runner=1
  run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$runner" --network "$network" --env DATABASE_URL \
    --env VID_TEST_DATABASE_OWNER --env VID_TEST_REDIS_OWNER --env VID_TEST_REDIS_TRANSPORT_URL \
    --env "REDIS_URL=redis://$redis_server:6379" "$image" bun "$@" >/dev/null
  run_stage "$run_timeout" docker start -a "$runner"
  exit 0
fi
