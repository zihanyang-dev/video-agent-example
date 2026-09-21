#!/usr/bin/env bash
#
# Makes one still image.
#
# Like every skill that spends money, the credential is not here: this carries a token good
# for one turn and calls the gateway, which attaches the real key (architecture.md §1).
#
# This endpoint returns the image in the submission response and exposes no resumable job
# here. Losing that response leaves the outcome unknown; retrying may charge again.
set -euo pipefail

PROMPT="${1:?usage: still.sh "<prompt>" [WIDTHxHEIGHT]}"
SIZE="${2:-2560x1440}"

MODEL="${VID_SEEDREAM_MODEL:?the sandbox was not told which model to use}"
OUT="stills"
mkdir -p "$OUT"

say() { printf '::vid %s\n' "$1"; }
activity() {
  say "{\"id\":\"$1\",\"activityType\":\"step\",\"content\":{\"label\":\"$2\",\"state\":\"$3\"}}"
}

slug=$(printf '%s' "$PROMPT" | tr -cd '[:alnum:] ' | tr ' ' '-' | cut -c1-40 | tr '[:upper:]' '[:lower:]')

activity "$slug" "Making a still" "running"

body=$(python3 - "$MODEL" "$PROMPT" "$SIZE" <<'PY'
import json, sys
model, prompt, size = sys.argv[1:4]
print(json.dumps({
    "model": model,
    "prompt": prompt,
    "size": size,
    "response_format": "url",
    "watermark": False,
}))
PY
)

answered=$(curl -sS -X POST "$VID_GATEWAY/seedream/api/v3/images/generations" \
  -H "Authorization: Bearer $VID_TURN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$body")

url=$(printf '%s' "$answered" | python3 -c "
import json,sys
answered = json.load(sys.stdin)
data = answered.get('data') or [{}]
print(data[0].get('url',''))
")

if [ -z "$url" ]; then
  activity "$slug" "Making a still" "failed"
  echo "no image came back: $answered" >&2
  exit 1
fi

# Through the gateway: there is no route off this network (architecture.md §8).
curl -sS -o "$OUT/$slug.png" \
  -H "Authorization: Bearer $VID_TURN_TOKEN" \
  --get --data-urlencode "url=$url" "$VID_GATEWAY/seedream/_result"
activity "$slug" "Making a still" "done"
echo "$OUT/$slug.png"
