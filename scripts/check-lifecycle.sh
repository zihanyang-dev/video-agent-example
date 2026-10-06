# Shared native timeout and exact-label cleanup for isolated check runners.
setup_timeout=${VID_SETUP_TIMEOUT:-600}
run_timeout=${VID_RUN_TIMEOUT:-600}
ready_timeout=${VID_READY_TIMEOUT:-60}
if command -v timeout >/dev/null 2>&1; then
  timeout_bin=timeout
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_bin=gtimeout
else
  echo 'GNU timeout is required (brew install coreutils on macOS)' >&2
  return 2
fi
for deadline in "$setup_timeout" "$run_timeout" "$ready_timeout"; do
  case "$deadline" in
    ''|0*|*[!0-9]*|?????*) echo 'Invalid check deadline: require 1..3600 seconds' >&2; return 2 ;;
  esac
  [ "$deadline" -le 3600 ] || return 2
done
run_stage() {
  stage_limit=$1
  shift
  "$timeout_bin" --signal=TERM --kill-after=10s "$stage_limit" "$@"
}

# A matching name is not authority to delete someone else's resource.
remove_owned() {
  resource=$1
  resource_name=$2
  if [ "$resource" = container ]; then
    label_format='{{.Id}} {{ index .Config.Labels "vid.check.owner" }}'
  else
    label_format='{{.Id}} {{ index .Labels "vid.check.owner" }}'
  fi
  run_stage 10 docker "$resource" inspect --format "$label_format" "$resource_name" > "$staging/owner" || return 1
  read -r owned_id owned_label < "$staging/owner" || return 1
  [ "$owned_label" = "$owner" ] || return 1
  if [ "$resource" = container ]; then
    run_stage 10 docker rm -f -v "$owned_id" >/dev/null
  else
    run_stage 10 docker network rm "$owned_id" >/dev/null
  fi
}
