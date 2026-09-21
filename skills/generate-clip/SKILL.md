---
name: generate-clip
description: Generate a video clip from a text prompt, or from a prompt plus a reference image, using Seedance. Use when footage is needed that nobody uploaded — an establishing shot, a cutaway, a background plate.
---

# Generating a clip

Generation costs money and takes minutes. Read this before calling it.

## Before you generate

Look at what is already in `clips/` first. Re-cutting footage that exists is free and
instant; generating is neither.

## Generating

```bash
./generate.sh "a slow drone shot over a misty lake at dawn" 5
```

The arguments are the prompt and the duration in seconds. It prints the path of the file it
wrote when it finishes.

To animate an image you already have, pass it as a third argument:

```bash
./generate.sh "the camera pushes in slowly" 5 stills/lake.png
```

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

Write down what you asked for in `notes.txt`. The next turn cannot see this conversation,
only the files.
