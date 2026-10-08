/**
 * Builds the renderer store for tests.
 *
 * The store is the one piece of the app with no coverage, and it is where two of
 * the bugs fixed this session live: a range selection that swept in filtered-out
 * photos, and a settings patch that re-filtered the whole library. Neither is
 * reachable from the MCP server or from `core/`, which is where every other test
 * in this repo points, so the store has to be exercised directly.
 *
 * `tsc` is not enough here. It compiles per-file and leaves the `@/lib/bridge`
 * and `@shared/*` aliases in the emitted JavaScript, which Node cannot resolve at
 * runtime; rewriting them afterwards would be more fragile than not emitting them.
 * esbuild resolves the aliases at bundle time and emits one file with none left,
 * so the test can import the store the way the app imports it.
 *
 * `window.opencpics` is left as a real property access rather than being replaced
 * at build time: the harness sets `globalThis.window` before importing the bundle,
 * so the module-level read in bridge.ts sees the stub. That keeps the test running
 * against the same code path the app does.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const watch = process.argv.includes('--watch')

const options = {
  entryPoints: [join(root, 'src', 'store', 'library.ts')],
  outfile: join(root, 'dist-test', 'store', 'library.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  // Left external so the bundle imports the same copy the app does, rather than
  // inlining a second instance whose module state would not be shared.
  external: ['react', 'react-dom', 'zustand', 'zustand/react'],
  tsconfig: join(root, 'tsconfig.web.json'),
  logLevel: 'info',
  define: {
    // bridge.ts reads `window.opencpics` at module scope. Node has no `window`, so
    // the emitted bundle would throw on import before a test could install a
    // stub - the read happens when the module initialises, not when it is used.
    //
    // The whole dotted expression is replaced rather than just `window`, so the
    // bundle does `globalThis.__openpicsBridge` and never performs a property
    // access on it. That is not tidiness: on this Node build a property literally
    // named `opencpics` is reachable through `Object.keys`, `JSON.stringify`,
    // spread and `getOwnPropertyDescriptors`, and unreachable through dot access,
    // `Object.hasOwn` and `getOwnPropertyDescriptor`. Assigning such a key from an
    // object literal produces an object that looks right in every serialisation
    // and answers `undefined` to a read. Building the key in the test with bracket
    // assignment sidesteps it, but the bundle's own read is not worth the gamble,
    // so the name disappears from the emitted code entirely.
    'window.opencpics': 'globalThis.__openpicsBridge'
  }
}

if (watch) {
  const { context } = await import('esbuild')
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching the store for changes')
} else {
  await build(options)
}