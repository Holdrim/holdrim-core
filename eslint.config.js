import js from '@eslint/js';

/**
 * Lint for Holdrim. Deliberately THIN: the pre-commit hook has to run in seconds, and a rule
 * nobody understands turns into `eslint-disable` scattered through the code.
 *
 * What is here is what has actually bitten this project — not a list of good practices copied from
 * somewhere.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      // The panel and Mermaid chunks are generated and committed. Linting minified output produces
      // hundreds of errors about code nobody wrote and nobody will fix.
      'engine/web/panel-react.js',
      'engine/web/generated/**',
    ],
  },

  js.configs.recommended,

  {
    // Node: the server, the CLI and the core.
    // TypeScript is NOT linted here, and that is a choice: linting it needs another dependency,
    // and `tsc --noEmit` already catches more than style — including unused locals and parameters,
    // which is most of what a lint would add. One tool per job.
    files: ['engine/**/*.js', '*.js'],
    ignores: ['engine/web/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', crypto: 'readonly', fetch: 'readonly',
        URL: 'readonly', TextEncoder: 'readonly', Buffer: 'readonly', setTimeout: 'readonly',
      },
    },
  },

  {
    // The React source of the panel, before bundling.
    files: ['engine/web/src/**/*.js', 'engine/web/src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly', fetch: 'readonly',
        console: 'readonly', setTimeout: 'readonly', Element: 'readonly', Attr: 'readonly', navigator: 'readonly',
      },
    },
  },

  {
    // Scripts an example ships to its adopters, like the template's proof in checks/. They run on
    // the adopter's plain Node, with no dependency, so they get Node's globals and nothing else.
    files: ['examples/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },

  {
    // Tests run on Node with the built-in runner.
    files: ['engine/tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', globalThis: 'writable', crypto: 'readonly',
        fetch: 'readonly', URL: 'readonly', Buffer: 'readonly', setTimeout: 'readonly',
        // A test that waits on something external has to be able to stop waiting. A suite that
        // hangs gets killed, and killed is not the same as failed.
        clearTimeout: 'readonly',
      },
    },
  },
];
