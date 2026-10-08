#!/bin/sh
# Host Docker controller; the underlying tests own their isolated resources.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
node --test tests/scripts/production-runtime.test.ts
node --test tests/scripts/storage-initialization.test.ts
exec sh tests/scripts/deployment-check.sh
