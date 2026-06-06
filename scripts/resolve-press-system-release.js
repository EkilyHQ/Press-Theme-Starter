#!/usr/bin/env node
const fs = require('node:fs');

const RELEASE_INTENT_TYPE = 'press-release-intent';
const DEFAULT_PRESS_REPOSITORY = 'EkilyHQ/Press';

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--release') options.releasePath = argv[++i] || '';
    else if (arg === '--release-intent') options.intentPath = argv[++i] || '';
    else if (arg === '--out') options.outPath = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function normalizeSemver(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (!match) return '';
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function semverToTag(value) {
  const version = normalizeSemver(value);
  return version ? `v${version}` : '';
}

function normalizeTag(value) {
  return semverToTag(value);
}

function normalizeDigest(value) {
  return String(value || '').trim().replace(/^sha256:/i, '').toLowerCase();
}

function canonicalReleaseIntentSource(pressRepository, tag) {
  const repository = String(pressRepository || DEFAULT_PRESS_REPOSITORY).trim() || DEFAULT_PRESS_REPOSITORY;
  const releaseTag = normalizeTag(tag);
  if (!releaseTag) return '';
  return `https://raw.githubusercontent.com/${repository}/release-artifacts/${releaseTag}/release-intent.json`;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readOptionalJsonFile(file) {
  if (!file || !fs.existsSync(file) || fs.statSync(file).size === 0) return null;
  return readJsonFile(file);
}

function requireString(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function envValue(name, fallback = '') {
  return process.env[name] || fallback;
}

function outputLine(key, value) {
  return `${key}=${String(value == null ? '' : value).replace(/\r?\n/g, ' ')}`;
}

function writeOutputs(values, outPath) {
  const text = Object.entries(values).map(([key, value]) => outputLine(key, value)).join('\n') + '\n';
  if (outPath) fs.writeFileSync(outPath, text, 'utf8');
  else process.stdout.write(text);
}

function targetExpectations() {
  return {
    repository: envValue('PRESS_TARGET_REPOSITORY', envValue('GITHUB_REPOSITORY')),
    category: envValue('PRESS_RELEASE_TARGET_CATEGORY'),
    ref: envValue('PRESS_RELEASE_TARGET_REF'),
    path: envValue('PRESS_RELEASE_TARGET_PATH'),
    type: envValue('PRESS_RELEASE_TARGET_TYPE'),
    reconciler: envValue('PRESS_RELEASE_TARGET_RECONCILER')
  };
}

function assertIntentTarget(intent, expected) {
  const repository = requireString(expected.repository, 'PRESS_TARGET_REPOSITORY or GITHUB_REPOSITORY');
  const targets = Array.isArray(intent.targets) ? intent.targets : [];
  const target = targets.find((candidate) => String(candidate && candidate.repository || '') === repository);
  if (!target) throw new Error(`release intent does not target ${repository}`);

  const observed = target.observed && typeof target.observed === 'object' ? target.observed : {};
  const reconciler = target.reconciler && typeof target.reconciler === 'object' ? target.reconciler : {};
  const targetExpected = target.expected && typeof target.expected === 'object' ? target.expected : {};
  const checks = [
    ['category', target.category, expected.category],
    ['eventType', target.eventType, 'press-system-release'],
    ['observed.ref', observed.ref, expected.ref],
    ['observed.path', observed.path, expected.path],
    ['observed.type', observed.type, expected.type],
    ['reconciler.kind', reconciler.kind, expected.reconciler]
  ];
  for (const [label, actual, wanted] of checks) {
    if (wanted && String(actual || '') !== wanted) {
      throw new Error(`release intent target ${repository} ${label} must be ${wanted}`);
    }
  }
  if (reconciler.idempotent !== true) {
    throw new Error(`release intent target ${repository} reconciler must be idempotent`);
  }
  if (normalizeSemver(targetExpected.version) !== normalizeSemver(intent.version)
    || normalizeTag(targetExpected.tag || targetExpected.version) !== normalizeTag(intent.tag || intent.version)) {
    throw new Error(`release intent target ${repository} expected version must match the intent`);
  }
}

function resolveFromIntent({ release, intent }) {
  if (Number(intent.schemaVersion || 0) !== 1) {
    throw new Error('release intent schemaVersion must be 1');
  }
  if (String(intent.type || '') !== RELEASE_INTENT_TYPE) {
    throw new Error(`release intent type must be ${RELEASE_INTENT_TYPE}`);
  }

  const version = normalizeSemver(intent.version);
  const tag = normalizeTag(intent.tag || intent.version);
  if (!version || tag !== semverToTag(version)) {
    throw new Error('release intent must declare matching version and tag');
  }
  if (release.tag_name && normalizeTag(release.tag_name) !== tag) {
    throw new Error('release intent tag must match the resolved GitHub release');
  }
  const pressRepository = envValue('PRESS_REPOSITORY', DEFAULT_PRESS_REPOSITORY);
  if (intent.repository && String(intent.repository) !== pressRepository) {
    throw new Error(`release intent repository must be ${pressRepository}`);
  }
  const canonicalSource = canonicalReleaseIntentSource(pressRepository, tag);
  const payloadSource = envValue('DISPATCH_RELEASE_INTENT_SOURCE', envValue('PRESS_RELEASE_INTENT_SOURCE'));
  if (payloadSource && payloadSource !== canonicalSource) {
    throw new Error('dispatch release_intent.source must match the canonical immutable release intent URL');
  }
  if (intent.source !== canonicalSource) {
    throw new Error('release intent source must match the canonical immutable release intent URL');
  }

  assertIntentTarget(intent, targetExpectations());

  const pressSystem = intent.pressSystem && typeof intent.pressSystem === 'object' ? intent.pressSystem : {};
  const asset = pressSystem.asset && typeof pressSystem.asset === 'object' ? pressSystem.asset : {};
  const assetName = requireString(asset.name, 'release intent pressSystem.asset.name');
  const assetUrl = requireString(asset.url, 'release intent pressSystem.asset.url');
  const assetDigest = normalizeDigest(asset.digest);
  const assetSize = Number(asset.size || 0);
  if (!assetDigest) throw new Error('release intent pressSystem.asset.digest is required');
  if (!(assetSize > 0)) throw new Error('release intent pressSystem.asset.size must be greater than zero');

  return {
    source_kind: 'release-intent',
    tag,
    version,
    asset_name: assetName,
    asset_url: assetUrl,
    asset_size: assetSize,
    asset_sha256: assetDigest,
    html_url: (intent.systemRelease && intent.systemRelease.htmlUrl) || release.html_url || '',
    release_intent_source: canonicalSource,
    upgrade_from_json: JSON.stringify(pressSystem.upgradeFrom && typeof pressSystem.upgradeFrom === 'object'
      ? pressSystem.upgradeFrom
      : {})
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('usage: resolve-press-system-release.js --release path --release-intent path [--out path]\n');
    return;
  }
  const releasePath = options.releasePath || envValue('PRESS_RELEASE_JSON', 'dist/press-release.json');
  const release = readJsonFile(releasePath);
  const intentPath = options.intentPath || envValue('PRESS_RELEASE_INTENT_JSON');
  const intent = readOptionalJsonFile(intentPath);
  if (!intent) {
    throw new Error('release intent is required; legacy GitHub release metadata fallback has been sunset');
  }
  const resolved = resolveFromIntent({ release, intent });
  writeOutputs(resolved, options.outPath);
}

main();
