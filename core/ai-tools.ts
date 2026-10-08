/**
 * The tools the bundled assistant can reach, and the parts of them that are pure.
 *
 * The dock's assistant used to be chat-only: it could read the photos you had
 * selected and nothing else, so anything about the wider library was guesswork.
 * These specs give it the small set of actions that make a photo browser feel
 * like a photo browser - search what is loaded, inspect an item, set a wallpaper,
 * look in the bin.
 *
 * Everything in this file is pure. `electron/ai/tools.ts` owns the half that has
 * to touch the system (the shell, the wallpaper API, the bin) and imports the
 * decisions made here, which is what keeps the matching and the path guard
 * testable without a running app.
 *
 * The tool names deliberately match the MCP server's where they overlap. An agent
 * driving OpenPics over MCP and the assistant inside the dock are then learning
 * one vocabulary rather than two.
 */

import type { AiLibraryEntry, AiLibrarySnapshot } from '../shared/ai-types'
import { normalizeToolCalls, type ChatMessage, type ToolCall } from './ai-wire'

/** OpenAI-style function schema, which is what llama-server's chat API accepts. */
export type AiToolSpec = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string; enum?: string[] }>
      required?: string[]
    }
  }
}

/**
 * What the dock shows while a tool runs.
 *
 * Keyed by tool name, so an unlabelled call cannot reach the user as an empty
 * status line: `toolLabel` falls back to the name rather than to nothing.
 */
const TOOL_LABELS: Record<string, string> = {
  photos_find: 'Searching the library',
  photo_info: 'Reading file details',
  library_stats: 'Counting the library',
  wallpaper_get: 'Reading the desktop background',
  wallpaper_set: 'Setting the desktop background',
  bin_list: 'Looking in the bin',
  reveal_in_folder: 'Opening the folder',
  open_file: 'Opening the file'
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Running ${name}`
}

/** The maximum a single search will return, whatever the model asks for. */
const MAX_RESULTS = 50
const DEFAULT_RESULTS = 20

export const AI_TOOL_SPECS: AiToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'photos_find',
      description:
        'Search the pictures and clips currently loaded in the library by file name. Use this whenever the user asks about their own library and you do not already know which file they mean. Leave query empty to get the most recently modified items.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Text to look for in file names, e.g. "sunset". Empty means most recent.'
          },
          limit: { type: 'integer', description: `How many results to return, up to ${MAX_RESULTS}.` }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'photo_info',
      description:
        'Get the stored details of one library item: kind, size on disk, dimensions, and when it was last changed. The path must be one returned by photos_find or already selected by the user.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path of a file in the library.' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'library_stats',
      description:
        'Count what is in the loaded library: how many pictures and clips, how much disk space they take, and the oldest and newest dates. Use this for questions like "how many photos do I have".',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wallpaper_get',
      description: 'Report which picture is currently set as the desktop background, and how it is fitted.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wallpaper_set',
      description:
        'Set one of the user\'s own pictures as the desktop background. The path must be one returned by photos_find or already selected by the user.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of a picture in the library.' },
          fit: {
            type: 'string',
            description: 'How the picture fills the screen.',
            enum: ['fill', 'fit', 'stretch', 'center', 'tile', 'span']
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bin_list',
      description:
        'List what was deleted through OpenPics and still sits in its bin, newest first. Each entry has an id that restore_bin accepts.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: `How many entries to return, up to ${MAX_RESULTS}.` }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reveal_in_folder',
      description:
        'Open Windows Explorer with one of the user\'s own files selected, for when they want to go and get it themselves. The path must be one returned by photos_find or already selected by the user.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path of a file in the library.' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_file',
      description:
        'Open one of the user\'s own pictures or clips in the default Windows application, the same as double-clicking it. The path must be one returned by photos_find or already selected by the user.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path of a file in the library.' } },
        required: ['path']
      }
    }
  }
]

/**
 * A tool call's arguments, as an object whatever arrived.
 *
 * Models get this wrong in both directions - JSON with trailing prose, a bare
 * string, nothing at all - so every failure lands on `{}` and the tool decides
 * whether it can work without arguments. A tool that threw here would surface as
 * an error to the user for what is really the model's formatting.
 */
export function parseToolArguments(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Fall through: an unparseable argument list is treated as no arguments.
  }
  return {}
}

export function clampLimit(value: unknown, fallback = DEFAULT_RESULTS): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(MAX_RESULTS, Math.max(1, Math.round(parsed)))
}

/** Windows paths compare case-insensitively; the model rarely matches our casing. */
function samePath(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export type LibrarySearch = {
  matches: AiLibraryEntry[]
  /** How many entries were actually searched. */
  searched: number
  /** How many the library really holds, which may be larger. */
  total: number
}

/**
 * Match library entries on file name.
 *
 * A substring rather than a pattern language, because the useful queries are
 * things like "sunset" or "IMG_2024" and a 0.5B model cannot be trusted to build
 * a glob. With no query the most recently changed items come back, which is what
 * "show me my recent photos" means.
 */
export function searchLibrary(
  snapshot: AiLibrarySnapshot | undefined,
  query: string,
  limit: number
): LibrarySearch {
  const entries = snapshot?.entries ?? []
  const needle = query.trim().toLowerCase()
  const matched = needle === ''
    ? entries.slice().sort((a, b) => b.mtime - a.mtime)
    : entries.filter((entry) => entry.name.toLowerCase().includes(needle))
  return {
    matches: matched.slice(0, limit),
    searched: entries.length,
    total: snapshot?.total ?? entries.length
  }
}

export function isKnownPath(snapshot: AiLibrarySnapshot | undefined, path: string): boolean {
  if (!snapshot || path.trim() === '') return false
  return snapshot.entries.some((entry) => samePath(entry.path, path))
}

/** The entry behind a path, matched case-insensitively. */
export function findEntry(
  snapshot: AiLibrarySnapshot | undefined,
  path: string
): AiLibraryEntry | undefined {
  return snapshot?.entries.find((entry) => samePath(entry.path, path))
}

/**
 * Whether the user explicitly selected this path alongside the current question.
 *
 * The snapshot is capped, so a selected file past the cap is one the user is
 * pointing at and the model still cannot see. Refusing it as "not in the
 * library" would contradict the photo_info spec, which already promises
 * selected files work. Selection is an explicit, per-question grant, so it is
 * safe to honor without weakening the guard against invented paths.
 */
export function isSelectedPath(selectedPaths: readonly string[] | undefined, path: string): boolean {
  if (!selectedPaths || path.trim() === '') return false
  return selectedPaths.some((candidate) => samePath(candidate, path))
}

/**
 * A path the assistant may act on: in the snapshot, or explicitly selected.
 *
 * Both halves are needed. The snapshot covers what the user loaded; selection
 * covers what they pointed at past the snapshot cap. Anything else is still
 * refused, which is the whole point of the guard.
 */
export function isAllowedPath(
  snapshot: AiLibrarySnapshot | undefined,
  selectedPaths: readonly string[] | undefined,
  path: string
): boolean {
  return isKnownPath(snapshot, path) || isSelectedPath(selectedPaths, path)
}

export type LibraryStats = {
  root: string
  photos: number
  videos: number
  /** How many entries were counted, which is less than `total` past the snapshot cap. */
  included: number
  total: number
  bytes: number
  oldest: number | null
  newest: number | null
}

export function libraryStats(snapshot: AiLibrarySnapshot | undefined): LibraryStats {
  const entries = snapshot?.entries ?? []

  // Reduced from `entries` only as a fallback. In a current snapshot the
  // renderer has already reduced the whole library into `totals`, because
  // anything counted over the capped list is a fraction of the user's actual
  // collection - and the assistant repeats these numbers back to them as fact.
  const counted = { photos: 0, videos: 0, bytes: 0, oldest: null as number | null, newest: null as number | null }
  for (const entry of entries) {
    if (entry.kind === 'video') counted.videos += 1
    else counted.photos += 1
    counted.bytes += entry.bytes
    if (entry.mtime > 0) {
      if (counted.oldest === null || entry.mtime < counted.oldest) counted.oldest = entry.mtime
      if (counted.newest === null || entry.mtime > counted.newest) counted.newest = entry.mtime
    }
  }

  const totals = snapshot?.totals
  return {
    root: snapshot?.root ?? '',
    photos: totals?.photos ?? counted.photos,
    videos: totals?.videos ?? counted.videos,
    bytes: totals?.bytes ?? counted.bytes,
    oldest: totals?.oldest ?? counted.oldest,
    newest: totals?.newest ?? counted.newest,
    /**
     * How much of the library is actually searchable.
     *
     * Separate from the counts above on purpose. `photos` and `total` describe
     * the collection as it really is; `included` bounds what `photos_find` can
     * reach, and the answer says so rather than letting the model imply a search
     * covered everything.
     */
    included: entries.length,
    total: snapshot?.total ?? entries.length
  }
}

/**
 * The stats as lines for the model.
 *
 * The counts are the user's real library, not the size of the part that was sent.
 * A model told "pictures: 2000" about fifty thousand pictures will tell the user
 * they have two thousand, and the user is the one who has to correct it.
 *
 * What *is* limited is search, and that is stated separately and in its own
 * terms, so the model can answer "how many pictures do I have" correctly and
 * still know not to promise a `photos_find` that reaches all of them.
 */
export function describeStats(stats: LibraryStats): string {
  const truncated = stats.included < stats.total
  const lines = [
    `root: ${stats.root || 'unknown'}`,
    `pictures: ${stats.photos}`,
    `clips: ${stats.videos}`,
    `items in library: ${stats.total}`,
    `size on disk: ${formatBytes(stats.bytes)}`,
    `oldest: ${formatWhen(stats.oldest)}`,
    `newest: ${formatWhen(stats.newest)}`
  ]
  if (truncated) {
    lines.push(
      `searchable: ${stats.included} of ${stats.total} - photos_find and photos_read can only reach those ${stats.included}, so a search that finds nothing may still have a match further down the list.`
    )
  }
  return lines.join('\n')
}

/** Short, readable sizes so the model is not handed raw byte counts to do sums on. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

export function formatWhen(epochMs: number | null): string {
  if (epochMs === null || epochMs <= 0) return 'unknown'
  return new Date(epochMs).toISOString().slice(0, 10)
}

/** One line per result, so a search reads as a list the model can reason about. */
export function describeSearch(hit: LibrarySearch, query: string): string {
  if (hit.matches.length === 0) {
    const scope = hit.searched < hit.total ? ` (searched ${hit.searched} of ${hit.total})` : ''
    return `No library items match ${JSON.stringify(query.trim())}${scope}.`
  }
  const lines = hit.matches.map((entry) => `- ${entry.name} (${entry.kind}) ${entry.path}`)
  const more = hit.total > hit.searched ? ` Searched ${hit.searched} of ${hit.total} loaded items.` : ''
  return `${hit.matches.length} match${hit.matches.length === 1 ? '' : 'es'}:\n${lines.join('\n')}${more}`
}

export function describeEntry(entry: AiLibraryEntry): string {
  const kind = entry.kind === 'video' ? 'clip' : 'picture'
  const dims = entry.width > 0 && entry.height > 0 ? `${entry.width}x${entry.height}` : 'unknown size'
  return [
    `${entry.name}`,
    `path: ${entry.path}`,
    `kind: ${kind}`,
    `size on disk: ${formatBytes(entry.bytes)}`,
    `dimensions: ${dims}`,
    `last changed: ${formatWhen(entry.mtime)}`
  ].join('\n')
}

/** One generation from the model: its text plus whatever tools it asked for. */
export type ToolLoopTurn = {
  text: string
  toolCalls: ToolCall[]
}

/**
 * The two impure halves of the tool loop, injected so the loop itself is pure.
 *
 * `generate` talks to the model; `act` touches the system. Everything between
 * them - the bound, the id repair, the history the next round sees - is decided
 * here, where a test can reach it without a server or a desktop.
 */
export type ToolLoopIO = {
  generate: (messages: ChatMessage[]) => Promise<ToolLoopTurn>
  act: (call: ToolCall) => Promise<string>
}

/**
 * Generate, run whatever was asked for, generate again - bounded.
 *
 * Every round is a whole generation on a small local model, so an unbounded loop
 * is a hang behind a spinner rather than a visible failure. `maxRounds` counts
 * rounds that run tools: a model that answers on round zero costs one generation
 * and no tools, and a model that never stops calling gets `maxRounds` tool rounds
 * plus one final generation before the loop gives up and says so.
 *
 * Calls and their results are appended to `messages` as they happen, so each
 * round sees the full conversation including what the tools returned.
 */
export async function runToolLoop(
  messages: ChatMessage[],
  maxRounds: number,
  io: ToolLoopIO
): Promise<{ reply: string; stopped: boolean }> {
  let reply = ''
  for (let round = 0; round <= maxRounds; round++) {
    const turn = await io.generate(messages)
    reply = turn.text
    if (turn.toolCalls.length === 0) return { reply, stopped: false }
    if (round === maxRounds) break
    // Ids are filled in before the assistant turn goes back, so the call and its
    // result carry the same one.
    const calls = normalizeToolCalls(turn.toolCalls, round)
    messages.push({ role: 'assistant', content: reply === '' ? null : reply, toolCalls: calls })
    for (const call of calls) {
      const output = await io.act(call)
      messages.push({ role: 'tool', toolCallId: call.id, content: output })
    }
  }
  return { reply, stopped: true }
}