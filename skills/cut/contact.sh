#!/usr/bin/env bash
#
# A contact sheet, so a cut gets looked at rather than measured.
#
# `ffprobe` says the file is 24fps and ten seconds. It cannot say the third shot is two
# seconds too long, and that is the only kind of problem worth finding at this stage.
set -euo pipefail

FILE="${1:?usage: contact.sh <video> [--cuts <seconds> ...]}"
shift

mkdir -p qc

if [ "${1:-}" = "--cuts" ]; then
  shift
  [ $# -ge 1 ] || {
    echo "--cuts needs at least one time" >&2
    exit 1
  }

  # Either side of each cut, which is where a join goes wrong: the frame before and the
  # frame after, so a jump or a grade shift is visible side by side.
  out=()
  for when in "$@"; do
    before=$(python3 -c "print(max(0, float('$when') - 0.12))")
    ffmpeg -v error -y -ss "$before" -i "$FILE" -frames:v 1 "qc/cut-${when}-before.jpg"
    ffmpeg -v error -y -ss "$when" -i "$FILE" -frames:v 1 "qc/cut-${when}-after.jpg"
    out+=("qc/cut-${when}-before.jpg" "qc/cut-${when}-after.jpg")
  done

  printf '%s\n' "${out[@]}"
  exit 0
fi

seconds=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE")
every=$(python3 -c "print(max(0.4, float('$seconds') / 12))")

ffmpeg -v error -y -i "$FILE" \
  -vf "fps=1/${every},scale=320:-1,tile=4x3" \
  -frames:v 1 qc/contact.jpg

echo qc/contact.jpg
