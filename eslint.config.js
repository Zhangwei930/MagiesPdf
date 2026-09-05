import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';

export default [
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      'vendor/office-runtime/**',
      // The vendored document engine is upstream AGPL source, ~600 MB of it.
      // It is not ours to lint, and scanning it makes a lint run take minutes.
      'vendor/onlyoffice/**',
    ],
  },
  js.configs.recommended,

  {
    rules: {
      /**
       * Off, deliberately.
       *
       * ESLint 10 turned this on in `recommended`, and every one of the eleven
       * places it fires in this repository is the same shape:
       *
       *     let encrypted = false;
       *     try { encrypted = peek.getMetaData('encryption') !== 'None'; }
       *     catch { encrypted = true; }
       *
       * The rule is not wrong — both branches assign, so the initialiser is
       * never read. But it is not dead weight either: it states the type and
       * the fallback at the declaration, where someone reading the code meets
       * the variable, instead of making them scan ahead to find out what the
       * failure case is. Removing it means either losing that, or replacing it
       * with a type annotation that says less.
       *
       * What the rule is good at — a value computed and then thrown away,
       * which usually means someone meant to use it — does not occur here, and
       * the rule cannot tell the two apart.
       */
      'no-useless-assignment': 'off',
    },
  },

  // Renderer + isomorphic core (TypeScript).
  {
    files: ['src/**/*.{ts,tsx}', '*.config.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLDivElement: 'readonly',
        DragEvent: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        ResizeObserver: 'readonly',
        matchMedia: 'readonly',
        localStorage: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        crypto: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      'unused-imports': unusedImports,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // TypeScript owns undefined-symbol detection; the base rule misfires on types.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],

      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // The isomorphic core must stay runnable in a bare worker thread: no DOM, no Electron.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/core must stay isomorphic — no DOM access.' },
        { name: 'document', message: 'src/core must stay isomorphic — no DOM access.' },
        { name: 'localStorage', message: 'src/core must stay isomorphic — no DOM access.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'src/core must stay isomorphic — no Electron imports.' },
            { name: 'react', message: 'src/core must stay isomorphic — no React imports.' },
          ],
          patterns: ['@app/*'],
        },
      ],
    },
  },

  // Tests assert against known-shaped fixtures, where `result.files[0]!` is
  // clearer than a guard that would only ever fire if the test itself is broken.
  {
    files: ['src/**/*.test.ts', 'src/core/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Build scripts: ESM running under Node.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { Buffer: 'readonly', console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },

  // Electron main process: CommonJS, Node globals.
  {
    files: ['electron/**/*.cjs', 'scripts/**/*.cjs', 'electron-builder.config.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        // Electron's protocol handlers are answered with a Response, and it
        // comes from the same fetch standard already listed above.
        Response: 'readonly',
        Request: 'readonly',
        structuredClone: 'readonly',
        AbortController: 'readonly',
        // Its other half: `AbortSignal.timeout` is how a test gives a request
        // a deadline, which is the only way to assert that one is never answered.
        AbortSignal: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
];
