#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/scripts/check-lifecycle.sh"
mkdir -p "$root/.cache"
staging=$(mktemp -d "$root/.cache/check.XXXXXX")
owner="vid-storage-$$-$(basename "$staging")"
network="$owner"
server="silo-$owner"
runner="runner-$owner"
has_network=0
has_server=0
has_runner=0
has_database=0
database="postgres-$owner"
cleanup() {
 status=$?
 trap - EXIT HUP INT TERM
 failed=0
 if [ -n "$client" ]; then kill "$client" 2>/dev/null || :; settle_cleanup "$client" 2>/dev/null || failed=1; client=''; fi
 if [ "$has_runner" -eq 1 ]; then remove_owned container "$runner" || failed=1; fi
 if [ "$has_database" -eq 1 ]; then remove_owned container "$database" || failed=1; fi
 if [ "$has_server" -eq 1 ]; then remove_owned container "$server" || failed=1; fi
 if [ "$has_network" -eq 1 ]; then remove_owned network "$network" || failed=1; fi
 rm -rf "$staging" || failed=1
 if [ "$failed" -ne 0 ]; then echo "Storage cleanup incomplete for $owner" >&2; fi
 if [ "$status" -eq 0 ]; then status=$failed; fi
 exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
run_stage "$setup_timeout" docker build --quiet -f "$root/deploy/docker/checks.Dockerfile" "$root" > "$staging/image"
image=$(cat "$staging/image")
has_network=1
run_stage "$setup_timeout" docker network create --label "vid.check.owner=$owner" "$network" >/dev/null
umask 077
printf 'POSTGRES_PASSWORD=integration-only\nPOSTGRES_DB=vid_test\n' > "$staging/postgres.env"
has_database=1
run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$database" --network "$network" \
 --env-file "$staging/postgres.env" \
 'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873' >/dev/null
run_stage "$setup_timeout" docker start "$database" >/dev/null
ready_end=$(($(date +%s) + ${VID_READY_TIMEOUT:-30}))
until run_stage 1 docker exec "$database" pg_isready -U postgres -d vid_test >/dev/null 2>&1; do
 if [ "$(date +%s)" -ge "$ready_end" ]; then echo 'Owned PostgreSQL did not become ready' >&2; exit 1; fi
 sleep 0.1
done
silo_image='pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46'
umask 077
printf 'MINIO_ROOT_USER=owned-storage-admin\nMINIO_ROOT_PASSWORD=owned-storage-admin-secret\n' > "$staging/root.env"
printf 'STORAGE_TEST_ENDPOINT=http://%s:9000\nSTORAGE_SERVER_ACCESS_KEY=owned-storage-test\nSTORAGE_SERVER_SECRET_KEY=owned-storage-test-secret\nSTORAGE_WORKER_ACCESS_KEY=owned-storage-worker\nSTORAGE_WORKER_SECRET_KEY=owned-storage-worker-secret\n' "$server" > "$staging/apps.env"
cat "$staging/root.env" "$staging/apps.env" > "$staging/bootstrap.env"
has_server=1
run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$server" --network "$network" --env-file "$staging/root.env" "$silo_image" server /data >/dev/null
run_stage "$setup_timeout" docker start "$server" >/dev/null
mkdir "$staging/policies"
for role in server worker; do
  sed 's/vid-assets/workspace-test/g' "$root/deploy/storage/$role-policy.json" > "$staging/policies/$role-policy.json"
done
for task in bootstrap boundaries; do
  credential_file="$staging/apps.env"
  [ "$task" != bootstrap ] || credential_file="$staging/bootstrap.env"
  has_runner=1
  run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$runner" --network "$network" --env-file "$credential_file" --mount "type=bind,src=$root/tests/scripts,dst=/checks,readonly" --mount "type=bind,src=$staging/policies,dst=/policies,readonly" --entrypoint sh "$silo_image" "/checks/deployment-storage-$task.sh" >/dev/null
  run_stage "$run_timeout" docker start -a "$runner"
  remove_owned container "$runner"
  has_runner=0
done
printf 'DATABASE_URL=postgres://postgres:integration-only@%s:5432/vid_test?sslmode=disable\n' "$database" >> "$staging/apps.env"
# Administrative credentials are test-only: seed historical immutable objects,
# never pass this store into an application or into the role-boundary probes.
printf 'STORAGE_TEST_ADMIN_ACCESS_KEY=owned-storage-admin\nSTORAGE_TEST_ADMIN_SECRET_KEY=owned-storage-admin-secret\n' >> "$staging/apps.env"
has_runner=1
run_stage "$setup_timeout" docker create --label "vid.check.owner=$owner" --name "$runner" --network "$network" --env-file "$staging/apps.env" "$image" sh -ec '
 cd /app/packages/database
 bun run db:migrate
 cd /app
 bun test tests/storage
 ' >/dev/null
run_stage "$run_timeout" docker start -a "$runner"
