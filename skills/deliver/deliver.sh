#!/usr/bin/env bash
#
# Announces one finished file as something a person may open.
#
# What is printed here is a workspace path, not a link. This script holds no storage
# credential and could not mint one; the path is turned into a short-lived URL outside the
# sandbox, and a path that cannot be turned into one is dropped rather than shown
# (architecture.md §6).
set -euo pipefail

FILE="${1:?usage: deliver.sh <file> [final|preview]}"
ROLE="${2:-final}"

case "$ROLE" in
  final | preview) ;;
  *)
    echo "role must be final or preview, not $ROLE" >&2
    exit 1
    ;;
esac

# Checked here so a mistake is an error the agent can read and fix, rather than a delivery
# that silently never appears on anyone's screen.
[ -f "$FILE" ] || {
  echo "no such file: $FILE" >&2
  exit 1
}

path=${FILE#./}
path=${path#/work/}

python3 - "$path" "$ROLE" <<'PY'
import json, sys
path, role = sys.argv[1:3]
# The id is the path, so delivering the same file twice updates one thing on the screen
# rather than stacking copies of it.
print('::vid ' + json.dumps({
    "id": f"artifact:{path}",
    "activityType": "artifact",
    "content": {"url": path, "role": role},
}))
PY

echo "delivered $path" >&2
