---
name: title-card
description: Render a title card, end card, or lower third from HTML using hyperframes. Use whenever a cut needs type on screen.
---

# Type on screen

**Set type in HTML, not in ffmpeg.** `drawtext` can put a string in the middle of a frame and
that is all it can do: no tracking that reads as considered, no web fonts, no layout, no way
to look at it before you commit. A title card is a design problem, and HTML is the tool that
has spent thirty years on that problem.

```bash
skills/title-card/card.sh "DRY SEASON" 1280x720 3
```

The arguments are the text, the size, and how long it holds. It prints the path it wrote.
The card fades up, holds, and fades out, on a near-black ground in a serif with wide
tracking — the default look, and a reasonable one.

## Changing the look

The script scaffolds a real hyperframes project under `.cards/<name>/` and renders it. **To
do anything the script does not offer, edit that project and render it again:**

```bash
hyperframes render .cards/dry-season -o cards/dry-season.mp4
```

`index.html` is the whole composition: one HTML file, ordinary CSS, and a GSAP timeline that
the renderer seeks frame by frame. Change the type, add a rule under the title, put the card
over a still — it is a web page, and anything you know about web pages applies.

`hyperframes snapshot` writes PNGs of key frames, which is how you look at a card without
rendering the whole thing. `hyperframes docs` has the rest.

## Two things about this machine

The scaffold hyperframes writes for you loads GSAP from a CDN. **There is no internet here.**
The script copies the local GSAP beside the project and points at that instead; if you write
a composition by hand, do the same — a composition whose timeline never loads renders one
still frame for its whole duration and does not tell you why.

For the same reason, `hyperframes init` needs `HYPERFRAMES_SKIP_SKILLS=1`, or it hangs
checking a registry it cannot reach.

## Putting it in the cut

A card is just another clip. Cut to it, or dissolve into it, with ffmpeg:

```bash
ffmpeg -i shot.mp4 -i cards/dry-season.mp4 \
  -filter_complex "[0:v][1:v]xfade=transition=fade:duration=1:offset=5" out.mp4
```

Match the size and frame rate of the card to the footage or the dissolve will not line up.
