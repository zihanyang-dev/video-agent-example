# Shared Docker/SSH client lifecycle for check runners (sourced, not executable).
# Call only direct CLI processes: their remote resources require separate cleanup.
client=''
setup_timeout=${VID_SETUP_TIMEOUT:-120}
run_timeout=${VID_RUN_TIMEOUT:-300}

settle_cleanup() {
  cleanup_attempt=0
  while kill -0 "$1" 2>/dev/null; do
    cleanup_attempt=$((cleanup_attempt + 1))
    if [ "$cleanup_attempt" -ge 50 ]; then
      echo 'Cleanup timed out; owned resources may require operator removal' >&2
      kill -KILL "$1" 2>/dev/null || :
      wait "$1" 2>/dev/null || :
      return 1
    fi
    sleep 0.1
  done
  wait "$1"
}

run_stage() {
  stage_limit=$1
  shift
  "$@" <&0 &
  client=$!
  stage_end=$(($(date +%s) + stage_limit))
  while kill -0 "$client" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$stage_end" ]; then
      echo "Stage timed out: $*" >&2
      kill "$client" 2>/dev/null || :
      settle_cleanup "$client" 2>/dev/null || :
      client=''
      return 124
    fi
    sleep 0.1
  done
  stage_status=0
  wait "$client" || stage_status=$?
  client=''
  return "$stage_status"
}

# Name alone is not deletion authority, including after create loses its ACK.
remove_owned() {
  resource=$1
  resource_name=$2
  if [ "$resource" = container ]; then
    label_format='{{.Id}} {{ index .Config.Labels "vid.check.owner" }}'
  else
    label_format='{{.Id}} {{ index .Labels "vid.check.owner" }}'
  fi
  docker "$resource" inspect --format "$label_format" "$resource_name" > "$staging/owner" 2>/dev/null &
  settle_cleanup "$!" || return 1
  read -r owned_id owned_label < "$staging/owner" || return 1
  [ "$owned_label" = "$owner" ] || return 1
  if [ "$resource" = container ]; then
    docker rm -f -v "$owned_id" >/dev/null &
  else
    docker network rm "$owned_id" >/dev/null &
  fi
  settle_cleanup "$!"
}
