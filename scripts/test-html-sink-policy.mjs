import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import {
  scanJavaScriptSource,
  scanRepository,
  verifyBootstrapPolicy,
  verifyInventory,
  verifyPolicyTransition
} from './check-html-sink-policy.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const withoutLocations = (records) =>
  records.map((record) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'column' && key !== 'line'))
  );
const kindMultiset = (records) =>
  Object.fromEntries(
    [...new Set(records.map(({ kind }) => kind))]
      .sort()
      .map((kind) => [kind, records.filter((record) => record.kind === kind).length])
  );

const detected = scanJavaScriptSource({
  filePath: 'theme/modules/fixture.js',
  wrapperNames: ['renderHtml'],
  source: `
    export function fixture(node, frame, range, parser, markup) {
      node.innerHTML = markup;
      node['outerHTML'] = markup;
      frame.srcdoc = markup;
      node.insertAdjacentHTML('beforeend', markup);
      node.setHTML(markup);
      node.setHTMLUnsafe(markup);
      node.html(markup);
      range.createContextualFragment(markup);
      document.write(markup);
      document.writeln(markup);
      frame.setAttribute('srcdoc', markup);
      frame.setAttributeNS(null, 'srcdoc', markup);
      parser.parseFromString(markup, 'text/html');
      document.execCommand('insertHTML', false, markup);
      renderHtml(node, markup);
    }
  `
});
assert.deepEqual(
  detected.map(({ kind }) => kind).sort(),
  [
    'DOMParser-text-html-call',
    'createContextualFragment-call',
    'document-write-call',
    'document-write-call',
    'execCommand-insertHTML-call',
    'html-method-call',
    'html-wrapper-call:renderHtml',
    'innerHTML-write',
    'insertAdjacentHTML-call',
    'outerHTML-write',
    'setAttribute-srcdoc-call',
    'setAttributeNS-srcdoc-call',
    'setHTML-call',
    'setHTMLUnsafe-call',
    'srcdoc-write'
  ].sort(),
  'known direct, computed, parser, document, iframe, library, and reviewed-wrapper HTML sinks must be inventoried'
);

const nonSinks = scanJavaScriptSource({
  filePath: 'theme/modules/non-sinks.js',
  source: `
    export function safe(node, parser, record, markup) {
      const { html } = record;
      const serialized = node.innerHTML;
      node.textContent = '<b>text</b>';
      node.setAttribute('title', '<b>title</b>');
      const xml = parser.parseFromString(markup, 'application/xml');
      const reflected = Reflect.get(node, 'innerHTML');
      Reflect.set(node, 'textContent', markup);
      Object.assign(node, { textContent: markup });
      Object.defineProperty(node, 'textContent', { value: markup });
      Object.defineProperties(node, { textContent: { value: markup } });
      return [html || '', serialized, xml, reflected];
    }
  `
});
assert.deepEqual(
  nonSinks,
  [],
  'serializer reads and text-only DOM writes must remain outside the HTML-write inventory'
);

const destructuredHtmlCallable = scanJavaScriptSource({
  filePath: 'theme/modules/destructured-html-callable.js',
  source: `
    export function render(widget, markup) {
      const { html } = widget;
      html(markup);
    }
  `
});
assert.deepEqual(
  destructuredHtmlCallable.map(({ kind }) => kind),
  ['html-native-sink-indirect-reference:html'],
  'a destructured html callable must fail closed while a data-only html field remains outside the inventory'
);

const inlineDirectiveCannotSuppress = scanJavaScriptSource({
  filePath: 'theme/modules/inline-directive.js',
  source: `
    export function render(node, markup) {
      // eslint-disable-next-line inventory/collect -- hostile suppression attempt
      node.innerHTML = markup;
    }
  `
});
assert.deepEqual(
  inlineDirectiveCannotSuppress.map(({ kind }) => kind),
  ['innerHTML-write'],
  'inline ESLint directives must be inert in the standalone sink inventory scanner'
);

const directNativeCalls = scanJavaScriptSource({
  filePath: 'theme/modules/direct-native.js',
  source: `
    export function render(node, range, widget, parser, markup) {
      node.insertAdjacentHTML('beforeend', markup);
      range.createContextualFragment(markup);
      node.setHTML(markup);
      node.setHTMLUnsafe(markup);
      widget.html(markup);
      parser.parseFromString(markup, 'text/html');
    }
  `
});
assert.deepEqual(
  directNativeCalls.map(({ kind }) => kind).sort(),
  [
    'DOMParser-text-html-call',
    'createContextualFragment-call',
    'html-method-call',
    'insertAdjacentHTML-call',
    'setHTML-call',
    'setHTMLUnsafe-call'
  ].sort(),
  'direct native HTML sink calls must retain their existing classifications without indirect-reference duplicates'
);

const opaqueComputedSinks = scanJavaScriptSource({
  filePath: 'theme/modules/opaque-computed-sinks.js',
  source: `
    export function render(element, property, method, markup) {
      element[property] = markup;
      for (element[property] of values) consume(element);
      for (element[property] in values) consume(element);
      for ({ value: element[property] } of values) consume(element);
      element[method](markup);
      element[method]\`<p>markup</p>\`;
      new element[method](markup);
      element['innerHTML'] = markup;
      element['insertAdjacentHTML']('beforeend', markup);
    }
  `
});
assert.deepEqual(
  opaqueComputedSinks.map(({ kind }) => kind),
  [
    'html-assignment-unproven-property',
    'html-assignment-unproven-property',
    'html-assignment-unproven-property',
    'html-assignment-unproven-property',
    'html-call-unproven-property',
    'html-call-unproven-property',
    'html-call-unproven-property',
    'innerHTML-write',
    'insertAdjacentHTML-call'
  ],
  'opaque computed assignment, loop-target, call, tag, and constructor properties must fail closed while static computed sink names retain exact kinds'
);
const firstLoopTarget = scanJavaScriptSource({
  filePath: 'theme/modules/loop-target-identity.js',
  source: `export function render(element, property, values) { for (element[property] of values) consume(element); }`
});
const secondLoopTarget = scanJavaScriptSource({
  filePath: 'theme/modules/loop-target-identity.js',
  source: `export function render(element, property, values) { for (element[property] of alternateValues) consume(element); }`
});
assert.deepEqual(
  withoutLocations(firstLoopTarget),
  withoutLocations(secondLoopTarget),
  'loop-target sink identity must be bounded to the mutated left-hand member rather than the iterable expression'
);
const safeComputedProperties = scanJavaScriptSource({
  filePath: 'theme/modules/safe-computed-properties.js',
  source: `
    export function render(element, text) {
      element['textContent'] = text;
      for (element['textContent'] of values) consume(element);
      for (element['textContent'] in values) consume(element);
      element['focus']();
      element['tag']\`static\`;
      new element['Widget']();
      element.textContent = text;
      element.focus();
    }
  `
});
assert.deepEqual(safeComputedProperties, [], 'statically safe computed and direct properties must remain clean');

const indirectNativeReferences = scanJavaScriptSource({
  filePath: 'theme/modules/indirect-native.js',
  source: `
    export const exportedHtml = globalWidget.html;
    export function capture(node, range, parser, consume) {
      const { insertAdjacentHTML: adjacent } = node;
      const contextual = Reflect.get(range, 'createContextualFragment').bind(range);
      node.setHTML.call(node, '<p>call</p>');
      node.setHTMLUnsafe.apply(node, ['<p>apply</p>']);
      consume(parser.parseFromString);
      return [adjacent, contextual, exportedHtml];
    }
  `
});
assert.deepEqual(
  indirectNativeReferences.map(({ kind }) => kind).sort(),
  [
    'html-native-sink-indirect-reference:createContextualFragment',
    'html-native-sink-indirect-reference:html',
    'html-native-sink-indirect-reference:insertAdjacentHTML',
    'html-native-sink-indirect-reference:parseFromString',
    'html-native-sink-indirect-reference:setHTML',
    'html-native-sink-indirect-reference:setHTMLUnsafe'
  ].sort(),
  'alias, bind, call, apply, callback, export, and parser references must fail closed when direct-call semantics are lost'
);

const indirectDocumentWrites = scanJavaScriptSource({
  filePath: 'theme/modules/indirect-document.js',
  source: `
    const boundWrite = document.write.bind(document);
    const { writeln: detachedWriteln } = frame.contentDocument;
    let assignedWrite;
    ({ write: assignedWrite } = document);
    let assignedWriteln;
    ({ writeln: assignedWriteln } = frame.ownerDocument);
    let assignedOwnerDocument;
    ({ ownerDocument: assignedOwnerDocument } = frame);
    let assignedContentDocument;
    ({ contentDocument: assignedContentDocument } = frame);
    let assignedDefaultDocument;
    ({ document: assignedDefaultDocument = frame.ownerDocument } = frame);
    let directlyAssignedDocument;
    directlyAssignedDocument = frame.ownerDocument;
    let initializedDocument = frame.contentDocument;
    export function render(frame, node, { ownerDocument: parameterDocument }, markup) {
      const { ownerDocument: contextDocument } = node;
      const { contentDocument } = frame;
      document.writeln.call(document, markup);
      frame.contentDocument.write(markup);
      node.ownerDocument.writeln(markup);
      contextDocument.write(markup);
      contentDocument.writeln(markup);
      parameterDocument.write(markup);
      assignedWrite(markup);
      assignedWriteln(markup);
      assignedOwnerDocument.write(markup);
      assignedContentDocument.writeln(markup);
      assignedDefaultDocument.write(markup);
      directlyAssignedDocument.write(markup);
      initializedDocument.writeln(markup);
      const reflectedWrite = Reflect.get(frame.ownerDocument, 'write');
      return [boundWrite, detachedWriteln, reflectedWrite];
    }
  `
});
assert.deepEqual(
  indirectDocumentWrites.map(({ kind }) => kind).sort(),
  [
    'document-write-call',
    'document-write-call',
    'document-write-call',
    'document-write-call',
    'document-write-call',
    'document-write-call',
    'document-write-call',
    'document-write-call',
    'document-write-call',
    'document-write-call',
    'html-native-sink-indirect-reference:document.write',
    'html-native-sink-indirect-reference:document.write',
    'html-native-sink-indirect-reference:document.write',
    'html-native-sink-indirect-reference:document.writeln',
    'html-native-sink-indirect-reference:document.writeln',
    'html-native-sink-indirect-reference:document.writeln'
  ].sort(),
  'document write aliases, call indirection, reflective lookup, contentDocument, and ownerDocument must fail closed'
);

const documentExpressionAliases = scanJavaScriptSource({
  filePath: 'theme/modules/document-expression-aliases.js',
  source: `
    export function render(frame, flag, textTarget, markup) {
      const logicalDocument = frame.contentDocument || document;
      const conditionalDocument = flag ? frame.ownerDocument : document;
      const sequenceDocument = (prepare(), frame.contentDocument);
      const safeSequence = (document, textTarget);
      const [arrayDocument] = [frame.ownerDocument];
      const [defaultDocument = document] = [];
      logicalDocument.write(markup);
      conditionalDocument.writeln(markup);
      sequenceDocument.write(markup);
      safeSequence.write(markup);
      arrayDocument.writeln(markup);
      defaultDocument.write(markup);
    }
  `
});
assert.deepEqual(
  documentExpressionAliases.map(({ kind }) => kind),
  ['document-write-call', 'document-write-call', 'document-write-call', 'document-write-call', 'document-write-call'],
  'logical, conditional, result-sequence, matched array, and defaulted array document aliases must classify while a safe final sequence value stays clean'
);

const dynamicParserMimes = scanJavaScriptSource({
  filePath: 'theme/modules/dynamic-parser.js',
  source: `
    export function parse(parser, markup, mime) {
      parser.parseFromString(markup, mime);
      parser.parseFromString(markup);
      parser.parseFromString(markup, 'application/xml');
    }
  `
});
assert.deepEqual(
  dynamicParserMimes.map(({ kind }) => kind),
  ['DOMParser-unproven-mime-call', 'DOMParser-unproven-mime-call'],
  'a dynamic or missing parser MIME must fail closed while a static non-HTML MIME remains outside the inventory'
);

const reflectiveWrites = scanJavaScriptSource({
  filePath: 'theme/modules/reflective-writes.js',
  source: `
    const inner = 'innerHTML';
    const outer = 'outerHTML';
    export function reflect(target, markup, srcdoc) {
      Reflect.set(target, inner, markup);
      Object.assign(target, {
        srcdoc,
        [outer]: markup,
        ['innerHTML']: markup
      });
      Object.defineProperty(target, 'srcdoc', { value: markup });
    }
  `
});
assert.deepEqual(
  reflectiveWrites.map(({ kind }) => kind).sort(),
  [
    'Object.assign-innerHTML',
    'Object.assign-outerHTML',
    'Object.assign-srcdoc',
    'Object.defineProperty-srcdoc',
    'Reflect.set-innerHTML'
  ].sort(),
  'Reflect.set, Object.assign plain/computed properties, and defineProperty must expose reflective HTML writes'
);

const opaqueReflectiveWrites = scanJavaScriptSource({
  filePath: 'theme/modules/opaque-reflective-writes.js',
  source: `
    export function reflect(target, key, value, payload, descriptors) {
      Reflect.set(target, key, value);
      Reflect.get(target, key);
      Object.assign(target, payload);
      Object.defineProperty(target, key, { value });
      Object.defineProperties(target, descriptors);
    }
  `
});
assert.deepEqual(
  opaqueReflectiveWrites.map(({ kind }) => kind).sort(),
  [
    'Object.assign-unproven-payload',
    'Object.defineProperties-unproven-descriptors',
    'Object.defineProperty-unproven-property',
    'Reflect.get-unproven-property',
    'Reflect.set-unproven-property'
  ].sort(),
  'opaque reflection properties, payloads, and descriptors must fail closed while statically safe properties stay clean'
);

const descriptorSetterLookups = scanJavaScriptSource({
  filePath: 'theme/modules/descriptor-setters.js',
  source: `
    export function write(element, markup, property) {
      Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set.call(element, markup);
      const outerDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
      outerDescriptor.set.call(element, markup);
      Object.getOwnPropertyDescriptor(Element.prototype, property);
      Reflect.getOwnPropertyDescriptor(Element.prototype, 'srcdoc').set.call(element, markup);
      Object.getOwnPropertyDescriptor(Element.prototype, 'textContent').set.call(element, markup);
    }
  `
});
assert.deepEqual(
  descriptorSetterLookups.map(({ kind }) => kind).sort(),
  [
    'Object.getOwnPropertyDescriptor-innerHTML-setter-reference',
    'Object.getOwnPropertyDescriptor-outerHTML-setter-reference',
    'Object.getOwnPropertyDescriptor-unproven-property',
    'Reflect.getOwnPropertyDescriptor-srcdoc-setter-reference'
  ].sort(),
  'descriptor-extracted HTML setters and opaque descriptor properties must be classified while a safe static property stays clean'
);
const descriptorHelperForms = scanJavaScriptSource({
  filePath: 'theme/modules/descriptor-helper-forms.js',
  source: `
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const getReflectDescriptor = Reflect.getOwnPropertyDescriptor;
    export function capture(target, markup) {
      getDescriptor(target, 'innerHTML');
      Object.getOwnPropertyDescriptor.call(Object, target, 'outerHTML');
      Object.getOwnPropertyDescriptor.apply(Object, [target, 'srcdoc']);
      Reflect.get(Object, 'getOwnPropertyDescriptor')(target, 'innerHTML');
      getReflectDescriptor(target, 'outerHTML');
      Reflect.getOwnPropertyDescriptor.call(Reflect, target, 'srcdoc');
      Reflect.getOwnPropertyDescriptor.apply(Reflect, [target, 'innerHTML']);
      Reflect.get(Reflect, 'getOwnPropertyDescriptor')(target, 'outerHTML');
    }
  `
});
for (const expectedKind of [
  'Object.getOwnPropertyDescriptor-innerHTML-setter-reference',
  'Object.getOwnPropertyDescriptor-outerHTML-setter-reference',
  'Object.getOwnPropertyDescriptor-srcdoc-setter-reference',
  'html-reflection-helper-apply:Object.getOwnPropertyDescriptor',
  'html-reflection-helper-call:Object.getOwnPropertyDescriptor',
  'html-reflection-helper-indirect-reference:Object.getOwnPropertyDescriptor',
  'Reflect.getOwnPropertyDescriptor-innerHTML-setter-reference',
  'Reflect.getOwnPropertyDescriptor-outerHTML-setter-reference',
  'Reflect.getOwnPropertyDescriptor-srcdoc-setter-reference',
  'html-reflection-helper-apply:Reflect.getOwnPropertyDescriptor',
  'html-reflection-helper-call:Reflect.getOwnPropertyDescriptor',
  'html-reflection-helper-indirect-reference:Reflect.getOwnPropertyDescriptor'
]) {
  assert.ok(
    descriptorHelperForms.some(({ kind }) => kind === expectedKind),
    `descriptor helper aliases and invocation forms must retain ${expectedKind}`
  );
}
const boundDescriptorHelperInvocations = scanJavaScriptSource({
  filePath: 'theme/modules/bound-reflection-helpers.js',
  source: `
    export function write(target, markup) {
      Object.getOwnPropertyDescriptor.bind(Object, target, 'innerHTML')();
      Reflect.set.bind(Reflect, target, 'outerHTML', markup)();
      Object.assign.bind(Object, target, { srcdoc: markup })();
      Object.defineProperty.bind(Object, target, 'innerHTML', { value: markup })();
      Object.defineProperties.bind(Object, target, { outerHTML: { value: markup } })();
      Object.getOwnPropertyDescriptors.bind(Object)(Element.prototype).srcdoc.set.call(target, markup);
    }
  `
});
assert.deepEqual(
  kindMultiset(boundDescriptorHelperInvocations),
  {
    'Object.assign-srcdoc': 1,
    'Object.defineProperties-outerHTML': 1,
    'Object.defineProperty-innerHTML': 1,
    'Object.getOwnPropertyDescriptor-innerHTML-setter-reference': 1,
    'Object.getOwnPropertyDescriptors-srcdoc-setter-reference': 1,
    'Reflect.set-outerHTML': 1,
    'html-reflection-helper-bind:Object.assign': 1,
    'html-reflection-helper-bind:Object.defineProperties': 1,
    'html-reflection-helper-bind:Object.defineProperty': 1,
    'html-reflection-helper-bind:Object.getOwnPropertyDescriptor': 1,
    'html-reflection-helper-bind:Object.getOwnPropertyDescriptors': 1,
    'html-reflection-helper-bind:Reflect.set': 1
  },
  'bound helper creation must emit one bind boundary while each actual invocation emits its concrete effect exactly once'
);

const defaultParameterDescriptorAliases = scanJavaScriptSource({
  filePath: 'theme/modules/default-parameter-descriptor-aliases.js',
  source: `
    export function writeObject({ getOwnPropertyDescriptor: get } = Object, target, markup) {
      get(target, 'innerHTML').set.call(target, markup);
    }
    export function writeReflect({ getOwnPropertyDescriptor: get } = Reflect, target, markup) {
      get(target, 'outerHTML').set.call(target, markup);
    }
    export function duplicate(
      { getOwnPropertyDescriptor: first, getOwnPropertyDescriptor: second } = Object
    ) {
      consume(first, second);
    }
  `
});
assert.deepEqual(
  kindMultiset(defaultParameterDescriptorAliases),
  {
    'html-reflection-helper-indirect-reference:Object.getOwnPropertyDescriptor': 3,
    'html-reflection-helper-indirect-reference:Reflect.getOwnPropertyDescriptor': 1
  },
  'default-parameter destructuring must fail closed once per helper boundary, including duplicate bindings'
);

const safeDefaultDescriptorAlias = scanJavaScriptSource({
  filePath: 'theme/modules/default-value-descriptor-alias.js',
  source: `export function write(target, get = Object.getOwnPropertyDescriptor) { get(target, 'textContent'); }`
});
const dangerousDefaultDescriptorAlias = scanJavaScriptSource({
  filePath: 'theme/modules/default-value-descriptor-alias.js',
  source: `export function write(target, get = Object.getOwnPropertyDescriptor) { get(target, 'innerHTML'); }`
});
const safeDefaultBoundary = safeDefaultDescriptorAlias.find(
  ({ kind }) => kind === 'html-reflection-helper-indirect-reference:Object.getOwnPropertyDescriptor'
);
const dangerousDefaultBoundary = dangerousDefaultDescriptorAlias.find(
  ({ kind }) => kind === 'html-reflection-helper-indirect-reference:Object.getOwnPropertyDescriptor'
);
assert.equal(
  safeDefaultBoundary.fingerprint,
  dangerousDefaultBoundary.fingerprint,
  'the default-value helper boundary itself must remain stable across call-site property changes'
);
assert.deepEqual(
  kindMultiset(dangerousDefaultDescriptorAlias),
  {
    'Object.getOwnPropertyDescriptor-innerHTML-setter-reference': 1,
    'html-reflection-helper-indirect-reference:Object.getOwnPropertyDescriptor': 1
  },
  'a dangerous default-value alias invocation must add one concrete setter finding instead of hiding behind the generic boundary'
);

const descriptorMapAliases = scanJavaScriptSource({
  filePath: 'theme/modules/descriptor-map-aliases.js',
  source: `
    const getDescriptors = Object.getOwnPropertyDescriptors;
    export function write(target, markup) {
      Object.getOwnPropertyDescriptors(Element.prototype).innerHTML.set.call(target, markup);
      const descriptors = Object.getOwnPropertyDescriptors(Element.prototype);
      descriptors.outerHTML.set.call(target, markup);
      getDescriptors(Element.prototype).srcdoc.set.call(target, markup);
      Object.getOwnPropertyDescriptors.bind(Object)(Element.prototype).innerHTML.set.call(target, markup);
      Object.getOwnPropertyDescriptors.apply(Object, [Element.prototype]).outerHTML.set.call(target, markup);
      Reflect.get(Object, 'getOwnPropertyDescriptors')(Element.prototype).srcdoc.set.call(target, markup);
    }
  `
});
assert.deepEqual(
  kindMultiset(descriptorMapAliases),
  {
    'Object.getOwnPropertyDescriptors-innerHTML-setter-reference': 2,
    'Object.getOwnPropertyDescriptors-outerHTML-setter-reference': 2,
    'Object.getOwnPropertyDescriptors-srcdoc-setter-reference': 2,
    'Object.getOwnPropertyDescriptors-unproven-property': 1,
    'html-reflection-helper-apply:Object.getOwnPropertyDescriptors': 1,
    'html-reflection-helper-bind:Object.getOwnPropertyDescriptors': 1,
    'html-reflection-helper-indirect-reference:Object.getOwnPropertyDescriptors': 3
  },
  'descriptor maps must retain exact direct, helper-alias, result-alias, bind, apply, and Reflect.get occurrence counts'
);

const legacyDescriptorSetters = scanJavaScriptSource({
  filePath: 'theme/modules/legacy-descriptor-setters.js',
  source: `
    export function write(target, markup, property) {
      Element.prototype.__lookupSetter__('innerHTML').call(target, markup);
      Element.prototype.__lookupSetter__('textContent').call(target, markup);
      Element.prototype.__lookupSetter__(property);
    }
  `
});
assert.deepEqual(
  kindMultiset(legacyDescriptorSetters),
  {
    '__lookupSetter__-innerHTML-setter-reference': 1,
    '__lookupSetter__-unproven-property': 1
  },
  'legacy setter lookup must classify an HTML property, ignore a static text-only key, and fail closed on an opaque key'
);
const safeDescriptorLookups = scanJavaScriptSource({
  filePath: 'theme/modules/safe-descriptor-lookups.js',
  source: `
    Object.getOwnPropertyDescriptor(Element.prototype, 'textContent');
    Reflect.getOwnPropertyDescriptor(Element.prototype, 'className');
    Object.getOwnPropertyDescriptors(Element.prototype).textContent;
    Element.prototype.__lookupSetter__('textContent');
  `
});
assert.deepEqual(safeDescriptorLookups, [], 'safe static descriptor properties must remain outside the sink inventory');

const aliasedReflectiveWrites = scanJavaScriptSource({
  filePath: 'theme/modules/aliased-reflective-writes.js',
  source: `
    const reflectSet = Reflect.set;
    const { get: reflectGet } = Reflect;
    const assign = Object.assign;
    const { defineProperty } = Object;
    const defineMany = Object.defineProperties;
    const inherited = { outerHTML: markup };
    const payload = { innerHTML: markup, ...inherited };
    const descriptors = {
      srcdoc: { value: markup },
      outerHTML: { value: markup }
    };
    export function reflect(target, range, markup) {
      reflectSet(target, 'srcdoc', markup);
      reflectGet(range, 'createContextualFragment');
      assign(target, payload);
      defineProperty(target, 'innerHTML', { value: markup });
      defineMany(target, descriptors);
    }
  `
});
assert.deepEqual(
  aliasedReflectiveWrites.map(({ kind }) => kind).sort(),
  [
    'Object.assign-innerHTML',
    'Object.assign-outerHTML',
    'Object.defineProperties-outerHTML',
    'Object.defineProperties-srcdoc',
    'Object.defineProperty-innerHTML',
    'Reflect.set-srcdoc',
    'html-native-sink-indirect-reference:createContextualFragment',
    'html-reflection-helper-indirect-reference:Object.assign',
    'html-reflection-helper-indirect-reference:Object.defineProperties',
    'html-reflection-helper-indirect-reference:Object.defineProperty',
    'html-reflection-helper-indirect-reference:Reflect.get',
    'html-reflection-helper-indirect-reference:Reflect.set'
  ].sort(),
  'const and destructured Reflect/Object helper aliases, aliased payloads, spreads, and defineProperties must be classified'
);

const reflectGetHelpers = scanJavaScriptSource({
  filePath: 'theme/modules/reflect-get-helpers.js',
  source: `
    const assign = Reflect.get(Object, 'assign');
    const setter = Reflect.get(Reflect, 'set');
    export function reflect(target, markup) {
      Reflect.get(Object, 'assign')(target, { innerHTML: markup });
      assign(target, { outerHTML: markup });
      Reflect.get(Reflect, 'set')(target, 'srcdoc', markup);
      setter.call(Reflect, target, 'innerHTML', markup);
      Reflect.get(Object, 'defineProperty').apply(Object, [target, 'outerHTML', { value: markup }]);
      Reflect.get(Object, 'keys')({ innerHTML: markup });
    }
  `
});
for (const expectedKind of [
  'Object.assign-innerHTML',
  'Object.assign-outerHTML',
  'Object.defineProperty-outerHTML',
  'Reflect.set-innerHTML',
  'Reflect.set-srcdoc',
  'html-reflection-helper-apply:Object.defineProperty',
  'html-reflection-helper-call:Reflect.set',
  'html-reflection-helper-indirect-reference:Object.assign',
  'html-reflection-helper-indirect-reference:Object.defineProperty',
  'html-reflection-helper-indirect-reference:Reflect.set'
]) {
  assert.ok(
    reflectGetHelpers.some(({ kind }) => kind === expectedKind),
    `Reflect.get helper retrieval must retain ${expectedKind}`
  );
}
assert.equal(
  reflectGetHelpers.some(({ kind }) => kind.includes('Object.keys')),
  false,
  'Reflect.get(Object, keys) must remain a safe negative control'
);

const repeatedAliasedPayload = scanJavaScriptSource({
  filePath: 'theme/modules/repeated-payload.js',
  source: `
    const payload = { innerHTML: markup };
    const descriptors = { srcdoc: { value: markup } };
    export function reflect(first, second) {
      Object.assign(first, payload);
      Object.assign(second, payload);
      Object.defineProperties(first, descriptors);
      Object.defineProperties(second, descriptors);
    }
  `
});
assert.deepEqual(
  repeatedAliasedPayload.map(({ kind }) => kind).sort(),
  [
    'Object.assign-innerHTML',
    'Object.assign-innerHTML',
    'Object.defineProperties-srcdoc',
    'Object.defineProperties-srcdoc'
  ].sort(),
  'each reflected payload call site must retain a distinct owner-bound occurrence even when the payload object is reused'
);
assert.equal(
  new Set(repeatedAliasedPayload.map(({ context }) => context)).size,
  4,
  'repeated reflected payload calls must be bound to their distinct owner-relative call locations'
);

const boundReflectionHelpers = scanJavaScriptSource({
  filePath: 'theme/modules/bound-reflection.js',
  source: `
    const assign = Object.assign.bind(Object);
    const set = Reflect.set.bind(Reflect);
    const defineMany = Object.defineProperties.bind(Object);
    export function reflect(target, markup) {
      assign(target, { innerHTML: markup });
      set(target, 'srcdoc', markup);
      defineMany(target, { outerHTML: { value: markup } });
    }
  `
});
assert.deepEqual(
  boundReflectionHelpers.map(({ kind }) => kind).sort(),
  [
    'Object.assign-innerHTML',
    'Object.defineProperties-outerHTML',
    'Reflect.set-srcdoc',
    'html-reflection-helper-bind:Object.assign',
    'html-reflection-helper-bind:Object.defineProperties',
    'html-reflection-helper-bind:Reflect.set'
  ].sort(),
  'bound Object and Reflect helper aliases must retain one bind boundary and one concrete reflected-write finding'
);

const safePreboundHelper = scanJavaScriptSource({
  filePath: 'theme/modules/prebound-helper-swap.js',
  source: `
    const setter = Reflect.set.bind(Reflect, target, 'textContent');
    const assign = Object.assign.bind(Object, target, { textContent: markup });
    export function run(markup) { setter(markup); assign(); }
  `
});
const dangerousPreboundHelper = scanJavaScriptSource({
  filePath: 'theme/modules/prebound-helper-swap.js',
  source: `
    const setter = Reflect.set.bind(Reflect, target, 'innerHTML');
    const assign = Object.assign.bind(Object, target, { srcdoc: markup });
    export function run(markup) { setter(markup); assign(); }
  `
});
const safeBindFingerprints = safePreboundHelper
  .filter(({ kind }) => kind.startsWith('html-reflection-helper-bind:'))
  .map(({ fingerprint }) => fingerprint)
  .sort();
const dangerousBindFingerprints = dangerousPreboundHelper
  .filter(({ kind }) => kind.startsWith('html-reflection-helper-bind:'))
  .map(({ fingerprint }) => fingerprint)
  .sort();
assert.notDeepEqual(
  safeBindFingerprints,
  dangerousBindFingerprints,
  'changing prebound helper keys or payloads must change the whole-bind identities'
);
assert.ok(dangerousPreboundHelper.some(({ kind }) => kind === 'Reflect.set-innerHTML'));
assert.ok(dangerousPreboundHelper.some(({ kind }) => kind === 'Object.assign-srcdoc'));

const indirectReflectionHelpers = scanJavaScriptSource({
  filePath: 'theme/modules/indirect-reflection.js',
  source: `
    export function capture(consume) {
      const reflectSet = Reflect.set;
      const { assign } = Object;
      const defineOne = Object.defineProperty.bind(Object);
      consume(Object.defineProperties);
      return [reflectSet, assign, defineOne];
    }
  `
});
assert.deepEqual(
  indirectReflectionHelpers.map(({ kind }) => kind).sort(),
  [
    'html-reflection-helper-bind:Object.defineProperty',
    'html-reflection-helper-indirect-reference:Object.assign',
    'html-reflection-helper-indirect-reference:Object.defineProperties',
    'html-reflection-helper-indirect-reference:Reflect.set'
  ].sort(),
  'Reflect and Object HTML-capable helpers must fail closed when aliased, destructured, bound, or passed as callbacks'
);

const reflectionCallAndApply = scanJavaScriptSource({
  filePath: 'theme/modules/reflection-call-apply.js',
  source: `
    const assignArgs = [target, { srcdoc: markup }];
    export function reflect(target, markup, opaqueArgs) {
      Object.assign.call(Object, target, { innerHTML: markup });
      Reflect.set.call(Reflect, target, 'outerHTML', markup);
      Object.defineProperties.call(Object, target, { srcdoc: { value: markup } });
      Object.assign.apply(Object, assignArgs);
      Object.assign.apply(Object, opaqueArgs);
    }
  `
});
for (const kind of [
  'Object.assign-innerHTML',
  'Object.assign-srcdoc',
  'Object.defineProperties-srcdoc',
  'Reflect.set-outerHTML',
  'html-reflection-helper-call:Object.assign',
  'html-reflection-helper-call:Object.defineProperties',
  'html-reflection-helper-call:Reflect.set',
  'html-reflection-helper-apply:Object.assign',
  'html-reflection-helper-opaque-apply:Object.assign'
]) {
  assert.ok(
    reflectionCallAndApply.some((finding) => finding.kind === kind),
    `${kind} must be inventoried through reflection helper call/apply normalization`
  );
}

const safeReflectionCall = scanJavaScriptSource({
  filePath: 'theme/modules/reflection-call-swap.js',
  source: `Object.assign.call(Object, target, { textContent: markup });`
});
const dangerousReflectionCall = scanJavaScriptSource({
  filePath: 'theme/modules/reflection-call-swap.js',
  source: `Object.assign.call(Object, target, { innerHTML: markup });`
});
const safeCallFinding = safeReflectionCall.find(({ kind }) => kind === 'html-reflection-helper-call:Object.assign');
const dangerousCallFinding = dangerousReflectionCall.find(
  ({ kind }) => kind === 'html-reflection-helper-call:Object.assign'
);
assert.notEqual(
  safeCallFinding.fingerprint,
  dangerousCallFinding.fingerprint,
  'changing a reflection helper .call payload must change the whole-call identity'
);
assert.ok(
  dangerousReflectionCall.some(({ kind }) => kind === 'Object.assign-innerHTML'),
  'a dangerous reflection helper .call payload must also expose the concrete HTML property write'
);

const aliasedSinks = scanJavaScriptSource({
  filePath: 'theme/modules/aliased.js',
  source: `
    const property = 'innerHTML';
    const method = 'insertAdjacentHTML';
    const mime = 'text/html';
    export function render(node, parser, markup) {
      node[property] = markup;
      node[method]('beforeend', markup);
      parser.parseFromString(markup, mime);
    }
  `
});
assert.deepEqual(
  aliasedSinks.map(({ kind }) => kind).sort(),
  ['DOMParser-text-html-call', 'innerHTML-write', 'insertAdjacentHTML-call'].sort(),
  'lexically resolved constant property and MIME aliases must not bypass the sink inventory'
);

const shadowedAlias = scanJavaScriptSource({
  filePath: 'theme/modules/shadowed.js',
  source: `
    const property = 'innerHTML';
    export function render(node, property, markup) {
      node[property] = markup;
    }
  `
});
assert.deepEqual(
  shadowedAlias.map(({ kind }) => kind),
  ['html-assignment-unproven-property'],
  'an opaque parameter must shadow an unrelated constant binding and fail closed as a computed assignment'
);

const indirectWrapperReferences = scanJavaScriptSource({
  filePath: 'theme/modules/wrapper-alias.js',
  wrapperNames: ['renderHtml'],
  source: `
    function renderHtml(node, markup) {
      node.innerHTML = markup;
    }
    const alias = renderHtml;
    const bound = renderHtml.bind(null);
    export const callbacks = { renderHtml };
    export function run(node, markup) {
      renderHtml(node, markup);
      return [alias, bound, callbacks, node, markup];
    }
  `
});
assert.equal(
  indirectWrapperReferences.filter(({ kind }) => kind === 'html-wrapper-indirect-reference:renderHtml').length,
  3,
  'aliasing, binding, or exporting a reviewed wrapper must produce fail-closed indirect-reference occurrences'
);
assert.equal(
  indirectWrapperReferences.filter(({ kind }) => kind === 'html-wrapper-call:renderHtml').length,
  1,
  'a direct reviewed wrapper call must remain separately inventoried'
);

const duplicateSource = `
  export function clear(first, second) {
    first.innerHTML = '';
    second.innerHTML = '';
  }
`;
const duplicateFirst = scanJavaScriptSource({
  filePath: 'theme/modules/duplicate.js',
  source: duplicateSource
});
const duplicateSecond = scanJavaScriptSource({
  filePath: 'theme/modules/duplicate.js',
  source: duplicateSource
});
assert.deepEqual(duplicateFirst, duplicateSecond, 'source fingerprints and duplicate ordinals must be deterministic');

const movedAcrossOwners = scanJavaScriptSource({
  filePath: 'theme/modules/owner-context.js',
  source: `
    export function first(node) {
      node.innerHTML = '';
    }
    export function second(node) {
      node.innerHTML = '';
    }
  `
});
assert.deepEqual(
  movedAcrossOwners.map(({ owner }) => owner),
  ['function:first', 'function:second'],
  'each sink must retain its enclosing owner as reviewed context'
);
assert.notEqual(
  movedAcrossOwners[0].fingerprint,
  movedAcrossOwners[1].fingerprint,
  'identical sink text moved to a different owner must receive a different fingerprint'
);
const movedWithinOwnerBefore = scanJavaScriptSource({
  filePath: 'theme/modules/owner-offset.js',
  source: `export function render(node) { node.innerHTML = ''; return true; }`
});
const movedWithinOwnerAfter = scanJavaScriptSource({
  filePath: 'theme/modules/owner-offset.js',
  source: `export function render(node) { const ready = true; node.innerHTML = ''; return ready; }`
});
assert.notEqual(
  movedWithinOwnerBefore[0].fingerprint,
  movedWithinOwnerAfter[0].fingerprint,
  'moving identical sink text within the same owner must change its owner-relative context fingerprint'
);
const trustedMethodSink = scanJavaScriptSource({
  filePath: 'theme/modules/same-method-name.js',
  source: `
    const trusted = { render(node, markup) { node.innerHTML = markup; } };
    const suspect = { render(node, markup) { return markup; } };
    export { trusted, suspect };
  `
});
const suspectMethodSink = scanJavaScriptSource({
  filePath: 'theme/modules/same-method-name.js',
  source: `
    const trusted = { render(node, markup) { return markup; } };
    const suspect = { render(node, markup) { node.innerHTML = markup; } };
    export { trusted, suspect };
  `
});
assert.equal(trustedMethodSink[0].owner, 'variable:trusted/property:render');
assert.equal(suspectMethodSink[0].owner, 'variable:suspect/property:render');
assert.notEqual(
  trustedMethodSink[0].fingerprint,
  suspectMethodSink[0].fingerprint,
  'same-named methods in different lexical containers must have distinct sink identities'
);

const firstCallbackSink = scanJavaScriptSource({
  filePath: 'theme/modules/repeated-callback.js',
  source: `export function run(items, node, markup) {
    items.forEach(() => { node.innerHTML = markup; });
    items.forEach(() => { work(); });
  }`
});
const secondCallbackSink = scanJavaScriptSource({
  filePath: 'theme/modules/repeated-callback.js',
  source: `export function run(items, node, markup) {
    items.forEach(() => { work(); });
    items.forEach(() => { node.innerHTML = markup; });
  }`
});
assert.equal(firstCallbackSink[0].owner, secondCallbackSink[0].owner);
assert.notEqual(
  firstCallbackSink[0].context,
  secondCallbackSink[0].context,
  'identical callback owners must retain distinct full-file call-site AST paths'
);

const alphaCallbackSink = scanJavaScriptSource({
  filePath: 'theme/modules/callback-owner.js',
  source: `export function run(alpha, beta, node, markup) { alpha(() => { node.innerHTML = markup; }); }`
});
const betaCallbackSink = scanJavaScriptSource({
  filePath: 'theme/modules/callback-owner.js',
  source: `export function run(alpha, beta, node, markup) { beta(() => { node.innerHTML = markup; }); }`
});
assert.notEqual(
  alphaCallbackSink[0].owner,
  betaCallbackSink[0].owner,
  'anonymous callbacks nested inside named functions must retain their semantic call-site owner anchor'
);
assert.notEqual(
  alphaCallbackSink[0].fingerprint,
  betaCallbackSink[0].fingerprint,
  'same-position sinks moved between callback callees must change exact identity'
);

const alphaNestedCallbackSink = scanJavaScriptSource({
  filePath: 'theme/modules/nested-callback-owner.js',
  source: `export function run(alpha, beta, node, markup) { return alpha(() => () => { node.innerHTML = markup; }); }`
});
const betaNestedCallbackSink = scanJavaScriptSource({
  filePath: 'theme/modules/nested-callback-owner.js',
  source: `export function run(alpha, beta, node, markup) { return beta(() => () => { node.innerHTML = markup; }); }`
});
assert.notEqual(
  alphaNestedCallbackSink[0].owner,
  betaNestedCallbackSink[0].owner,
  'nested anonymous functions must retain every enclosing callback call-site anchor'
);

const callbackQuoteSource = `obj["listen"](() => { target.innerHTML = markup; });`;
const formattedCallbackQuoteSource = await prettier.format(callbackQuoteSource, {
  parser: 'babel',
  printWidth: 120,
  semi: true,
  singleQuote: true,
  trailingComma: 'none'
});
assert.deepEqual(
  withoutLocations(
    scanJavaScriptSource({ filePath: 'theme/modules/callback-quote-stability.js', source: callbackQuoteSource })
  ),
  withoutLocations(
    scanJavaScriptSource({
      filePath: 'theme/modules/callback-quote-stability.js',
      source: formattedCallbackQuoteSource
    })
  ),
  'callback callee identities must normalize computed literal quoting across Prettier formatting'
);

const headerStableSource = `export function render(node, markup) { node.innerHTML = markup; }`;
assert.deepEqual(
  withoutLocations(scanJavaScriptSource({ filePath: 'theme/modules/header-stability.js', source: headerStableSource })),
  withoutLocations(
    scanJavaScriptSource({
      filePath: 'theme/modules/header-stability.js',
      source: `// file header only\n\n${headerStableSource}`
    })
  ),
  'file-header comments and blank lines must not perturb AST-bound sink identities'
);

const policy = JSON.parse(await readFile(path.join(SCRIPT_DIR, 'html-sink-policy.json'), 'utf8'));
const inventory = await scanRepository({ wrappers: policy.wrappers });
for (const filePath of ['theme/modules/starter.js']) {
  const starterSource = await readFile(path.join(SCRIPT_DIR, '..', filePath), 'utf8');
  const formattedStarterSource = await prettier.format(starterSource, {
    parser: 'babel',
    printWidth: 120,
    semi: true,
    singleQuote: true,
    trailingComma: 'none'
  });
  assert.deepEqual(
    withoutLocations(
      scanJavaScriptSource({
        filePath,
        source: starterSource,
        wrapperNames: policy.wrappers.map(({ name }) => name)
      })
    ),
    withoutLocations(
      scanJavaScriptSource({
        filePath,
        source: formattedStarterSource,
        wrapperNames: policy.wrappers.map(({ name }) => name)
      })
    ),
    `the exact Starter sink inventory must remain stable when Prettier formats ${filePath}`
  );
}
assert.deepEqual(verifyInventory(inventory, policy), [], 'the checked-in exact sink inventory must match theme source');

const changedInventory = structuredClone(inventory);
changedInventory[0].fingerprint = `sha256:${'0'.repeat(64)}`;
assert.ok(
  verifyInventory(changedInventory, policy).some((error) => /unclassified sink/u.test(error)),
  'a changed sink fingerprint must fail closed as unclassified'
);

const addedInventory = structuredClone(inventory);
addedInventory.push({
  path: 'theme/modules/new.js',
  owner: 'function:render',
  context: 'function:render@path:body/body[0]',
  kind: 'innerHTML-write',
  fingerprint: `sha256:${'1'.repeat(64)}`,
  occurrence: 1,
  line: 1,
  column: 1
});
assert.ok(
  verifyInventory(addedInventory, policy).some((error) => /unclassified sink/u.test(error)),
  'a new sink must fail closed as unclassified'
);

assert.deepEqual(
  verifyPolicyTransition(null, policy),
  [],
  'the first policy may bootstrap when the merge base has none'
);
assert.deepEqual(
  verifyBootstrapPolicy(inventory, policy),
  [],
  'the first policy may only bootstrap from exact sinks independently recomputed from merge-base source'
);
const shrunkenPolicy = structuredClone(policy);
shrunkenPolicy.approved = shrunkenPolicy.approved.slice(1);
assert.deepEqual(
  verifyPolicyTransition(policy, shrunkenPolicy),
  [],
  'an established sink baseline may shrink after a sink is removed'
);
const expandedPolicy = structuredClone(policy);
expandedPolicy.approved.push({
  path: 'theme/modules/new.js',
  owner: 'function:render',
  context: 'function:render@path:body/body[0]',
  kind: 'innerHTML-write',
  fingerprint: `sha256:${'2'.repeat(64)}`,
  occurrence: 1,
  disposition: 'escaped-theme-template',
  rationale: 'A newly reviewed template must still be blocked by the permanent merge-base no-growth boundary.'
});
assert.ok(
  verifyPolicyTransition(policy, expandedPolicy).some((error) => /baseline growth is forbidden/u.test(error)),
  'updating the head policy must not authorize a new sink relative to the merge base'
);
assert.ok(
  verifyBootstrapPolicy(inventory, expandedPolicy).some((error) => /bootstrap growth is forbidden/u.test(error)),
  'an initial policy must not authorize a sink absent from the exact merge-base source inventory'
);
const replacedFingerprintPolicy = structuredClone(policy);
replacedFingerprintPolicy.approved[0].fingerprint = `sha256:${'3'.repeat(64)}`;
assert.ok(
  verifyPolicyTransition(policy, replacedFingerprintPolicy).some((error) =>
    /baseline growth is forbidden/u.test(error)
  ),
  'replacing an approved fingerprint must be treated as sink growth even when the count is unchanged'
);
const movedOwnerPolicy = structuredClone(policy);
movedOwnerPolicy.approved[0].owner = 'function:moved';
movedOwnerPolicy.approved[0].context = 'function:moved@path:body/body[0]';
assert.ok(
  verifyPolicyTransition(policy, movedOwnerPolicy).some((error) => /baseline growth is forbidden/u.test(error)),
  'moving identical sink text into a different owner must be treated as baseline growth'
);
const duplicateGrowthPolicy = structuredClone(policy);
duplicateGrowthPolicy.approved.push({
  ...duplicateGrowthPolicy.approved[0],
  occurrence: 2
});
assert.ok(
  verifyPolicyTransition(policy, duplicateGrowthPolicy).some((error) => /approved count grew/u.test(error)),
  'duplicating an existing sink occurrence must fail the merge-base count boundary'
);
const removedWrapperPolicy = structuredClone(policy);
removedWrapperPolicy.wrappers = [];
assert.ok(
  verifyPolicyTransition(policy, removedWrapperPolicy).some((error) =>
    /wrapper removal or rename is forbidden/u.test(error)
  ),
  'an established wrapper name must not be removed from the head policy'
);
const renamedWrapperPolicy = structuredClone(policy);
renamedWrapperPolicy.wrappers[0].name = 'setMarkup';
assert.ok(
  verifyPolicyTransition(policy, renamedWrapperPolicy).some((error) =>
    /wrapper removal or rename is forbidden/u.test(error)
  ),
  'renaming an established wrapper must fail the merge-base transition'
);

process.stdout.write(`HTML sink policy self-test passed for ${inventory.length} repository occurrences.\n`);
