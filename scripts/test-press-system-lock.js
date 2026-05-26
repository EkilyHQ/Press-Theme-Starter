#!/usr/bin/env node
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const repoName = process.env.GITHUB_REPOSITORY
  ? process.env.GITHUB_REPOSITORY.split('/').pop()
  : path.basename(repoRoot);
const script = path.join(repoRoot, 'scripts', 'write-press-system-lock.js');
const digest = 'a'.repeat(64);

function repoContract(name) {
  if (name === 'YAP') {
    return {
      repository: 'EkilyHQ/YAP',
      category: 'downstream',
      ref: 'main',
      observedPath: 'assets/press-system.json',
      observedType: 'press-system-manifest',
      reconciler: 'press-runtime-sync',
      versionSource: 'system'
    };
  }
  if (name === 'Press-Theme-Starter') {
    return {
      repository: 'EkilyHQ/Press-Theme-Starter',
      category: 'downstream',
      ref: 'main',
      observedPath: 'press-system-release.json',
      observedType: 'press-release-marker',
      reconciler: 'theme-starter-marker-sync',
      versionSource: 'marker'
    };
  }
  const match = name.match(/^Press-Theme-([A-Za-z0-9_-]+)$/u);
  if (match) {
    return {
      repository: `EkilyHQ/${name}`,
      category: 'themeDemo',
      ref: 'demo',
      observedPath: 'assets/press-system.json',
      observedType: 'press-system-manifest',
      reconciler: 'theme-demo-runtime-sync',
      versionSource: 'system'
    };
  }
  throw new Error(`unsupported repository ${name}`);
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'press-system-lock-'));
try {
  const contract = repoContract(repoName);
  const envPath = path.join(tmpDir, 'press-release-env.txt');
  const outPath = path.join(tmpDir, 'press-system-lock.json');
  const systemPath = path.join(tmpDir, 'assets', 'press-system.json');
  const markerPath = path.join(tmpDir, 'press-system-release.json');

  writeFile(envPath, [
    'source_kind=release-intent',
    'tag=v9.9.9',
    'version=9.9.9',
    'asset_name=press-system-v9.9.9.zip',
    'asset_url=https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/press-system-v9.9.9.zip',
    'asset_size=456',
    `asset_sha256=${digest}`,
    'html_url=https://github.com/EkilyHQ/Press/releases/tag/v9.9.9',
    'release_intent_source=https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/release-intent.json',
    'upgrade_from_json={"ranges":[">=9.9.8 <9.9.9"],"allowUnknownSource":false,"message":"Update first."}',
    ''
  ].join('\n'));

  writeJson(systemPath, {
    schemaVersion: 1,
    type: 'press-system',
    version: '9.9.9',
    tag: 'v9.9.9'
  });
  writeJson(markerPath, {
    schemaVersion: 1,
    version: '9.9.9',
    tag: 'v9.9.9'
  });

  const args = [
    script,
    '--release-env', envPath,
    '--out', outPath,
    '--repository', contract.repository,
    '--category', contract.category,
    '--ref', contract.ref,
    '--path', contract.observedPath,
    '--observed-type', contract.observedType,
    '--reconciler', contract.reconciler
  ];
  if (contract.versionSource === 'system') args.push('--system-manifest', systemPath);
  if (contract.versionSource === 'marker') args.push('--marker', markerPath);

  childProcess.execFileSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const lock = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.type, 'press-system-release-lock');
  assert.equal(lock.repository, contract.repository);
  assert.deepEqual(lock.target, {
    category: contract.category,
    ref: contract.ref,
    path: contract.observedPath,
    type: contract.observedType,
    reconciler: contract.reconciler
  });
  assert.equal(lock.sourceKind, 'release-intent');
  assert.equal(lock.version, '9.9.9');
  assert.equal(lock.tag, 'v9.9.9');
  assert.equal(lock.asset.digest, `sha256:${digest}`);
  assert.equal(lock.releaseIntent.source, 'https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/release-intent.json');
  assert.deepEqual(lock.upgradeFrom.ranges, ['>=9.9.8 <9.9.9']);

  const badSystemPath = path.join(tmpDir, 'bad-press-system.json');
  writeJson(badSystemPath, { version: '9.9.8', tag: 'v9.9.8' });
  assert.throws(() => {
    childProcess.execFileSync(process.execPath, [
      script,
      '--release-env', envPath,
      '--out', outPath,
      '--repository', contract.repository,
      '--category', contract.category,
      '--ref', contract.ref,
      '--path', contract.observedPath,
      '--observed-type', contract.observedType,
      '--reconciler', contract.reconciler,
      '--system-manifest', badSystemPath
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  }, /does not match/);

  console.log('ok - Press system lock');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
