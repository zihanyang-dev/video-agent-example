#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
container=''
client=''

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  failed=0
  if [ -n "$client" ]; then kill "$client" 2>/dev/null || :; fi
  # Remove by the ID returned by create; never sweep containers or use a shared image tag.
  if [ -n "$container" ]; then
    docker rm -f -v "$container" >/dev/null &
    remover=$!
    settle_cleanup "$remover" || failed=1
  fi
  if [ -n "$client" ]; then settle_cleanup "$client" 2>/dev/null || :; fi
  if [ "$status" -eq 0 ]; then status=$failed; fi
  exit "$status"
}
settle_cleanup() {
  attempt=0
  # A stalled daemon must not make cancellation wait forever. Removal may remain unknown.
  while kill -0 "$1" 2>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 50 ]; then
      echo "Cleanup timed out; container $container may require operator removal" >&2
      kill -KILL "$1" 2>/dev/null || :
      wait "$1" 2>/dev/null || :
      return 1
    fi
    sleep 0.1
  done
  wait "$1"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

image=$(docker build --quiet -f "$root/deploy/docker/checks.Dockerfile" "$root")
if [ "$#" -eq 0 ]; then set -- run check; fi

# Use the filtered image only; mounting the checkout would expose operator secrets.
container=$(docker create --name "vid-check-runner-$$" "$image" bun "$@")
# Waiting on the attached client lets signal traps stop the owned container promptly.
docker start -a "$container" &
client=$!
wait "$client"
client=''
