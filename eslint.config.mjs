import js from '@eslint/js';
import globals from 'globals';

const RECOMMENDED_RULES = js.configs.recommended.rules;

export default [
  {
    ignores: ['.press/**', 'artifacts-worktree/**', 'dist/**', 'node_modules/**', 'press-theme-*/**']
  },
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error'
    }
  },
  {
    files: ['*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node
    },
    rules: RECOMMENDED_RULES
  },
  {
    files: ['*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: RECOMMENDED_RULES
  },
  {
    files: ['theme/**/*.js', 'theme/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser
    },
    rules: {
      ...RECOMMENDED_RULES,
      'no-unused-vars': 'off'
    }
  }
];
