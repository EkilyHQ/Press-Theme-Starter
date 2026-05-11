import assert from 'node:assert/strict';

import { effects } from '../theme/modules/starter.js';

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
    pageEntries: [
      ['<img src=x onerror=alert(1)>', { location: 'post/demo.md' }]
    ]
  });
  assertNoExecutableTitleMarkup(container.innerHTML);
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
