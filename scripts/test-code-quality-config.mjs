import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateBaselineTransition, evaluateBootstrapBaseline } from './format-baseline-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_DEV_DEPENDENCIES = {
  '@eslint/js': '10.0.1',
  eslint: '10.6.0',
  globals: '17.7.0',
  prettier: '3.9.4'
};
const EXPECTED_DISABLED_RULES = ['no-unused-vars'];
const EXPECTED_MEASURED_RULES = ['no-empty', 'no-unused-vars', 'no-useless-assignment'];
const EXPECTED_FORMAT_EXCLUSIONS = ['theme-release.example.json', 'theme-release.json', 'theme/theme.json'];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

const packageJson = readJson('package.json');
assert.equal(packageJson.name, '@ekilyhq/press-theme-starter-development');
assert.equal(packageJson.private, true, 'the development-only quality package must remain private');
assert.equal(packageJson.type, undefined, 'the package must not reinterpret existing CommonJS .js scripts as modules');
assert.deepEqual(packageJson.engines, { node: '>=22.18.0 <23' }, 'quality tooling must stay on the CI Node line');
assert.equal(packageJson.packageManager, 'npm@10.9.3', 'the lockfile owner must remain pinned');
assert.deepEqual(
  packageJson.devDependencies,
  EXPECTED_DEV_DEPENDENCIES,
  'quality dependencies must stay minimal and exact'
);
for (const version of Object.values(packageJson.devDependencies)) {
  assert.match(version, /^\d+\.\d+\.\d+$/u, 'quality dependency versions must be exact');
}
assert.equal(packageJson.scripts?.lint, 'eslint . --max-warnings 0');
assert.equal(packageJson.scripts?.['lint:debt-policy'], 'node scripts/test-eslint-debt-policy.mjs');
assert.equal(packageJson.scripts?.['lint:debt-probe'], 'node scripts/probe-eslint-debt.mjs');
assert.equal(packageJson.scripts?.['lint:policy'], 'node scripts/test-eslint-policy.mjs');
assert.equal(packageJson.scripts?.['format:check'], 'node scripts/check-format.mjs');
assert.equal(
  packageJson.scripts?.['security:html-sinks'],
  'node scripts/test-html-sink-policy.mjs && node scripts/check-html-sink-policy.mjs'
);
assert.equal(
  packageJson.scripts?.quality,
  'node scripts/test-code-quality-config.mjs && npm run lint:policy && npm run lint && npm run lint:debt-policy && npm run lint:debt-probe && npm run format:check && npm run security:html-sinks'
);

const packageLock = readJson('package-lock.json');
assert.equal(packageLock.lockfileVersion, 3, 'npm 10 must own a lockfile v3 dependency graph');
assert.equal(packageLock.packages?.['']?.name, packageJson.name);
assert.deepEqual(packageLock.packages?.['']?.engines, packageJson.engines);
assert.deepEqual(packageLock.packages?.['']?.devDependencies, EXPECTED_DEV_DEPENDENCIES);

const gitignore = read('.gitignore');
assert.match(gitignore, /^node_modules\/$/mu, 'node_modules must remain ignored');
const editorConfig = read('.editorconfig');
assert.match(editorConfig, /^root = true$/mu);
assert.match(editorConfig, /^end_of_line = lf$/mu);
assert.match(editorConfig, /^insert_final_newline = true$/mu);
assert.match(editorConfig, /^indent_size = 2$/mu);
assert.deepEqual(readJson('.prettierrc.json'), {
  printWidth: 120,
  singleQuote: true,
  semi: true,
  trailingComma: 'none'
});

const eslintConfig = read('eslint.config.mjs');
assert.match(eslintConfig, /js\.configs\.recommended\.rules/u, 'ESLint recommended rules must remain enabled');
assert.match(eslintConfig, /noInlineConfig:\s*true/u, 'source comments must not alter the project lint policy');
assert.match(eslintConfig, /reportUnusedDisableDirectives:\s*'error'/u);
assert.match(eslintConfig, /sourceType:\s*'commonjs'/u, 'existing .js tooling must remain CommonJS');
assert.match(eslintConfig, /sourceType:\s*'module'/u, 'theme and .mjs tooling must parse as modules');
assert.match(eslintConfig, /files:\s*\['\*\.js', 'scripts\/\*\*\/\*\.js'\]/u);
assert.match(eslintConfig, /files:\s*\['\*\.mjs', 'scripts\/\*\*\/\*\.mjs'\]/u);
for (const ignoredPath of ['.press/**', 'artifacts-worktree/**', 'dist/**', 'node_modules/**', 'press-theme-*/**']) {
  assert.ok(eslintConfig.includes(`'${ignoredPath}'`), `ESLint must ignore ${ignoredPath}`);
}
const disabledRules = [...eslintConfig.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]off['"]/gu)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(disabledRules, EXPECTED_DISABLED_RULES, 'theme lint must not silently broaden legacy exclusions');
assert.equal(
  fs.existsSync(path.join(ROOT, 'eslint-suppressions.json')),
  false,
  'bulk ESLint suppressions are forbidden'
);

const policy = readJson('scripts/code-quality-policy.json');
assert.equal(policy.schemaVersion, 1);
assert.equal(policy.eslint?.profile, '@eslint/js recommended');
assert.deepEqual(
  policy.eslint?.measuredRules?.map(({ rule, observedDiagnostics, observedAffectedFiles, decision }) => ({
    rule,
    observedDiagnostics,
    observedAffectedFiles,
    decision
  })),
  [
    {
      rule: 'no-empty',
      observedDiagnostics: 0,
      observedAffectedFiles: 0,
      decision: 'enforced-zero-baseline'
    },
    {
      rule: 'no-unused-vars',
      observedDiagnostics: 1,
      observedAffectedFiles: 1,
      decision: 'accepted-no-action'
    },
    {
      rule: 'no-useless-assignment',
      observedDiagnostics: 0,
      observedAffectedFiles: 0,
      decision: 'enforced-zero-baseline'
    }
  ]
);
for (const record of policy.eslint.measuredRules) {
  assert.ok(record.evidence.length >= 32, `${record.rule} must retain reviewable evidence`);
}
assert.equal(policy.eslint?.noGrowth?.mechanism, 'merge-base-only-shrinking-exact-diagnostic-baseline');
assert.deepEqual(policy.eslint?.diagnosticBaseline, {
  file: 'scripts/eslint-debt-baseline.json',
  decision: 'exact-owner-context-fingerprint-baseline-with-zero-growth',
  initialDiagnostics: 1,
  identity:
    'path, rule, messageId, message, full lexical owner, full-file AST path with array ordinals, normalized diagnostic-context fingerprint, and duplicate occurrence',
  bootstrap:
    'The initial baseline must be a subset of diagnostics independently recomputed from the exact merge-base theme source; a same-count owner or context swap is forbidden.'
});
assert.deepEqual(policy.eslint?.inlineConfiguration, {
  decision: 'forbidden',
  mechanism: 'linterOptions.noInlineConfig',
  proofCommand: 'node scripts/test-eslint-policy.mjs',
  policy:
    'Source comments cannot disable or reconfigure ESLint rules. The executable proof loads the real project configuration and confirms a used no-undef directive neither suppresses nor downgrades the severity-2 diagnostic.'
});
const eslintPolicyTest = read('scripts/test-eslint-policy.mjs');
for (const token of [
  'calculateConfigForFile',
  'noInlineConfig',
  'suppressedMessages',
  "ruleId === 'no-undef'",
  'severity',
  'rootModuleProbePath',
  'rootCommonProbePath'
]) {
  assert.ok(eslintPolicyTest.includes(token), `ESLint policy proof must retain ${token}`);
}
const eslintDebtProbe = read('scripts/probe-eslint-debt.mjs');
assert.match(eslintDebtProbe, /noInlineConfig:\s*true/u, 'the debt probe must make inline directives inert');
assert.match(eslintDebtProbe, /has no effect because you have 'noInlineConfig' setting/u);
for (const token of [
  'contextFor',
  'ownerFor',
  'ownerPathFor',
  'scanRepositoryAtRef',
  'loadBaselineAtRef',
  'ESLint debt baseline growth is forbidden',
  'ESLint debt bootstrap growth is forbidden'
]) {
  assert.ok(eslintDebtProbe.includes(token), `ESLint exact-debt probe must retain ${token}`);
}
const eslintDebtPolicyTest = read('scripts/test-eslint-debt-policy.mjs');
for (const token of ['aggregate rule counts', 'verifyBaselineTransition', 'verifyBootstrapBaseline', 'only shrink']) {
  assert.ok(eslintDebtPolicyTest.includes(token), `ESLint debt adversarial proof must retain ${token}`);
}
const eslintDebtBaseline = readJson('scripts/eslint-debt-baseline.json');
assert.equal(eslintDebtBaseline.schemaVersion, 1);
assert.equal(eslintDebtBaseline.decision, 'exact-owner-context-fingerprint-baseline-with-zero-growth');
assert.deepEqual(eslintDebtBaseline.rules, EXPECTED_MEASURED_RULES);
assert.deepEqual(eslintDebtBaseline.expectedCounts, {
  'no-empty': 0,
  'no-unused-vars': 1,
  'no-useless-assignment': 0
});
assert.equal(eslintDebtBaseline.diagnostics.length, 1);
for (const diagnostic of eslintDebtBaseline.diagnostics) {
  assert.ok(typeof diagnostic.ownerPath === 'string' && diagnostic.ownerPath.length > 0);
}
const eslintDebtKeys = eslintDebtBaseline.diagnostics.map((diagnostic) =>
  [
    diagnostic.path,
    diagnostic.rule,
    diagnostic.messageId,
    diagnostic.message,
    diagnostic.owner,
    diagnostic.ownerPath,
    diagnostic.fingerprint,
    String(diagnostic.occurrence)
  ].join('|')
);
assert.deepEqual(eslintDebtKeys, [...eslintDebtKeys].sort(), 'exact ESLint debt identities must stay sorted');
assert.equal(policy.prettier?.baseline?.file, 'scripts/prettier-baseline.json');
assert.equal(policy.prettier?.baseline?.initialFiles, 7);
assert.deepEqual(policy.prettier?.excludedGeneratedFiles, EXPECTED_FORMAT_EXCLUSIONS);
assert.equal(policy.prettier?.noGrowth?.mechanism, 'merge-base-shrinking-file-baseline');
assert.equal(policy.prettier?.noGrowth?.baseRefEnvironmentVariable, 'CODE_QUALITY_BASE_REF');
assert.equal(policy.prettier?.noGrowth?.headShaEnvironmentVariable, 'CODE_QUALITY_HEAD_SHA');

const prettierBaseline = readJson('scripts/prettier-baseline.json');
assert.equal(prettierBaseline.schemaVersion, 1);
assert.equal(prettierBaseline.files.length, 7);
assert.deepEqual(prettierBaseline.files, [...prettierBaseline.files].sort(), 'the format baseline must be sorted');
for (const excludedPath of EXPECTED_FORMAT_EXCLUSIONS) {
  assert.equal(
    prettierBaseline.files.includes(excludedPath),
    false,
    `${excludedPath} must remain outside formatting policy`
  );
}

assert.deepEqual(
  evaluateBaselineTransition({
    baseFiles: ['legacy.js'],
    headFiles: ['legacy.js'],
    changes: [{ status: 'M', oldPath: 'legacy.js', newPath: 'legacy.js' }]
  }),
  [{ code: 'touched-baseline-retained', file: 'legacy.js' }]
);
assert.deepEqual(
  evaluateBaselineTransition({
    baseFiles: ['legacy.js'],
    headFiles: ['renamed.js'],
    changes: [{ status: 'R100', oldPath: 'legacy.js', newPath: 'renamed.js' }]
  }),
  []
);
assert.deepEqual(
  evaluateBaselineTransition({
    baseFiles: [],
    headFiles: ['new.js'],
    changes: []
  }),
  [{ code: 'baseline-growth', file: 'new.js' }]
);
assert.deepEqual(
  evaluateBootstrapBaseline({
    basePaths: ['legacy.js'],
    headFiles: ['new.js'],
    changes: []
  }),
  [{ code: 'bootstrap-path-not-in-base', file: 'new.js' }]
);
assert.deepEqual(
  evaluateBootstrapBaseline({
    basePaths: ['legacy.js'],
    headFiles: ['legacy.js'],
    changes: [{ status: 'M', oldPath: 'legacy.js', newPath: 'legacy.js' }]
  }),
  [{ code: 'bootstrap-touched-baseline-retained', file: 'legacy.js' }]
);

const formatCheck = read('scripts/check-format.mjs');
assert.match(formatCheck, /gitText\(\['merge-base', baseTip, head\]\)/u);
assert.match(formatCheck, /CODE_QUALITY_HEAD_SHA/u);
assert.match(formatCheck, /--find-renames=100%/u);
for (const excludedPath of EXPECTED_FORMAT_EXCLUSIONS) {
  assert.ok(formatCheck.includes(`'${excludedPath}'`), `format guard must exclude ${excludedPath}`);
}

const htmlPolicy = readJson('scripts/html-sink-policy.json');
assert.equal(htmlPolicy.schemaVersion, 1);
assert.equal(htmlPolicy.decision, 'reviewed-exact-fingerprint-baseline-with-zero-growth');
assert.deepEqual(htmlPolicy.expectedKinds, {
  'html-wrapper-call:setHtml': 5,
  'innerHTML-write': 1
});
assert.equal(htmlPolicy.approved.length, 6, 'the direct write and every reviewed wrapper call must remain classified');
for (const approved of htmlPolicy.approved) {
  assert.ok(
    typeof approved.owner === 'string' && approved.owner.length > 0,
    'every approved sink must retain owner context'
  );
  assert.equal(
    approved.context.startsWith(`${approved.owner}@path:`),
    true,
    'every approved sink must retain a full-file AST path'
  );
}
assert.deepEqual(
  htmlPolicy.wrappers.map(({ name }) => name),
  ['setHtml']
);
assert.match(
  htmlPolicy.rationale,
  /every caller separately/u,
  'the wrapper policy must not make a blanket safety claim'
);
assert.match(
  htmlPolicy.approved.find(({ owner }) => owner === 'function:setHtml')?.rationale || '',
  /does not sanitize by itself/u,
  'the direct wrapper write must state that setHtml is not a sanitizer'
);
const htmlSinkCheck = read('scripts/check-html-sink-policy.mjs');
assert.match(htmlSinkCheck, /gitText\(\[['"]merge-base['"], baseTip, head\]\)/u);
assert.match(htmlSinkCheck, /CODE_QUALITY_HEAD_SHA/u);
assert.match(htmlSinkCheck, /loadPolicyAtRef\(comparison\.base\)/u);
assert.match(htmlSinkCheck, /scanRepositoryAtRef/u);
assert.match(htmlSinkCheck, /verifyBootstrapPolicy/u);
assert.match(htmlSinkCheck, /HTML sink bootstrap growth is forbidden/u);
assert.match(htmlSinkCheck, /HTML sink baseline growth is forbidden/u);
assert.match(htmlSinkCheck, /html-wrapper-indirect-reference/u);
assert.match(htmlSinkCheck, /html-native-sink-indirect-reference/u);
assert.match(htmlSinkCheck, /Reflect\.set-/u);
assert.match(htmlSinkCheck, /Object\.assign-/u);
assert.match(htmlSinkCheck, /Object\.defineProperty-/u);
assert.match(htmlSinkCheck, /Object\.defineProperties-/u);
assert.match(htmlSinkCheck, /getOwnPropertyDescriptor/u);
assert.match(htmlSinkCheck, /getOwnPropertyDescriptors/u);
assert.match(htmlSinkCheck, /__lookupSetter__/u);
assert.match(htmlSinkCheck, /html-assignment-unproven-property/u);
assert.match(htmlSinkCheck, /html-call-unproven-property/u);
assert.match(htmlSinkCheck, /DOMParser-unproven-mime-call/u);
assert.match(htmlSinkCheck, /contentDocument/u);
assert.match(htmlSinkCheck, /ownerDocument/u);
assert.match(htmlSinkCheck, /resolveConstExpression/u);
assert.match(htmlSinkCheck, /documentBindingProperty/u);
assert.match(htmlSinkCheck, /astPathFor/u);
assert.match(htmlSinkCheck, /canonicalNodeSource/u);
assert.match(htmlSinkCheck, /semanticExpressionLabel/u);
assert.match(htmlSinkCheck, /identityNode/u);
assert.match(htmlSinkCheck, /resolveReflectionCallable/u);
assert.match(htmlSinkCheck, /normalizeReflectionCall/u);
assert.match(htmlSinkCheck, /isDocumentNode\(sourceObject\)/u);
assert.match(htmlSinkCheck, /opaque-apply/u);
assert.match(htmlSinkCheck, /unproven-payload/u);
assert.match(htmlSinkCheck, /unproven-descriptors/u);
assert.match(htmlSinkCheck, /unproven-property/u);
assert.match(htmlSinkCheck, /noInlineConfig:\s*true/u);
assert.match(htmlSinkCheck, /has no effect because you have 'noInlineConfig' setting/u);
assert.match(htmlSinkCheck, /finding\.owner/u);
assert.match(htmlSinkCheck, /finding\.context/u);
assert.match(htmlSinkCheck, /HTML sink wrapper removal or rename is forbidden/u);
for (const token of [
  'ForInStatement',
  'ForOfStatement',
  'TaggedTemplateExpression',
  'NewExpression',
  'parameterDefaultBindings',
  'descriptorMapCall',
  'isReflectionBindTarget'
]) {
  assert.ok(htmlSinkCheck.includes(token), `HTML sink scanner must retain ${token}`);
}
const htmlSinkPolicyTest = read('scripts/test-html-sink-policy.mjs');
for (const token of [
  'opaque-computed-sinks',
  'descriptor-helper-forms',
  'bound-reflection-helpers',
  'default-parameter-descriptor-aliases',
  'default-value-descriptor-alias',
  'descriptor-map-aliases',
  'legacy-descriptor-setters',
  "Reflect.get(Object, 'getOwnPropertyDescriptor')",
  "Reflect.get(Reflect, 'getOwnPropertyDescriptor')",
  "Reflect.get(Object, 'getOwnPropertyDescriptors')",
  'document-expression-aliases',
  'DOMParser-unproven-mime-call',
  'Object.assign-unproven-payload',
  'Object.defineProperties-unproven-descriptors',
  'html-reflection-helper-opaque-apply:Object.assign'
]) {
  assert.ok(htmlSinkPolicyTest.includes(token), `HTML sink adversarial proof must retain ${token}`);
}

const workflow = read('.github/workflows/code-quality.yml');
assert.match(workflow, /^name: Code Quality$/mu);
assert.match(workflow, /^ {2}push:\n {4}branches:\n {6}- main$/mu);
assert.match(workflow, /^ {2}pull_request:\n {4}branches:\n {6}- main$/mu);
assert.match(workflow, /^ {2}workflow_dispatch:$/mu);
assert.match(workflow, /^ {2}schedule:\n {4}- cron: '[^']+ [^']+ \* \* [0-6]'$/mu);
assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
assert.doesNotMatch(workflow, /(?:write-all|contents:\s*write)/u);
assert.match(workflow, /^concurrency:\n {2}group: code-quality-/mu);
assert.match(workflow, /uses: actions\/checkout@v6/u);
assert.match(workflow, /fetch-depth: 0/u);
assert.match(workflow, /persist-credentials: false/u);
assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u);
assert.match(workflow, /uses: actions\/setup-node@v6/u);
assert.match(workflow, /node-version: 22\.18\.0/u);
assert.match(workflow, /run: npm ci --ignore-scripts/u);
assert.match(workflow, /run: npm run quality/u);
assert.match(
  workflow,
  /CODE_QUALITY_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \|\| github\.sha \}\}/u
);
assert.match(workflow, /CODE_QUALITY_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u);
assert.match(workflow, /git merge-base "\$CODE_QUALITY_BASE_REF" "\$CODE_QUALITY_HEAD_SHA"/u);
assert.match(workflow, /git diff --check "\$quality_base_sha" "\$CODE_QUALITY_HEAD_SHA"/u);
assert.equal(countMatches(workflow, /git status --porcelain --untracked-files=all/gu), 3);
assert.match(workflow, /- name: Verify quality gate cleanup\n {8}if: always\(\)/u);

process.stdout.write('Code-quality configuration self-test passed.\n');
