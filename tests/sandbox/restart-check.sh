#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/scripts/check-lifecycle.sh"
cd "$root"
staging=$(mktemp -d)
ssh_config="$root/.cache/e2b/lima/e2b/ssh.config"
owner="vid-native-restart-$$-$(basename "$staging")"
remote_attempted=0
ssh_vm() { run_stage "$run_timeout" ssh -F "$ssh_config" -T -o ConnectTimeout=5 -o ServerAliveInterval=3 -o ServerAliveCountMax=3 lima-e2b "$@"; }
cleanup() {
 status=$?; trap - EXIT HUP INT TERM
 failed=0
 # The build has no sandbox or runner to reconcile. Seed dispatch can commit
 # before losing its receipt, so cleanup must check actual labelled ownership.
 if [ "$remote_attempted" -eq 1 ]; then
 ssh_vm sh -s -- "$owner" <<'CLEAN' || failed=1
set -eu
cd "$HOME/e2b"
if sudo timeout 10 docker inspect "$1" >/dev/null 2>&1; then
 label=$(sudo timeout 5 docker inspect --format '{{ index .Config.Labels "vid.check.owner" }}' "$1")
 [ "$label" = "$1" ] || exit 1
 sudo timeout 10 docker stop --time 5 "$1" >/dev/null || :
 sudo timeout 5 docker start "$1" >/dev/null
 sudo timeout 10 sh -c 'iptables -C INPUT -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I INPUT 1 -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP; iptables -C DOCKER-USER -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP'
 sudo timeout 90 docker compose up -d --wait >/dev/null
 sudo timeout 15 docker exec -e E2B_RESTART_PHASE=cleanup "$1" bun test tests/sandbox/native-restart.test.ts
 label=$(sudo timeout 5 docker inspect --format '{{ index .Config.Labels "vid.check.owner" }}' "$1")
 [ "$label" = "$1" ] || exit 1
 sudo timeout 5 docker rm -f "$1" >/dev/null
else
 # A failed inspect is not evidence of absence (daemon errors and timeouts
 # have the same status). Only a successful full listing may release metadata.
 names=$(sudo timeout 10 docker container ls -a --format '{{.Names}}')
 if printf '%s\n' "$names" | grep -Fx "$1" >/dev/null; then
  echo "Cleanup inspection uncertain for owned runner $1" >&2
  exit 1
 fi
fi
sudo timeout 5 rm -f "/tmp/$1.env"
CLEAN
 fi
 rm -rf "$staging" || failed=1
 if [ "$failed" -ne 0 ]; then echo "Cleanup incomplete for owned runner $owner" >&2; fi
 if [ "$status" -eq 0 ]; then status=$failed; fi
 exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Both the SDK test image and Embed stay on the dedicated Docker daemon.
run_stage "$setup_timeout" tar --no-xattrs --no-mac-metadata -C "$root" \
  --exclude=.git --exclude=.cache --exclude=.playwright-cli \
  --exclude=.ruff_cache --exclude=node_modules \
  --exclude='.env*' --exclude='credentials*' -cf "$staging/context.tar" .
ssh_vm sudo timeout 300 docker build --quiet -f deploy/docker/checks.Dockerfile - \
  < "$staging/context.tar" > "$staging/image"
image=$(cat "$staging/image")
remote_attempted=1
ssh_vm sh -s -- "$image" "$owner" <<'SEED'
set -eu
cd "$HOME/e2b"; umask 077
sudo timeout 5 iptables -C INPUT -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP
sudo timeout 5 iptables -C DOCKER-USER -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP
sudo timeout 10 docker compose exec -T ready sh -c 'umask 077; printf "E2B_API_URL=http://127.0.0.1:3000\nE2B_SANDBOX_URL=http://127.0.0.1:3002\nE2B_API_KEY=%s\n" "$(cat /run/e2b/team-api-key)" > "/tmp/$1.env"' sh "$2"
sudo timeout 10 docker cp "e2b-ready-1:/tmp/$2.env" "/tmp/$2.env"
sudo timeout 5 chmod 600 "/tmp/$2.env"
sudo timeout 10 docker create --name "$2" --label "vid.check.owner=$2" --network host --env-file "/tmp/$2.env" --env "E2B_RESTART_OWNER=$2" "$1" sleep 600 >/dev/null
sudo timeout 10 docker start "$2" >/dev/null
sudo timeout 20 docker exec -e E2B_RESTART_PHASE=seed "$2" bun test tests/sandbox/native-restart.test.ts
sudo timeout 5 docker compose exec -T ready rm -f "/tmp/$2.env"
# Stop services first so none auto-start before guards on the next boot.
sudo timeout 90 docker compose stop --timeout 10
SEED
run_stage "$setup_timeout" env HOME="$root/.cache/e2b/host-home" LIMA_HOME="$root/.cache/e2b/lima" limactl stop e2b
run_stage "$setup_timeout" env HOME="$root/.cache/e2b/host-home" LIMA_HOME="$root/.cache/e2b/lima" limactl start e2b
ssh_vm sh -s -- "$owner" <<'RESUME'
set -eu
sudo timeout 10 sh -c 'iptables -C INPUT -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I INPUT 1 -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP; iptables -C DOCKER-USER -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP'
cd "$HOME/e2b"
sudo timeout 90 docker compose up -d --wait >/dev/null
sudo timeout 5 docker start "$1" >/dev/null
sudo timeout 100 docker exec -e E2B_RESTART_PHASE=resume "$1" bun test tests/sandbox/native-restart.test.ts
RESUME
