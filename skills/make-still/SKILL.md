---
name: make-still
description: Make a still image from a text prompt using Seedream. Use for a reference frame to animate, a background plate, or a look test before spending on video.
---

# Making a still

A still costs a few cents and comes back in seconds. A clip costs dollars and takes minutes.
**When you are unsure what a shot should look like, find out here first.**

## Making one

```bash
./still.sh "a misty lake at dawn, low sun, cold blue light" 1280x720
```

The arguments are the prompt and the size. It prints the path of the file it wrote.

Sizes are `WIDTHxHEIGHT`. Match the size to the video you are cutting: a still made at a
different aspect ratio has to be cropped, and the crop takes away the part of the frame you
chose it for.

## Using it as a reference

The usual reason to make a still is to animate it:

```bash
./still.sh "a misty lake at dawn, low sun, cold blue light" 1280x720
./generate.sh "the camera pushes in slowly across the water" 5 stills/a-misty-lake-at-dawn.png
```

Doing it in this order means the look is settled before the expensive call. Generating two
clips to compare two looks costs more than generating six stills.

## What it does about failure

Nothing, on purpose. This is one request that either returns an image or returns an error,
so there is no half-finished state to record — unlike `generate-clip`, where the money is
spent minutes before the result exists. If it fails, read the error and try again.

## Keeping the result

The file lands in `stills/`. Write down which prompt produced the look you settled on; the
next turn can see the image but not the sentence that made it.
