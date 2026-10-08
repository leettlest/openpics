/**
 * Windows path splitting, in one place.
 *
 * Three copies of this grew up apart - the store, the context menu and the AI
 * core each had their own - and copies of path code are where drive-root and
 * separator edge cases go to disagree. Everything here works on the string
 * alone, never touching the disk, so the renderer, main and the test build can
 * all import it.
 */

/** The file name at the end of a path, or the path itself when it has none. */
export function basenameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/**
 * The directory containing a path.
 *
 * Written out rather than imported from `node:path` because the renderer is
 * sandboxed and has no Node builtins. The rules here are only the ones Windows
 * paths actually follow: separators, trailing separators, and a drive root with
 * nothing after it.
 */
export function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (cut < 0) return trimmed
  // Keep the separator when what remains is a bare drive root like "C:".
  if (cut <= 2) return trimmed.slice(0, 3)
  return trimmed.slice(0, cut)
}
