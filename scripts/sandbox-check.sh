#!/bin/sh
set -eu
if [ "${1:-}" = --restart ]; then
  shift
  exec sh "$(dirname -- "$0")/../tests/sandbox/restart-check.sh" "$@"
fi

# The verified Embed VM is separate from the existing Colima daemon. This runner
# neither creates/starts it nor installs host software; see docs/e2b-local.md.
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
. "$root/scripts/check-lifecycle.sh"
ssh_config="$root/.cache/e2b/lima/e2b/ssh.config"
if [ ! -f "$ssh_config" ]; then
  echo 'Local E2B Embed is not configured; see docs/e2b-local.md' >&2
  exit 1
fi
if [ "$#" -eq 0 ]; then set -- tests/sandbox/e2b.test.ts; fi
staging=$(mktemp -d)
runner="vid-e2b-tests-$$-$(basename "$staging")"
remote_attempted=0
ssh_vm() {
  run_stage "$run_timeout" ssh -F "$ssh_config" -T -o ConnectTimeout=5 -o ServerAliveInterval=3 \
    -o ServerAliveCountMax=3 lima-e2b "$@"
}
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  failed=0
  if [ -n "$client" ]; then
    kill "$client" 2>/dev/null || :
    settle_cleanup "$client" 2>/dev/null || :
    client=''
  fi
  if [ "$remote_attempted" -eq 1 ]; then
    # Disconnect is not termination proof. Ask the owned remote shell to clean up;
    # its independent timeout remains effective even when this connection fails.
    ssh_vm sh -s -- "$runner" <<'CANCEL' || failed=1
set -eu
control="$HOME/e2b/.$1"
if [ -f "$control/pid" ]; then kill -TERM "$(cat "$control/pid")"; fi
attempt=0
while [ -d "$control" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 10 ]; then echo "Remote cleanup remains unconfirmed for $1" >&2; exit 1; fi
  sleep 1
done
CANCEL
  fi
  rm -rf "$staging" || failed=1
  if [ "$failed" -ne 0 ]; then echo "Cleanup incomplete for owned runner $runner" >&2; fi
  if [ "$status" -eq 0 ]; then status=$failed; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Build only inside the dedicated VM; never use the host's default Docker context.
run_stage "$setup_timeout" tar --no-xattrs --no-mac-metadata -C "$root" \
  --exclude=.git --exclude=.cache --exclude=node_modules \
  --exclude='.env*' --exclude='credentials*' -cf "$staging/context.tar" .
ssh_vm sudo timeout --signal=TERM --kill-after=5 300 docker build --quiet \
  -f deploy/docker/checks.Dockerfile - < "$staging/context.tar" > "$staging/image"
image=$(cat "$staging/image")
remote_attempted=1
ssh_vm timeout --signal=TERM --kill-after=90 240 sh -s -- "$image" "$runner" "$@" <<'REMOTE'
set -eu
image=$1
runner=$2
shift 2
cd "$HOME/e2b"
umask 077
control="$HOME/e2b/.$runner"
mkdir "$control"
# A TEST-NET address avoids weakening Embed's predefined private-range deny.
# Restrict the temporary alias to one owned probe port, never the management ports.
probe_host=203.0.113.254
probe_port=$((30000 + $$ % 20000))
alias_created=0
runner_created=0
allow_rule_created=0
deny_rule_created=0
client=''
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  failed=0
  # Interrupt wait immediately; the native timeout forwards cancellation to
  # its Docker client. Resource deletion below still checks actual ownership.
  if [ -n "$client" ]; then
    kill -TERM "$client" 2>/dev/null || :
    wait "$client" 2>/dev/null || :
    client=''
  fi
  # A disconnected Docker client does not prove its container stopped.
  if [ "$runner_created" -eq 1 ]; then
    ownership=$(sudo timeout 10 docker inspect --format '{{.Id}} {{ index .Config.Labels "vid.check.owner" }}' "$runner" 2>/dev/null) || ownership=''
    owned_id=${ownership%% *}
    if [ "${ownership#* }" = "$runner" ]; then
      sudo timeout 10 docker rm -f -v "$owned_id" >/dev/null 2>&1 || failed=1
    else
      failed=1
    fi
  fi
  alias_remaining=0
  if [ "$alias_created" -eq 1 ]; then
    if ! sudo timeout 10 ip addr del "$probe_host/32" dev lo; then
      failed=1
      alias_remaining=1
      echo "Retaining management-port guard for leftover alias $probe_host ($runner)" >&2
    fi
  fi
  if [ "$deny_rule_created" -eq 1 ] && [ "$alias_remaining" -eq 0 ]; then
    sudo timeout 10 iptables -D INPUT -d "$probe_host" -m conntrack --ctstate NEW -m comment --comment "$runner" -j DROP || failed=1
  fi
  if [ "$allow_rule_created" -eq 1 ]; then
    sudo timeout 10 iptables -D INPUT -d "$probe_host" -p tcp --dport "$probe_port" -m comment --comment "$runner" -j ACCEPT || failed=1
  fi
  sudo timeout 10 rm -rf "$control" || failed=1
  sudo timeout 10 docker compose exec -T ready rm -f "/tmp/$runner.env" || failed=1
  if [ "$failed" -ne 0 ]; then echo "Cleanup incomplete for owned runner $runner" >&2; fi
  if [ "$status" -eq 0 ]; then status=$failed; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
echo $$ > "$control/pid"
# Serialize the shared TEST-NET alias; never delete a preexisting alias.
exec 9> "$HOME/e2b/.check-probe.lock"
flock -w 10 9
sudo timeout --signal=TERM --kill-after=2 10 ip -o addr show dev lo > "$control/addresses"
if grep -q "$probe_host/32" "$control/addresses"; then
  echo "Probe alias already exists: $probe_host" >&2
  exit 1
fi
# Fail closed if the owned host was restarted without management-port guards.
sudo timeout --signal=TERM --kill-after=2 5 iptables -C INPUT -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP
sudo timeout --signal=TERM --kill-after=2 5 iptables -C DOCKER-USER -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP
# Derive only the local team key. Administrative/API signing secrets stay in Embed.
sudo timeout --signal=TERM --kill-after=2 10 docker compose exec -T ready sh -c '
  umask 077
  printf "E2B_API_URL=http://127.0.0.1:3000\nE2B_SANDBOX_URL=http://127.0.0.1:3002\nE2B_API_KEY=%s\n" "$(cat /run/e2b/team-api-key)" > "/tmp/$1.env"
' sh "$runner"
sudo timeout --signal=TERM --kill-after=2 10 docker cp "e2b-ready-1:/tmp/$runner.env" "$control/key.env"
sudo timeout --signal=TERM --kill-after=2 10 chmod 600 "$control/key.env"
deny_rule_created=1
sudo timeout --signal=TERM --kill-after=2 10 iptables -I INPUT 1 -d "$probe_host" -m conntrack --ctstate NEW -m comment --comment "$runner" -j DROP
allow_rule_created=1
sudo timeout --signal=TERM --kill-after=2 10 iptables -I INPUT 1 -d "$probe_host" -p tcp --dport "$probe_port" -m comment --comment "$runner" -j ACCEPT
alias_created=1
sudo timeout --signal=TERM --kill-after=2 10 ip addr add "$probe_host/32" dev lo
runner_created=1
sudo timeout --signal=TERM --kill-after=2 30 docker create --label "vid.check.owner=$runner" --name "$runner" --network host --env-file "$control/key.env" \
  --env "E2B_TEST_HOST=$probe_host" --env "E2B_TEST_PORT=$probe_port" \
  --env MODEL_API_KEY=worker-model-canary --env DATABASE_URL=postgres://worker-db-canary \
  --env TURN_TOKEN_SECRET=worker-signing-canary "$image" bun test "$@" >/dev/null
sudo timeout --signal=TERM --kill-after=2 180 docker start -a "$runner" &
client=$!
wait "$client"
client=''
REMOTE
