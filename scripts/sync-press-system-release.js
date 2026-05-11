#!/usr/bin/env node
const fs = require('node:fs');

const releasePath = process.env.PRESS_RELEASE_JSON || 'dist/press-release.json';
const outputPath = process.env.PRESS_SYSTEM_RELEASE_MARKER || 'press-system-release.json';
const pressRepository = process.env.PRESS_REPOSITORY || 'EkilyHQ/Press';
const assetName = process.env.PRESS_ASSET_NAME || '';
const assetSize = Number(process.env.PRESS_ASSET_SIZE || 0);
const assetSha256 = String(process.env.PRESS_ASSET_SHA256 || '').replace(/^sha256:/i, '');
const systemVersion = String(process.env.PRESS_SYSTEM_VERSION || '').replace(/^v/i, '');
const upgradeFromJson = String(process.env.PRESS_UPGRADE_FROM_JSON || '').trim();

if (!fs.existsSync(releasePath)) {
  throw new Error(`Press release JSON not found: ${releasePath}`);
}

const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
const assets = Array.isArray(release.assets) ? release.assets : [];
const asset = assets.find((candidate) => {
  const name = String(candidate.name || '');
  if (assetName) return name === assetName;
  return /^press-system-v\d+\.\d+\.\d+\.zip$/.test(name);
});

if (!asset) {
  throw new Error('Press system release asset not found');
}

const body = String(release.body || '');
const digest = String(asset.digest || assetSha256 || '').replace(/^sha256:/i, '')
  || ((body.match(/SHA-256:\s*`?([a-fA-F0-9]{64})`?/) || [])[1] || '');
const tag = release.tag_name || '';
const version = systemVersion || String(tag).replace(/^v/i, '');

const marker = {
  schemaVersion: 1,
  pressRepository,
  version,
  tag,
  name: release.name || tag || '',
  publishedAt: release.published_at || release.created_at || '',
  releaseUrl: release.html_url || '',
  asset: {
    name: asset.name || assetName,
    url: asset.browser_download_url || '',
    size: Number(asset.size || assetSize || 0),
    digest: digest ? `sha256:${digest}` : ''
  }
};

if (upgradeFromJson && upgradeFromJson !== 'null') {
  marker.upgradeFrom = JSON.parse(upgradeFromJson);
}

fs.writeFileSync(outputPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
console.log(`Updated ${outputPath} for ${marker.tag}.`);
