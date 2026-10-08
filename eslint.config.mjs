import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

/**
 * Linting for OpenPics.
 *
 * Split by environment, because the codebase runs in four places and the rules
 * that matter differ between them. `tsc` already checks types three times over -
 * node, web and MCP - so this config deliberately does not re-check types. What
 * it adds is the class of mistake TypeScript cannot see: a promise fired and
 * dropped, hooks called in the wrong order, a handler returning a promise where
 * the framework will not await it.
 *
 * Nothing here is a style preference. Formatting is Prettier's job and
 * `.prettierrc` already exists; a linter that argues about line length only
 * manufactures `--fix` fights.
 *
 * The type-aware rules live in their own blocks at the bottom because they need a
 * tsconfig, and mixing them into the blocks above makes every file an error.
 * That split is why `tests/**` gets the untyped rules only - the `.mjs` harnesses
 * are not in any tsconfig, and a rule that throws on load is worse than no rule.
 */

const IGNORED = [
  'dist/**',
  'dist-mcp/**',
  'dist-test/**',
  'out/**',
  'release/**',
  'node_modules/**',
  'build/**'
]

/** Rules that hold everywhere, and need nothing but a parser. */
const COMMON = {
  // `catch {}` with no binding is used deliberately throughout to mean "ignore
  // this failure", which is a different decision from swallowing one silently.
  'no-empty': ['error', { allowEmptyCatch: true }],
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
  ],
  // Truthiness on a number is often right in this codebase - `size` and `bytes`
  // are legitimately 0 - so this stays off rather than being argued about.
  '@typescript-eslint/strict-boolean-expressions': 'off'
}

export default tseslint.config(
  { ignores: IGNORED },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /* ---------- electron + core + mcp + shared: Node, no DOM ---------- */
  {
    files: ['electron/**/*.ts', 'core/**/*.ts', 'mcp/**/*.ts', 'shared/**/*.ts', 'electron.vite.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' }
    },
    rules: { ...COMMON }
  },

  /* ---------- src: the renderer. Browser globals, plus React ---------- */
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...COMMON,
      // `rules-of-hooks` and `exhaustive-deps` only - not
      // `reactHooks.configs.recommended`, which also switches on the React
      // Compiler's own rules (`refs`, `set-state-in-effect`, `immutability`,
      // `preserve-manual-memoization`).
      //
      // Those describe how code must be *written for the compiler* - no ref
      // writes during render, no setState in an effect body - and this project
      // does not run it: `electron.vite.config.ts` uses plain
      // `@vitejs/plugin-react`, with no `babel-plugin-react-compiler` in
      // devDependencies. The rules are not wrong, they are answering a question
      // about a build this app does not have, and adopting them would mean
      // rewriting nine components' state handling to satisfy a compiler that
      // was never going to run.
      //
      // They are the right rules the day `babel-plugin-react-compiler` is added,
      // which is the day these come back - as errors, not warnings. `rules-of-hooks`
      // is the one exception and is on now: it is a genuine runtime crash
      // (React throws "Rendered fewer hooks than expected") independent of any
      // compiler, and it caught a real one in PhotoContextMenu when this config
      // was first run.
      'react-hooks/rules-of-hooks': 'error',
      // Left as the plugin sets it - a warning - because a missing dependency is
      // usually a stale-closure bug but occasionally deliberate, and a hard
      // failure here trains people to add the suppression without reading it.
      'react-hooks/exhaustive-deps': 'warn',
      // Fast Refresh only works when a module exports components and nothing
      // else; a hook or a helper alongside them defeats it.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },

  /* ---------- scripts and tests: Node, plain JS, no tsconfig ---------- */
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' }
    },
    rules: {
      ...COMMON,
      // The harnesses build partial objects on purpose, to prove a shape is
      // rejected, and `any` is the honest annotation for a parsed JSON value.
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },

  /* ---------- the launcher: CommonJS, and packaged as-is ---------- */
  {
    // `bin/openpics.js` is deliberately a CommonJS script with no build step, so
    // it is linted as what it is rather than being forced into the module shape
    // every other file uses. `require` and `module` are real here.
    files: ['bin/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'commonjs' }
    },
    rules: { ...COMMON, '@typescript-eslint/no-require-imports': 'off' }
  },

  /* ---------- the GUI probe: node driver, browser callbacks inside ---------- */
  {
    // `scripts/gui-probe.mjs` runs in Node and drives a Playwright page. Its
    // `page.evaluate` callbacks are serialised and run *inside* the browser
    // context, so `document` and `window` are legitimately in scope there and
    // legitimately not defined in the surrounding module. ESLint sees one scope
    // and cannot tell the two apart, so the browser globals are declared for
    // this file rather than the four callbacks being littered with eslint-disable
    // comments that would outlive the callbacks.
    files: ['scripts/gui-probe.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    rules: { ...COMMON }
  },

  /* ---------- type-aware, Node side ---------- */
  {
    // `projectService` rather than an explicit `project`, because these files live
    // in `tsconfig.node.json` and the service finds the right project without
    // being told. The MCP gets its own block below.
    files: ['electron/**/*.ts', 'core/**/*.ts', 'shared/**/*.ts', 'electron.vite.config.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      // The most common real defect in an async codebase, and the one `tsc`
      // cannot see at all. This codebase already writes `void bridge.foo()`
      // where it means to fire and forget, so this produces findings rather
      // than noise.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } }
      ],
      // Reaching for `any` defeats the three separate tsc projects above.
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },

  /* ---------- type-aware, renderer side ---------- */
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } }
      ],
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },

  /* ---------- type-aware, MCP side: its own project ---------- */
  {
    // The MCP compiles under `tsconfig.mcp.json`, which `projectService` cannot
    // discover: it only looks for a project referenced from the root
    // `tsconfig.json`, and the root references the node and web projects, not
    // this one. The file is named explicitly so the type-aware rules still run
    // here instead of the whole block failing to parse.
    files: ['mcp/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.mcp.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } }
      ],
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
)
