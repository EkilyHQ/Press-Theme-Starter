#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateBaselineTransition, evaluateBootstrapBaseline } from './format-baseline-policy.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASELINE_PATH = resolve(SCRIPT_DIR, 'prettier-baseline.json');
const BASELINE_REPOSITORY_PATH = 'scripts/prettier-baseline.json';
const SUPPORTED_EXTENSIONS = new Set(['.css', '.js', '.json', '.mjs', '.yaml', '.yml']);
const ROOT_CANDIDATES = new Set(['.prettierrc.json', 'eslint.config.mjs', 'package-lock.json', 'package.json']);
const EXCLUDED_FILES = new Set(['theme-release.example.json', 'theme-release.json', 'theme/theme.json']);
const EXCLUDED_PREFIXES = ['.press/', 'artifacts-worktree/', 'dist/', 'node_modules/', 'press-theme-'];

function parseArgs(args) {
  const options = {
    baseRef: String(process.env.CODE_QUALITY_BASE_REF || '').trim(),
    headSha: String(process.env.CODE_QUALITY_HEAD_SHA || '').trim(),
    writeBaseline: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--base-ref') {
      options.baseRef = args[index + 1] || '';
      if (!options.baseRef || options.baseRef.startsWith('-')) throw new Error('--base-ref requires a Git ref');
      index += 1;
    } else if (argument === '--write-baseline') {
      options.writeBaseline = true;
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write('Usage: node scripts/check-format.mjs [--base-ref <git-ref>] | --write-baseline\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.writeBaseline && (options.baseRef || options.headSha)) {
    throw new Error('--write-baseline cannot be combined with exact-base environment variables');
  }
  if (options.headSha && !options.baseRef) {
    throw new Error('CODE_QUALITY_HEAD_SHA requires CODE_QUALITY_BASE_REF or --base-ref');
  }
  return options;
}

function gitBuffer(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024 * 1024
  });
}

function gitText(args) {
  return gitBuffer(args).toString('utf8').trim();
}

function gitPaths(args) {
  return gitBuffer(args).toString('utf8').split('\0').filter(Boolean).sort();
}

function gitNameStatus(base, head) {
  const tokens = gitBuffer([
    'diff',
    '--name-status',
    '--find-renames=100%',
    '--diff-filter=ACMRTD',
    '-z',
    base,
    head,
    '--'
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (/^[RC]/u.test(status)) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (!oldPath || !newPath) throw new Error(`invalid Git rename record for ${status}`);
      records.push({ status, oldPath, newPath });
    } else {
      const file = tokens[index++];
      if (!file) throw new Error(`invalid Git change record for ${status}`);
      records.push({ status, oldPath: file, newPath: file });
    }
  }
  return records;
}

function resolveCommit(ref, label) {
  const commit = gitText(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`${label} must resolve to an exact commit SHA`);
  return commit;
}

function resolveComparison(options) {
  const checkout = resolveCommit('HEAD', 'checkout HEAD');
  const head = options.headSha ? resolveCommit(options.headSha, 'CODE_QUALITY_HEAD_SHA') : checkout;
  if (checkout !== head) {
    throw new Error(`checked out HEAD ${checkout} does not match CODE_QUALITY_HEAD_SHA ${head}`);
  }
  if (!options.baseRef) return null;
  const baseTip = resolveCommit(options.baseRef, 'CODE_QUALITY_BASE_REF');
  return {
    base: resolveCommit(gitText(['merge-base', baseTip, head]), 'quality merge base'),
    head
  };
}

function isCandidate(file) {
  if (EXCLUDED_FILES.has(file)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))) return false;
  if (ROOT_CANDIDATES.has(file)) return true;
  if (file.startsWith('.github/workflows/')) return SUPPORTED_EXTENSIONS.has(extname(file));
  if (!file.startsWith('scripts/') && !file.startsWith('theme/')) return false;
  return SUPPORTED_EXTENSIONS.has(extname(file));
}

function parseBaseline(contents, label) {
  let baseline;
  try {
    baseline = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error
    });
  }
  if (baseline?.schemaVersion !== 1 || !Array.isArray(baseline.files)) {
    throw new Error(`${label} must contain schemaVersion 1 and a files array`);
  }
  const sorted = [...baseline.files].sort();
  if (sorted.some((file) => typeof file !== 'string' || !file || !isCandidate(file))) {
    throw new Error(`${label}.files contains a non-candidate path`);
  }
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label}.files contains duplicates`);
  if (JSON.stringify(sorted) !== JSON.stringify(baseline.files)) throw new Error(`${label}.files must be sorted`);
  return { schemaVersion: 1, files: sorted };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) throw new Error(`${BASELINE_REPOSITORY_PATH} is missing`);
  return parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), BASELINE_REPOSITORY_PATH);
}

function loadBaselineAtRef(ref) {
  const result = spawnSync('git', ['show', `${ref}:${BASELINE_REPOSITORY_PATH}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status === 0) return parseBaseline(result.stdout, `${ref}:${BASELINE_REPOSITORY_PATH}`);
  const message = String(result.stderr || result.stdout || '').trim();
  if (/does not exist in|exists on disk, but not in|path .* does not exist/u.test(message)) return null;
  throw new Error(`cannot read ${BASELINE_REPOSITORY_PATH} at ${ref}: ${message || `git exited ${result.status}`}`);
}

async function unformattedPaths(paths, { tolerateParserErrors = false } = {}) {
  const prettier = await import('prettier');
  const config = await prettier.resolveConfig(resolve(REPO_ROOT, 'package.json'), { editorconfig: true });
  const checks = await Promise.all(
    paths.map(async (file) => {
      const absolutePath = resolve(REPO_ROOT, file);
      try {
        const formatted = await prettier.check(readFileSync(absolutePath, 'utf8'), {
          ...(config || {}),
          filepath: absolutePath
        });
        return formatted ? null : file;
      } catch (error) {
        if (tolerateParserErrors) return file;
        throw new Error(`Prettier could not check ${file}: ${error.message}`, {
          cause: error
        });
      }
    })
  );
  return checks.filter(Boolean);
}

function describeViolations(violations) {
  return violations.map(({ code, file }) => `${code}: ${file}`).join(', ');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const trackedCandidates = gitPaths(['ls-files', '-z']).filter(isCandidate);
  if (options.writeBaseline) {
    const files = await unformattedPaths(trackedCandidates, {
      tolerateParserErrors: true
    });
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
    process.stdout.write(`Wrote ${BASELINE_REPOSITORY_PATH} with ${files.length} legacy files.\n`);
    return;
  }

  const baseline = loadBaseline();
  const trackedSet = new Set(trackedCandidates);
  const stale = baseline.files.filter((file) => !trackedSet.has(file));
  if (stale.length > 0) throw new Error(`remove stale baseline entries: ${stale.join(', ')}`);

  const comparison = resolveComparison(options);
  if (comparison) {
    const changes = gitNameStatus(comparison.base, comparison.head);
    const baseBaseline = loadBaselineAtRef(comparison.base);
    const violations = baseBaseline
      ? evaluateBaselineTransition({
          baseFiles: baseBaseline.files,
          headFiles: baseline.files,
          changes
        })
      : evaluateBootstrapBaseline({
          basePaths: gitPaths(['ls-tree', '-r', '--name-only', '-z', comparison.base]),
          headFiles: baseline.files,
          changes
        });
    if (violations.length > 0) {
      throw new Error(
        `Prettier baseline transition failed relative to ${comparison.base}: ${describeViolations(violations)}`
      );
    }
    if (!baseBaseline) process.stdout.write(`Bootstrapping ${BASELINE_REPOSITORY_PATH} from ${comparison.base}.\n`);
  }

  const allCandidates = gitPaths(['ls-files', '-co', '--exclude-standard', '-z'])
    .filter((file) => existsSync(resolve(REPO_ROOT, file)))
    .filter(isCandidate);
  const baselineSet = new Set(baseline.files);
  const enforced = allCandidates.filter((file) => !baselineSet.has(file));
  const failures = await unformattedPaths(enforced);
  if (failures.length > 0) throw new Error(`Prettier check failed for:\n- ${failures.join('\n- ')}`);
  process.stdout.write(`Prettier passed for ${enforced.length} files; ${baseline.files.length} legacy files remain.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
