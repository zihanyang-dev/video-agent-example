#!/usr/bin/env bash
#
# Joins shots into one piece.
#
# The normalising is the point. Generated clips disagree about size, frame rate, pixel
# format and audio layout -- and often about whether there is audio at all -- and `concat`
# across that either refuses or produces something that breaks halfway through. Every input
# is put into the same shape first, and only then joined.
#
# Transitions are not here. A dissolve between two specific shots is a decision about those
# two shots (SKILL.md), so it belongs in a command written for them, not in a flag on this.
set -euo pipefail

usage() {
  cat >&2 <<'TXT'
usage: assemble.sh <out.mp4> <WIDTHxHEIGHT> <fps> <file:seconds> [file:seconds ...]

  assemble.sh opener.mp4 1280x720 24 clips/wide.mp4:6 clips/boat.mp4:3 cards/title.mp4:4

Each shot is trimmed to the seconds given, from its start. Shots shorter than that are used
whole -- padding them with a freeze is worse than a piece that runs slightly short.
TXT
  exit 1
}

[ $# -ge 4 ] || usage

OUT=$1
SIZE=$2
FPS=$3
shift 3

WIDTH=${SIZE%x*}
HEIGHT=${SIZE#*x}

say() {
  python3 - "$1" "$2" <<'PY'
import json, sys
label, state = sys.argv[1:3]
print('::vid ' + json.dumps({
    "id": "assemble",
    "activityType": "step",
    "content": {"label": label, "state": state},
}))
PY
}

has_audio() {
  [ -n "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$1")" ]
}

say "Cutting it together" running

SHOTS=$#

inputs=()
filters=()
joined=""
video=0

# Silence for shots that have none. Measured: a single clip without an audio track makes
# the whole filtergraph fail to bind, because `[N:a]` matches nothing -- so each such shot
# gets a silent input of its own rather than being left to refer to a stream that is not
# there.
silence=()

for shot in "$@"; do
  file=${shot%:*}
  seconds=${shot##*:}

  [ -f "$file" ] || {
    say "Cutting it together" failed
    echo "no such shot: $file" >&2
    exit 1
  }

  inputs+=(-i "$file")

  # Two counters, not one. Silent inputs are appended after every real one, so their index
  # is `SHOTS` plus however many have been added -- computing it from a single running
  # counter puts every shot after the first silent one on the wrong stream.
  if has_audio "$file"; then
    audio=$video
  else
    audio=$((SHOTS + ${#silence[@]} / 6))
    silence+=(-f lavfi -t "$seconds" -i "anullsrc=r=48000:cl=stereo")
  fi

  # Scale to fit and pad rather than stretch: a clip generated at a different aspect ratio
  # is letterboxed, never distorted. Faces are the first thing a stretch ruins.
  filters+=(
    "[${video}:v]trim=duration=${seconds},setpts=PTS-STARTPTS,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${video}];"
  )

  # `apad` covers a track shorter than its picture, which is otherwise a join that drifts
  # out of sync from that shot onwards.
  filters+=(
    "[${audio}:a]atrim=duration=${seconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${seconds}[a${video}];"
  )

  joined="${joined}[v${video}][a${video}]"
  video=$((video + 1))
done

filters+=("${joined}concat=n=${SHOTS}:v=1:a=1[v][a]")

mkdir -p "$(dirname "$OUT")"

# Silent inputs go after the real ones, so a shot's own index never moves.
if ffmpeg -y "${inputs[@]}" "${silence[@]}" \
  -filter_complex "$(printf '%s' "${filters[@]}")" \
  -map '[v]' -map '[a]' \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart "$OUT" 2>/tmp/assemble.log; then
  say "Cutting it together" done
  echo "$OUT"
else
  say "Cutting it together" failed
  echo "ffmpeg refused; the last 30 lines:" >&2
  tail -30 /tmp/assemble.log >&2
  exit 1
fi
