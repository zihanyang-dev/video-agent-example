#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
. "$root/scripts/check-lifecycle.sh"
staging=$(mktemp -d)
owner="vid-check-$$-$(basename "$staging")"
container=$owner
create_attempted=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  failed=0
  if [ "$create_attempted" -eq 1 ]; then remove_owned container "$container" || failed=1; fi
  rm -rf "$staging" || failed=1
  if [ "$failed" -ne 0 ]; then echo "Cleanup incomplete for owned container $container" >&2; fi
  if [ "$status" -eq 0 ]; then status=$failed; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

image=${VID_CHECK_IMAGE:-}
if [ -z "$image" ]; then
  run_stage "$setup_timeout" docker build --quiet -f "$root/deploy/docker/checks.Dockerfile" "$root" > "$staging/image"
  image=$(cat "$staging/image")
fi
if [ "$#" -eq 0 ]; then set -- run check; fi

# Record the owned name before creation so cancellation still cleans up.
create_attempted=1
run_stage "$setup_timeout" docker create --name "$container" --label "vid.check.owner=$owner" "$image" bun "$@" >/dev/null
# Use the filtered image only; mounting the checkout would expose operator secrets.
run_stage "$run_timeout" docker start -a "$container"
