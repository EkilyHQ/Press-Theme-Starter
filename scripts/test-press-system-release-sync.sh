#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

workflow=".github/workflows/sync-press-system-release.yml"
script="scripts/sync-press-system-release.js"

for path in "${workflow}" "${script}"; do
  if [[ ! -f "${path}" ]]; then
    echo "expected ${path} to exist" >&2
    exit 1
  fi
done

if ! grep -F 'repository_dispatch:' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must accept repository_dispatch events" >&2
  exit 1
fi

if ! grep -F 'press-system-release' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must listen for press-system-release" >&2
  exit 1
fi

if ! grep -F 'scripts/sync-press-system-release.js' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must run the local sync script" >&2
  exit 1
fi

if ! grep -F 'press-system-release.json' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must commit the version marker" >&2
  exit 1
fi

if grep -F 'pull-requests: write' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must not request pull request permissions" >&2
  exit 1
fi

node --check "${script}"

echo "ok - Press system release sync workflow"
