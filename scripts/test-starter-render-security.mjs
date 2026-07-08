import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { effects } from '../theme/modules/starter.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'theme/modules/starter.js'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'theme/theme.json'), 'utf8'));
const releaseExample = JSON.parse(readFileSync(resolve(root, 'theme-release.example.json'), 'utf8'));

assert.equal(manifest.contractVersion, 4);
assert.equal(manifest.engines.press, '>=3.4.130 <4.0.0');
assert.equal(releaseExample.contractVersion, 4);
assert.equal(releaseExample.engines.press, '>=3.4.130 <4.0.0');
assert.doesNotMatch(source, /[?&](?:tab|id)=/, 'v4 packaged source should use router href helpers for public routes');
assert.doesNotMatch(source, /getRuntimeRouteHref[\s\S]{0,120}\|\|\s*'#'/, 'v4 route helper null results should not become hash dead links');

function fakeElement() {
  return {
    innerHTML: '',
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

function assertNoExecutableTitleMarkup(html) {
  assert.doesNotMatch(html, /<img\b/iu);
  assert.doesNotMatch(html, /<[^>]+\son\w+=/iu);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
}

{
  const container = fakeElement();
  effects.renderPostView({
    container,
    postMetadata: { title: '<img src=x onerror=alert(1)>' },
    markdownHtml: '<p>body</p>'
  });
  assertNoExecutableTitleMarkup(container.innerHTML);
}

{
  const container = fakeElement();
  effects.renderIndexView({
    container,
    ctx: {
      router: {
        prefix: '?id=',
        getPostHref(location) {
          return `${this.prefix}${location}`;
        }
      }
    },
    pageEntries: [
      ['<img src=x onerror=alert(1)>', { location: 'post/demo.md' }]
    ]
  });
  assertNoExecutableTitleMarkup(container.innerHTML);
}

{
  const container = fakeElement();
  effects.renderIndexView({
    container,
    ctx: {
      router: {
        getPostHref: () => null
      }
    },
    pageEntries: [
      ['Product', { location: 'post/demo.md' }]
    ]
  });
  assert.doesNotMatch(container.innerHTML, /href="(?:#|)"/, 'null post href helpers should not render empty or hash links');
}

{
  const container = fakeElement();
  effects.renderStaticTabView({
    container,
    tab: { title: '<img src=x onerror=alert(1)>' },
    markdownHtml: '<p>tab</p>'
  });
  assertNoExecutableTitleMarkup(container.innerHTML);
}

console.log('ok - starter render security');
