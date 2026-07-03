function getDocument(context = {}) {
  return context.document || (typeof document !== 'undefined' ? document : null);
}

function ensureElement(parent, selector, create) {
  const existing = parent.querySelector(selector);
  if (existing) return existing;
  const element = create();
  parent.appendChild(element);
  return element;
}

function setHtml(element, html) {
  if (!element) return false;
  element.innerHTML = String(html || '');
  return true;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getMain(params = {}) {
  return (params.containers && params.containers.mainElement)
    || params.container
    || (params.ctx && params.ctx.regions && params.ctx.regions.main)
    || null;
}

function withRuntimeLangParam(params = {}, href = '') {
  const router = params.ctx && params.ctx.router;
  if (router && typeof router.withLangParam === 'function') return router.withLangParam(href);
  if (typeof params.withLangParam === 'function') return params.withLangParam(href);
  return href;
}

function renderPost(params = {}) {
  const main = getMain(params);
  if (!main) return undefined;
  const title = (params.postMetadata && params.postMetadata.title) || params.fallbackTitle || '';
  const heading = title ? `<h1>${escapeHtml(title)}</h1>` : '';
  setHtml(main, `${heading}${params.markdownHtml || ''}`);
  return { decorated: true, title };
}

function renderList(params = {}) {
  const main = getMain(params);
  if (!main) return undefined;
  const entries = Array.isArray(params.pageEntries) ? params.pageEntries : [];
  const cards = entries.map(([title, meta]) => {
    const href = withRuntimeLangParam(params, `?id=${encodeURIComponent((meta && meta.location) || '')}`);
    return `<article class="starter-card"><h2><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></h2></article>`;
  }).join('');
  setHtml(main, cards || '<p>No posts yet.</p>');
  return { decorated: true };
}

function renderSearch(params = {}) {
  const main = getMain(params);
  if (!main) return undefined;
  const heading = params.query ? `Search: ${params.query}` : 'Search';
  renderList(params);
  return { decorated: true, title: heading };
}

function renderTab(params = {}) {
  const main = getMain(params);
  if (!main) return undefined;
  const title = params.tab && params.tab.title ? params.tab.title : '';
  const heading = title ? `<h1>${escapeHtml(title)}</h1>` : '';
  setHtml(main, `${heading}${params.markdownHtml || ''}`);
  return { decorated: true, title };
}

function renderError(params = {}) {
  const main = getMain(params);
  if (!main) return undefined;
  setHtml(main, '<h1>Page not found</h1>');
  return { decorated: true };
}

function renderLoading(params = {}) {
  const main = getMain(params);
  if (!main) return undefined;
  setHtml(main, '<p>Loading...</p>');
  return { decorated: true };
}

function getViewContainer(params = {}) {
  const context = params.ctx || {};
  const regions = context.regions || {};
  return regions[params.role] || regions.main || null;
}

export function mount(context = {}) {
  const doc = getDocument(context);
  if (!doc || !doc.body) return context;

  const shell = ensureElement(doc.body, '[data-theme-root="container"]', () => {
    const element = doc.createElement('div');
    element.setAttribute('data-theme-root', 'container');
    doc.body.insertBefore(element, doc.body.firstChild);
    return element;
  });
  shell.className = 'starter-shell';
  shell.setAttribute('data-theme-region', 'container');

  const nav = ensureElement(shell, '[data-theme-region="nav"]', () => {
    const element = doc.createElement('nav');
    element.className = 'starter-nav';
    element.setAttribute('aria-label', 'Primary navigation');
    return element;
  });
  nav.setAttribute('data-theme-region', 'nav');

  const search = ensureElement(shell, '[data-theme-region="search"]', () => {
    const element = doc.createElement('press-search');
    element.className = 'starter-search';
    return element;
  });
  search.setAttribute('data-theme-region', 'search');

  const main = ensureElement(shell, '[data-theme-region="main"]', () => {
    const element = doc.createElement('main');
    element.className = 'starter-main';
    element.setAttribute('role', 'main');
    element.setAttribute('tabindex', '-1');
    return element;
  });
  main.setAttribute('data-theme-region', 'main');

  const toc = ensureElement(shell, '[data-theme-region="toc"]', () => {
    const element = doc.createElement('press-toc');
    element.className = 'starter-toc';
    return element;
  });
  toc.setAttribute('data-theme-region', 'toc');

  const tags = ensureElement(shell, '[data-theme-region="tags"]', () => {
    const element = doc.createElement('section');
    element.className = 'starter-tags';
    element.setAttribute('aria-label', 'Tags');
    return element;
  });
  tags.setAttribute('data-theme-region', 'tags');

  const footer = ensureElement(shell, '[data-theme-region="footer"]', () => {
    const element = doc.createElement('footer');
    element.className = 'starter-footer';
    element.setAttribute('role', 'contentinfo');
    return element;
  });
  footer.setAttribute('data-theme-region', 'footer');

  context.document = doc;
  context.regions = {
    container: shell,
    content: main,
    footer,
    main,
    nav,
    search,
    tags,
    toc
  };
  return context;
}

export const views = {
  post: renderPost,
  posts: renderList,
  search: renderSearch,
  tab: renderTab,
  error: renderError,
  loading: renderLoading
};

export const components = {};

export const effects = {
  getViewContainer,
  renderPostView: renderPost,
  renderIndexView: renderList,
  renderSearchResults: renderSearch,
  renderStaticTabView: renderTab,
  renderErrorState: renderError,
  renderPostLoadingState: renderLoading,
  renderStaticTabLoadingState: renderLoading
};

export function createThemeApi() {
  return { views, components, effects };
}

export default {
  mount,
  views,
  components,
  effects
};
