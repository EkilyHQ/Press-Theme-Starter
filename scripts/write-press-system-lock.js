#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--release-env') options.releaseEnvPath = argv[++i] || '';
    else if (arg === '--system-manifest') options.systemManifestPath = argv[++i] || '';
    else if (arg === '--marker') options.markerPath = argv[++i] || '';
    else if (arg === '--out') options.outPath = argv[++i] || '';
    else if (arg === '--repository') options.repository = argv[++i] || '';
    else if (arg === '--category') options.category = argv[++i] || '';
    else if (arg === '--ref') options.ref = argv[++i] || '';
    else if (arg === '--path') options.observedPath = argv[++i] || '';
    else if (arg === '--observed-type') options.observedType = argv[++i] || '';
    else if (arg === '--reconciler') options.reconciler = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function parseEnvFile(file) {
  const values = {};
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\r?\n/u).forEach((line) => {
    if (!line.trim()) return;
    const index = line.indexOf('=');
    if (index <= 0) throw new Error(`invalid release env line: ${line}`);
    values[line.slice(0, index)] = line.slice(index + 1);
  });
  return values;
}

function normalizeDigest(value) {
  const text = String(value || '').trim().replace(/^sha256:/i, '').toLowerCase();
  if (!text) return '';
  return `sha256:${text}`;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function optionalJson(value) {
  const text = String(value || '').trim();
  if (!text || text === 'null' || text === 'undefined') return null;
  return JSON.parse(text);
}

function requireValue(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function verifyVersionSource(lock, options) {
  const versionSources = [];
  if (options.systemManifestPath) {
    const manifest = readJsonFile(options.systemManifestPath);
    versionSources.push({ label: options.systemManifestPath, version: manifest.version, tag: manifest.tag });
  }
  if (options.markerPath) {
    const marker = readJsonFile(options.markerPath);
    versionSources.push({ label: options.markerPath, version: marker.version, tag: marker.tag });
  }
  versionSources.forEach((source) => {
    if (String(source.version || '') !== lock.version || String(source.tag || '') !== lock.tag) {
      throw new Error(`${source.label} does not match resolved Press release ${lock.tag}`);
    }
  });
}

function buildLock(options) {
  const releaseEnv = parseEnvFile(options.releaseEnvPath || 'dist/press-release-env.txt');
  const repository = requireValue(options.repository || process.env.GITHUB_REPOSITORY, 'repository');
  const sourceKind = requireValue(releaseEnv.source_kind, 'source_kind');
  const tag = requireValue(releaseEnv.tag, 'tag');
  const version = requireValue(releaseEnv.version, 'version');
  const assetDigest = normalizeDigest(releaseEnv.asset_sha256);
  if (!assetDigest) throw new Error('asset_sha256 is required');

  const lock = {
    schemaVersion: 1,
    type: 'press-system-release-lock',
    repository,
    target: {
      category: requireValue(options.category, 'category'),
      ref: requireValue(options.ref, 'ref'),
      path: requireValue(options.observedPath, 'path'),
      type: requireValue(options.observedType, 'observed-type'),
      reconciler: requireValue(options.reconciler, 'reconciler')
    },
    sourceKind,
    version,
    tag,
    releaseUrl: String(releaseEnv.html_url || ''),
    asset: {
      name: requireValue(releaseEnv.asset_name, 'asset_name'),
      url: requireValue(releaseEnv.asset_url, 'asset_url'),
      size: Number(releaseEnv.asset_size || 0),
      digest: assetDigest
    }
  };

  if (!(lock.asset.size > 0)) throw new Error('asset_size must be greater than zero');

  if (releaseEnv.release_intent_source) {
    lock.releaseIntent = {
      type: 'press-release-intent',
      source: releaseEnv.release_intent_source
    };
  }

  const upgradeFrom = optionalJson(releaseEnv.upgrade_from_json);
  if (upgradeFrom) lock.upgradeFrom = upgradeFrom;

  verifyVersionSource(lock, options);
  return lock;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('usage: write-press-system-lock.js --release-env path --out path --repository owner/name --category downstream|themeDemo --ref main|demo --path observed/path --observed-type type --reconciler kind [--system-manifest path] [--marker path]\n');
    return;
  }

  const outPath = options.outPath || 'press-system-lock.json';
  const lock = buildLock(options);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.log(`Updated ${outPath} for ${lock.tag}.`);
}

main();
