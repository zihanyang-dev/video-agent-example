---
name: cut
description: Assemble generated shots into a finished piece — order, shot length, transitions, and the normalising that makes mismatched footage cut together. Use whenever there is more than one clip to join.
---

# Cutting it together

Shots that each look good almost never form a film on their own. **The problem is not the
shots, it is that generated footage gives you "close enough" continuity rather than
continuity** — the light shifts, the framing jumps, the grade moves — and an assembly that
ignores that reads as a pile of clips rather than a piece.

```bash
skills/cut/assemble.sh out.mp4 1280x720 24 shot-a.mp4:6 shot-b.mp4:3 shot-c.mp4:4
```

Each argument is `file:seconds`. The script normalises everything to the same size, frame
rate, pixel format and audio layout first, then joins. Normalising is not optional: a
`concat` of clips that disagree on any of those either fails or produces something subtly
broken halfway through.

## Length is the thing you control most and think about least

**Do not give every shot the same duration.** Equal lengths read as a slideshow — the eye
learns the rhythm in two cuts and stops watching. Vary them deliberately:

- **Establishing shot: longest.** The audience is reading a new place; give them time.
- **Cutaways and detail: shortest.** They land in under two seconds. Holding one past its
  information is where a piece starts to drag.
- **The last shot before a title: let it breathe.** Cutting away early makes the ending feel
  like it was interrupted.

A useful default for a short piece: the first shot roughly twice the length of the middle
ones, the last one and a half.

If a shot is not carrying anything for its whole length, **trim it rather than keeping it
symmetrical.** The version that is four seconds and good beats the version that is six
seconds and matches its neighbour.

## Transitions: one language, used sparingly

**Pick one transition language per piece and stay in it.** Five styles in one timeline is
the clearest sign nobody was editing — it reads as someone trying options rather than making
a film.

|                     |                                                              |
| ------------------- | ------------------------------------------------------------ |
| **Cut**             | the default. Use it for pace, and for anything continuous.   |
| **Dissolve**        | for a change of time or place, and for reflective moments.   |
| **Fade to black**   | for an ending, or a real break. Rarely in the middle.        |
| Wipes, spins, zooms | almost never. Only when the movement is already the subject. |

**If the transition draws more attention than the change it is covering, it is too strong.**
That is the whole test.

## Using a transition to hide what generation got wrong

This is the one place a dissolve earns its keep beyond taste. When two shots share a subject
but not quite its position, or the light has drifted between them, a **short** dissolve —
12 to 20 frames — carries the eye over the discontinuity. A straight cut would show it.

Do not reach for this every time. Two shots that genuinely match should cut, because a cut
is invisible and a dissolve is not.

## Order

Wide before close, unless you have a reason. A close-up first is a deliberate effect — the
audience does not know where they are, which is either tension or confusion depending on
whether you meant it.

Do not cut between two shots of the same size and angle of the same subject. That is a jump
cut, and with generated footage it looks like a mistake because usually it is one.

## Sound holds it together

A continuous ambience under the whole piece does more for coherence than any visual
transition. Shots generated separately have audio that stops and starts; a single bed
underneath makes them one place.

When you have dialogue or a sound with an obvious source, let the sound of the next shot
start a beat before its picture. That is a **J-cut**, and it is the least visible way to
make two shots feel joined.

## Check it with your eyes, not with ffprobe

`ffprobe` tells you the file is 24fps and ten seconds. It cannot tell you the third shot is
two seconds too long.

```bash
skills/cut/contact.sh out.mp4          # one contact sheet of frames across the piece
```

Look at it. Then look at the frames either side of each cut, which is where the problems
are:

```bash
skills/cut/contact.sh out.mp4 --cuts 6 9 13
```
