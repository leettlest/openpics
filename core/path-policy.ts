/**
 * Path authorisation for the agent-facing surface.
 *
 * The desktop app is its own trust boundary: the renderer picks a folder, and
 * everything it asks for is under it. An MCP server has no such boundary. It
 * accepts absolute paths from a language model, and among the tools it exposes
 * are permanent delete, overwrite, `shell.openPath` and a registry write. So the
 * server needs to decide for itself what a model may name.
 *
 * The decision made here, and it is a decision rather than a technicality:
 *
 *   **An agent may only touch paths inside the library the app currently has
 *   open, plus its own data directory.**
 *
 * That is the same trust the desktop thumbnail protocol already extends - see
 * `isAllowed` in electron/thumbs.ts, which pins its roots on every scan - so
 * enabling the switch does not quietly widen what the app can reach. It does mean
 * an agent cannot be pointed at a folder the user has not opened in the app
 * first, which is the intended consequence: the library is the consent surface.
 *
 * Three rules make the containment real rather than apparent:
 *
 *   1. Both sides are `resolve`d, so `..`, `.`, doubled separators and mixed
 *      slashes cannot walk out of a permitted root. Comparing strings before
 *      resolving would let `C:\photos\..\..\Windows` pass a `C:\photos` check.
 *   2. The comparison is case-insensitive, because Windows paths are.
 *   3. The prefix test appends a separator to the root, so a root of
 *      `C:\photos` does not admit `C:\photos-private`. This is the mistake a
 *      plain `startsWith` makes and it is the reason the boundary is written out
 *      rather than left to a reader.
 *
 * UNC paths are refused outright rather than compared. A `\\host\share` target is
 * a machine the user's own filesystem says nothing about, and resolving it
 * depends on network state the caller controls, so "is this inside the library"
 * is not a question that can be answered honestly about one.
 */

import { isAbsolute, resolve, sep } from 'node:path'
import { dataDir, dataFile, readJson } from './datadir'

/**
 * The roots an agent may act within.
 *
 * `explicit` is for tests and for a caller that knows its own scope;
 * `includeDataDir` is the app's own state directory, which is always permitted
 * because the drawing, settings and tag tools have to write there and it holds
 * nothing the user considers theirs.
 */
export interface PathPolicy {
  /** Directories to permit in addition to the data directory. */
  explicit?: readonly string[]
  /** Whether the app's own data directory is permitted. Default true. */
  includeDataDir?: boolean
}

/** A refusal, with the reason, so the message can say why rather than just no. */
export class PathRefused extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(message)
    this.name = 'PathRefused'
    this.path = path
  }
}

/**
 * Canonical form used for every comparison.
 *
 * `resolve` does the real work - collapsing `..` against the filesystem root -
 * and the rest is Windows normalisation: one separator style, no trailing
 * separator, lower case. A trailing separator is stripped because a root and the
 * same root written with a trailing backslash must not compare as different.
 */
export function canonicalPath(input: string): string {
  const slashed = input.replace(/\//g, sep)
  const trimmed = slashed.replace(/[\\]+$/, '')
  const resolved = resolve(trimmed.length === 0 ? slashed : trimmed)
  return /^[a-zA-Z]:/.test(resolved) || resolved.startsWith(sep)
    ? resolved.toLowerCase()
    : resolved
}

/** True when `candidate` is `root` itself or something underneath it. */
export function isWithinRoot(candidate: string, root: string): boolean {
  const c = canonicalPath(candidate)
  const r = canonicalPath(root)
  // A root of `C:\` canonicalises to `C:` once the trailing separator goes, so
  // the drive root is spelled back out before it can be used as a prefix.
  const prefix = r.endsWith(':') ? `${r}${sep}` : `${r}${sep}`
  return c === r || c.startsWith(prefix)
}

/**
 * The library root the application currently has open, if any.
 *
 * Read per call rather than cached, for the reason `mcpEnabled` gives: this
 * server can outlive the window by hours, and a root cached at startup would
 * authorise against a library the user has since changed. An absent or
 * unreadable settings file yields `null`, which permits nothing - see
 * `assertPathAllowed`.
 */
export function libraryRootFromSettings(settings: { root?: unknown; scanMode?: unknown }): string | null {
  // "This PC" is not one folder, so there is no single root to name. Rather than
  // inventing a rule for a machine-wide scan, the agent is confined to the data
  // directory and has to use `photos_find` to work outward from it. Choosing to
  // permit everything here would be the one change that makes the other controls
  // decorative.
  if (settings.scanMode === 'computer') return null
  const root = settings.root
  return typeof root === 'string' && root.trim() !== '' ? root : null
}

/**
 * Refuses a path that is not inside a permitted root.
 *
 * Throws `PathRefused`, which `guard` turns into a tool error. Returns the
 * canonical path on success so the caller can work with the resolved form rather
 * than re-resolving the raw input later.
 */
export function assertPathAllowed(path: string, policy: PathPolicy = {}): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new PathRefused('a path is required', String(path))
  }
  if (!isAbsolute(path)) {
    throw new PathRefused(
      `path must be absolute: ${JSON.stringify(path)}. Relative paths are refused because what they resolve against is not the caller's decision to make.`,
      path
    )
  }
  // Refused before resolution because resolution cannot answer it: a UNC target
  // is a machine, and `realpathSync` would either hang on an unreachable host or
  // answer about a share the user never agreed to expose.
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    throw new PathRefused(
      `network paths are refused: ${JSON.stringify(path)}. Open the folder in OpenPics first if the pictures live on a share.`,
      path
    )
  }

  const roots: string[] = []
  if (policy.includeDataDir !== false) roots.push(dataDir())
  const libraryRoot = libraryRootFromSettings(readSettings())
  if (libraryRoot !== null) roots.push(libraryRoot)
  for (const extra of policy.explicit ?? []) roots.push(extra)

  const canonical = canonicalPath(path)
  for (const root of roots) {
    if (isWithinRoot(canonical, root)) return canonical
  }

  // Naming the permitted roots is what makes this actionable. An agent that has
  // been refused can look again; one that has only been told "no" cannot.
  const permitted = roots.map((r) => canonicalPath(r)).join(', ')
  throw new PathRefused(
    `${JSON.stringify(path)} is outside the library OpenPics has open. ` +
      (permitted === ''
        ? 'No library is open, so no path is permitted.'
        : `Permitted: ${permitted}. `) +
      'Open the folder in OpenPics first.',
    path
  )
}

/** The same check, for a list, where every entry has to pass. */
export function assertPathsAllowed(paths: readonly string[], policy: PathPolicy = {}): void {
  for (const path of paths) assertPathAllowed(path, policy)
}

/** Convenience for `photos_find`-style directory arguments. */
export function assertDirectoryAllowed(path: string, policy: PathPolicy = {}): string {
  return assertPathAllowed(path, policy)
}

/**
 * A tiny reader, kept local so this module has no dependency on the settings
 * module's own shape and so a test can point it at a fixture via the data dir
 * override that `dataDir` already honours.
 */
function readSettings(): { root?: unknown; scanMode?: unknown } {
  try {
    // A static import rather than a lazy `require`, so the module graph is
    // honest. The comment that used to justify the `require` said a missing
    // import would surface as "no library" instead of a crash, which was true
    // and also wrong: `datadir` is a dependency of this file in every build
    // that produces it, so a missing module could only mean a broken install -
    // not the empty-settings case this read is actually here to handle. A static
    // import makes that a load-time failure, which is louder and more accurate,
    // and leaves the `catch` below doing the one job it was written for.
    return readJson<{ root?: unknown; scanMode?: unknown }>(dataFile('settings.json'), {})
  } catch {
    return {}
  }
}