#!/usr/bin/env bash
#
# The plan a person watches get worked through.
#
# Kept in a workspace file so later turns can continue from the saved plan. Recovery after
# a lost sandbox restores the last committed workspace, not every file write (§6 of
# architecture.md).
#
# Announced in full on every change, because the activity replaces by default: one thing on
# the screen that updates, never a pile of lines nobody can read as a whole.
set -euo pipefail

PLAN=".plan.json"

usage() {
  cat >&2 <<'TXT'
usage:
  plan.sh set "first thing" "second thing" ...   write the plan, all to do
  plan.sh doing <n>                             mark item n as being worked on
  plan.sh done <n>                              mark item n finished
  plan.sh skip <n> ["why"]                      mark item n as not needed
  plan.sh show                                  re-announce, unchanged
TXT
  exit 1
}

[ $# -ge 1 ] || usage

announce() {
  python3 - "$PLAN" <<'PY'
import json, sys
items = json.load(open(sys.argv[1]))
print('::vid ' + json.dumps({
    "id": "plan",
    "activityType": "plan",
    "content": {"items": items},
}))
PY
}

case "$1" in
  set)
    shift
    [ $# -ge 1 ] || usage
    python3 - "$PLAN" "$@" <<'PY'
import json, sys
path, labels = sys.argv[1], sys.argv[2:]
json.dump([{"label": label, "state": "todo"} for label in labels], open(path, "w"))
PY
    ;;

  doing | done | skip)
    what=$1
    [ -f "$PLAN" ] || {
      echo "there is no plan yet; run 'plan.sh set ...' first" >&2
      exit 1
    }
    [ $# -ge 2 ] || usage
    python3 - "$PLAN" "$what" "$2" "${3:-}" <<'PY'
import json, sys
path, what, which, why = sys.argv[1:5]
items = json.load(open(path))

at = int(which) - 1
if not 0 <= at < len(items):
    sys.exit(f"there is no item {which}; the plan has {len(items)}")

# Only one thing is ever being worked on, so starting one settles the last.
if what == "doing":
    for item in items:
        if item["state"] == "doing":
            item["state"] = "done"

items[at]["state"] = {"doing": "doing", "done": "done", "skip": "skipped"}[what]
if why:
    items[at]["label"] = f'{items[at]["label"]} — {why}'

json.dump(items, open(path, "w"))
PY
    ;;

  show)
    [ -f "$PLAN" ] || exit 0
    ;;

  *) usage ;;
esac

announce
