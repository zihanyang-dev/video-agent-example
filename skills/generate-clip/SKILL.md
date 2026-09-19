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

## What it does about failure

The script writes the job id to `.jobs/` **before** it starts waiting. If something kills
this turn half way, the next one finds that file and picks the same job back up rather than
paying for it twice.

If it prints `unknown`, the generation may or may not have run. **Do not call it again for
the same shot.** Tell the person what happened and let them decide — that is the one case
where guessing costs real money.

## Keeping the result

The file lands in `clips/`. Everything in the working directory is kept for the next turn,
so nothing needs uploading.

Write down what you asked for in `notes.txt`. The next turn cannot see this conversation,
only the files.
