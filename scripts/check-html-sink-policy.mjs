#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const POLICY_PATH = path.join(SCRIPT_DIR, 'html-sink-policy.json');
const HTML_ASSIGNMENT_PROPERTIES = new Map([
  ['innerHTML', 'innerHTML-write'],
  ['outerHTML', 'outerHTML-write'],
  ['srcdoc', 'srcdoc-write']
]);
const HTML_CALL_PROPERTIES = new Map([
  ['createContextualFragment', 'createContextualFragment-call'],
  ['html', 'html-method-call'],
  ['insertAdjacentHTML', 'insertAdjacentHTML-call'],
  ['setHTML', 'setHTML-call'],
  ['setHTMLUnsafe', 'setHTMLUnsafe-call']
]);
const NATIVE_CALLABLE_HTML_SINKS = new Set([...HTML_CALL_PROPERTIES.keys(), '__lookupSetter__', 'parseFromString']);
const DOCUMENT_REFERENCE_PROPERTIES = new Set(['contentDocument', 'document', 'ownerDocument']);
const REFLECTED_HTML_PROPERTIES = new Set(HTML_ASSIGNMENT_PROPERTIES.keys());
const REFLECTION_HELPERS = new Map([
  [
    'Object',
    new Set(['assign', 'defineProperties', 'defineProperty', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors'])
  ],
  ['Reflect', new Set(['get', 'getOwnPropertyDescriptor', 'set'])]
]);
const ALLOWED_DISPOSITIONS = new Set([
  'controlled-detached-parser',
  'empty-clear',
  'escaped-theme-template',
  'non-dom-data-write',
  'press-renderer-output',
  'static-theme-template',
  'trusted-wrapper-call'
]);

function unwrap(node) {
  let current = node;
  while (current?.type === 'ChainExpression') current = current.expression;
  return current;
}

function normalizeAstValue(current) {
  if (current === null || typeof current !== 'object') {
    return typeof current === 'bigint' ? `bigint:${current}` : current;
  }
  if (Array.isArray(current)) return current.map(normalizeAstValue);
  if (current instanceof RegExp) return { flags: current.flags, source: current.source };
  const normalized = {};
  for (const key of Object.keys(current).sort()) {
    if (['comments', 'end', 'loc', 'parent', 'range', 'raw', 'start', 'tokens'].includes(key)) continue;
    if (typeof current[key] === 'function' || current[key] === undefined) continue;
    normalized[key] = normalizeAstValue(current[key]);
  }
  return normalized;
}

function canonicalAstSource(node) {
  return JSON.stringify(normalizeAstValue(unwrap(node)));
}

function semanticExpressionLabel(node) {
  const current = unwrap(node);
  if (current?.type === 'Identifier') return current.name;
  if (current?.type === 'ThisExpression') return 'this';
  if (current?.type === 'Literal') return `literal:${JSON.stringify(current.value)}`;
  if (current?.type === 'TemplateLiteral' && current.expressions.length === 0) {
    return `literal:${JSON.stringify(current.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(''))}`;
  }
  if (current?.type === 'MemberExpression') {
    if (current.computed) {
      return `${semanticExpressionLabel(current.object)}[${semanticExpressionLabel(current.property)}]`;
    }
    return `${semanticExpressionLabel(current.object)}.${current.property?.name || '(missing)'}`;
  }
  if (current?.type === 'CallExpression') {
    return `${semanticExpressionLabel(current.callee)}(${current.arguments.map(semanticExpressionLabel).join(',')})`;
  }
  const digest = createHash('sha256').update(canonicalAstSource(current)).digest('hex');
  return `expression:${current?.type || 'unknown'}:${digest}`;
}

function staticString(node, resolveIdentifier = null, seen = new Set()) {
  const current = unwrap(node);
  if (current?.type === 'Literal' && typeof current.value === 'string') return current.value;
  if (current?.type === 'TemplateLiteral' && current.expressions.length === 0) {
    return current.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
  }
  if (current?.type === 'Identifier' && resolveIdentifier) {
    const binding = resolveIdentifier(current);
    if (!binding || seen.has(binding)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(binding);
    return staticString(binding.init, resolveIdentifier, nextSeen);
  }
  return null;
}

function memberPropertyName(node, resolveIdentifier = null) {
  const current = unwrap(node);
  if (current?.type !== 'MemberExpression') return '';
  if (!current.computed && current.property.type === 'Identifier') return current.property.name;
  return current.computed ? staticString(current.property, resolveIdentifier) || '' : '';
}

function resolveConstExpression(node, resolveIdentifier, seen = new Set()) {
  const current = unwrap(node);
  if (current?.type !== 'Identifier' || !resolveIdentifier) return current;
  const binding = resolveIdentifier(current);
  if (!binding || seen.has(binding)) return current;
  const nextSeen = new Set(seen);
  nextSeen.add(binding);
  return resolveConstExpression(binding.init, resolveIdentifier, nextSeen);
}

function isDocumentReference(node, resolveIdentifier = null, resolveDocumentBinding = null, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return false;
  if (current.type === 'LogicalExpression') {
    return (
      isDocumentReference(current.left, resolveIdentifier, resolveDocumentBinding, seen) ||
      isDocumentReference(current.right, resolveIdentifier, resolveDocumentBinding, seen)
    );
  }
  if (current.type === 'ConditionalExpression') {
    return (
      isDocumentReference(current.consequent, resolveIdentifier, resolveDocumentBinding, seen) ||
      isDocumentReference(current.alternate, resolveIdentifier, resolveDocumentBinding, seen)
    );
  }
  if (current.type === 'SequenceExpression') {
    return isDocumentReference(current.expressions.at(-1), resolveIdentifier, resolveDocumentBinding, seen);
  }
  if (current.type === 'AssignmentExpression') {
    return isDocumentReference(current.right, resolveIdentifier, resolveDocumentBinding, seen);
  }
  if (current.type === 'Identifier') {
    if (/^(?:doc|document|documentRef)$/u.test(current.name)) return true;
    if (resolveDocumentBinding?.(current)) return true;
    if (!resolveIdentifier) return false;
    const binding = resolveIdentifier(current);
    if (!binding || seen.has(binding)) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(binding);
    return isDocumentReference(binding.init, resolveIdentifier, resolveDocumentBinding, nextSeen);
  }
  if (current.type !== 'MemberExpression') return false;
  return DOCUMENT_REFERENCE_PROPERTIES.has(memberPropertyName(current, resolveIdentifier));
}

function objectPropertyName(property, resolveIdentifier) {
  if (!property || (property.type !== 'Property' && property.type !== 'MethodDefinition')) return '';
  if (property.computed) return staticString(property.key, resolveIdentifier) || '';
  if (property.key?.type === 'Identifier') return property.key.name;
  return staticString(property.key, resolveIdentifier) || '';
}

function fingerprint(filePath, owner, context, kind, source) {
  const normalizedSource = source.replace(/\r\n?/gu, '\n');
  return `sha256:${createHash('sha256')
    .update(`${filePath}\0${owner}\0${context}\0${kind}\0${normalizedSource}`)
    .digest('hex')}`;
}

function inventoryKey(record) {
  return [record.path, record.owner, record.context, record.kind, record.fingerprint, String(record.occurrence)].join(
    '|'
  );
}

function gitText(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  }).trim();
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
    base: resolveCommit(gitText(['merge-base', baseTip, head]), 'HTML sink merge base'),
    head
  };
}

function loadPolicyAtRef(ref) {
  const repositoryPath = 'scripts/html-sink-policy.json';
  const result = spawnSync('git', ['show', `${ref}:${repositoryPath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`${ref}:${repositoryPath} is invalid JSON: ${error.message}`, {
        cause: error
      });
    }
  }
  const message = String(result.stderr || result.stdout || '').trim();
  if (/does not exist in|exists on disk, but not in|path .* does not exist/u.test(message)) {
    return null;
  }
  throw new Error(`cannot read ${repositoryPath} at ${ref}: ${message || `git exited ${result.status}`}`);
}

function parseJavaScript({ filePath, source, wrapperNames }) {
  const rawFindings = [];
  const calls = [];
  const wrapperSet = new Set(wrapperNames);
  const collectorRule = {
    create(context) {
      const sourceCode = context.sourceCode;
      const recordedOccurrences = new Set();
      const parameterDefaultBindings = new WeakMap();
      const findVariable = (identifier) => {
        let scope = sourceCode.getScope(identifier);
        let variable = null;
        while (scope && !variable) {
          variable = scope.set.get(identifier.name) || null;
          scope = scope.upper;
        }
        return variable;
      };
      const resolveIdentifier = (identifier) => {
        const variable = findVariable(identifier);
        if (!variable || variable.defs.length !== 1) return null;
        const definition = variable.defs[0];
        if (definition.type === 'Parameter' && definition.name?.type === 'Identifier') {
          if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
          const defaultPattern = sourceCode
            .getAncestors(definition.name)
            .findLast((candidate) => candidate.type === 'AssignmentPattern' && candidate.left === definition.name);
          if (!defaultPattern) return null;
          let binding = parameterDefaultBindings.get(defaultPattern);
          if (!binding) {
            binding = { init: defaultPattern.right };
            parameterDefaultBindings.set(defaultPattern, binding);
          }
          return binding;
        }
        if (
          definition.type !== 'Variable' ||
          definition.parent?.kind !== 'const' ||
          definition.node?.id?.type !== 'Identifier' ||
          !definition.node.init
        )
          return null;
        if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
        return definition.node;
      };
      const documentBindingProperty = (identifier, seen = new Set()) => {
        const variable = findVariable(identifier);
        if (!variable || seen.has(variable)) return '';
        const nextSeen = new Set(seen);
        nextSeen.add(variable);
        const isDocumentOrigin = (node) =>
          isDocumentReference(node, resolveIdentifier, (candidate) =>
            DOCUMENT_REFERENCE_PROPERTIES.has(documentBindingProperty(candidate, nextSeen))
          );
        const arrayPatternDocumentProperty = (binding, ancestors, sourceNode) => {
          const patternIndex = ancestors.findLastIndex((ancestor) => ancestor.type === 'ArrayPattern');
          if (patternIndex < 0) return '';
          const pattern = ancestors[patternIndex];
          const child = [...ancestors, binding][patternIndex + 1];
          const elementIndex = pattern.elements.indexOf(child);
          if (elementIndex < 0) return '';
          if (child?.type === 'AssignmentPattern' && isDocumentOrigin(child.right)) return 'document';
          const source = resolveConstExpression(sourceNode, resolveIdentifier);
          if (source?.type !== 'ArrayExpression') return '';
          const sourceElement = source.elements[elementIndex];
          return sourceElement && isDocumentOrigin(sourceElement) ? 'document' : '';
        };
        for (const binding of variable.identifiers) {
          if (binding.name !== identifier.name) continue;
          const ancestors = sourceCode.getAncestors(binding);
          for (let index = ancestors.length - 1; index >= 0; index -= 1) {
            const property = ancestors[index];
            if (property.type !== 'Property' || ancestors[index - 1]?.type !== 'ObjectPattern') continue;
            return objectPropertyName(property, resolveIdentifier);
          }
          const declarator = ancestors.findLast((ancestor) => ancestor.type === 'VariableDeclarator');
          const arrayProperty = declarator?.init
            ? arrayPatternDocumentProperty(binding, ancestors, declarator.init)
            : '';
          if (arrayProperty) return arrayProperty;
          if (declarator?.id === binding && declarator.init && isDocumentOrigin(declarator.init)) return 'document';
        }
        for (const reference of variable.references) {
          if (!reference.isWrite()) continue;
          const ancestors = sourceCode.getAncestors(reference.identifier);
          for (let index = ancestors.length - 1; index >= 0; index -= 1) {
            const property = ancestors[index];
            if (property.type !== 'Property' || ancestors[index - 1]?.type !== 'ObjectPattern') continue;
            const pattern = ancestors[index - 1];
            const assignment = ancestors[index - 2];
            if (assignment?.type !== 'AssignmentExpression' || assignment.left !== pattern) continue;
            const propertyName = objectPropertyName(property, resolveIdentifier);
            if (DOCUMENT_REFERENCE_PROPERTIES.has(propertyName)) return propertyName;
          }
          const assignment = ancestors.at(-1);
          const patternAssignment = ancestors.findLast(
            (ancestor) => ancestor.type === 'AssignmentExpression' && ancestor.left?.type === 'ArrayPattern'
          );
          const arrayProperty = patternAssignment
            ? arrayPatternDocumentProperty(reference.identifier, ancestors, patternAssignment.right)
            : '';
          if (arrayProperty) return arrayProperty;
          if (
            assignment?.type === 'AssignmentExpression' &&
            assignment.left === reference.identifier &&
            isDocumentOrigin(assignment.right)
          ) {
            return 'document';
          }
        }
        return '';
      };
      const isDocumentNode = (node) =>
        isDocumentReference(node, resolveIdentifier, (identifier) =>
          DOCUMENT_REFERENCE_PROPERTIES.has(documentBindingProperty(identifier))
        );
      const astPathFor = (node, ancestors = sourceCode.getAncestors(node)) => {
        const chain = [...ancestors, node];
        const segments = [];
        for (let pathIndex = 0; pathIndex < chain.length - 1; pathIndex += 1) {
          const parent = chain[pathIndex];
          const child = chain[pathIndex + 1];
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
      };
      const ownerContext = (node) => {
        const ancestors = sourceCode.getAncestors(node);
        for (let index = ancestors.length - 1; index >= 0; index -= 1) {
          const candidate = ancestors[index];
          if (!['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(candidate.type)) {
            continue;
          }
          const labels = [];
          for (let ownerIndex = 0; ownerIndex <= index; ownerIndex += 1) {
            const ownerNode = ancestors[ownerIndex];
            if (ownerNode.type === 'ClassDeclaration') {
              labels.push(`class:${ownerNode.id?.name || '<anonymous>'}`);
            } else if (ownerNode.type === 'FunctionDeclaration') {
              labels.push(`function:${ownerNode.id?.name || '<anonymous>'}`);
            } else if (ownerNode.type === 'VariableDeclarator') {
              labels.push(`variable:${semanticExpressionLabel(ownerNode.id)}`);
            } else if (ownerNode.type === 'AssignmentExpression') {
              labels.push(`assignment:${semanticExpressionLabel(ownerNode.left)}`);
            } else if (ownerNode.type === 'Property') {
              labels.push(`property:${objectPropertyName(ownerNode, resolveIdentifier) || '(computed)'}`);
            } else if (ownerNode.type === 'MethodDefinition') {
              labels.push(`method:${objectPropertyName(ownerNode, resolveIdentifier) || '(computed)'}`);
            }
            if (['ArrowFunctionExpression', 'FunctionExpression'].includes(ownerNode.type)) {
              const parent = ancestors[ownerIndex - 1];
              if (parent?.type === 'CallExpression') {
                const argumentIndex = parent.arguments.indexOf(ownerNode);
                if (argumentIndex >= 0) {
                  const precedingArguments = parent.arguments
                    .slice(0, argumentIndex)
                    .map(semanticExpressionLabel)
                    .join(',');
                  labels.push(
                    `callback:${semanticExpressionLabel(parent.callee)}(${precedingArguments})#${argumentIndex + 1}`
                  );
                }
              }
            }
          }
          if (candidate.type !== 'FunctionDeclaration' && labels.length === 0) {
            const parent = ancestors[index - 1];
            if (parent?.type === 'CallExpression') {
              labels.push(
                `callback:${semanticExpressionLabel(parent.callee)}()#${parent.arguments.indexOf(candidate) + 1}`
              );
            } else {
              labels.push(`anonymous:${candidate.type}`);
            }
          }
          const owner = labels.join('/') || 'program';
          return {
            owner,
            context: `${owner}@path:${astPathFor(node, ancestors)}`
          };
        }
        return { owner: 'program', context: `program@path:${astPathFor(node, ancestors)}` };
      };
      const canonicalNodeSource = canonicalAstSource;
      const record = (node, kind, { identityNode = node, sourceText = canonicalNodeSource(node) } = {}) => {
        const occurrenceKey = `${node.range[0]}:${node.range[1]}:${identityNode.range[0]}:${identityNode.range[1]}:${kind}`;
        if (recordedOccurrences.has(occurrenceKey)) return;
        recordedOccurrences.add(occurrenceKey);
        const { owner, context: ownerLocation } = ownerContext(node);
        rawFindings.push({
          path: filePath,
          owner,
          context: ownerLocation,
          kind,
          source: sourceText,
          start: node.range[0],
          line: node.loc.start.line,
          column: node.loc.start.column + 1
        });
      };
      const isDeclarationOrStaticKey = (node, parent) => {
        if (!parent) return true;
        if (
          (parent.type === 'FunctionDeclaration' ||
            parent.type === 'FunctionExpression' ||
            parent.type === 'ClassDeclaration') &&
          parent.id === node
        ) {
          return true;
        }
        if (parent.type === 'VariableDeclarator' && parent.id === node) return true;
        if (
          (parent.type === 'ImportSpecifier' ||
            parent.type === 'ImportDefaultSpecifier' ||
            parent.type === 'ImportNamespaceSpecifier') &&
          parent.local === node
        ) {
          return true;
        }
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
          return true;
        }
        if (
          (parent.type === 'Property' || parent.type === 'MethodDefinition') &&
          parent.key === node &&
          !parent.computed &&
          !parent.shorthand
        ) {
          return true;
        }
        return false;
      };
      const isDirectMemberCall = (node) => {
        const ancestors = sourceCode.getAncestors(node);
        let candidate = node;
        let index = ancestors.length - 1;
        while (
          index >= 0 &&
          ancestors[index]?.type === 'ChainExpression' &&
          ancestors[index].expression === candidate
        ) {
          candidate = ancestors[index];
          index -= 1;
        }
        const parent = ancestors[index];
        return parent?.type === 'CallExpression' && unwrap(parent.callee) === node;
      };
      const isReflectionBindTarget = (node) => {
        const ancestors = sourceCode.getAncestors(node);
        const bindMember = ancestors.at(-1);
        const bindCall = ancestors.at(-2);
        return (
          bindMember?.type === 'MemberExpression' &&
          unwrap(bindMember.object) === node &&
          memberPropertyName(bindMember, resolveIdentifier) === 'bind' &&
          bindCall?.type === 'CallExpression' &&
          unwrap(bindCall.callee) === bindMember
        );
      };
      const patternHasCallableUse = (property) => {
        const binding =
          property.value?.type === 'Identifier'
            ? property.value
            : property.value?.type === 'AssignmentPattern' && property.value.left?.type === 'Identifier'
              ? property.value.left
              : null;
        if (!binding) return true;
        const variable = findVariable(binding);
        if (!variable) return true;
        return variable.references.some((reference) => {
          if (reference.init) return false;
          const identifier = reference.identifier;
          const parent = sourceCode.getAncestors(identifier).at(-1);
          if (parent?.type === 'CallExpression') return true;
          if (
            parent?.type === 'MemberExpression' &&
            parent.object === identifier &&
            ['apply', 'bind', 'call'].includes(memberPropertyName(parent, resolveIdentifier))
          ) {
            return true;
          }
          if (parent?.type === 'VariableDeclarator' && parent.init === identifier) return true;
          if (parent?.type === 'AssignmentExpression' && parent.right === identifier) return true;
          if (parent?.type === 'ReturnStatement' || parent?.type === 'ExportDefaultDeclaration') return true;
          return parent?.type === 'Property' && parent.value === identifier;
        });
      };
      const isGlobalReference = (node, globalName) => {
        const current = resolveConstExpression(node, resolveIdentifier);
        if (current?.type === 'Identifier') return current.name === globalName;
        return current?.type === 'MemberExpression' && memberPropertyName(current, resolveIdentifier) === globalName;
      };
      const resolveCallableBinding = (node, seen = new Set()) => {
        const current = unwrap(node);
        if (current?.type === 'Identifier') {
          const binding = resolveIdentifier(current);
          if (binding && !seen.has(binding)) {
            const nextSeen = new Set(seen);
            nextSeen.add(binding);
            return resolveCallableBinding(binding.init, nextSeen);
          }
        }
        if (current?.type === 'CallExpression' && memberPropertyName(current.callee, resolveIdentifier) === 'bind') {
          const bindMember = unwrap(current.callee);
          const target = resolveCallableBinding(bindMember.object, seen);
          return {
            boundArguments: [...target.boundArguments, ...current.arguments.slice(1)],
            callee: target.callee
          };
        }
        return { boundArguments: [], callee: current };
      };
      const resolveCallableExpression = (node) => resolveCallableBinding(node).callee;
      const destructuredGlobalMethod = (identifier, objectName, methodName) => {
        const variable = findVariable(identifier);
        if (!variable || variable.defs.length !== 1) return false;
        const definition = variable.defs[0];
        if (
          definition.type !== 'Variable' ||
          definition.parent?.kind !== 'const' ||
          definition.node?.id?.type !== 'ObjectPattern' ||
          !isGlobalReference(definition.node.init, objectName)
        ) {
          return false;
        }
        return definition.node.id.properties.some((property) => {
          if (property.type !== 'Property' || objectPropertyName(property, resolveIdentifier) !== methodName) {
            return false;
          }
          const local = property.value?.type === 'AssignmentPattern' ? property.value.left : property.value;
          return local?.type === 'Identifier' && local.name === identifier.name;
        });
      };
      const isGlobalMethod = (callee, objectName, methodName) => {
        const direct = unwrap(callee);
        if (direct?.type === 'Identifier' && destructuredGlobalMethod(direct, objectName, methodName)) return true;
        const member = resolveCallableExpression(direct);
        if (member?.type !== 'MemberExpression' || memberPropertyName(member, resolveIdentifier) !== methodName) {
          return false;
        }
        return isGlobalReference(member.object, objectName);
      };
      const globalObjectName = (node) => {
        for (const objectName of REFLECTION_HELPERS.keys()) {
          if (isGlobalReference(node, objectName)) return objectName;
        }
        return '';
      };
      const reflectionHelperName = (node) => {
        const current = unwrap(node);
        if (current?.type !== 'MemberExpression') return '';
        const objectName = globalObjectName(current.object);
        const methodName = memberPropertyName(current, resolveIdentifier);
        return objectName && REFLECTION_HELPERS.get(objectName)?.has(methodName) ? `${objectName}.${methodName}` : '';
      };
      const reflectionMethodName = (callee) => {
        for (const [objectName, methods] of REFLECTION_HELPERS) {
          for (const methodName of methods) {
            if (isGlobalMethod(callee, objectName, methodName)) return `${objectName}.${methodName}`;
          }
        }
        return '';
      };
      const resolveReflectionCallable = (node, seen = new Set()) => {
        const current = unwrap(node);
        if (!current) return null;
        if (current.type === 'CallExpression') {
          const callee = unwrap(current.callee);
          if (callee?.type === 'MemberExpression' && memberPropertyName(callee, resolveIdentifier) === 'bind') {
            const target = resolveReflectionCallable(callee.object, seen);
            if (!target) return null;
            return {
              boundArguments: [...target.boundArguments, ...current.arguments.slice(1)],
              callee: target.callee,
              helperName: target.helperName
            };
          }
        }
        if (current.type === 'Identifier') {
          const binding = resolveIdentifier(current);
          if (binding && !seen.has(binding)) {
            const nextSeen = new Set(seen);
            nextSeen.add(binding);
            return resolveReflectionCallable(binding.init, nextSeen);
          }
        }
        const directHelperName = reflectionMethodName(current);
        if (directHelperName) return { boundArguments: [], callee: current, helperName: directHelperName };
        if (current.type !== 'CallExpression') return null;
        if (isGlobalMethod(current.callee, 'Reflect', 'get')) {
          const objectName = globalObjectName(current.arguments[0]);
          const methodName = staticString(current.arguments[1], resolveIdentifier);
          const helperName =
            objectName && REFLECTION_HELPERS.get(objectName)?.has(methodName) ? `${objectName}.${methodName}` : '';
          if (helperName) return { boundArguments: [], callee: current, helperName };
        }
        return null;
      };
      const normalizeReflectionCall = (node) => {
        const originalCallee = unwrap(node.callee);
        const form = memberPropertyName(originalCallee, resolveIdentifier);
        if (originalCallee?.type === 'MemberExpression' && ['bind', 'call', 'apply'].includes(form)) {
          const target = resolveReflectionCallable(originalCallee.object);
          if (!target) return { arguments: node.arguments, callee: originalCallee, form: 'direct', helperName: '' };
          if (form === 'bind' || form === 'call') {
            return {
              arguments: [...target.boundArguments, ...node.arguments.slice(1)],
              callee: target.callee,
              form,
              helperName: target.helperName
            };
          }
          const argumentArray = resolveConstExpression(node.arguments[1], resolveIdentifier);
          if (argumentArray?.type === 'ArrayExpression' && argumentArray.elements.every((element) => element)) {
            return {
              arguments: [...target.boundArguments, ...argumentArray.elements],
              callee: target.callee,
              form,
              helperName: target.helperName
            };
          }
          return {
            arguments: [],
            callee: target.callee,
            form: 'opaque-apply',
            helperName: target.helperName
          };
        }
        const target = resolveReflectionCallable(originalCallee);
        if (target) {
          return {
            arguments: [...target.boundArguments, ...node.arguments],
            callee: target.callee,
            form: 'direct',
            helperName: target.helperName
          };
        }
        const binding = resolveCallableBinding(originalCallee);
        return {
          arguments: [...binding.boundArguments, ...node.arguments],
          callee: binding.callee,
          form: 'direct',
          helperName: reflectionMethodName(binding.callee)
        };
      };
      const destructuredSource = (node) => {
        const ancestors = sourceCode.getAncestors(node);
        if (ancestors.at(-1)?.type !== 'ObjectPattern') return null;
        const container = ancestors.at(-2);
        if (container?.type === 'VariableDeclarator' && container.id === ancestors.at(-1)) return container.init;
        if (container?.type === 'AssignmentExpression' && container.left === ancestors.at(-1)) {
          return container.right;
        }
        if (container?.type === 'AssignmentPattern' && container.left === ancestors.at(-1)) {
          return container.right;
        }
        return null;
      };
      const analyzeReflectedObject = (node, seen = new Set()) => {
        const object = resolveConstExpression(node, resolveIdentifier);
        if (!object || seen.has(object)) return { opaque: [], properties: [] };
        if (object.type !== 'ObjectExpression') return { opaque: [object], properties: [] };
        const nextSeen = new Set(seen);
        nextSeen.add(object);
        const opaque = [];
        const properties = [];
        for (const property of object.properties) {
          if (property.type === 'SpreadElement') {
            const nested = analyzeReflectedObject(property.argument, nextSeen);
            opaque.push(...nested.opaque);
            properties.push(...nested.properties);
          } else {
            properties.push(property);
          }
        }
        return { opaque, properties };
      };
      const descriptorMapCall = (member) => {
        const current = unwrap(member);
        if (current?.type !== 'MemberExpression') return null;
        const object = resolveConstExpression(current.object, resolveIdentifier);
        if (object?.type !== 'CallExpression') return null;
        const reflectionCall = normalizeReflectionCall(object);
        return reflectionCall.helperName === 'Object.getOwnPropertyDescriptors' && reflectionCall.form !== 'bind'
          ? reflectionCall
          : null;
      };
      const immediateMemberAccess = (node) => {
        const ancestors = sourceCode.getAncestors(node);
        let candidate = node;
        let index = ancestors.length - 1;
        while (
          index >= 0 &&
          ancestors[index]?.type === 'ChainExpression' &&
          ancestors[index].expression === candidate
        ) {
          candidate = ancestors[index];
          index -= 1;
        }
        const parent = ancestors[index];
        return parent?.type === 'MemberExpression' && unwrap(parent.object) === candidate ? parent : null;
      };
      const loopMutationOwner = (node) =>
        sourceCode
          .getAncestors(node)
          .findLast(
            (candidate) =>
              (candidate.type === 'ForInStatement' || candidate.type === 'ForOfStatement') &&
              candidate.left?.range?.[0] <= node.range[0] &&
              candidate.left?.range?.[1] >= node.range[1]
          );
      const recordCallable = (node, callable) => {
        const resolved = resolveCallableExpression(callable);
        const property = memberPropertyName(resolved, resolveIdentifier);
        const directKind = HTML_CALL_PROPERTIES.get(property);
        if (directKind) record(node, directKind);
        else if (resolved?.type === 'MemberExpression' && resolved.computed && !property) {
          record(node, 'html-call-unproven-property');
        }
      };
      return {
        Identifier(node) {
          if (!wrapperSet.has(node.name)) return;
          const ancestors = sourceCode.getAncestors(node);
          const parent = ancestors.at(-1);
          if (isDeclarationOrStaticKey(node, parent)) return;
          if (parent?.type === 'CallExpression' && unwrap(parent.callee) === node) return;
          record(node, `html-wrapper-indirect-reference:${node.name}`);
        },
        Property(node) {
          const ancestors = sourceCode.getAncestors(node);
          const pattern = ancestors.at(-1);
          if (pattern?.type !== 'ObjectPattern') return;
          const property = objectPropertyName(node, resolveIdentifier);
          if (property === 'html' && !patternHasCallableUse(node)) return;
          if (NATIVE_CALLABLE_HTML_SINKS.has(property)) {
            record(node, `html-native-sink-indirect-reference:${property}`);
          }
          const sourceObject = destructuredSource(node);
          const reflectionObject = globalObjectName(sourceObject);
          if (reflectionObject && REFLECTION_HELPERS.get(reflectionObject)?.has(property)) {
            record(node, `html-reflection-helper-indirect-reference:${reflectionObject}.${property}`);
          }
          if ((property === 'write' || property === 'writeln') && isDocumentNode(sourceObject)) {
            record(node, `html-native-sink-indirect-reference:document.${property}`);
          }
        },
        MemberExpression(node) {
          const property = memberPropertyName(node, resolveIdentifier);
          const descriptorMap = descriptorMapCall(node);
          if (descriptorMap) {
            if (!property) record(node, 'Object.getOwnPropertyDescriptors-unproven-property');
            else if (REFLECTED_HTML_PROPERTIES.has(property)) {
              record(node, `Object.getOwnPropertyDescriptors-${property}-setter-reference`);
            }
            return;
          }
          if (loopMutationOwner(node)) {
            const kind = HTML_ASSIGNMENT_PROPERTIES.get(property);
            if (kind) record(node, kind);
            else if (node.computed && !property) record(node, 'html-assignment-unproven-property');
          }
          if (
            (property === 'write' || property === 'writeln') &&
            isDocumentNode(node.object) &&
            !isDirectMemberCall(node)
          ) {
            record(node, `html-native-sink-indirect-reference:document.${property}`);
            return;
          }
          if (NATIVE_CALLABLE_HTML_SINKS.has(property) && !isDirectMemberCall(node)) {
            record(node, `html-native-sink-indirect-reference:${property}`);
          }
          const helperName = reflectionHelperName(node);
          if (helperName && !isDirectMemberCall(node) && !isReflectionBindTarget(node)) {
            record(node, `html-reflection-helper-indirect-reference:${helperName}`);
          }
        },
        AssignmentExpression(node) {
          const left = unwrap(node.left);
          const property = memberPropertyName(left, resolveIdentifier);
          const kind = HTML_ASSIGNMENT_PROPERTIES.get(property);
          if (kind) record(node, kind);
          else if (left?.type === 'MemberExpression' && left.computed && !property) {
            record(node, 'html-assignment-unproven-property');
          }
        },
        CallExpression(node) {
          const callee = unwrap(node.callee);
          if (callee?.type === 'Identifier' && wrapperSet.has(callee.name)) {
            calls.push({ node, name: callee.name, ...ownerContext(node), source: canonicalNodeSource(node) });
          }
          const property = memberPropertyName(callee, resolveIdentifier);
          const directKind = HTML_CALL_PROPERTIES.get(property);
          if (directKind) record(node, directKind);
          else if (callee?.type === 'MemberExpression' && callee.computed && !property) {
            record(node, 'html-call-unproven-property');
          }
          const reflectionCall = normalizeReflectionCall(node);
          if (reflectionCall.helperName && reflectionCall.form !== 'direct') {
            record(node, `html-reflection-helper-${reflectionCall.form}:${reflectionCall.helperName}`);
          }
          if (
            reflectionCall.form !== 'bind' &&
            reflectionCall.helperName === 'Reflect.set' &&
            reflectionCall.arguments.length >= 2
          ) {
            const reflectedProperty = staticString(reflectionCall.arguments[1], resolveIdentifier);
            if (reflectedProperty === null) record(node, 'Reflect.set-unproven-property');
            else if (REFLECTED_HTML_PROPERTIES.has(reflectedProperty)) {
              record(node, `Reflect.set-${reflectedProperty}`);
            }
          }
          if (
            reflectionCall.form !== 'bind' &&
            reflectionCall.helperName === 'Reflect.get' &&
            reflectionCall.arguments.length >= 2
          ) {
            const reflectedProperty = staticString(reflectionCall.arguments[1], resolveIdentifier);
            if (reflectedProperty === null) record(node, 'Reflect.get-unproven-property');
            else if (NATIVE_CALLABLE_HTML_SINKS.has(reflectedProperty)) {
              record(node, `html-native-sink-indirect-reference:${reflectedProperty}`);
            }
            if (
              (reflectedProperty === 'write' || reflectedProperty === 'writeln') &&
              isDocumentNode(reflectionCall.arguments[0])
            ) {
              record(node, `html-native-sink-indirect-reference:document.${reflectedProperty}`);
            }
            const reflectedObject = globalObjectName(reflectionCall.arguments[0]);
            if (reflectedObject && REFLECTION_HELPERS.get(reflectedObject)?.has(reflectedProperty)) {
              record(node, `html-reflection-helper-indirect-reference:${reflectedObject}.${reflectedProperty}`);
            }
          }
          if (reflectionCall.form !== 'bind' && reflectionCall.helperName === 'Object.assign') {
            for (const argument of reflectionCall.arguments.slice(1)) {
              const analysis = analyzeReflectedObject(argument);
              for (const opaque of analysis.opaque) {
                record(node, 'Object.assign-unproven-payload', {
                  identityNode: opaque,
                  sourceText: `${canonicalNodeSource(node)}\0opaque:${canonicalNodeSource(opaque)}`
                });
              }
              for (const reflectedProperty of analysis.properties) {
                const reflectedName = objectPropertyName(reflectedProperty, resolveIdentifier);
                if (!reflectedName) {
                  record(node, 'Object.assign-unproven-property', {
                    identityNode: reflectedProperty,
                    sourceText: `${canonicalNodeSource(node)}\0property:${canonicalNodeSource(reflectedProperty)}`
                  });
                } else if (REFLECTED_HTML_PROPERTIES.has(reflectedName)) {
                  record(node, `Object.assign-${reflectedName}`, {
                    identityNode: reflectedProperty,
                    sourceText: `${canonicalNodeSource(node)}\0property:${canonicalNodeSource(reflectedProperty)}`
                  });
                }
              }
            }
          }
          if (
            reflectionCall.form !== 'bind' &&
            reflectionCall.helperName === 'Object.defineProperty' &&
            reflectionCall.arguments.length >= 2
          ) {
            const reflectedProperty = staticString(reflectionCall.arguments[1], resolveIdentifier);
            if (reflectedProperty === null) record(node, 'Object.defineProperty-unproven-property');
            else if (REFLECTED_HTML_PROPERTIES.has(reflectedProperty)) {
              record(node, `Object.defineProperty-${reflectedProperty}`);
            }
          }
          if (
            reflectionCall.form !== 'bind' &&
            reflectionCall.helperName === 'Object.defineProperties' &&
            reflectionCall.arguments.length >= 2
          ) {
            const analysis = analyzeReflectedObject(reflectionCall.arguments[1]);
            for (const opaque of analysis.opaque) {
              record(node, 'Object.defineProperties-unproven-descriptors', {
                identityNode: opaque,
                sourceText: `${canonicalNodeSource(node)}\0opaque:${canonicalNodeSource(opaque)}`
              });
            }
            for (const reflectedProperty of analysis.properties) {
              const reflectedName = objectPropertyName(reflectedProperty, resolveIdentifier);
              if (!reflectedName) {
                record(node, 'Object.defineProperties-unproven-property', {
                  identityNode: reflectedProperty,
                  sourceText: `${canonicalNodeSource(node)}\0property:${canonicalNodeSource(reflectedProperty)}`
                });
              } else if (REFLECTED_HTML_PROPERTIES.has(reflectedName)) {
                record(node, `Object.defineProperties-${reflectedName}`, {
                  identityNode: reflectedProperty,
                  sourceText: `${canonicalNodeSource(node)}\0property:${canonicalNodeSource(reflectedProperty)}`
                });
              }
            }
          }
          if (
            reflectionCall.form !== 'bind' &&
            ['Object.getOwnPropertyDescriptor', 'Reflect.getOwnPropertyDescriptor'].includes(
              reflectionCall.helperName
            ) &&
            reflectionCall.arguments.length >= 2
          ) {
            const reflectedProperty = staticString(reflectionCall.arguments[1], resolveIdentifier);
            if (reflectedProperty === null) {
              record(node, `${reflectionCall.helperName}-unproven-property`);
            } else if (REFLECTED_HTML_PROPERTIES.has(reflectedProperty)) {
              record(node, `${reflectionCall.helperName}-${reflectedProperty}-setter-reference`);
            }
          }
          if (
            reflectionCall.form !== 'bind' &&
            reflectionCall.helperName === 'Object.getOwnPropertyDescriptors' &&
            !immediateMemberAccess(node)
          ) {
            record(node, 'Object.getOwnPropertyDescriptors-unproven-property');
          }
          if (property === '__lookupSetter__') {
            const reflectedProperty = staticString(node.arguments[0], resolveIdentifier);
            if (reflectedProperty === null) record(node, '__lookupSetter__-unproven-property');
            else if (REFLECTED_HTML_PROPERTIES.has(reflectedProperty)) {
              record(node, `__lookupSetter__-${reflectedProperty}-setter-reference`);
            }
          }
          if ((property === 'write' || property === 'writeln') && isDocumentNode(callee?.object)) {
            record(node, 'document-write-call');
          }
          if (
            property === 'setAttribute' &&
            staticString(node.arguments[0], resolveIdentifier)?.toLowerCase() === 'srcdoc'
          ) {
            record(node, 'setAttribute-srcdoc-call');
          }
          if (
            property === 'setAttributeNS' &&
            staticString(node.arguments[1], resolveIdentifier)?.toLowerCase() === 'srcdoc'
          ) {
            record(node, 'setAttributeNS-srcdoc-call');
          }
          if (property === 'parseFromString') {
            const parserMime = staticString(node.arguments[1], resolveIdentifier);
            if (parserMime === null) record(node, 'DOMParser-unproven-mime-call');
            else if (parserMime.trim().toLowerCase() === 'text/html') {
              record(node, 'DOMParser-text-html-call');
            }
          }
          if (
            property === 'execCommand' &&
            staticString(node.arguments[0], resolveIdentifier)?.trim().toLowerCase() === 'inserthtml'
          ) {
            record(node, 'execCommand-insertHTML-call');
          }
        },
        TaggedTemplateExpression(node) {
          recordCallable(node, node.tag);
        },
        NewExpression(node) {
          recordCallable(node, node.callee);
        }
      };
    }
  };
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(
    source,
    [
      {
        files: ['**/*.{js,mjs}'],
        linterOptions: {
          noInlineConfig: true,
          reportUnusedDisableDirectives: 'off'
        },
        languageOptions: {
          ecmaVersion: 'latest',
          parserOptions: { range: true, loc: true },
          sourceType: 'module'
        },
        plugins: { inventory: { rules: { collect: collectorRule } } },
        rules: { 'inventory/collect': 'error' }
      }
    ],
    { filename: filePath }
  );
  const unexpectedMessages = messages.filter(
    (message) =>
      !(
        message.ruleId === null &&
        message.severity === 1 &&
        /has no effect because you have 'noInlineConfig' setting/u.test(message.message)
      )
  );
  if (unexpectedMessages.length > 0) {
    const details = unexpectedMessages
      .map((message) => `${filePath}:${message.line}:${message.column}: ${message.message}`)
      .join('\n');
    throw new Error(`HTML sink scanner could not parse source:\n${details}`);
  }
  for (const { node, name, owner, context, source: findingSource } of calls) {
    rawFindings.push({
      path: filePath,
      owner,
      context,
      kind: `html-wrapper-call:${name}`,
      source: findingSource,
      start: node.range[0],
      line: node.loc.start.line,
      column: node.loc.start.column + 1
    });
  }
  return rawFindings;
}

export function scanJavaScriptSource({ filePath, source, wrapperNames = [] }) {
  const rawFindings = parseJavaScript({ filePath, source, wrapperNames });
  rawFindings.sort((left, right) => left.start - right.start || left.kind.localeCompare(right.kind));
  const occurrences = new Map();
  return rawFindings.map((finding) => {
    const digest = fingerprint(finding.path, finding.owner, finding.context, finding.kind, finding.source);
    const identity = `${finding.path}|${finding.owner}|${finding.context}|${finding.kind}|${digest}`;
    const occurrence = (occurrences.get(identity) || 0) + 1;
    occurrences.set(identity, occurrence);
    return {
      path: finding.path,
      owner: finding.owner,
      context: finding.context,
      kind: finding.kind,
      fingerprint: digest,
      occurrence,
      line: finding.line,
      column: finding.column
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

export async function scanRepository({ wrappers = [] } = {}) {
  const wrapperNames = wrappers.map(({ name }) => name);
  const themeRoot = path.join(REPO_ROOT, 'theme');
  const inventory = [];
  for (const relativePath of await listJavaScriptFiles(themeRoot)) {
    const repositoryPath = path.posix.join('theme', relativePath);
    const source = await readFile(path.join(themeRoot, relativePath), 'utf8');
    inventory.push(
      ...scanJavaScriptSource({
        filePath: repositoryPath,
        source,
        wrapperNames
      })
    );
  }
  return inventory.sort((left, right) => inventoryKey(left).localeCompare(inventoryKey(right)));
}

export function scanRepositoryAtRef(ref, { wrappers = [] } = {}) {
  const wrapperNames = wrappers.map(({ name }) => name);
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', ref, '--', 'theme'], {
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024 * 1024
  })
    .toString('utf8')
    .split('\0')
    .filter((filePath) => /\.(?:js|mjs)$/u.test(filePath))
    .sort();
  const inventory = [];
  for (const filePath of paths) {
    const source = execFileSync('git', ['show', `${ref}:${filePath}`], {
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024
    }).toString('utf8');
    inventory.push(...scanJavaScriptSource({ filePath, source, wrapperNames }));
  }
  return inventory.sort((left, right) => inventoryKey(left).localeCompare(inventoryKey(right)));
}

function countKinds(records) {
  const counts = {};
  for (const record of records) counts[record.kind] = (counts[record.kind] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function verifyInventory(actual, policy) {
  const errors = [];
  if (policy?.schemaVersion !== 1) errors.push('policy schemaVersion must equal 1');
  if (policy?.decision !== 'reviewed-exact-fingerprint-baseline-with-zero-growth') {
    errors.push('policy decision must retain the reviewed exact-fingerprint baseline');
  }
  if (!Array.isArray(policy?.approved)) errors.push('policy approved must be an array');
  const approved = Array.isArray(policy?.approved) ? policy.approved : [];
  const wrappers = Array.isArray(policy?.wrappers) ? policy.wrappers : [];
  if (!Array.isArray(policy?.wrappers)) errors.push('policy wrappers must be an array');
  const wrapperNames = wrappers.map(({ name }) => name);
  if (new Set(wrapperNames).size !== wrapperNames.length) errors.push('policy wrapper names must be unique');
  for (const wrapper of wrappers) {
    if (typeof wrapper.name !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(wrapper.name)) {
      errors.push(`policy wrapper name is invalid: ${wrapper.name || '(missing)'}`);
    }
    if (typeof wrapper.rationale !== 'string' || wrapper.rationale.trim().length < 32) {
      errors.push(`policy wrapper rationale must be reviewable: ${wrapper.name || '(missing)'}`);
    }
  }
  const approvedKeys = approved.map(inventoryKey);
  if (new Set(approvedKeys).size !== approvedKeys.length) errors.push('policy approved entries must be unique');
  if (
    JSON.stringify([...approvedKeys].sort((left, right) => left.localeCompare(right))) !== JSON.stringify(approvedKeys)
  ) {
    errors.push('policy approved entries must be sorted by path, owner, context, kind, fingerprint, and occurrence');
  }
  for (const record of approved) {
    if (typeof record.owner !== 'string' || record.owner.length === 0) {
      errors.push(`owner must identify the reviewed sink context for ${inventoryKey(record)}`);
    }
    if (typeof record.context !== 'string' || !record.context.includes('@path:')) {
      errors.push(`context must pin the sink within its reviewed owner for ${inventoryKey(record)}`);
    }
    if (!ALLOWED_DISPOSITIONS.has(record.disposition)) {
      errors.push(`unsupported disposition for ${inventoryKey(record)}: ${record.disposition || '(missing)'}`);
    }
    if (typeof record.rationale !== 'string' || record.rationale.trim().length < 32) {
      errors.push(`rationale must be reviewable for ${inventoryKey(record)}`);
    }
  }
  const actualMap = new Map(actual.map((record) => [inventoryKey(record), record]));
  const approvedMap = new Map(approved.map((record) => [inventoryKey(record), record]));
  for (const [key, record] of actualMap) {
    if (!approvedMap.has(key))
      errors.push(
        `unclassified sink ${record.path}:${record.line}:${record.column} ${record.kind} ${record.fingerprint}`
      );
  }
  for (const key of approvedMap.keys()) {
    if (!actualMap.has(key)) errors.push(`stale or changed approved sink ${key}`);
  }
  const actualCounts = countKinds(actual);
  if (JSON.stringify(policy?.expectedKinds || {}) !== JSON.stringify(actualCounts)) {
    errors.push(
      `expectedKinds mismatch: expected ${JSON.stringify(policy?.expectedKinds || {})}, observed ${JSON.stringify(actualCounts)}`
    );
  }
  return errors;
}

export function verifyPolicyTransition(basePolicy, headPolicy) {
  if (!basePolicy) return [];
  if (!Array.isArray(basePolicy.approved)) return ['merge-base policy approved must be an array'];
  if (!Array.isArray(headPolicy?.approved)) return ['head policy approved must be an array'];
  const baseKeys = new Set(basePolicy.approved.map(inventoryKey));
  const errors = [];
  const baseWrapperNames = new Set(
    Array.isArray(basePolicy.wrappers) ? basePolicy.wrappers.map(({ name }) => name) : []
  );
  const headWrapperNames = new Set(
    Array.isArray(headPolicy.wrappers) ? headPolicy.wrappers.map(({ name }) => name) : []
  );
  for (const name of baseWrapperNames) {
    if (!headWrapperNames.has(name)) errors.push(`HTML sink wrapper removal or rename is forbidden: ${name}`);
  }
  for (const record of headPolicy.approved) {
    const key = inventoryKey(record);
    if (!baseKeys.has(key)) errors.push(`HTML sink baseline growth is forbidden: ${key}`);
  }
  if (headPolicy.approved.length > basePolicy.approved.length) {
    errors.push(`HTML sink approved count grew from ${basePolicy.approved.length} to ${headPolicy.approved.length}`);
  }
  return errors.sort();
}

export function verifyBootstrapPolicy(baseInventory, headPolicy) {
  if (!Array.isArray(headPolicy?.approved)) return ['head policy approved must be an array'];
  const baseKeys = new Set(baseInventory.map(inventoryKey));
  const errors = [];
  for (const record of headPolicy.approved) {
    const key = inventoryKey(record);
    if (!baseKeys.has(key)) errors.push(`HTML sink bootstrap growth is forbidden: ${key}`);
  }
  if (headPolicy.approved.length > baseInventory.length) {
    errors.push(`HTML sink bootstrap count grew from ${baseInventory.length} to ${headPolicy.approved.length}`);
  }
  return errors.sort();
}

async function main() {
  const policy = JSON.parse(await readFile(POLICY_PATH, 'utf8'));
  const inventory = await scanRepository({ wrappers: policy.wrappers });
  if (process.argv.includes('--print-inventory')) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return;
  }
  const errors = verifyInventory(inventory, policy);
  const comparison = resolveComparison();
  if (comparison) {
    const basePolicy = loadPolicyAtRef(comparison.base);
    errors.push(...verifyPolicyTransition(basePolicy, policy));
    if (!basePolicy) {
      errors.push(
        ...verifyBootstrapPolicy(scanRepositoryAtRef(comparison.base, { wrappers: policy.wrappers }), policy)
      );
      process.stdout.write(`Bootstrapping HTML sink policy from ${comparison.base}; no merge-base policy exists.\n`);
    }
  }
  if (errors.length > 0) throw new Error(`HTML sink policy failed:\n- ${errors.join('\n- ')}`);
  process.stdout.write(`HTML sink policy passed for ${inventory.length} classified occurrences.\n`);
}

if (path.resolve(process.argv[1] || '') === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
