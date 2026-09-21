---
name: generate-clip
description: Generate a video clip from a text prompt, or from a prompt plus a reference image. Use when footage is needed that nobody uploaded — an establishing shot, a cutaway, a background plate. Contains how to write a shot prompt that produces usable footage.
---

# Generating a shot

Generation costs money and takes minutes. **Most of what separates a usable shot from an
unusable one is decided before you call this**, in the sentence you write.

## Before you generate

Look in `clips/` first. Re-cutting footage that exists is free and instant; generating is
neither.

```bash
skills/generate-clip/generate.sh "<prompt>" <seconds> [reference-image]
```

It prints the path of the file it wrote.

## How to write the prompt

Five parts, in this order. The model is not inferring a film from your description — it
responds to specific vocabulary, and whatever you leave out, it invents.

**Subject** — who or what, concretely. Age, material, colour, wear. _"a weathered wooden
rowboat, paint flaking"_ beats _"a boat"_.

**Action** — **one motion arc**, with a beginning and an end. _"drifts slowly left to right
and comes to rest."_ Stacking unrelated actions is the most common way to get a shot where
nothing reads: the model tries to fit all of them into the seconds it has and finishes none.

**Camera** — shot size, angle and movement, in film terms:

|          |                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| size     | wide · medium · close-up · extreme close-up                                                                                                 |
| angle    | eye-level · low · high · overhead                                                                                                           |
| movement | dolly in / push in · dolly out / pull back · pan left / right · tilt up / down · orbit · crane up / down · tracking · handheld · **static** |

Pair movement with a speed: _slow_, _smooth_, _fast_. **"Static" is a real choice** and
often the right one — a held shot lets the subject do the moving, and it cuts against a
moving shot far better than two moving shots cut against each other.

**Lighting** — this carries the emotion more than any adjective you could add. _"golden hour
backlight"_, _"soft overcast daylight"_, _"hard single source, deep shadows"_, _"moody
neon"_.

**Style** — the look, in concrete terms: _"cinematic, shallow depth of field, 35mm film
grain"_, _"documentary, natural colour, deep focus"_.

**Audio** (optional) — ambience in plain words: _"lake water and distant birds"_, _"room
tone, no music"_. Dialogue in quotes.

Put together:

> _A weathered wooden rowboat, paint flaking, drifts slowly left to right and comes to rest.
> Slow dolly-in to a medium shot, eye level. Golden hour backlight, mist on the water.
> Cinematic, shallow depth of field, 35mm film grain. Lake water and distant birds._

## Making shots look like the same film

This is the hard part, and the reason most AI footage does not cut together: two prompts
written in the same style still produce two different worlds.

**Use a reference image, not more adjectives.** Settle the look on a still with
`make-still`, then pass it as the third argument and say _"the lake from the reference"_
rather than describing the lake again. A second description is a second world.

```bash
skills/generate-clip/generate.sh "the camera pushes in slowly across the water" 5 stills/lake.png
```

**Carry the same Lighting and Style sentence across every shot in a sequence, word for
word.** Change Subject, Action and Camera; leave the rest untouched. Write that sentence
into `notes.txt` so the next turn uses the same one.

## The model is not your decision

The script asks for the model this deployment pays for. **If a call is refused, do not pick
a different model and try again** — the gateway will refuse that too, and on the day it does
not, the bill is for something nobody chose.

Read the refusal instead. A rejected _parameter_ says so and names the parameter: durations
in particular are not free-form, and not every length is offered for every model. Fix the
argument and call the script again.

## What it does about failure

The script writes to `.jobs/` **before it sends the request**, not after the reply comes
back. A reply that never arrives is not a generation that never happened — the provider may
have taken the job and the money may already be gone.

So when the next run finds a record with no job id, it does not resubmit. It asks the
provider what it has, matching on when the task was created, which model, and how long:

- found exactly one → picks it up, nothing is paid twice
- found none, and enough time has passed → it never landed, submits again
- **found more than one, or the provider would not answer → stops with `unknown`**

If it prints `unknown`, **do not call it again for the same shot.** Tell the person what
happened and let them decide. That is the one case where guessing costs real money, and it
is the whole reason there is a third state instead of just success and failure.

## Keeping the result

The file lands in `clips/`. Everything in the working directory is kept for the next turn,
so nothing needs uploading.

Write down the prompt that produced a shot you are keeping, in `notes.txt`. The next turn
can see the clip but not the sentence that made it, and working it out again costs another
generation.
