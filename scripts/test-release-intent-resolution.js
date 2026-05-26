#!/usr/bin/env node
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const repoName = path.basename(repoRoot);
const script = path.join(repoRoot, 'scripts', 'resolve-press-system-release.js');
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const RESOLVER_ENV_KEYS = [
  'PRESS_REPOSITORY',
  'PRESS_TARGET_REPOSITORY',
  'GITHUB_REPOSITORY',
  'PRESS_RELEASE_TARGET_CATEGORY',
  'PRESS_RELEASE_TARGET_REF',
  'PRESS_RELEASE_TARGET_PATH',
  'PRESS_RELEASE_TARGET_TYPE',
  'PRESS_RELEASE_TARGET_RECONCILER',
  'DISPATCH_RELEASE_INTENT_SOURCE',
  'PRESS_RELEASE_INTENT_SOURCE',
  'DISPATCH_ASSET_NAME',
  'PRESS_ASSET_NAME',
  'PRESS_ASSET_URL',
  'DISPATCH_ASSET_SIZE',
  'PRESS_ASSET_SIZE',
  'DISPATCH_ASSET_SHA256',
  'PRESS_ASSET_SHA256',
  'DISPATCH_TAG',
  'PRESS_SYSTEM_TAG',
  'PRESS_SYSTEM_VERSION',
  'DISPATCH_UPGRADE_FROM_JSON',
  'PRESS_UPGRADE_FROM_JSON',
  'PRESS_RELEASE_JSON',
  'PRESS_RELEASE_INTENT_JSON'
];

function repoContract(name) {
  if (name === 'YAP') {
    return {
      key: 'yap',
      repository: 'EkilyHQ/YAP',
      category: 'downstream',
      ref: 'main',
      observedPath: 'assets/press-system.json',
      observedType: 'press-system-manifest',
      reconciler: 'press-runtime-sync'
    };
  }
  if (name === 'Press-Theme-Starter') {
    return {
      key: 'themeStarter',
      repository: 'EkilyHQ/Press-Theme-Starter',
      category: 'downstream',
      ref: 'main',
      observedPath: 'press-system-release.json',
      observedType: 'press-release-marker',
      reconciler: 'theme-starter-marker-sync'
    };
  }
  const match = name.match(/^Press-Theme-([A-Za-z0-9_-]+)$/u);
  if (match) {
    return {
      key: match[1].toLowerCase(),
      repository: `EkilyHQ/${name}`,
      category: 'themeDemo',
      ref: 'demo',
      observedPath: 'assets/press-system.json',
      observedType: 'press-system-manifest',
      reconciler: 'theme-demo-runtime-sync'
    };
  }
  throw new Error(`unsupported repository ${name}`);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseEnv(text) {
  return Object.fromEntries(String(text).trim().split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function resolverEnv(overrides) {
  const clean = { ...process.env };
  for (const key of RESOLVER_ENV_KEYS) {
    delete clean[key];
  }
  return { ...clean, ...overrides };
}

function runResolver(args, env) {
  return parseEnv(childProcess.execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: resolverEnv(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

function createRelease(tag = 'v9.9.9') {
  return {
    tag_name: tag,
    name: tag,
    html_url: `https://github.com/EkilyHQ/Press/releases/tag/${tag}`,
    published_at: '2026-05-26T00:00:00Z',
    assets: [
      {
        name: `press-system-${tag}.zip`,
        browser_download_url: `https://github.com/EkilyHQ/Press/releases/download/${tag}/press-system-${tag}.zip`,
        size: 123,
        digest: `sha256:${digestB}`
      }
    ],
    body: `SHA-256: \`${digestB}\``
  };
}

function createIntent(contract) {
  return {
    schemaVersion: 1,
    type: 'press-release-intent',
    repository: 'EkilyHQ/Press',
    version: '9.9.9',
    tag: 'v9.9.9',
    source: 'https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/release-intent.json',
    systemRelease: {
      htmlUrl: 'https://github.com/EkilyHQ/Press/releases/tag/v9.9.9'
    },
    pressSystem: {
      asset: {
        name: 'press-system-v9.9.9.zip',
        url: 'https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/press-system-v9.9.9.zip',
        size: 456,
        digest: `sha256:${digestA}`
      },
      upgradeFrom: {
        ranges: ['>=9.9.8 <9.9.9'],
        allowUnknownSource: false,
        message: 'Update to v9.9.8 first.'
      }
    },
    targets: [
      {
        key: contract.key,
        category: contract.category,
        label: contract.repository,
        repository: contract.repository,
        eventType: 'press-system-release',
        expected: {
          version: '9.9.9',
          tag: 'v9.9.9'
        },
        observed: {
          ref: contract.ref,
          path: contract.observedPath,
          type: contract.observedType,
          source: `https://raw.githubusercontent.com/${contract.repository}/${contract.ref}/${contract.observedPath}`
        },
        reconciler: {
          kind: contract.reconciler,
          idempotent: true
        }
      }
    ]
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'press-release-intent-resolution-'));
try {
  const contract = repoContract(repoName);
  const releasePath = path.join(tmpDir, 'press-release.json');
  const intentPath = path.join(tmpDir, 'release-intent.json');
  writeJson(releasePath, createRelease());
  writeJson(intentPath, createIntent(contract));

  const baseEnv = {
    PRESS_REPOSITORY: 'EkilyHQ/Press',
    PRESS_TARGET_REPOSITORY: contract.repository,
    PRESS_RELEASE_TARGET_CATEGORY: contract.category,
    PRESS_RELEASE_TARGET_REF: contract.ref,
    PRESS_RELEASE_TARGET_PATH: contract.observedPath,
    PRESS_RELEASE_TARGET_TYPE: contract.observedType,
    PRESS_RELEASE_TARGET_RECONCILER: contract.reconciler
  };

  const resolvedIntent = runResolver(['--release', releasePath, '--release-intent', intentPath], baseEnv);
  assert.equal(resolvedIntent.source_kind, 'release-intent');
  assert.equal(resolvedIntent.tag, 'v9.9.9');
  assert.equal(resolvedIntent.version, '9.9.9');
  assert.equal(resolvedIntent.asset_url, 'https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/press-system-v9.9.9.zip');
  assert.equal(resolvedIntent.asset_sha256, digestA);
  assert.equal(resolvedIntent.release_intent_source, 'https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/v9.9.9/release-intent.json');
  assert.deepEqual(JSON.parse(resolvedIntent.upgrade_from_json).ranges, ['>=9.9.8 <9.9.9']);

  assert.throws(() => {
    runResolver(['--release', releasePath, '--release-intent', intentPath], {
      ...baseEnv,
      DISPATCH_RELEASE_INTENT_SOURCE: 'https://example.test/release-intent.json'
    });
  }, /canonical immutable/);

  const resolvedLegacy = runResolver(['--release', releasePath], {
    ...baseEnv,
    DISPATCH_ASSET_NAME: 'press-system-v9.9.9.zip'
  });
  assert.equal(resolvedLegacy.source_kind, 'legacy-release');
  assert.equal(resolvedLegacy.asset_url, 'https://github.com/EkilyHQ/Press/releases/download/v9.9.9/press-system-v9.9.9.zip');
  assert.equal(resolvedLegacy.asset_sha256, digestB);
  assert.equal(resolvedLegacy.release_intent_source, '');

  const badIntent = createIntent(contract);
  badIntent.targets[0].repository = 'EkilyHQ/Other';
  writeJson(intentPath, badIntent);
  assert.throws(() => {
    runResolver(['--release', releasePath, '--release-intent', intentPath], baseEnv);
  }, /does not target/);

  const nonCanonicalIntent = createIntent(contract);
  nonCanonicalIntent.source = 'https://raw.githubusercontent.com/EkilyHQ/Press/release-artifacts/release-intent.json';
  writeJson(intentPath, nonCanonicalIntent);
  assert.throws(() => {
    runResolver(['--release', releasePath, '--release-intent', intentPath], baseEnv);
  }, /canonical immutable/);

  console.log('ok - Press release intent resolution');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
