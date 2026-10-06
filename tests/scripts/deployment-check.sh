#!/bin/sh
# Exercise the shipped Compose on fresh, isolated volumes. No model or VM calls.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
. "$root/scripts/check-lifecycle.sh"
umask 077
mkdir -p .cache
staging=$(mktemp -d "$root/.cache/deployment.XXXXXX")
project="vid-deployment-$(basename "$staging" | tr '[:upper:].' '[:lower:]-')"
compose() { run_stage "$run_timeout" docker compose --project-name "$project" --env-file "$staging/env" -f "$root/compose.yaml" -f "$staging/probe.yaml" "$@"; }
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  # Only this test's project is removed; cleanup has its own bounded CLI stage.
  run_stage "$setup_timeout" docker compose --project-name "$project" --env-file "$staging/env" -f "$root/compose.yaml" -f "$staging/probe.yaml" down --volumes --remove-orphans || status=1
  rm -rf "$staging" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$staging/env" <<'ENV'
POSTGRES_DB=vid_test
POSTGRES_PASSWORD=0000000000000000000000000000000000000000000000000000000000000001
SERVER_DB_PASSWORD=0000000000000000000000000000000000000000000000000000000000000002
WORKER_DB_PASSWORD=0000000000000000000000000000000000000000000000000000000000000003
SERVER_REDIS_PASSWORD=0000000000000000000000000000000000000000000000000000000000000004
WORKER_REDIS_PASSWORD=0000000000000000000000000000000000000000000000000000000000000005
AUTH_BASE_URL=http://127.0.0.1:8787
AUTH_SECRET=owned-deployment-test-auth-secret-at-least-32
GITHUB_CLIENT_ID=fixture-only
GITHUB_CLIENT_SECRET=fixture-only
OBJECT_STORAGE_ROOT_USER=owned-storage-admin
OBJECT_STORAGE_ROOT_PASSWORD=owned-storage-admin-secret
OBJECT_STORAGE_URL=http://objects:9000
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=workspace-test
SERVER_OBJECT_STORAGE_ACCESS_KEY_ID=owned-storage-test
SERVER_OBJECT_STORAGE_SECRET_ACCESS_KEY=owned-storage-test-secret
WORKER_OBJECT_STORAGE_ACCESS_KEY_ID=owned-storage-worker
WORKER_OBJECT_STORAGE_SECRET_ACCESS_KEY=owned-storage-worker-secret
MODEL_BASE_URL=http://unused-model:8080
MODEL_API_KEY=fixture-never-called
MODEL_ID=fixture
MODEL_CONTEXT_WINDOW=4096
MODEL_MAX_OUTPUT_TOKENS=1024
E2B_API_URL=http://unused-vm:8080
E2B_SANDBOX_URL=http://unused-vm:8080
E2B_API_KEY=fixture-never-called
ENV
test_owner=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
printf 'VID_TEST_DATABASE_OWNER=%s\n' "$test_owner" >> "$staging/env"
# Use the already-built filtered checks image, if provided by CI.
if [ -z "${VID_CHECK_IMAGE:-}" ]; then
  VID_CHECK_IMAGE=$(run_stage "$setup_timeout" docker build --quiet -f "$root/deploy/docker/checks.Dockerfile" "$root")
fi
printf 'VID_CHECK_IMAGE=%s\n' "$VID_CHECK_IMAGE" >> "$staging/env"
cat > "$staging/probe.yaml" <<'YAML'
services:
  redis:
    volumes: !override
      - type: tmpfs
        target: /data
  web:
    ports: !reset []
  probe:
    profiles: [checks]
    image: ${VID_CHECK_IMAGE}
    environment:
      VID_TEST_DATABASE_OWNER: ${VID_TEST_DATABASE_OWNER}
      STORAGE_TEST_ADMIN_ACCESS_KEY: ${OBJECT_STORAGE_ROOT_USER}
      STORAGE_TEST_ADMIN_SECRET_KEY: ${OBJECT_STORAGE_ROOT_PASSWORD}
      REDIS_URL: redis://vid_server:${SERVER_REDIS_PASSWORD}@redis:6379
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?sslmode=disable
      SERVER_DATABASE_URL: postgres://vid_server:${SERVER_DB_PASSWORD}@postgres:5432/${POSTGRES_DB}?sslmode=disable
      WORKER_DATABASE_URL: postgres://vid_worker:${WORKER_DB_PASSWORD}@postgres:5432/${POSTGRES_DB}?sslmode=disable
      OLD_SERVER_DATABASE_URL: postgres://vid_server:0000000000000000000000000000000000000000000000000000000000000002@postgres:5432/${POSTGRES_DB}?sslmode=disable
      OLD_WORKER_DATABASE_URL: postgres://vid_worker:0000000000000000000000000000000000000000000000000000000000000003@postgres:5432/${POSTGRES_DB}?sslmode=disable
      SERVER_REDIS_URL: redis://vid_server:${SERVER_REDIS_PASSWORD}@redis:6379
      WORKER_REDIS_URL: redis://vid_worker:${WORKER_REDIS_PASSWORD}@redis:6379
      STORAGE_TEST_ENDPOINT: http://objects:9000
      OBJECT_STORAGE_BUCKET: ${OBJECT_STORAGE_BUCKET}
      STORAGE_SERVER_ACCESS_KEY: ${SERVER_OBJECT_STORAGE_ACCESS_KEY_ID}
      STORAGE_SERVER_SECRET_KEY: ${SERVER_OBJECT_STORAGE_SECRET_ACCESS_KEY}
      STORAGE_WORKER_ACCESS_KEY: ${WORKER_OBJECT_STORAGE_ACCESS_KEY_ID}
      STORAGE_WORKER_SECRET_KEY: ${WORKER_OBJECT_STORAGE_SECRET_ACCESS_KEY}
      OLD_STORAGE_SERVER_SECRET_KEY: owned-storage-test-secret
      OLD_STORAGE_WORKER_SECRET_KEY: owned-storage-worker-secret
      DEPLOYMENT_WEB_URL: http://web:8080
    command: [bun, test, tests/scripts/deployment-boundaries.test.ts]
YAML

# Default startup must include the application prerequisites.
compose config --services > "$staging/services"
for service in objects storage-init worker; do
  grep -qx "$service" "$staging/services"
done

# This is the operator's actual startup command, not a second deployment recipe.
compose up --build -d --wait --wait-timeout 120
# Start the packaged worker, but never submit a command to paid providers.
compose exec -T worker bun -e '
  await Bun.file("/app/apps/agent/prompt.md").text()
  for (const key of ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "OBJECT_STORAGE_ROOT_PASSWORD", "AUTH_SECRET", "SERVER_DB_PASSWORD"])
    if (Bun.env[key]) throw new Error("Unexpected credential projection")
'
compose exec -T server bun -e '
  for (const key of ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "OBJECT_STORAGE_ROOT_PASSWORD", "MODEL_API_KEY", "E2B_API_KEY", "WORKER_DB_PASSWORD"])
    if (Bun.env[key]) throw new Error("Unexpected credential projection")
'
# Stop the unchanged, healthy application and verify successful settlement.
compose stop worker
worker_id=$(compose ps -a -q worker)
[ "$(docker inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}}' "$worker_id")" = '0 false' ]
compose exec -T postgres psql -X -U postgres -d vid_test -v ON_ERROR_STOP=1 \
  -c "COMMENT ON DATABASE vid_test IS 'vid-test-database:$test_owner'"
compose run --rm -T --no-deps probe bun test tests/storage
# Historical data is administrator-seeded, not writable by either app role.
printf 'legacy-upload' > "$staging/legacy-upload"
compose exec -T objects sh -ec '
  export MC_CONFIG_DIR=/tmp/owned-client
  printf "%s\n%s\n" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" |
    mcli alias set local http://objects:9000 >/dev/null 2>&1
  mcli pipe local/workspace-test/materials/boundary >/dev/null 2>&1
' < "$staging/legacy-upload"
printf 'legacy-output' > "$staging/legacy-output"
compose exec -T objects mcli --config-dir /tmp/owned-client pipe local/workspace-test/artifacts/boundary < "$staging/legacy-output"
compose run --rm -T --no-deps probe bun test tests/scripts/deployment-boundaries.test.ts -t 'S3 asset'
compose stop objects
compose up -d --wait objects
compose run --rm -T storage-init
compose run --rm -T storage-init
# External S3 is not provisioned or contacted with the local root secret.
compose run --rm -T -e OBJECT_STORAGE_URL=http://unprovisioned-external:9000 storage-init
compose run --rm -T --no-deps probe bun test tests/scripts/deployment-boundaries.test.ts -t 'S3 retained'

compose exec -T postgres psql -X -U postgres -d vid_test -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE auth.boundary_existing_table (id int);
CREATE TABLE execution.boundary_existing_table (id int);
GRANT USAGE ON SCHEMA auth TO vid_worker;
GRANT USAGE ON SCHEMA execution TO vid_server;
GRANT CREATE ON SCHEMA auth TO vid_server;
GRANT CREATE ON SCHEMA execution TO vid_worker;
GRANT TRUNCATE ON auth.boundary_existing_table TO vid_server;
GRANT TRUNCATE ON execution.boundary_existing_table TO vid_worker;
GRANT SELECT ON auth.boundary_existing_table TO vid_worker;
GRANT SELECT ON execution.boundary_existing_table TO vid_server;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT SELECT ON TABLES TO vid_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA auth GRANT SELECT ON TABLES TO vid_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA execution GRANT SELECT ON TABLES TO vid_server;
SQL

# Restart PostgreSQL on its retained volume, including the damaged grant fixtures.
compose stop server postgres
compose up -d --wait --wait-timeout 60 postgres

# Reapply the same native initialization with rotated fixture passwords.
sed -e 's/^SERVER_DB_PASSWORD=.*/SERVER_DB_PASSWORD=0000000000000000000000000000000000000000000000000000000000000006/' -e 's/^SERVER_OBJECT_STORAGE_SECRET_ACCESS_KEY=.*/SERVER_OBJECT_STORAGE_SECRET_ACCESS_KEY=rotated-server-secret/' -e 's/^WORKER_OBJECT_STORAGE_SECRET_ACCESS_KEY=.*/WORKER_OBJECT_STORAGE_SECRET_ACCESS_KEY=rotated-worker-secret/' -e 's/^WORKER_DB_PASSWORD=.*/WORKER_DB_PASSWORD=0000000000000000000000000000000000000000000000000000000000000007/' "$staging/env" > "$staging/rotated"
mv "$staging/rotated" "$staging/env"
compose run --rm -T migrate
compose run --rm -T storage-init
compose exec -T postgres psql -X -U postgres -d vid_test -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE auth.boundary_future_table (id int);
CREATE TABLE execution.boundary_future_table (id int);
SQL
compose run --rm -T --no-deps probe

# ACL probes intentionally publish poison. Recreate this test's tmpfs Redis;
# retain PostgreSQL to verify the same deployment can start again with its data.
compose stop server redis
compose up -d --force-recreate --wait --wait-timeout 60 redis server web
compose run --rm -T --no-deps probe bun test tests/scripts/deployment-web.test.ts

compose stop server
server_id=$(compose ps -a -q server)
[ "$(docker inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}}' "$server_id")" = '0 false' ]
