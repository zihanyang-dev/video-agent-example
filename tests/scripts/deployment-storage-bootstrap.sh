#!/bin/sh
set -eu
umask 077
export MC_CONFIG_DIR=$(mktemp -d)
trap 'rm -rf "$MC_CONFIG_DIR"' EXIT
trap 'exit 1' HUP INT TERM
# Only this short-lived job sees the root secret; never use --json user add.
printf '%s\n%s\n' "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" | mcli alias set root "$STORAGE_TEST_ENDPOINT" --api S3v4 --path on >/dev/null 2>&1
unset MINIO_ROOT_USER MINIO_ROOT_PASSWORD
end=$(($(date +%s) + 30))
until mcli ready root >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$end" ] || exit 1
  sleep 0.1
done
mcli mb root/workspace-test >/dev/null 2>&1
# Seed exactly correlated historical keys before testing application principals.
printf legacy-upload | mcli pipe root/workspace-test/materials/boundary >/dev/null 2>&1
printf legacy-output | mcli pipe root/workspace-test/artifacts/boundary >/dev/null 2>&1
for role in server worker; do
  mcli admin policy create root "$role" "/policies/$role-policy.json" >/dev/null 2>&1
done
printf '%s\n%s\n' "$STORAGE_SERVER_ACCESS_KEY" "$STORAGE_SERVER_SECRET_KEY" | mcli admin user add root >/dev/null 2>&1
printf '%s\n%s\n' "$STORAGE_WORKER_ACCESS_KEY" "$STORAGE_WORKER_SECRET_KEY" | mcli admin user add root >/dev/null 2>&1
mcli admin policy attach root server --user "$STORAGE_SERVER_ACCESS_KEY" >/dev/null 2>&1
mcli admin policy attach root worker --user "$STORAGE_WORKER_ACCESS_KEY" >/dev/null 2>&1
