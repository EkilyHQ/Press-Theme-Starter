#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import globals from 'globals';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BASELINE_PATH = path.join(SCRIPT_DIR, 'eslint-debt-baseline.json');
const BASELINE_REPOSITORY_PATH = 'scripts/eslint-debt-baseline.json';
const MEASURED_RULES = ['no-empty', 'no-unused-vars', 'no-useless-assignment'];
const BASELINE_DECISION = 'exact-owner-context-fingerprint-baseline-with-zero-growth';

function unwrap(node) {
  let current = node;
  while (current?.type === 'ChainExpression') current = current.expression;
  return current;
}

function normalizeText(sourceCode, node) {
  return sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
}

function memberPropertyName(node) {
  const current = unwrap(node);
  if (current?.type !== 'MemberExpression') return '';
  if (!current.computed && current.property.type === 'Identifier') return current.property.name;
  if (current.computed && current.property.type === 'Literal' && typeof current.property.value === 'string') {
    return current.property.value;
  }
  return '';
}

function expressionLabel(node, sourceCode) {
  const current = unwrap(node);
  if (current?.type === 'Identifier') return current.name;
  if (current?.type === 'ThisExpression') return 'this';
  if (current?.type === 'Literal') return `literal:${JSON.stringify(current.value)}`;
  if (current?.type === 'TemplateLiteral' && current.expressions.length === 0) {
    return `literal:${JSON.stringify(current.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(''))}`;
  }
  if (current?.type === 'MemberExpression') {
    if (current.computed) {
      return `${expressionLabel(current.object, sourceCode)}[${expressionLabel(current.property, sourceCode)}]`;
    }
    return `${expressionLabel(current.object, sourceCode)}.${memberPropertyName(current) || '(missing)'}`;
  }
  if (current?.type === 'CallExpression') {
    return `${expressionLabel(current.callee, sourceCode)}(${current.arguments
      .map((argument) => expressionLabel(argument, sourceCode))
      .join(',')})`;
  }
  const normalize = (value) => {
    if (value === null || typeof value !== 'object') {
      return typeof value === 'bigint' ? `bigint:${value}` : value;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value instanceof RegExp) return { flags: value.flags, source: value.source };
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (['comments', 'end', 'loc', 'parent', 'range', 'raw', 'start', 'tokens'].includes(key)) continue;
      if (typeof value[key] === 'function' || value[key] === undefined) continue;
      normalized[key] = normalize(value[key]);
    }
    return normalized;
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(normalize(current)))
    .digest('hex');
  return `expression:${current?.type || 'unknown'}:${digest}`;
}

function propertyName(property, sourceCode) {
  if (!property || (property.type !== 'Property' && property.type !== 'MethodDefinition')) return '';
  if (!property.computed && property.key?.type === 'Identifier') return property.key.name;
  if (property.key?.type === 'Literal' && typeof property.key.value === 'string') return property.key.value;
  return expressionLabel(property.key, sourceCode);
}

function ownerFor(sourceCode, node) {
  const ancestors = sourceCode.getAncestors(node);
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = ancestors[index];
    if (!['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(candidate.type)) {
      continue;
    }
    const labels = [];
    for (let ownerIndex = 0; ownerIndex <= index; ownerIndex += 1) {
      const current = ancestors[ownerIndex];
      if (current.type === 'ClassDeclaration') {
        labels.push(`class:${current.id?.name || '<anonymous>'}`);
      } else if (current.type === 'FunctionDeclaration') {
        labels.push(`function:${current.id?.name || '<anonymous>'}`);
      } else if (current.type === 'VariableDeclarator') {
        labels.push(`variable:${expressionLabel(current.id, sourceCode)}`);
      } else if (current.type === 'AssignmentExpression') {
        labels.push(`assignment:${expressionLabel(current.left, sourceCode)}`);
      } else if (current.type === 'Property') {
        labels.push(`property:${propertyName(current, sourceCode) || '(computed)'}`);
      } else if (current.type === 'MethodDefinition') {
        labels.push(`method:${propertyName(current, sourceCode) || '(computed)'}`);
      }
      if (['ArrowFunctionExpression', 'FunctionExpression'].includes(current.type)) {
        const parent = ancestors[ownerIndex - 1];
        if (parent?.type === 'CallExpression') {
          const argumentIndex = parent.arguments.indexOf(current);
          if (argumentIndex >= 0) {
            const precedingArguments = parent.arguments
              .slice(0, argumentIndex)
              .map((argument) => expressionLabel(argument, sourceCode))
              .join(',');
            labels.push(
              `callback:${expressionLabel(parent.callee, sourceCode)}(${precedingArguments})#${argumentIndex + 1}`
            );
          }
        }
      }
    }
    if (candidate.type !== 'FunctionDeclaration' && labels.length === 0) {
      labels.push(`anonymous:${candidate.type}`);
    }
    return labels.join('/') || '<module>';
  }
  return '<module>';
}

function ownerPathFor(sourceCode, node) {
  const chain = [...sourceCode.getAncestors(node), node];
  const segments = [];
  for (let index = 0; index < chain.length - 1; index += 1) {
    const parent = chain[index];
    const child = chain[index + 1];
    const visitorKeys = sourceCode.visitorKeys[parent.type] || [];
    let segment = child.type;
    for (const key of visitorKeys) {
      const value = parent[key];
      if (value === child) {
        segment = key;
        break;
      }
      if (Array.isArray(value)) {
        const childIndex = value.indexOf(child);
        if (childIndex >= 0) {
          segment = `${key}[${childIndex}]`;
          break;
        }
      }
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function contextFor(sourceCode, node) {
  return `${node.type}:${normalizeText(sourceCode, node)}`;
}

function fingerprintDiagnostic({ filePath, rule, messageId, message, owner, ownerPath, context }) {
  const payload = [filePath, rule, messageId, message, owner, ownerPath, context].join('\0');
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function inventoryKey(record) {
  return [
    record.path,
    record.rule,
    record.messageId,
    record.message,
    record.owner,
    record.ownerPath,
    record.fingerprint,
    String(record.occurrence)
  ].join('|');
}

function compareInventoryRecords(left, right) {
  const leftKey = inventoryKey(left);
  const rightKey = inventoryKey(right);
  return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
}

function debtConfig() {
  return [
    {
      linterOptions: {
        noInlineConfig: true,
        reportUnusedDisableDirectives: 'off'
      },
      languageOptions: {
        ecmaVersion: 'latest',
        parserOptions: { loc: true, range: true },
        sourceType: 'module',
        globals: globals.browser
      },
      rules: Object.fromEntries(MEASURED_RULES.map((rule) => [rule, 'error']))
    }
  ];
}

function measuredMessages(messages) {
  const measured = [];
  for (const message of messages) {
    if (
      message.ruleId === null &&
      message.severity === 1 &&
      /has no effect because you have 'noInlineConfig' setting/u.test(message.message)
    ) {
      continue;
    }
    if (!MEASURED_RULES.includes(message.ruleId)) {
      throw new Error(
        `unexpected ESLint debt probe diagnostic ${message.ruleId || '(parser)'} at ${message.line}:${message.column}: ${message.message}`
      );
    }
    measured.push(message);
  }
  return measured;
}

export function scanJavaScriptSource({ filePath, source }) {
  const linter = new Linter({ configType: 'flat' });
  const messages = measuredMessages(
    linter.verify(source, debtConfig(), {
      filename: filePath
    })
  );
  const sourceCode = linter.getSourceCode();
  if (!sourceCode) throw new Error(`ESLint did not produce a SourceCode object for ${filePath}`);
  const raw = messages
    .map((message) => {
      const index = sourceCode.getIndexFromLoc({
        line: message.line,
        column: Math.max(0, message.column - 1)
      });
      const node = sourceCode.getNodeByRangeIndex(Math.min(index, Math.max(0, source.length - 1))) || sourceCode.ast;
      const owner = ownerFor(sourceCode, node);
      const ownerPath = ownerPathFor(sourceCode, node);
      const messageId = String(message.messageId || '(none)');
      const context = contextFor(sourceCode, node);
      return {
        path: filePath,
        rule: message.ruleId,
        messageId,
        message: message.message,
        owner,
        ownerPath,
        fingerprint: fingerprintDiagnostic({
          filePath,
          rule: message.ruleId,
          messageId,
          message: message.message,
          owner,
          ownerPath,
          context
        }),
        start: index,
        line: message.line,
        column: message.column
      };
    })
    .sort((left, right) => left.start - right.start || compareInventoryRecords(left, right));
  const occurrences = new Map();
  return raw.map((record) => {
    const identity = [
      record.path,
      record.rule,
      record.messageId,
      record.message,
      record.owner,
      record.ownerPath,
      record.fingerprint
    ].join('|');
    const occurrence = (occurrences.get(identity) || 0) + 1;
    occurrences.set(identity, occurrence);
    return {
      ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'start')),
      occurrence
    };
  });
}

async function listJavaScriptFiles(root, relativeRoot = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(relativeRoot, entry.name);
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listJavaScriptFiles(absolutePath, relativePath)));
    else if (entry.isFile() && /\.(?:js|mjs)$/u.test(entry.name)) files.push(relativePath);
  }
  return files;
}

export async function scanRepository() {
  const themeRoot = path.join(REPO_ROOT, 'theme');
  const inventory = [];
  for (const relativePath of await listJavaScriptFiles(themeRoot)) {
    const repositoryPath = path.posix.join('theme', relativePath);
    const source = await readFile(path.join(themeRoot, relativePath), 'utf8');
    inventory.push(...scanJavaScriptSource({ filePath: repositoryPath, source }));
  }
  return inventory.sort(compareInventoryRecords);
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

function resolveCommit(ref, label) {
  const commit = gitText(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`${label} must resolve to an exact commit SHA`);
  return commit;
}

function resolveComparison() {
  const baseRef = String(process.env.CODE_QUALITY_BASE_REF || '').trim();
  const declaredHead = String(process.env.CODE_QUALITY_HEAD_SHA || '').trim();
  if (declaredHead && !baseRef) throw new Error('CODE_QUALITY_HEAD_SHA requires CODE_QUALITY_BASE_REF');
  if (!baseRef) return null;
  const checkout = resolveCommit('HEAD', 'checkout HEAD');
  const head = declaredHead ? resolveCommit(declaredHead, 'CODE_QUALITY_HEAD_SHA') : checkout;
  if (checkout !== head) {
    throw new Error(`checked out HEAD ${checkout} does not match CODE_QUALITY_HEAD_SHA ${head}`);
  }
  const baseTip = resolveCommit(baseRef, 'CODE_QUALITY_BASE_REF');
  return {
    base: resolveCommit(gitText(['merge-base', baseTip, head]), 'ESLint debt merge base'),
    head
  };
}

export function scanRepositoryAtRef(ref) {
  const paths = gitBuffer(['ls-tree', '-r', '--name-only', '-z', ref, '--', 'theme'])
    .toString('utf8')
    .split('\0')
    .filter((file) => /\.(?:js|mjs)$/u.test(file))
    .sort();
  const inventory = [];
  for (const filePath of paths) {
    const source = gitBuffer(['show', `${ref}:${filePath}`]).toString('utf8');
    inventory.push(...scanJavaScriptSource({ filePath, source }));
  }
  return inventory.sort(compareInventoryRecords);
}

function parseBaseline(contents, label) {
  let baseline;
  try {
    baseline = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`, { cause: error });
  }
  return baseline;
}

async function loadBaseline() {
  return parseBaseline(await readFile(BASELINE_PATH, 'utf8'), BASELINE_REPOSITORY_PATH);
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

function countRules(records) {
  return Object.fromEntries(
    MEASURED_RULES.map((rule) => [rule, records.filter((record) => record.rule === rule).length])
  );
}

function baselineRecord(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !['column', 'line'].includes(key)));
}

function verifyBaselineShape(baseline) {
  const errors = [];
  if (baseline?.schemaVersion !== 1) errors.push('ESLint debt baseline schemaVersion must equal 1');
  if (baseline?.decision !== BASELINE_DECISION) {
    errors.push(`ESLint debt baseline decision must equal ${BASELINE_DECISION}`);
  }
  if (JSON.stringify(baseline?.rules) !== JSON.stringify(MEASURED_RULES)) {
    errors.push('ESLint debt baseline rules must match the exact measured rule set');
  }
  if (!Array.isArray(baseline?.diagnostics)) errors.push('ESLint debt baseline diagnostics must be an array');
  const diagnostics = Array.isArray(baseline?.diagnostics) ? baseline.diagnostics : [];
  const keys = diagnostics.map(inventoryKey);
  if (new Set(keys).size !== keys.length) errors.push('ESLint debt baseline diagnostics must be unique');
  if (JSON.stringify([...keys].sort()) !== JSON.stringify(keys)) {
    errors.push('ESLint debt baseline diagnostics must be sorted by exact identity');
  }
  for (const diagnostic of diagnostics) {
    if (!MEASURED_RULES.includes(diagnostic.rule)) {
      errors.push(`unsupported ESLint debt rule: ${diagnostic.rule || '(missing)'}`);
    }
    if (typeof diagnostic.path !== 'string' || !/^theme\/.*\.(?:js|mjs)$/u.test(diagnostic.path)) {
      errors.push(`invalid ESLint debt path: ${diagnostic.path || '(missing)'}`);
    }
    if (typeof diagnostic.messageId !== 'string' || typeof diagnostic.message !== 'string') {
      errors.push(`ESLint debt message identity is incomplete for ${diagnostic.path || '(missing)'}`);
    }
    if (typeof diagnostic.owner !== 'string' || !diagnostic.owner) {
      errors.push(`ESLint debt owner is missing for ${diagnostic.path || '(missing)'}`);
    }
    if (typeof diagnostic.ownerPath !== 'string' || diagnostic.ownerPath.length === 0) {
      errors.push(`ESLint debt ownerPath is invalid for ${diagnostic.path || '(missing)'}`);
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(diagnostic.fingerprint || '')) {
      errors.push(`ESLint debt fingerprint is invalid for ${diagnostic.path || '(missing)'}`);
    }
    if (!Number.isInteger(diagnostic.occurrence) || diagnostic.occurrence < 1) {
      errors.push(`ESLint debt occurrence is invalid for ${diagnostic.path || '(missing)'}`);
    }
    if ('line' in diagnostic || 'column' in diagnostic) {
      errors.push(
        `ESLint debt baseline must use stable context fingerprints instead of stored line numbers: ${diagnostic.path}`
      );
    }
  }
  if (JSON.stringify(baseline?.expectedCounts || {}) !== JSON.stringify(countRules(diagnostics))) {
    errors.push(
      `ESLint debt expectedCounts mismatch: expected ${JSON.stringify(
        baseline?.expectedCounts || {}
      )}, baseline contains ${JSON.stringify(countRules(diagnostics))}`
    );
  }
  return errors;
}

export function verifyInventory(actual, baseline) {
  const errors = verifyBaselineShape(baseline);
  const diagnostics = Array.isArray(baseline?.diagnostics) ? baseline.diagnostics : [];
  const actualMap = new Map(actual.map((record) => [inventoryKey(record), record]));
  const baselineMap = new Map(diagnostics.map((record) => [inventoryKey(record), record]));
  for (const [key, record] of actualMap) {
    if (!baselineMap.has(key)) {
      errors.push(
        `unapproved ESLint debt ${record.path}:${record.line}:${record.column} ${record.rule} ${record.owner} ${record.fingerprint}`
      );
    }
  }
  for (const key of baselineMap.keys()) {
    if (!actualMap.has(key)) errors.push(`stale or moved ESLint debt baseline entry ${key}`);
  }
  if (JSON.stringify(baseline?.expectedCounts || {}) !== JSON.stringify(countRules(actual))) {
    errors.push(
      `ESLint debt inventory count mismatch: expected ${JSON.stringify(
        baseline?.expectedCounts || {}
      )}, observed ${JSON.stringify(countRules(actual))}`
    );
  }
  return errors;
}

export function verifyBaselineTransition(baseBaseline, headBaseline) {
  if (!baseBaseline) return [];
  const errors = [...verifyBaselineShape(baseBaseline), ...verifyBaselineShape(headBaseline)];
  const baseKeys = new Set((baseBaseline.diagnostics || []).map(inventoryKey));
  for (const diagnostic of headBaseline.diagnostics || []) {
    const key = inventoryKey(diagnostic);
    if (!baseKeys.has(key)) errors.push(`ESLint debt baseline growth is forbidden: ${key}`);
  }
  if ((headBaseline.diagnostics || []).length > (baseBaseline.diagnostics || []).length) {
    errors.push(
      `ESLint debt diagnostic count grew from ${baseBaseline.diagnostics.length} to ${headBaseline.diagnostics.length}`
    );
  }
  return [...new Set(errors)].sort();
}

export function verifyBootstrapBaseline(baseInventory, headBaseline) {
  const errors = verifyBaselineShape(headBaseline);
  const baseKeys = new Set(baseInventory.map(inventoryKey));
  for (const diagnostic of headBaseline.diagnostics || []) {
    const key = inventoryKey(diagnostic);
    if (!baseKeys.has(key)) errors.push(`ESLint debt bootstrap growth is forbidden: ${key}`);
  }
  if ((headBaseline.diagnostics || []).length > baseInventory.length) {
    errors.push(`ESLint debt bootstrap count grew from ${baseInventory.length} to ${headBaseline.diagnostics.length}`);
  }
  return [...new Set(errors)].sort();
}

export function createBaseline(records) {
  const diagnostics = records.map(baselineRecord).sort(compareInventoryRecords);
  return {
    schemaVersion: 1,
    decision: BASELINE_DECISION,
    rules: [...MEASURED_RULES],
    expectedCounts: countRules(diagnostics),
    diagnostics
  };
}

async function main() {
  if (process.argv.includes('--print-inventory')) {
    process.stdout.write(`${JSON.stringify(await scanRepository(), null, 2)}\n`);
    return;
  }
  const baseline = await loadBaseline();
  const inventory = await scanRepository();
  const errors = verifyInventory(inventory, baseline);
  const comparison = resolveComparison();
  if (comparison) {
    const baseBaseline = loadBaselineAtRef(comparison.base);
    if (baseBaseline) {
      errors.push(...verifyBaselineTransition(baseBaseline, baseline));
    } else {
      errors.push(...verifyBootstrapBaseline(scanRepositoryAtRef(comparison.base), baseline));
      process.stdout.write(
        `Bootstrapping exact ESLint debt baseline from ${comparison.base}; no merge-base baseline exists.\n`
      );
    }
  }
  if (errors.length > 0) throw new Error(`ESLint debt policy failed:\n- ${[...new Set(errors)].sort().join('\n- ')}`);
  process.stdout.write(
    `ESLint exact debt baseline passed: ${MEASURED_RULES.map((rule) => `${rule}=${baseline.expectedCounts[rule]}`).join(
      ', '
    )} across ${baseline.diagnostics.length} owner-bound diagnostics.\n`
  );
}

if (path.resolve(process.argv[1] || '') === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
