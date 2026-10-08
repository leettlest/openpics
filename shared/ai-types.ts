export type AiMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

/** Which view the assistant dock shows. Lives in the store, not the dock, so a
 * page switch that unmounts the dock does not reset it. */
export type AiDockTab = 'chat' | 'tags' | 'similar'

export type AiModelInfo = {
  path: string
  name: string
  sizeBytes?: number
}

export type AiState = {
  ready: boolean
  /** True when a bundled vision model is present, so attached photos are read. */
  visionReady: boolean
  modelPath: string | null
  modelName: string | null
  promptPath: string | null
  thinking: boolean
  lastError: string | null
}

export type AiChatTurn = {
  role: 'user' | 'assistant'
  content: string
}

/**
 * The conversation tail a request may carry.
 *
 * Twelve turns of unbounded length is still unbounded: pasted essays would grow
 * every request until the server silently truncates past its context window, and
 * the model would answer a question it only half received. So the tail has a
 * character budget too, and the newest turns win it - the latest question
 * matters more than the first.
 *
 * Lives here rather than in core/ai-wire.ts so the renderer can use it without
 * importing out of its layer: history is shaped where the question is asked.
 */
export function takeRecentHistory<T extends { content: string }>(
  turns: readonly T[],
  maxTurns = 12,
  maxChars = 6000
): T[] {
  const tail = turns.slice(-maxTurns)
  let chars = 0
  const kept: T[] = []
  for (let i = tail.length - 1; i >= 0; i--) {
    const turn = tail[i]!
    // The newest turn always survives, however long: dropping the question
    // being asked to protect the budget would be the worse failure.
    if (kept.length > 0 && chars + turn.content.length > maxChars) break
    chars += turn.content.length
    kept.unshift(turn)
  }
  return kept
}

/**
 * One entry of the library as the assistant sees it.
 *
 * This is a projection of `Photo`, not the whole record: the assistant needs the
 * name to search on and the path to act on, and nothing else. Sending the full
 * object for every item would make each message carry fields no tool reads.
 */
export type AiLibraryEntry = {
  name: string
  path: string
  kind: 'photo' | 'video'
  bytes: number
  mtime: number
  width: number
  height: number
}

/**
 * The whole-library aggregates, computed before the entry list is capped.
 *
 * These exist because a number derived from a truncated list is a lie the model
 * will repeat. `entries` stops at 2,000 so a 50,000-picture library stays cheap
 * to send, and anything counted over those 2,000 - pictures, clips, bytes, the
 * date range - is a fraction of the truth. The assistant read "pictures: 2000"
 * and told the user they had two thousand pictures.
 *
 * So the renderer, which holds the complete scan, reduces it to these five
 * numbers before slicing. They are about the whole library and are unaffected by
 * the cap. `libraryStats` prefers them and only falls back to counting entries
 * when they are absent, which keeps a snapshot from an older build working.
 */
export type AiLibraryTotals = {
  photos: number
  videos: number
  bytes: number
  /** Epoch ms of the oldest entry, or null when nothing carried a usable date. */
  oldest: number | null
  /** Epoch ms of the newest entry, or null. */
  newest: number | null
}

/**
 * The loaded library, sent alongside a question so tools can search it.
 *
 * The scan lives in the renderer, not in main, so a tool that wanted to search
 * the library would otherwise have to walk the disk again on every call. Sending
 * the names once per message keeps a search instant and reuses the scan the user
 * is already looking at.
 *
 * `entries` is capped. `total` is what the library really holds, `included` is
 * what was actually sent, and `totals` is the uncapped reduction - so a tool can
 * report the user's real picture count and still be honest that it can only
 * search the first `included` of them.
 */
export type AiLibrarySnapshot = {
  root: string
  total: number
  included: number
  entries: AiLibraryEntry[]
  /**
   * Whole-library counts, independent of the cap.
   *
   * Optional because a snapshot built before this field existed - or by a test
   * that only cares about search - should still be usable. Consumers fall back
   * to counting `entries` and accept that the answer is partial.
   */
  totals?: AiLibraryTotals
}

/**
 * What the assistant is doing right now, when the answer is not text yet.
 *
 * A tool call is otherwise invisible: the model emits a call, waits, and the reply
 * arrives seconds later with no sign anything happened. This is what the dock
 * shows in that gap.
 */
export type AiToolActivity = {
  name: string
  /** Short human phrasing, e.g. "Searching the library". */
  label: string
}

export type AiChatContext = {
  photoIds?: string[]
  paths?: string[]
  /** Prior turns, oldest first, so the model can follow the conversation. */
  history?: AiChatTurn[]
  /** The loaded library, so search tools work without re-scanning the disk. */
  library?: AiLibrarySnapshot
}

export type AiChatReply = {
  content: string
  /** True when the request was cancelled instead of answered. */
  cancelled?: boolean
}

/**
 * One streamed piece of a reply, tagged with the request it belongs to.
 *
 * Main can only send deltas down one channel, and a cancelled request can still
 * have a piece in flight when the next question starts. Without the tag, that
 * piece would land in the new answer; with it, the renderer can tell stale
 * pieces from current ones.
 */
export type AiChatDelta = {
  requestId: number
  delta: string
}

/** Same request tag for tool-activity gaps between streamed text. */
export type AiChatActivity = {
  requestId: number
  activity: AiToolActivity | null
}
