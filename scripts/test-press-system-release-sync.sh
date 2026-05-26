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

if ! grep -F 'scripts/resolve-press-system-release.js' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must resolve Press release intent before updating the marker" >&2
  exit 1
fi

if ! grep -F 'DISPATCH_RELEASE_INTENT_SOURCE' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must prefer release_intent.source from dispatch payloads" >&2
  exit 1
fi

if ! grep -F 'canonical_intent_source="https://raw.githubusercontent.com/${PRESS_REPOSITORY}/release-artifacts/${release_tag}/release-intent.json"' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must fall back to the immutable release-intent path for scheduled runs" >&2
  exit 1
fi

if ! grep -F 'payload_intent_source' "${workflow}" >/dev/null || ! grep -F 'dispatch release_intent.source must match' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must treat dispatch release_intent.source as a canonical-source consistency check only" >&2
  exit 1
fi

if ! grep -F 'system-release.json declares release intent' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must fail when system-release.json declares an intent that cannot be fetched" >&2
  exit 1
fi

if ! grep -F 'PRESS_RELEASE_TARGET_RECONCILER="theme-starter-marker-sync"' "${workflow}" >/dev/null; then
  echo "Press system release sync workflow must validate the Theme Starter release intent target kind" >&2
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

if ! grep -F 'actions/checkout@v6' "${workflow}" >/dev/null || ! grep -F 'actions/checkout@v6' "${theme_workflow}" >/dev/null; then
  echo "Theme Starter workflows must use Node 24-compatible checkout actions" >&2
  exit 1
fi

if grep -E 'actions/(checkout@v4|upload-artifact@v4)' "${workflow}" "${theme_workflow}" >/dev/null; then
  echo "Theme Starter workflows must not pin known Node 20-backed GitHub actions" >&2
  exit 1
fi

node --check "${script}"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

cat > "${tmp_dir}/press-release.json" <<'JSON'
{
  "tag_name": "v9.9.9",
  "name": "v9.9.9",
  "html_url": "https://github.com/EkilyHQ/Press/releases/tag/v9.9.9",
  "published_at": "2026-05-26T00:00:00Z",
  "assets": [
    {
      "name": "press-system-v9.9.9.zip",
      "browser_download_url": "https://github.com/EkilyHQ/Press/releases/download/v9.9.9/press-system-v9.9.9.zip",
      "size": 123,
      "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ]
}
JSON

PRESS_RELEASE_JSON="${tmp_dir}/press-release.json" \
PRESS_SYSTEM_RELEASE_MARKER="${tmp_dir}/press-system-release.json" \
PRESS_ASSET_NAME="press-system-v9.9.9.zip" \
PRESS_ASSET_URL="https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/press-system-v9.9.9.zip" \
PRESS_ASSET_SIZE="456" \
PRESS_ASSET_SHA256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
PRESS_SYSTEM_VERSION="9.9.9" \
PRESS_SYSTEM_TAG="v9.9.9" \
PRESS_UPGRADE_FROM_JSON='{"ranges":[">=9.9.8 <9.9.9"],"allowUnknownSource":false,"message":"Update first."}' \
PRESS_RELEASE_INTENT_SOURCE="https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/release-intent.json" \
node "${script}" >/dev/null

node - "${tmp_dir}/press-system-release.json" <<'NODE'
const fs = require('fs');
const marker = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (marker.asset.url !== 'https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/press-system-v9.9.9.zip') {
  throw new Error('marker must use the resolved asset URL');
}
if (marker.asset.digest !== 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  throw new Error('marker must pair the resolved asset URL with the resolved digest');
}
if (marker.asset.size !== 456) {
  throw new Error('marker must use the resolved asset size');
}
if (marker.releaseIntent?.source !== 'https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/release-intent.json') {
  throw new Error('marker must record the resolved release intent source');
}
if (marker.upgradeFrom?.ranges?.[0] !== '>=9.9.8 <9.9.9') {
  throw new Error('marker must record resolved upgrade metadata');
}
NODE

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
for (const needle of ['PRESS_SYSTEM_VERSION', 'PRESS_UPGRADE_FROM_JSON', 'marker.upgradeFrom', 'PRESS_RELEASE_INTENT_SOURCE', 'marker.releaseIntent']) {
  if (!script.includes(needle)) {
    throw new Error(`sync script must include ${needle}`);
  }
}
NODE

node scripts/test-release-intent-resolution.js

echo "ok - Press system release sync workflow"
