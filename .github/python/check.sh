#!/bin/sh
# Tool installation is isolated in RUNNER_TEMP by CI; never use ambient npx/uv.
set -eu
: "${VID_CI_PYTHON_BIN:?Set to the hash-locked tooling venv bin directory}"

# Only repository-owned shipped sources, not operator config or caches.
# Git's file list includes new nonignored sources for local verification too.
source_files() {
  git ls-files --cached --others --exclude-standard -- "$@" \
    ':!:config/**' ':!:.cache/**' ':!:.playwright/**' |
    while IFS= read -r file; do
      [ ! -f "$file" ] || printf '%s\n' "$file"
    done
}
shell_files=$(source_files '*.sh')
yaml_files=$(source_files '*.yaml' '*.yml')
# Repository source names contain no whitespace; splitting these lists is intended.
# shellcheck disable=SC2086
"$VID_CI_PYTHON_BIN/yamllint" --strict $yaml_files
status=0
for file in $shell_files; do
  case "$file" in
    deploy/storage/initialize.sh) shell='bash'; bash -n "$file" || status=1 ;;
    *) shell='sh'; sh -n "$file" || status=1 ;;
  esac
  case "$file" in
    # Library variables are consumed/provided by the sourcing native runners.
    scripts/check-lifecycle.sh) exclude=SC2034,SC2154 ;;
    # The literal body is passed to the container's sh, not expanded on the host.
    tests/scripts/deployment-check.sh) exclude=SC2016 ;;
    *) exclude='' ;;
  esac
  "$VID_CI_PYTHON_BIN/shellcheck" --shell="$shell" --external-sources \
    --exclude="$exclude" "$file" || status=1
done
exit "$status"
