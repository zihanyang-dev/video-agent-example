#!/usr/bin/env bash
#
# Submits one generation and waits for it.
#
# The credential for this is not here and never will be: this runs in a sandbox executing
# commands a model wrote, so it carries a token good for one turn and calls the gateway,
# which attaches the real key on the way out (architecture.md §1).
#
# The intent is written down *before* the request goes out, not after the reply comes back.
# A reply that never arrives is not a generation that never happened: the provider may have
# accepted it and the money may already be gone. Writing afterwards leaves exactly that case
# with no local record, and the next turn pays for the same clip again (architecture.md §4).
#
# When the record says we submitted but never learnt the id, `reconcile.py` asks the provider
# what it has. Anything it cannot answer confidently is `unknown` and stops here -- that is
# what the third state is for.
set -euo pipefail

PROMPT="${1:?usage: generate.sh "<prompt>" <seconds> [reference-image]}"
SECONDS_LONG="${2:-5}"
REFERENCE="${3:-}"

MODEL="${VID_SEEDANCE_MODEL:?the sandbox was not told which model to use}"
JOBS=".jobs"
OUT="clips"
mkdir -p "$JOBS" "$OUT"

activity() {
  python3 - "$1" "$2" "$3" "${4:-}" <<'PY'
import json, sys
message_id, label, state, detail = sys.argv[1:5]
content = {"label": label, "state": state}
if detail:
    content["detail"] = detail
print('::vid ' + json.dumps({"id": message_id, "activityType": "step", "content": content}))
PY
}

slug=$(printf '%s' "$PROMPT" | tr -cd '[:alnum:] ' | tr ' ' '-' | cut -c1-40 | tr '[:upper:]' '[:lower:]')
job_file="$JOBS/$slug.json"

here=$(cd "$(dirname "$0")" && pwd)

# The record of one submission. Written before the request and updated after it, so the
# window where money may be spent and nothing knows about it does not exist.
note_job() {
  python3 - "$job_file" "$1" "$2" "$MODEL" "$SECONDS_LONG" "$PROMPT" <<'PY'
import json, sys, time
path, state, task_id, model, seconds, prompt = sys.argv[1:7]
try:
    was = json.load(open(path))
except Exception:
    was = {}
json.dump({
    "state": state,
    "id": task_id or was.get("id", ""),
    "submitted_at": was.get("submitted_at") or int(time.time()),
    "model": model,
    "duration": int(seconds),
    "prompt": prompt,
}, open(path, "w"))
PY
}

read_job() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$job_file" "$1"
}

task_id=""

# --- pick the job up again rather than paying twice --------------------------
if [ -f "$job_file" ]; then
  case "$(read_job state)" in
    submitted)
      task_id=$(read_job id)
      echo "resuming $task_id, already submitted" >&2
      ;;
    submitting)
      # It went out and we never learnt what came of it. Asking is the only honest move:
      # resubmitting risks paying twice, giving up risks throwing away a finished clip.
      echo "a previous attempt submitted but never got an id; asking the provider" >&2
      verdict=$(python3 "$here/reconcile.py" "$job_file")
      case "$verdict" in
        "FOUND "*)
          task_id=${verdict#FOUND }
          note_job submitted "$task_id"
          echo "it did land, as $task_id" >&2
          ;;
        NONE)
          echo "it never landed; submitting once more" >&2
          rm -f "$job_file"
          ;;
        *)
          activity "$slug" "Generating footage" "failed" \
            "A generation may already be running; someone should look before we pay again."
          echo "unknown: $verdict" >&2
          exit 2
          ;;
      esac
      ;;
  esac
fi

if [ -z "$task_id" ]; then
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

  # Before the request, never after. This file is the only evidence that money may have been
  # spent when the reply does not come back.
  note_job submitting ""

  submitted=$(curl -sS -X POST "$VID_GATEWAY/seedance/api/v3/contents/generations/tasks" \
    -H "Authorization: Bearer $VID_TURN_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$body")

  task_id=$(printf '%s' "$submitted" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
  if [ -z "$task_id" ]; then
    # Refused outright: the provider answered, and it said no, so nothing was bought.
    rm -f "$job_file"
    activity "$slug" "Generating footage" "failed"
    echo "submit refused: $submitted" >&2
    exit 1
  fi

  note_job submitted "$task_id"
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

      # Through the gateway, not straight at the link. There is no route off this
      # network -- the gateway is the only thing reachable from here, and it fetches
      # only from hosts this deployment named (architecture.md §5).
      curl -sS -o "$OUT/$slug.mp4" \
        -H "Authorization: Bearer $VID_TURN_TOKEN" \
        --get --data-urlencode "url=$url" "$VID_GATEWAY/seedance/_result"
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
