"""
Works out what happened to a generation we told the provider to start but never heard back
about.

This exists because a lost response is not a lost generation. The request may have landed
and the money may already be spent; resubmitting would spend it again, and giving up would
throw away a clip that is sitting there finished. Neither is acceptable, so we ask.

The provider does not echo the prompt back in its task list, so a marker cannot be planted
and read. What it does return is when a task was created, which model made it and how long
it is -- enough to recognise our own submission in a narrow window, and enough to know when
we cannot.

Prints one of:

    FOUND <task-id>   exactly one task matches; adopt it
    NONE              nothing matches and enough time has passed; it never landed
    WAIT              nothing matches yet, but the listing may simply be behind
    UNKNOWN <why>     more than one match, or the provider would not say

Anything but FOUND and NONE is a question for a person. That is what `unknown` means.
"""

import json
import os
import subprocess
import sys
import time

# How far either side of our submission a task may have been created and still be ours.
# The provider stamps `created_at` when it accepts, which is after we sent and possibly
# after we stopped listening.
BEFORE = 30
AFTER = 180

# Below this, an empty listing means nothing: the task may exist and not be indexed yet.
SETTLED_AFTER = 90


def listing(gateway: str, token: str) -> list[dict]:
    """The provider's recent tasks, newest first, through the gateway."""
    answered = subprocess.run(
        [
            "curl", "-sS",
            "-H", f"Authorization: Bearer {token}",
            f"{gateway}/seedance/api/v3/contents/generations/tasks?page_size=50",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if answered.returncode != 0:
        raise RuntimeError(answered.stderr.strip() or "the listing could not be fetched")

    return json.loads(answered.stdout).get("items", [])


def ours(task: dict, job: dict) -> bool:
    """Whether one listed task could be the one we submitted."""
    created = task.get("created_at")
    if not isinstance(created, int):
        return False

    submitted = job["submitted_at"]
    if not (submitted - BEFORE <= created <= submitted + AFTER):
        return False

    if task.get("model") != job["model"]:
        return False

    # Duration is what separates two clips submitted a minute apart more often than not.
    return int(task.get("duration", -1)) == int(job["duration"])


def main() -> None:
    job = json.load(open(sys.argv[1]))

    try:
        tasks = listing(os.environ["VID_GATEWAY"], os.environ["VID_TURN_TOKEN"])
    except Exception as why:  # noqa: BLE001 -- any failure here means the same thing
        print(f"UNKNOWN the provider would not say: {why}")
        return

    matches = [task for task in tasks if ours(task, job)]

    if len(matches) == 1:
        print(f"FOUND {matches[0]['id']}")
    elif len(matches) > 1:
        ids = ", ".join(task["id"] for task in matches)
        print(f"UNKNOWN {len(matches)} tasks match that window: {ids}")
    elif time.time() - job["submitted_at"] < SETTLED_AFTER:
        print("WAIT")
    else:
        print("NONE")


main()
