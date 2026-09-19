#!/usr/bin/env bash
#
# Submits one generation and waits for it.
#
# The credential for this is not here and never will be: this runs in a sandbox executing
# commands a model wrote, so it carries a token good for one turn and calls the gateway,
# which attaches the real key on the way out (architecture.md §1).
#
# The job id is written down before the first poll. A turn that dies between submitting and
# finishing has already spent the money, and the file is what lets the next one collect the
# result instead of paying again (architecture.md §4).
set -euo pipefail

PROMPT="${1:?usage: generate.sh "<prompt>" <seconds> [reference-image]}"
SECONDS_LONG="${2:-5}"
REFERENCE="${3:-}"

MODEL="${VID_SEEDANCE_MODEL:?the sandbox was not told which model to use}"
JOBS=".jobs"
OUT="clips"
mkdir -p "$JOBS" "$OUT"

say() { printf '::vid %s\n' "$1"; }
activity() {
  say "{\"id\":\"$1\",\"activityType\":\"step\",\"content\":{\"label\":\"$2\",\"state\":\"$3\"}}"
}

slug=$(printf '%s' "$PROMPT" | tr -cd '[:alnum:] ' | tr ' ' '-' | cut -c1-40 | tr '[:upper:]' '[:lower:]')
job_file="$JOBS/$slug.json"

# --- pick the job up again rather than paying twice --------------------------
if [ -f "$job_file" ]; then
  task_id=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['id'])" "$job_file")
  echo "resuming $task_id, already submitted" >&2
else
  activity "$slug" "Generating footage" "running"

  body=$(python3 - "$MODEL" "$PROMPT" "$SECONDS_LONG" "$REFERENCE" <<'PY'
import json, sys
model, prompt, seconds, reference = sys.argv[1:5]
content = [{"type": "text", "text": f"{prompt} --dur {seconds}"}]
if reference:
    content.append({"type": "image_url", "image_url": {"url": reference}})
print(json.dumps({"model": model, "content": content}))
PY
)

  submitted=$(curl -sS -X POST "$VID_GATEWAY/seedance/api/v3/contents/generations/tasks" \
    -H "Authorization: Bearer $VID_TURN_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$body")

  task_id=$(printf '%s' "$submitted" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
  if [ -z "$task_id" ]; then
    activity "$slug" "Generating footage" "failed"
    echo "submit refused: $submitted" >&2
    exit 1
  fi

  # Written down before the first poll, never after.
  printf '{"id":"%s","prompt":%s}\n' "$task_id" "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$PROMPT")" > "$job_file"
fi

# --- wait -------------------------------------------------------------------
deadline=$(( $(date +%s) + ${SEEDANCE_WAIT_SECONDS:-900} ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  task=$(curl -sS "$VID_GATEWAY/seedance/api/v3/contents/generations/tasks/$task_id" \
    -H "Authorization: Bearer $VID_TURN_TOKEN")
  status=$(printf '%s' "$task" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")

  case "$status" in
    succeeded)
      url=$(printf '%s' "$task" | python3 -c "import json,sys;print(json.load(sys.stdin).get('content',{}).get('video_url',''))")
      [ -n "$url" ] || { echo "succeeded but no video_url: $task" >&2; exit 1; }
      curl -sS -o "$OUT/$slug.mp4" "$url"
      rm -f "$job_file"
      activity "$slug" "Generating footage" "done"
      echo "$OUT/$slug.mp4"
      exit 0
      ;;
    failed|cancelled)
      rm -f "$job_file"
      activity "$slug" "Generating footage" "failed"
      echo "$status: $task" >&2
      exit 1
      ;;
  esac
  sleep 5
done

# Not a failure. The job may still be running and may already have been paid for, so the
# record stays where the next turn can find it.
echo "unknown: still running after the wait ran out, job kept at $job_file" >&2
exit 2
