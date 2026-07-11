import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import prettier from 'prettier';
import {
  createBaseline,
  scanJavaScriptSource,
  verifyBaselineTransition,
  verifyBootstrapBaseline,
  verifyInventory
} from './probe-eslint-debt.mjs';

const baseSource = `
  export function alpha() {
    const dormant = 1;
    try {
      document.body.focus();
    } catch (_) {}
    return true;
  }

  export function beta() {
    return true;
  }
`;

const directiveCannotSuppress = scanJavaScriptSource({
  filePath: 'theme/modules/inline-debt-directive.js',
  source: `
    export function render() {
      // eslint-disable-next-line no-unused-vars -- hostile suppression attempt
      const dormant = 1;
      return true;
    }
  `
});
assert.equal(
  directiveCannotSuppress.filter(({ rule }) => rule === 'no-unused-vars').length,
  1,
  'inline ESLint directives must be inert in the standalone exact-debt scanner'
);

const swappedSource = `
  export function alpha() {
    return true;
  }

  export function beta() {
    const dormant = 1;
    try {
      document.body.focus();
    } catch (_) {}
    return true;
  }
`;

const baseInventory = scanJavaScriptSource({
  filePath: 'theme/modules/swap-debt.js',
  source: baseSource
});
const swappedInventory = scanJavaScriptSource({
  filePath: 'theme/modules/swap-debt.js',
  source: swappedSource
});
const countRules = (records) =>
  Object.fromEntries(
    [...new Set(records.map(({ rule }) => rule))]
      .sort()
      .map((rule) => [rule, records.filter((record) => record.rule === rule).length])
  );

assert.deepEqual(
  countRules(baseInventory),
  countRules(swappedInventory),
  'the adversarial fixture must preserve aggregate rule counts'
);
assert.equal(baseInventory.length, swappedInventory.length, 'the adversarial fixture must preserve total debt');
assert.notDeepEqual(
  baseInventory.map(({ owner, fingerprint }) => ({ owner, fingerprint })),
  swappedInventory.map(({ owner, fingerprint }) => ({ owner, fingerprint })),
  'moving debt to another function must change exact owner/context identities'
);

const baseBaseline = createBaseline(baseInventory);
const swappedBaseline = createBaseline(swappedInventory);
assert.deepEqual(
  verifyInventory(swappedInventory, swappedBaseline),
  [],
  'each fixture must be internally valid before testing the transition boundary'
);
assert.ok(
  verifyBaselineTransition(baseBaseline, swappedBaseline).some((error) =>
    /ESLint debt baseline growth is forbidden/u.test(error)
  ),
  'same-count debt moved to another owner must fail the merge-base transition'
);
assert.ok(
  verifyBootstrapBaseline(baseInventory, swappedBaseline).some((error) =>
    /ESLint debt bootstrap growth is forbidden/u.test(error)
  ),
  'same-count debt moved during the initial bootstrap must fail against merge-base diagnostics'
);

const shrunkenBaseline = createBaseline(baseInventory.slice(0, -1));
assert.deepEqual(
  verifyBaselineTransition(baseBaseline, shrunkenBaseline),
  [],
  'the exact diagnostic baseline may only shrink'
);
assert.deepEqual(
  verifyBootstrapBaseline(baseInventory, baseBaseline),
  [],
  'an exact initial baseline may bootstrap from matching merge-base diagnostics'
);

const trustedMethodDebt = scanJavaScriptSource({
  filePath: 'theme/modules/same-method-name.js',
  source: `
    const trusted = { render() { const dormant = 1; return true; } };
    const suspect = { render() { return true; } };
    export { trusted, suspect };
  `
});
const suspectMethodDebt = scanJavaScriptSource({
  filePath: 'theme/modules/same-method-name.js',
  source: `
    const trusted = { render() { return true; } };
    const suspect = { render() { const dormant = 1; return true; } };
    export { trusted, suspect };
  `
});
assert.equal(trustedMethodDebt[0].owner, 'variable:trusted/property:render');
assert.equal(suspectMethodDebt[0].owner, 'variable:suspect/property:render');
assert.ok(
  verifyBaselineTransition(createBaseline(trustedMethodDebt), createBaseline(suspectMethodDebt)).some((error) =>
    /ESLint debt baseline growth is forbidden/u.test(error)
  ),
  'same-count debt moved between same-named methods in different containers must fail the exact baseline'
);

const firstRepeatedContextDebt = scanJavaScriptSource({
  filePath: 'theme/modules/repeated-context.js',
  source: `
    export function render(first, second) {
      if (first) {
        // legacy slot
        const dormant = 1;
        run();
      }
      if (second) {
        // legacy slot
        run();
      }
    }
  `
});
const secondRepeatedContextDebt = scanJavaScriptSource({
  filePath: 'theme/modules/repeated-context.js',
  source: `
    export function render(first, second) {
      if (first) {
        // legacy slot
        run();
      }
      if (second) {
        // legacy slot
        const dormant = 1;
        run();
      }
    }
  `
});
assert.equal(firstRepeatedContextDebt[0].owner, 'function:render');
assert.equal(secondRepeatedContextDebt[0].owner, 'function:render');
assert.notEqual(
  firstRepeatedContextDebt[0].ownerPath,
  secondRepeatedContextDebt[0].ownerPath,
  'same-owner duplicate source context must retain distinct owner-relative AST paths'
);
assert.ok(
  verifyBaselineTransition(createBaseline(firstRepeatedContextDebt), createBaseline(secondRepeatedContextDebt)).some(
    (error) => /ESLint debt baseline growth is forbidden/u.test(error)
  ),
  'same-count debt moved between repeated contexts in one owner must fail the exact baseline'
);

const firstCallbackDebt = scanJavaScriptSource({
  filePath: 'theme/modules/repeated-callback.js',
  source: `
    export function run(items) {
      items.forEach(() => { const dormant = 1; work(); });
      items.forEach(() => { work(); });
    }
  `
});
const secondCallbackDebt = scanJavaScriptSource({
  filePath: 'theme/modules/repeated-callback.js',
  source: `
    export function run(items) {
      items.forEach(() => { work(); });
      items.forEach(() => { const dormant = 1; work(); });
    }
  `
});
assert.equal(firstCallbackDebt[0].owner, secondCallbackDebt[0].owner);
assert.notEqual(
  firstCallbackDebt[0].ownerPath,
  secondCallbackDebt[0].ownerPath,
  'identical callback owners must retain their distinct outer call-site AST paths'
);
assert.ok(
  verifyBaselineTransition(createBaseline(firstCallbackDebt), createBaseline(secondCallbackDebt)).some((error) =>
    /ESLint debt baseline growth is forbidden/u.test(error)
  ),
  'same-count debt moved between identical callback call sites must fail the exact baseline'
);

const firstComputedCallbackDebt = scanJavaScriptSource({
  filePath: 'theme/modules/computed-callback.js',
  source: `export function run(items, first, second) { items[first](() => { const dormant = 1; }); }`
});
const secondComputedCallbackDebt = scanJavaScriptSource({
  filePath: 'theme/modules/computed-callback.js',
  source: `export function run(items, first, second) { items[second](() => { const dormant = 1; }); }`
});
assert.notEqual(
  firstComputedCallbackDebt[0].owner,
  secondComputedCallbackDebt[0].owner,
  'computed callback callees must retain the semantic property expression in their owner identity'
);
assert.ok(
  verifyBaselineTransition(createBaseline(firstComputedCallbackDebt), createBaseline(secondComputedCallbackDebt)).some(
    (error) => /ESLint debt baseline growth is forbidden/u.test(error)
  ),
  'same-position debt moved between computed callback callees must fail the exact baseline'
);

const firstNestedCallbackDebt = scanJavaScriptSource({
  filePath: 'theme/modules/nested-callback.js',
  source: `export function run(alpha, beta) { return alpha(() => () => { const dormant = 1; }); }`
});
const secondNestedCallbackDebt = scanJavaScriptSource({
  filePath: 'theme/modules/nested-callback.js',
  source: `export function run(alpha, beta) { return beta(() => () => { const dormant = 1; }); }`
});
assert.notEqual(
  firstNestedCallbackDebt[0].owner,
  secondNestedCallbackDebt[0].owner,
  'nested anonymous functions must retain every enclosing semantic callback call-site anchor'
);
assert.ok(
  verifyBaselineTransition(createBaseline(firstNestedCallbackDebt), createBaseline(secondNestedCallbackDebt)).some(
    (error) => /ESLint debt baseline growth is forbidden/u.test(error)
  ),
  'same-position debt moved between outer nested callback callees must fail the exact baseline'
);

const callbackQuoteSource = `export function run(alpha) { alpha("click", () => { const dormant = 1; }); }`;
const formattedCallbackQuoteSource = await prettier.format(callbackQuoteSource, {
  parser: 'babel',
  printWidth: 120,
  semi: true,
  singleQuote: true,
  trailingComma: 'none'
});
assert.deepEqual(
  createBaseline(
    scanJavaScriptSource({ filePath: 'theme/modules/callback-quote-stability.js', source: callbackQuoteSource })
  ),
  createBaseline(
    scanJavaScriptSource({
      filePath: 'theme/modules/callback-quote-stability.js',
      source: formattedCallbackQuoteSource
    })
  ),
  'callback identities must normalize preceding literal arguments across Prettier quote changes'
);

const unformattedDebtSource = `export function render( ){try{run()}catch(_){}const dormant=1;return true}`;
const formattedDebtSource = await prettier.format(unformattedDebtSource, {
  parser: 'babel',
  printWidth: 120,
  semi: true,
  singleQuote: true,
  trailingComma: 'none'
});
assert.deepEqual(
  createBaseline(
    scanJavaScriptSource({ filePath: 'theme/modules/format-stability.js', source: unformattedDebtSource })
  ),
  createBaseline(scanJavaScriptSource({ filePath: 'theme/modules/format-stability.js', source: formattedDebtSource })),
  'exact diagnostic identities must remain stable across Prettier-only formatting'
);
assert.deepEqual(
  createBaseline(scanJavaScriptSource({ filePath: 'theme/modules/header-stability.js', source: baseSource })),
  createBaseline(
    scanJavaScriptSource({
      filePath: 'theme/modules/header-stability.js',
      source: `// file header only\n\n${baseSource}`
    })
  ),
  'file-header comments and blank lines must not perturb AST-bound exact diagnostic identities'
);

const starterSource = await readFile(new URL('../theme/modules/starter.js', import.meta.url), 'utf8');
const formattedStarterSource = await prettier.format(starterSource, {
  parser: 'babel',
  printWidth: 120,
  semi: true,
  singleQuote: true,
  trailingComma: 'none'
});
assert.deepEqual(
  createBaseline(scanJavaScriptSource({ filePath: 'theme/modules/starter.js', source: starterSource })),
  createBaseline(scanJavaScriptSource({ filePath: 'theme/modules/starter.js', source: formattedStarterSource })),
  'the exact Starter debt baseline must remain stable when the touched-legacy Prettier rule formats its theme file'
);

process.stdout.write('ESLint exact-debt policy self-test passed: same-count owner swaps fail and shrinkage passes.\n');
