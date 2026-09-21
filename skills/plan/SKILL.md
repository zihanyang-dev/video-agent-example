---
name: plan
description: Show the person what you intend to do, and cross each part off as you finish it. Use at the start of any job that needs more than one generation or more than a couple of minutes.
---

# Saying what you are about to do

A ten-minute job that shows one step at a time looks the same from the outside as a job that
has lost its way. The person cannot see what is left, so they cannot tell whether to wait or
stop you. **The plan is what makes their waiting informed.**

```bash
./plan.sh set \
  "Settle the look on a still" \
  "Generate the establishing shot" \
  "Generate the two cutaways" \
  "Cut them together" \
  "Set the title card"
```

Then, as you go:

```bash
./plan.sh doing 2
./plan.sh done 2
./plan.sh skip 3 "the establishing shot already covers this"
```

Starting one item settles whichever was being worked on before it. It does **not** touch
items you never started — say what happened to those yourself, with `done` or `skip`. A
plan that quietly marks things finished because you moved past them is a plan that lies.

## Write it for them, not for you

Each line is one thing they would recognise as a piece of the film. **"Generate the
establishing shot"** is a line. **"Run ffprobe on the source"** is not — it is how you do
your job, and they are not watching your job, they are watching theirs.

Five to eight lines for most work. Fewer than three means the plan says nothing they could
not already guess; more than ten and nobody reads it.

## Keep it honest as you learn

The plan is written before the work, so it is a guess. Change it when the guess turns out
wrong:

- **`skip` is a real outcome, not a failure.** Finding out a shot is unnecessary is the plan
  doing its job. Saying so is better than leaving it unfinished, which reads as something
  that broke.
- Learned you need a step nobody planned? `set` the whole list again with it included. The
  screen shows one plan, not a history of plans.

## Why it is a file

`.plan.json` lives in the working directory, so it outlives the turn. A turn that dies half
way leaves the plan where the next one finds it — and the next one can pick up at the first
line that is not done rather than working out the whole thing again from the conversation.

Run `./plan.sh show` at the start of a turn that is continuing earlier work: it puts the
plan back on their screen without changing anything.
