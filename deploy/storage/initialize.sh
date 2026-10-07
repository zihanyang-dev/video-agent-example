#!/usr/bin/env bash
set -e

# External S3 is operator-provisioned, never managed with local root.
[ "$OBJECT_STORAGE_URL" = http://objects:9000 ] || exit 0
set -o pipefail
stage=input
trap \
  'echo "Local object storage initialization failed: $stage" >&2' ERR
umask 077
export MC_CONFIG_DIR=/run/storage/client
bucket=$OBJECT_STORAGE_BUCKET
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]
[[ "$bucket" != *..* && "$bucket" != *.-* && "$bucket" != *-.* ]]
[[ ! "$bucket" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
[ "$SERVER_ACCESS_KEY" != "$WORKER_ACCESS_KEY" ]
[ "$SERVER_ACCESS_KEY" != "$MINIO_ROOT_USER" ]
[ "$WORKER_ACCESS_KEY" != "$MINIO_ROOT_USER" ]
stage='alias'
printf '%s\n%s\n' "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" |
  mcli alias set local http://objects:9000 --api S3v4 --path on \
  >/dev/null 2>&1
unset MINIO_ROOT_USER MINIO_ROOT_PASSWORD
stage=bucket
mcli mb --ignore-existing "local/$bucket" >/dev/null 2>&1
# Canonical full-JSON template contract: this reserved ARN prefix occurs
# only at Resource bucket slots. Real-JSON conformance is gated by
# tests/scripts/storage-initialization.test.ts; not a generic renderer.
slot='arn:aws:s3:::vid-assets/'
for role in server worker; do
  stage=$role-policy
  policy=$(cat "/policies/$role-policy.json" 2>/dev/null)
  printf '%s\n' "${policy//"$slot"/"arn:aws:s3:::$bucket/"}" \
    > "/run/storage/$role.json"
  mcli admin policy create local "$role" \
    "/run/storage/$role.json" >/dev/null 2>&1
done
stage=server-principal
printf '%s\n%s\n' "$SERVER_ACCESS_KEY" "$SERVER_SECRET_KEY" |
  mcli admin user add local >/dev/null 2>&1
stage=worker-principal
printf '%s\n%s\n' "$WORKER_ACCESS_KEY" "$WORKER_SECRET_KEY" |
  mcli admin user add local >/dev/null 2>&1
stage=server-attach
mcli admin policy attach local server --user "$SERVER_ACCESS_KEY" \
  >/dev/null 2>&1
stage=worker-attach
mcli admin policy attach local worker --user "$WORKER_ACCESS_KEY" \
  >/dev/null 2>&1
