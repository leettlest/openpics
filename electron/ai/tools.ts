/**
 * Running the assistant's tools.
 *
 * `core/ai-tools.ts` owns what each tool means; this owns the half that has to
 * touch Windows. The split is deliberate: the decisions worth testing - what
 * matches a search, whether a path is one of the user's own files - are pure and
 * live in core, while the shell calls that act on the system stay here where they
 * can be read in one place.
 *
 * Every tool that acts on a file takes its path from the library snapshot the
 * renderer sent with the question, or from the files the user explicitly selected
 * alongside it. A 0.5B model will invent a path now and then, and "set the
 * wallpaper" or "open this" must not become a way for a hallucinated string to
 * reach any file on the disk. Anything else is refused in as many words, which
 * the model then reads and can correct.
 */

import { shell } from 'electron'
import { listBin } from '../../core/recyclebin'
import { getWallpaper, setWallpaper, type WallpaperFit } from '../../core/wallpaper'
import {
  clampLimit,
  describeEntry,
  describeSearch,
  describeStats,
  findEntry,
  formatBytes,
  formatWhen,
  isAllowedPath,
  isSelectedPath,
  libraryStats,
  parseToolArguments,
  searchLibrary,
  toolLabel
} from '../../core/ai-tools'
import type { AiChatContext, AiLibrarySnapshot } from '../../shared/ai-types'
import { isVideoName } from '../../shared/video'

const WALLPAPER_FITS: WallpaperFit[] = ['fill', 'fit', 'stretch', 'center', 'tile', 'span']

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The text a tool hands back to the model.
 *
 * Errors are answers rather than exceptions. A tool that failed because a file
 * was locked is something the model can read and react to, and letting it throw
 * would replace a recoverable mistake with a red error in the dock.
 */
export async function runAiTool(
  name: string,
  rawArgs: string | null | undefined,
  context: AiChatContext | undefined
): Promise<string> {
  const args = parseToolArguments(rawArgs)
  const library: AiLibrarySnapshot | undefined = context?.library
  const selected: readonly string[] | undefined = context?.paths
  try {
    switch (name) {
      case 'photos_find': {
        const query = asString(args.query)
        const hit = searchLibrary(library, query, clampLimit(args.limit))
        return describeSearch(hit, query)
      }

      case 'photo_info': {
        const path = asString(args.path)
        const entry = findEntry(library, path)
        if (!entry) {
          // Selected but outside the snapshot: the user pointed at it, so it is
          // allowed, but there is no metadata to describe. Saying that plainly
          // beats inventing details the snapshot never contained.
          if (isSelectedPath(selected, path)) {
            return `${path} is selected but outside the loaded snapshot, so its size, dimensions and dates are unavailable. Only files in the snapshot have stored details.`
          }
          return notInLibrary(path, library)
        }
        return describeEntry(entry)
      }

      case 'library_stats': {
        const stats = libraryStats(library)
        if (stats.total === 0) return 'The library is empty, or nothing has been scanned yet.'
        return describeStats(stats)
      }

      case 'wallpaper_get': {
        const state = await getWallpaper()
        if (!state.path) return 'No picture is set as the desktop background.'
        return `path: ${state.path}\nfit: ${state.fit ?? 'unknown'}`
      }

      case 'wallpaper_set': {
        const path = asString(args.path)
        const entry = findEntry(library, path)
        if (!entry && !isSelectedPath(selected, path)) return notInLibrary(path, library)
        // A clip is a known library file and would pass the guard, but Windows
        // cannot tile it as a background, and the failure surfaces as a wallpaper
        // that silently did not change. Better to say which file will not work.
        // A selected path carries no metadata, so a video extension is the only
        // way to tell; the wallpaper call itself still reports real failures.
        if ((entry && entry.kind === 'video') || (!entry && isVideoName(path))) {
          const name = entry ? entry.name : path.split(/[\\/]/).pop() || path
          return `${name} is a clip, and Windows cannot use a video as a desktop background.`
        }
        const requested = asString(args.fit) as WallpaperFit
        const fit = WALLPAPER_FITS.includes(requested) ? requested : 'fill'
        const target = entry ? entry.path : path
        await setWallpaper(target, fit)
        return `Desktop background set to ${target} (${fit}).`
      }

      case 'bin_list': {
        const limit = clampLimit(args.limit)
        const entries = (await listBin())
          .sort((a, b) => b.deletedAt - a.deletedAt)
          .slice(0, limit)
        if (entries.length === 0) return 'The bin is empty.'
        const lines = entries.map(
          (entry) =>
            `- ${entry.originalName} (${formatBytes(entry.bytes)}, deleted ${formatWhen(entry.deletedAt)}, id ${entry.id})`
        )
        return `${entries.length} item${entries.length === 1 ? '' : 's'} in the bin:\n${lines.join('\n')}`
      }

      case 'reveal_in_folder': {
        const path = asString(args.path)
        if (!isAllowedPath(library, selected, path)) return notInLibrary(path, library)
        shell.showItemInFolder(path)
        return `Opened the folder containing ${path}.`
      }

      case 'open_file': {
        const path = asString(args.path)
        if (!isAllowedPath(library, selected, path)) return notInLibrary(path, library)
        const problem = await shell.openPath(path)
        if (problem !== '') return `Windows could not open ${path}: ${problem}`
        return `Opened ${path}.`
      }

      default:
        return `There is no tool called ${name}.`
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `The ${name} tool failed: ${detail}`
  }
}

/** The refusal every path-taking tool shares, worded so the model can recover. */
function notInLibrary(path: string, library: AiLibrarySnapshot | undefined): string {
  if (path.trim() === '') return 'No path was given. Use photos_find to look one up in the library first.'
  const included = library?.entries.length ?? 0
  const total = library?.total ?? included
  const scope =
    total > included
      ? ` It is neither in the ${included} loaded entries sent with this question (of ${total} total) nor among the files the user selected.`
      : ''
  return `${path} is not in the loaded library, so it was not touched.${scope} Use photos_find to find the file you mean and use the path it returns, or ask the user to select the file first.`
}

export { toolLabel }