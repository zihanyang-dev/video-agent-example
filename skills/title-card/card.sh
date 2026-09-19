#!/usr/bin/env bash
#
# Renders a title card from HTML, using the hyperframes CLI.
#
# Two things here are about this sandbox rather than about hyperframes, and both were
# measured (architecture.md §5):
#
#   - `init` checks a skills registry on GitHub. This sandbox reaches exactly one thing and
#     it is not GitHub, so that check is turned off.
#   - the project it scaffolds loads GSAP from a CDN. Here that script never arrives, and a
#     composition whose timeline never loads renders one still frame for its whole duration.
#     The copy in the image is used instead.
set -euo pipefail

TEXT="${1:?usage: card.sh "<TEXT>" [WIDTHxHEIGHT] [SECONDS] [OUTPUT]}"
SIZE="${2:-1280x720}"
SECONDS_LONG="${3:-3}"

WIDTH=${SIZE%x*}
HEIGHT=${SIZE#*x}

slug=$(printf '%s' "$TEXT" | tr -cd '[:alnum:] ' | tr ' ' '-' | cut -c1-40 | tr '[:upper:]' '[:lower:]')
OUT="${4:-cards/$slug.mp4}"
PROJECT=".cards/$slug"

say() { printf '::vid %s\n' "$1"; }
activity() {
  say "{\"id\":\"$1\",\"activityType\":\"step\",\"content\":{\"label\":\"$2\",\"state\":\"$3\"}}"
}

activity "card-$slug" "Setting the title" "running"

rm -rf "$PROJECT"
mkdir -p "$(dirname "$PROJECT")" "$(dirname "$OUT")"

HYPERFRAMES_SKIP_SKILLS=1 hyperframes init "$PROJECT" \
  --example blank --non-interactive --skip-transcribe >/dev/null

cp "${VID_GSAP:?the sandbox image did not vendor gsap}" "$PROJECT/gsap.min.js"

python3 - "$PROJECT/index.html" "$TEXT" "$WIDTH" "$HEIGHT" "$SECONDS_LONG" <<'PY'
import html, sys

path, text, width, height, seconds = sys.argv[1:6]

# Escaped, because the text came from a brief someone typed. A title containing a tag would
# otherwise be markup rather than a title.
open(path, 'w').write(f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width={width}, height={height}" />
    <script src="./gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ width: {width}px; height: {height}px; overflow: hidden; background: #05070a; }}
      #root {{ width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }}
      #title {{
        color: #ece8de;
        font-family: 'Liberation Serif', Georgia, serif;
        font-size: {max(28, int(width) // 22)}px;
        font-weight: 400;
        letter-spacing: 0.34em;
        /* The tracking is applied on the right of every letter, including the last one, so
           the line sits left of true centre without this. */
        text-indent: 0.34em;
        white-space: pre;
      }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{seconds}"
         data-width="{width}" data-height="{height}">
      <h1 id="title" class="clip" data-start="0" data-duration="{seconds}"
          data-track-index="0">{html.escape(text)}</h1>
    </div>
    <script>
      const tl = gsap.timeline({{ paused: true }});
      tl.fromTo("#title", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.9, ease: "power1.out" }}, 0);
      tl.to("#title", {{ opacity: 0, duration: 0.6, ease: "power1.in" }}, {max(0.9, float(seconds) - 0.6)});
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
""")
PY

if hyperframes render "$PROJECT" -o "$OUT" --quiet >/dev/null 2>&1; then
  activity "card-$slug" "Setting the title" "done"
  echo "$OUT"
else
  activity "card-$slug" "Setting the title" "failed"
  echo "hyperframes could not render the card; run it without --quiet to see why" >&2
  exit 1
fi
