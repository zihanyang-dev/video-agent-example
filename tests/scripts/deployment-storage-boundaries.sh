#!/bin/sh
set -eu
umask 077
export MC_CONFIG_DIR=$(mktemp -d)
trap 'rm -rf "$MC_CONFIG_DIR"' EXIT
trap 'exit 1' HUP INT TERM
printf '%s\n%s\n' "$STORAGE_SERVER_ACCESS_KEY" "$STORAGE_SERVER_SECRET_KEY" | mcli alias set server "$STORAGE_TEST_ENDPOINT" --api S3v4 --path on >/dev/null 2>&1
printf '%s\n%s\n' "$STORAGE_WORKER_ACCESS_KEY" "$STORAGE_WORKER_SECRET_KEY" | mcli alias set worker "$STORAGE_TEST_ENDPOINT" --api S3v4 --path on >/dev/null 2>&1
unset STORAGE_SERVER_ACCESS_KEY STORAGE_SERVER_SECRET_KEY STORAGE_WORKER_ACCESS_KEY STORAGE_WORKER_SECRET_KEY
printf upload | mcli pipe server/workspace-test/assets/uploads/boundary >/dev/null
printf generated | mcli pipe worker/workspace-test/assets/generated/boundary >/dev/null
for role in server worker; do
  test "$(mcli cat "$role/workspace-test/assets/uploads/boundary")" = upload
  test "$(mcli cat "$role/workspace-test/assets/generated/boundary")" = generated
  test "$(mcli cat "$role/workspace-test/materials/boundary")" = legacy-upload
  test "$(mcli cat "$role/workspace-test/artifacts/boundary")" = legacy-output
  if printf forbidden | mcli pipe "$role/workspace-test/materials/forbidden" >/dev/null 2>&1; then exit 1; fi
  if printf forbidden | mcli pipe "$role/workspace-test/artifacts/forbidden" >/dev/null 2>&1; then exit 1; fi
  if printf forbidden | mcli pipe "$role/workspace-test/workspaces/forbidden" >/dev/null 2>&1; then exit 1; fi
  if mcli ls "$role/workspace-test" >/dev/null 2>&1; then exit 1; fi
  if mcli mb "$role/forbidden-bucket" >/dev/null 2>&1; then exit 1; fi
  if mcli rm "$role/workspace-test/assets/generated/boundary" >/dev/null 2>&1; then exit 1; fi
done
if printf forbidden | mcli pipe server/workspace-test/assets/generated/forbidden >/dev/null 2>&1; then exit 1; fi
if printf forbidden | mcli pipe worker/workspace-test/assets/uploads/forbidden >/dev/null 2>&1; then exit 1; fi
echo 'Separate S3 principals and final asset prefixes verified.'
