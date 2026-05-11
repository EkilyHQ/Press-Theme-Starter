#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

workflow=".github/workflows/sync-press-system-release.yml"
script="scripts/sync-press-system-release.js"
theme_workflow=".github/workflows/theme-release.yml"
theme_manifest="theme/theme.json"
theme_release_example="theme-release.example.json"

for path in "${workflow}" "${script}" "${theme_workflow}" "${theme_manifest}" "${theme_release_example}"; do
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

if ! grep -F 'PRESS_SYSTEM_VERSION' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must pass through the Press version" >&2
  exit 1
fi

if ! grep -F 'PRESS_UPGRADE_FROM_JSON' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must pass through upgrade compatibility metadata" >&2
  exit 1
fi

if grep -F 'pull-requests: write' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must not request pull request permissions" >&2
  exit 1
fi

node --check "${script}"

node <<'NODE'
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('theme/theme.json', 'utf8'));
const example = JSON.parse(fs.readFileSync('theme-release.example.json', 'utf8'));
if (manifest.engines?.press !== '>=3.4.0 <4.0.0') {
  throw new Error('theme/theme.json must declare engines.press >=3.4.0 <4.0.0');
}
if (example.engines?.press !== manifest.engines.press) {
  throw new Error('theme-release.example.json must carry the same engines.press range');
}
const workflow = fs.readFileSync('.github/workflows/theme-release.yml', 'utf8');
for (const needle of ['themeManifest.engines', 'engines,', 'theme/theme.json must declare engines.press']) {
  if (!workflow.includes(needle)) {
    throw new Error(`theme release workflow must include ${needle}`);
  }
}
const script = fs.readFileSync('scripts/sync-press-system-release.js', 'utf8');
for (const needle of ['PRESS_SYSTEM_VERSION', 'PRESS_UPGRADE_FROM_JSON', 'marker.upgradeFrom']) {
  if (!script.includes(needle)) {
    throw new Error(`sync script must include ${needle}`);
  }
}
NODE

echo "ok - Press system release sync workflow"
