import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { DEFAULT_SETTINGS, comparePhotos, type DriveInfo, type Photo, type ScanProgress, type ScanResult, type Settings, type SmartCollection, type SmartCollectionRule, type SortDir, type SortKey } from '@shared/protocol'
import { normalizeTags } from '@shared/ai-tags'
import { clampDockWidth } from '@shared/dock-width'
import { parentDir } from '@shared/paths'
import type { SimilarHit } from '@shared/ai-similar'
import type { AiDockTab, AiLibrarySnapshot, AiToolActivity } from '@shared/ai-types'
import { takeRecentHistory } from '@shared/ai-types'
import { bridge } from '@/lib/bridge'

export type ScanStatus = 'idle' | 'scanning' | 'ready' | 'error'

/**
 * How many photos one "tag selection" run will tag.
 *
 * Every photo is its own model call and the vision model costs seconds per
 * picture on a CPU, so a whole-library selection would look hung. The dock
 * states this number rather than a run quietly stopping short.
 */
export const AUTOTAG_LIMIT = 10

/** A photo paired with its position in the full library. */
export interface PhotoEntry {
  photo: Photo
  /** Index into `photos`, which is what selection, the viewer and the tray address. */
  index: number
}

interface LibraryState {
  settings: Settings
  raw: Photo[]
  photos: Photo[]
  /**
   * Library indices in display order: sorted, then narrowed by the filter. Every
   * consumer addresses photos through this list, so a filter can never make a
   * tile, the cursor and the viewer disagree about which photo is which.
   */
  visible: number[]
  status: ScanStatus
  error: string | null
  scanInfo: Omit<ScanResult, 'photos'> | null
  /** Live progress, present only while a scan is running. */
  progress: ScanProgress | null
  /** Drives found on the machine, for the computer-scan source. */
  drives: DriveInfo[]

  /** Index into `photos`, or null when the viewer is closed. */
  openIndex: number | null
  slideshowPlaying: boolean

  cursor: number
  anchor: number
  selected: Set<number>

  showInfo: boolean
  showShortcuts: boolean
  showSettings: boolean
  /** Creatives as a top-level page, next to the library rather than inside the dock. */
  showCreatives: boolean
  /** Whether the terminal drawer is showing. Its shells keep running when hidden. */
  terminalOpen: boolean
  query: string

  // Filters
  typeFilter: 'all' | 'image' | 'video'
  dateStart: number | null
  dateEnd: number | null
  sizeMin: number | null
  sizeMax: number | null
  cameraFilter: string
  tagFilter: string[]

  // Smart collections
  collections: SmartCollection[]
  activeCollectionId: string | null

  // AI
  aiDockExpanded: boolean
  aiDockWidth: number
  aiThinking: boolean
  /**
   * Identifies the latest chat request.
   *
   * Deltas arrive on one shared channel, so a piece from a stopped answer can
   * otherwise land in the next one. Every send and every stop moves this number,
   * and anything tagged with an older one is ignored.
   */
  aiRequestId: number
  /** What tool the assistant is running right now, or null between tools. */
  aiActivity: AiToolActivity | null
  aiModelReady: boolean
  aiVisionReady: boolean
  /** True while a batch of tags is being generated. */
  aiTagging: boolean
  /** Why the last tag run produced nothing, when it says so instead. */
  aiTagNote: string | null
  /** True while a similarity search is in flight. */
  aiSimilarBusy: boolean
  /** The last similarity search: the photo searched from and its hits. */
  aiSimilar: { path: string; results: SimilarHit[] } | null
  aiMessages: { role: 'user' | 'assistant'; content: string }[]
  photoTags: Map<string, string[]>
  exifCache: Map<string, unknown>

  /**
   * Counts the requests to open a picture straight into the editor.
   *
   * A counter rather than a boolean because asking for the same picture to be
   * opened and edited twice has to work: a flag the viewer cleared on the way in
   * would leave the second request with nothing left to read.
   */
  editRequest: number
  /** Clears the request once the viewer has acted on it. */
  clearEditRequest: () => void

  boot: () => Promise<void>
  rescan: () => Promise<void>
  pickFolder: () => Promise<void>
  /** Walks every drive on the machine, reporting progress into `progress`. */
  scanComputer: () => Promise<void>
  cancelScan: () => Promise<void>
  /** Shows the file Windows handed us and focuses its folder in the grid. */
  openFiles: (paths: string[]) => Promise<void>
  /** Re-points the library at a folder handed over on the command line. */
  openFolders: (folders: string[]) => Promise<void>
  patch: (patch: Partial<Settings>) => Promise<void>
  setSort: (key: SortKey) => void
  setQuery: (query: string) => void

  // Filters
  setTypeFilter: (type: 'all' | 'image' | 'video') => void
  setDateRange: (start: number | null, end: number | null) => void
  setSizeRange: (min: number | null, max: number | null) => void
  setCameraFilter: (camera: string) => void
  setTagFilter: (tags: string[]) => void
  clearAllFilters: () => void
  /** Caches EXIF already read. */
  setExif: (path: string, data: unknown) => void
  /** Reads EXIF once from main and caches it, for the Details panel. */
  loadExif: (path: string) => Promise<unknown>

  // Smart collections
  setActiveCollection: (id: string | null) => void
  addCollection: (name: string) => SmartCollection
  /** Creates a collection whose rules mirror the filters in force right now. */
  addCollectionFromFilters: (name: string) => SmartCollection
  removeCollection: (id: string) => void
  renameCollection: (id: string, name: string) => void

  select: (index: number, mode: 'replace' | 'toggle' | 'range') => void
  /** Selects every currently visible photo. */
  selectAll: () => void
  /** Flips selection across the visible photos. */
  invertSelection: () => void
  /** Clears the selection and drops the anchor. */
  clearSelection: () => void
  moveCursor: (delta: number, extend?: boolean) => void
  open: (index: number) => void
  /** Opens a picture and asks the viewer to start an edit session on it. */
  openForEdit: (index: number) => void
  close: () => void
  step: (delta: number) => void
  /**
   * Drops pictures that are no longer on disk.
   *
   * Selection, the cursor and the viewer are all indices, and every one of them
   * has to survive the removal rather than silently start pointing at whatever
   * photo slid into the old slot.
   */
  forgetPaths: (paths: readonly string[]) => void

  /**
   * Records what a clip turned out to actually be.
   *
   * The scan deliberately leaves a clip's width, height and duration at zero
   * because measuring them means an ffprobe run per file, and a whole-drive walk
   * would then be tens of thousands of child processes. The `<video>` element
   * learns all three numbers for free the moment the clip is opened, so it hands
   * them back here and the grid, the info panel and the sort order stop treating
   * it as a zero-sized unknown.
   *
   * Called once per clip per open. Writing it through the same `photos` array
   * `visible` is derived from keeps the grid tile in step without a re-scan, and
   * a second call for the same clip is a no-op by construction.
   */
  learnClip: (index: number, media: { width: number; height: number; durationSeconds: number }) => void

  setSlideshow: (playing: boolean) => void
  toggleSlideshow: () => void
  toggleInfo: () => void
  toggleShortcuts: () => void
  setShowSettings: (open: boolean) => void
  setShowCreatives: (open: boolean) => void
  setTerminalOpen: (open: boolean) => void
  toggleTerminal: () => void

  // AI dock
  toggleAi: () => void
  setAiDockExpanded: (expanded: boolean) => void
  setAiDockWidth: (width: number, viewportWidth?: number) => void
  /**
   * Opens the assistant from the outside (CLI `--chat`, tray): back to the
   * library, dock expanded, and a bump callers watch to select the chat tab.
   */
  openChat: () => void
  /** Counts `openChat` calls so the dock can react exactly once per request. */
  chatRequest: number
  sendAiMessage: (text: string) => Promise<void>
  /** Stops the in-flight answer and invalidates its remaining pieces. */
  cancelAiMessage: () => void
  /** Re-asks the last user question, discarding the failed answer after it. */
  retryAiMessage: () => void
  /** Which dock view is showing; stored so page switches keep it, not reset it. */
  aiDockTab: AiDockTab
  setAiDockTab: (tab: AiDockTab) => void
  /** The unsent composer text; stored so page switches keep it, not eat it. */
  aiDraft: string
  setAiDraft: (draft: string) => void
  appendAiDelta: (delta: string) => void
  /** Records which tool the assistant is running, or null when the gap is over. */
  setAiActivity: (activity: AiToolActivity | null) => void
  /** Merges tag suggestions into the per-photo map and persists them. */
  mergePhotoTags: (entries: Array<{ path: string; tags: string[] }>) => void
  /** Replaces the tags of one photo; an empty list removes them. */
  setPhotoTags: (path: string, tags: string[]) => void
  /** Suggests tags for the current selection; returns how many got a tag. */
  tagSelection: () => Promise<number>
  /** Finds photos in the current view that look like `path`. */
  findSimilar: (path: string) => Promise<void>
  clearSimilar: () => void
}

function sortPhotos(raw: Photo[], key: SortKey, dir: SortDir): Photo[] {
  return [...raw].sort((a, b) => comparePhotos(a, b, key, dir))
}

/**
 * How many library entries ride along with a question.
 *
 * The assistant's tools search this list rather than the disk. Main holds no scan
 * of its own, and re-walking a drive mid-answer would cost seconds on a large
 * library for a name lookup. A few thousand names is comfortably more than a
 * person can usefully ask about, and `included` is reported honestly so a tool
 * never claims to have searched a library it could not see.
 */
const AI_LIBRARY_ENTRIES = 2000

/**
 * The last snapshot handed to the assistant, and the library it was built from.
 *
 * Rebuilding 2,000 entries per question is waste for a library that has not
 * changed since the last one. The raw array identity only changes on a scan or
 * a deletion, so reusing the snapshot while it holds is exact, not approximate.
 */
let snapshotCache: { raw: Photo[]; root: string; snapshot: AiLibrarySnapshot } | null = null

function cachedLibrarySnapshot(state: {
  raw: Photo[]
  scanInfo: Omit<ScanResult, 'photos'> | null
}): AiLibrarySnapshot {
  const root = state.scanInfo?.root ?? ''
  if (snapshotCache && snapshotCache.raw === state.raw && snapshotCache.root === root) {
    return snapshotCache.snapshot
  }
  const snapshot = librarySnapshot(state)
  snapshotCache = { raw: state.raw, root, snapshot }
  return snapshot
}

function librarySnapshot(state: {
  raw: Photo[]
  scanInfo: Omit<ScanResult, 'photos'> | null
}): AiLibrarySnapshot {
  // Reduced over the whole library before the cap, because the assistant is told
  // these numbers as facts about the user's collection. Counting the 2,000
  // entries that get sent instead would report "pictures: 2000" for a library of
  // fifty thousand, and the user is the one who has to hear that.
  //
  // One pass over the full array, so this is O(n) on the entire library rather
  // than the slice - still far cheaper than sending the entries themselves, and
  // `cachedLibrarySnapshot` means it runs once per scan rather than per question.
  let photos = 0
  let videos = 0
  let bytes = 0
  let oldest: number | null = null
  let newest: number | null = null
  for (const photo of state.raw) {
    if (photo.kind === 'video') videos += 1
    else photos += 1
    bytes += photo.bytes
    if (photo.mtime > 0) {
      if (oldest === null || photo.mtime < oldest) oldest = photo.mtime
      if (newest === null || photo.mtime > newest) newest = photo.mtime
    }
  }

  return {
    root: state.scanInfo?.root ?? '',
    total: state.raw.length,
    included: Math.min(state.raw.length, AI_LIBRARY_ENTRIES),
    totals: { photos, videos, bytes, oldest, newest },
    entries: state.raw.slice(0, AI_LIBRARY_ENTRIES).map((photo) => ({
      name: photo.name,
      path: photo.path,
      kind: photo.kind,
      bytes: photo.bytes,
      mtime: photo.mtime,
      width: photo.width,
      height: photo.height
    }))
  }
}

/** Everything that narrows the library, combined with AND. */
export interface FilterCriteria {
  query: string
  typeFilter: 'all' | 'image' | 'video'
  dateStart: number | null
  dateEnd: number | null
  sizeMin: number | null
  sizeMax: number | null
  cameraFilter: string
  tagFilter: string[]
  /** Rules of the active smart collection, or null when none is active. */
  collectionRules: SmartCollectionRule[] | null
}

/** Pulls the filter slice out of the whole store state. */
function criteriaOf(state: LibraryState): FilterCriteria {
  const active = state.collections.find((c) => c.id === state.activeCollectionId && c.enabled)
  return {
    query: state.query,
    typeFilter: state.typeFilter,
    dateStart: state.dateStart,
    dateEnd: state.dateEnd,
    sizeMin: state.sizeMin,
    sizeMax: state.sizeMax,
    cameraFilter: state.cameraFilter,
    tagFilter: state.tagFilter,
    collectionRules: active ? active.rules : null
  }
}

/** True when any filter would hide something, so the UI can show an active count. */
export function activeFilterCount(state: LibraryState): number {
  let count = 0
  if (state.query.trim() !== '') count++
  if (state.typeFilter !== 'all') count++
  if (state.dateStart !== null || state.dateEnd !== null) count++
  if (state.sizeMin !== null || state.sizeMax !== null) count++
  if (state.cameraFilter.trim() !== '') count++
  if (state.tagFilter.length > 0) count++
  return count
}

/** Camera/model recorded for a path, when EXIF has been read. Empty otherwise. */
function cameraOf(cache: Map<string, unknown>, path: string): string {
  const entry = cache.get(path)
  if (entry && typeof entry === 'object') {
    const value = entry as { camera?: unknown; model?: unknown; Make?: unknown; Model?: unknown }
    for (const candidate of [value.camera, value.model, value.Make, value.Model]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
  }
  return ''
}

function matchesFilters(
  photo: Photo,
  filters: FilterCriteria,
  tags: Map<string, string[]>,
  exif: Map<string, unknown>
): boolean {
  const needle = filters.query.trim().toLowerCase()
  if (
    needle !== '' &&
    !photo.name.toLowerCase().includes(needle) &&
    !photo.relDir.toLowerCase().includes(needle)
  ) {
    return false
  }
  if (filters.typeFilter === 'image' && photo.kind !== 'photo') return false
  if (filters.typeFilter === 'video' && photo.kind !== 'video') return false
  if (filters.dateStart !== null && photo.mtime < filters.dateStart) return false
  if (filters.dateEnd !== null && photo.mtime > filters.dateEnd) return false
  if (filters.sizeMin !== null && photo.bytes < filters.sizeMin) return false
  if (filters.sizeMax !== null && photo.bytes > filters.sizeMax) return false
  const camera = filters.cameraFilter.trim().toLowerCase()
  if (camera !== '' && !cameraOf(exif, photo.path).toLowerCase().includes(camera)) return false
  if (filters.tagFilter.length > 0) {
    const owned = tags.get(photo.path) ?? []
    if (!filters.tagFilter.every((tag) => owned.includes(tag))) return false
  }
  if (filters.collectionRules && filters.collectionRules.length > 0) {
    if (!filters.collectionRules.every((rule) => matchesRule(photo, rule, tags, exif))) return false
  }
  return true
}

/** True when one smart-collection rule accepts a photo. Unknown fields reject. */
function matchesRule(
  photo: Photo,
  rule: SmartCollectionRule,
  tags: Map<string, string[]>,
  exif: Map<string, unknown>
): boolean {
  const value = rule.value
  switch (rule.field) {
    case 'tag': {
      const owned = tags.get(photo.path) ?? []
      const wanted = String(value)
      const has = owned.includes(wanted)
      return rule.op === 'neq' ? !has : has
    }
    case 'camera':
    case 'cameraMake':
    case 'cameraModel': {
      const camera = cameraOf(exif, photo.path).toLowerCase()
      const wanted = String(value).toLowerCase()
      if (rule.op === 'contains') return camera.includes(wanted)
      if (rule.op === 'neq') return camera !== wanted
      return camera === wanted
    }
    case 'name': {
      const name = photo.name.toLowerCase()
      const wanted = String(value).toLowerCase()
      if (rule.op === 'contains') return name.includes(wanted)
      if (rule.op === 'neq') return name !== wanted
      return name === wanted
    }
    case 'type': {
      const kind = photo.kind
      const wanted = String(value) === 'image' ? 'photo' : String(value)
      return rule.op === 'neq' ? kind !== wanted : kind === wanted
    }
    case 'orientation': {
      const orientation =
        photo.width > photo.height
          ? 'landscape'
          : photo.width < photo.height
            ? 'portrait'
            : 'square'
      return rule.op === 'neq' ? orientation !== String(value) : orientation === String(value)
    }
    case 'date': {
      if (rule.op === 'between' && Array.isArray(value)) {
        return photo.mtime >= value[0] && photo.mtime <= value[1]
      }
      const wanted = Number(value)
      if (rule.op === 'gte') return photo.mtime >= wanted
      if (rule.op === 'lte') return photo.mtime <= wanted
      if (rule.op === 'neq') return photo.mtime !== wanted
      return photo.mtime === wanted
    }
    case 'size': {
      if (rule.op === 'between' && Array.isArray(value)) {
        return photo.bytes >= value[0] && photo.bytes <= value[1]
      }
      const wanted = Number(value)
      if (rule.op === 'gte') return photo.bytes >= wanted
      if (rule.op === 'lte') return photo.bytes <= wanted
      if (rule.op === 'neq') return photo.bytes !== wanted
      return photo.bytes === wanted
    }
    default:
      return false
  }
}

function visibleIndices(
  photos: Photo[],
  filters: FilterCriteria,
  tags: Map<string, string[]>,
  exif: Map<string, unknown>
): number[] {
  const out: number[] = []
  for (let index = 0; index < photos.length; index++) {
    if (matchesFilters(photos[index]!, filters, tags, exif)) out.push(index)
  }
  return out
}

const initial: Settings = { ...DEFAULT_SETTINGS }

/**
 * Monotonic id of the most recently started scan.
 *
 * A walk takes seconds, and a second one can begin before the first resolves:
 * opening a file from Windows re-points the library, and the user can hit rescan
 * again mid-walk. Without a token the slower scan would land last and overwrite
 * the newer result, so a stale result is dropped instead.
 */
let scanGeneration = 0

/** The scan currently in flight, so a caller can wait for the library to settle. */
let pendingScan: Promise<void> | null = null

/**
 * Runs `run` as the active scan, recording it as in flight for its duration.
 *
 * Every scan goes through here so `pendingScan` cannot drift out of sync with
 * `scanGeneration`: the two are only ever assigned together.
 */
function beginScan(run: () => Promise<void>): Promise<void> {
  const promise = run().finally(() => {
    if (pendingScan === promise) pendingScan = null
  })
  pendingScan = promise
  return promise
}

type StoreGet = () => LibraryState
type StoreSet = (partial: Partial<LibraryState>) => void

/**
 * Applies a filter change and re-derives everything that depends on the filter.
 *
 * Cursor, anchor and selection are all library indices, so narrowing the set can
 * leave any of them pointing at a photo the grid no longer shows. Recomputing the
 * visible list first and then settling each reference is what keeps a tile, the
 * cursor and the viewer from disagreeing about which picture is which.
 */
function applyFilterChange(
  get: StoreGet,
  set: StoreSet,
  patch: Partial<FilterCriteria>
): void {
  const state = get()
  const criteria: FilterCriteria = { ...criteriaOf(state), ...patch }
  const visible = visibleIndices(state.photos, criteria, state.photoTags, state.exifCache)
  const keepsCursor = visible.includes(state.cursor)
  set({
    ...patch,
    visible,
    cursor: keepsCursor ? state.cursor : (visible[0] ?? -1),
    anchor: -1,
    selected: new Set()
  })
}

/**
 * Commits a finished scan, unless a newer one has already started.
 *
 * Shared by both modes so the reset that follows a completed walk is identical:
 * any scan replaces the whole library, which means selection, cursor and the
 * viewer are all addressed against indices that no longer mean what they did.
 */
function applyScanResult(
  get: StoreGet,
  set: StoreSet,
  result: Omit<ScanResult, 'photos'> & { photos: Photo[] },
  generation: number
): void {
  if (generation !== scanGeneration) return
  const { photos: raw, ...rest } = result
  const { settings } = get()
  const photos = sortPhotos(raw, settings.sortKey, settings.sortDir)
  // A new walk replaces the library, so per-file EXIF reads from the old one are
  // pruned to what still exists: keeping entries for deleted files would serve
  // stale metadata. Tags are deliberately left alone - they are the user's own
  // data, and switching folders must not erase them.
  const alive = new Set(raw.map((photo) => photo.path))
  const exifCache = new Map<string, unknown>()
  for (const [path, data] of get().exifCache) {
    if (alive.has(path)) exifCache.set(path, data)
  }
  const photoTags = get().photoTags
  set({
    raw,
    photos,
    visible: visibleIndices(photos, criteriaOf(get()), photoTags, exifCache),
    exifCache,
    photoTags,
    status: 'ready',
    error: null,
    // Computer mode walks every drive, so there is no single root to report; the
    // list is the meaningful part and `root` falls back to the first one.
    scanInfo: { ...rest, root: result.root || result.roots?.[0] || '' },
    cursor: -1,
    anchor: -1,
    selected: new Set(),
    openIndex: null,
    slideshowPlaying: false
  })
}

export const useLibrary = create<LibraryState>((set, get) => ({
  settings: initial,
  raw: [],
  photos: [],
  visible: [],
  status: 'idle',
  error: null,
  scanInfo: null,
  progress: null,
  drives: [],

  openIndex: null,
  slideshowPlaying: false,

  cursor: -1,
  anchor: -1,
  selected: new Set(),

  showInfo: false,
  showShortcuts: false,
  showSettings: false,
  showCreatives: false,
  terminalOpen: false,
  query: '',

  typeFilter: 'all',
  dateStart: null,
  dateEnd: null,
  sizeMin: null,
  sizeMax: null,
  cameraFilter: '',
  tagFilter: [],

  collections: [],
  activeCollectionId: null,

  aiDockExpanded: initial.aiDockExpanded ?? true,
  aiDockWidth: initial.aiDockWidth ?? 360,
  aiDockTab: 'chat',
  aiDraft: '',
  chatRequest: 0,
  aiThinking: false,
  aiRequestId: 0,
  aiActivity: null,
  aiModelReady: false,
  aiVisionReady: false,
  aiTagging: false,
  aiTagNote: null,
  aiSimilarBusy: false,
  aiSimilar: null,
  aiMessages: [],
  photoTags: new Map(),
  exifCache: new Map(),

  editRequest: 0,

  clearEditRequest() {
    if (get().editRequest !== 0) set({ editRequest: 0 })
  },

  async boot() {
    const settings = await bridge.settings.get()
    set({
      settings,
      collections: settings.aiCollections ?? [],
      // Tags live in settings so they survive a restart; the Map is the shape the
      // filter and the dock read, so it is rebuilt once here.
      photoTags: new Map(Object.entries(settings.aiTags ?? {}))
    })
    // Probing 26 drive letters is cheap, and knowing what is attached before the
    // user reaches for the button avoids a "no drives" surprise.
    const drives = await bridge.library.drives()
    set({ drives })
    // Knowing whether a model is installed lets the dock tell the truth about
    // why it cannot answer, instead of failing on the first message.
    void bridge.ai
      .init()
      .then((ai) => set({ aiModelReady: ai.ready, aiVisionReady: ai.visionReady }))
      .catch(() => set({ aiModelReady: false, aiVisionReady: false }))
    // The persisted mode is the source the user last chose, so a machine left on
    // "This PC" has to come back up scanning drives rather than a stale folder.
    const scan = get().settings.scanMode === 'computer' ? get().scanComputer : get().rescan
    // Not awaited. On a cold start from "Open with", the file hand-off resolves
    // and calls `patch`, which starts a scan of the file's own folder; awaiting
    // here would make the hand-off wait on a scan whose result is about to be
    // thrown away, delaying the file the user actually asked to see.
    void scan()
  },

  async rescan() {
    return beginScan(async () => {
      const { settings } = get()
      const generation = ++scanGeneration
      // Same subscription as the computer walk, for the same reason: a deep
      // folder on a slow disk is not visibly different from a hang.
      const stop = bridge.library.onScanProgress((progress) => {
        if (progress.running && generation === scanGeneration) set({ progress })
      })
      set({ status: 'scanning', error: null, progress: null })
      try {
        const { root, photos: raw, ...rest } = await bridge.library.scan(
          settings.root,
          settings.recursive
        )
        applyScanResult(get, set, { ...rest, root, photos: raw }, generation)
      } catch (err) {
        if (generation !== scanGeneration) return
        set({
          status: 'error',
          error: err instanceof Error ? err.message : 'The folder could not be read.'
        })
      } finally {
        stop?.()
        if (generation === scanGeneration) set({ progress: null })
      }
    })
  },

  async scanComputer() {
    return beginScan(async () => {
      // Subscribed here rather than at module scope: a listener registered once
      // and never torn down leaks across hot reloads, and the progress channel is
      // only meaningful while a walk is actually running.
      const generation = ++scanGeneration
      const stop = bridge.library.onScanProgress((progress) => {
        // A progress event from a superseded walk would show the wrong numbers
        // over the scan the user is actually watching.
        if (progress.running && generation === scanGeneration) set({ progress })
      })
      set({ status: 'scanning', error: null, progress: null })
      try {
        const { root, photos: raw, ...rest } = await bridge.library.scanComputer()
        applyScanResult(get, set, { ...rest, root, photos: raw }, generation)
      } catch (err) {
        if (generation !== scanGeneration) return
        set({
          status: 'error',
          error: err instanceof Error ? err.message : 'This PC could not be scanned.'
        })
      } finally {
        stop?.()
        if (generation === scanGeneration) set({ progress: null })
      }
    })
  },

  async cancelScan() {
    await bridge.library.cancelScan()
  },

  async openFiles(paths) {
    if (paths.length === 0) return
    const first = paths[0]!
    const folder = parentDir(first)
    // The file may sit outside the current library, in computer mode or in
    // another folder entirely. Re-pointing at its folder and rescanning is what
    // guarantees the photo is actually in `photos` when it is opened.
    const { settings } = get()
    const needsRescan = settings.root !== folder || settings.scanMode !== 'folder'
    if (needsRescan) {
      await get().patch({ root: folder, scanMode: 'folder' })
    }
    // A scan started before this hand-off, such as the one `boot()` kicks off,
    // would otherwise land after the selection is made and clear it. Waiting
    // here costs nothing when the library is already settled.
    if (pendingScan) await pendingScan
    const { photos } = get()
    const wanted = new Set(paths.map((p) => p.toLowerCase()))
    const indices = photos
      .map((photo, index) => ({ photo, index }))
      .filter(({ photo }) => wanted.has(photo.path.toLowerCase()))
      .map(({ index }) => index)
    if (indices.length === 0) return
    const selected = new Set<number>(indices)
    set({ selected, cursor: indices[0]!, anchor: indices[0]!, openIndex: indices[0]! })
  },

  async openFolders(folders) {
    // A folder on the command line is the user choosing a source, the same as
    // picking one in the folder dialog. The first wins when several arrive:
    // the library has one root, and silently scanning one of several folders
    // would be a worse surprise than saying which one was taken.
    const folder = folders.find((entry) => entry.trim() !== '')
    if (!folder) return
    const { settings } = get()
    if (settings.root === folder && settings.scanMode === 'folder') return
    await get().patch({ root: folder, scanMode: 'folder' })
  },

  async pickFolder() {
    const result = await bridge.library.pick()
    if (result.canceled || !result.path) return
    // Choosing a folder is itself the choice of source. Without the explicit
    // mode, a user coming from "This PC" would pick a folder and watch a
    // whole-machine scan run instead of seeing what they just selected.
    await get().patch({ root: result.path, scanMode: 'folder' })
  },

  async patch(patch) {
    const settings = await bridge.settings.patch(patch)
    const state = get()
    const sortChanged = patch.sortKey !== undefined || patch.sortDir !== undefined
    const photos = sortChanged
      ? sortPhotos(state.raw, settings.sortKey, settings.sortDir)
      : state.photos
    const collections = patch.aiCollections !== undefined ? (settings.aiCollections ?? []) : state.collections
    const photoTags =
      patch.aiTags !== undefined ? new Map(Object.entries(settings.aiTags ?? {})) : state.photoTags
    const activeCollectionId =
      state.activeCollectionId !== null && collections.some((c) => c.id === state.activeCollectionId)
        ? state.activeCollectionId
        : null
    const criteria = { ...criteriaOf(state), collectionRules: collections.find((c) => c.id === activeCollectionId && c.enabled)?.rules ?? null }
    // Only re-filter when the inputs to filtering actually changed. `visible` is
    // stored state rather than a derived selector, so recomputing it here rebuilt
    // the whole thing on every settings patch - and `patch` is the funnel for
    // collapsing the AI dock, resizing it, opening the chat, editing a collection
    // name. Each of those ran an O(n) pass over the library, allocated a new
    // `visible`, and invalidated `useVisibleEntries`, which allocates a fresh
    // entry object per photo and so re-ran `layoutJustified` over everything.
    // Collapsing the dock is a single click and was costing a full relayout.
    //
    // The inputs are: the sort (which reorders, so the index list changes), the
    // tags a rule can match on, and a collection's rules. Everything else in a
    // patch - dock width, expanded, slideshow interval, theme - cannot change
    // which photos match.
    const filterInputsChanged = sortChanged || patch.aiTags !== undefined || patch.aiCollections !== undefined
    const visible = filterInputsChanged
      ? visibleIndices(photos, criteria, photoTags, state.exifCache)
      : state.visible
    // Reordering the sort changes what an index means, so `visible` cannot keep
    // the old list even when nothing about membership was filtered differently -
    // it is a list of positions into `photos`, and those positions have moved.
    // `moved` is built either way because the cursor remap below needs it.
    // Sorting reorders the same photos rather than replacing them, so cursor,
    // selection and viewer references follow their photos instead of staying at
    // stale positions. Paths identify the photo because the set did not change.
    const moved = new Map(photos.map((photo, index) => [photo.path, index] as const))
    const remapIndex = (index: number): number => {
      if (index < 0) return -1
      const photo = state.photos[index]
      if (!photo) return -1
      return moved.get(photo.path) ?? -1
    }
    const selected = new Set<number>()
    for (const index of state.selected) {
      const found = remapIndex(index)
      if (found >= 0) selected.add(found)
    }
    set({
      settings,
      collections,
      activeCollectionId,
      photos,
      photoTags,
      visible,
      cursor: remapIndex(state.cursor),
      anchor: remapIndex(state.anchor),
      selected,
      openIndex: state.openIndex === null ? null : remapIndex(state.openIndex)
    })
    // Which source and how deep to walk both decide what exists on disk, so any
    // change to them has to re-read from disk rather than relabel the old set.
    if (patch.root !== undefined || patch.recursive !== undefined || patch.scanMode !== undefined) {
      if (settings.scanMode === 'computer') {
        await get().scanComputer()
      } else {
        await get().rescan()
      }
    }
  },

  setSort(key) {
    const { settings } = get()
    // Clicking the active key flips direction, which is what a sortable header should do.
    const dir: SortDir =
      settings.sortKey === key ? (settings.sortDir === 'asc' ? 'desc' : 'asc') : 'asc'
    void get().patch({ sortKey: key, sortDir: dir })
  },

  setQuery(query) {
    applyFilterChange(get, set, { query })
  },

  setTypeFilter(typeFilter) {
    applyFilterChange(get, set, { typeFilter })
  },

  setDateRange(dateStart, dateEnd) {
    applyFilterChange(get, set, { dateStart, dateEnd })
  },

  setSizeRange(sizeMin, sizeMax) {
    applyFilterChange(get, set, { sizeMin, sizeMax })
  },

  setCameraFilter(cameraFilter) {
    applyFilterChange(get, set, { cameraFilter })
  },

  setTagFilter(tagFilter) {
    applyFilterChange(get, set, { tagFilter })
  },

  clearAllFilters() {
    applyFilterChange(get, set, {
      query: '',
      typeFilter: 'all',
      dateStart: null,
      dateEnd: null,
      sizeMin: null,
      sizeMax: null,
      cameraFilter: '',
      tagFilter: []
    })
  },

  /**
   * Records one picture's EXIF and refreshes the view if that can change what
   * matches a camera filter or collection rule.
   *
   * Read `state` once, after any await, and derive both writes from that single
   * snapshot. Building the new Map from a pre-await read instead loses updates
   * when two reads overlap - which is easy to trigger by expanding EXIF on one
   * picture and then another before the first returns: both take the same base
   * Map, and whichever writes second erases the other's entry, so that picture
   * silently re-reads from disk on the next expand.
   *
   * Exported because the MCP and the dock read cached metadata too; the store
   * itself is the only thing that may write it.
   */
  setExif(path, data) {
    const state = get()
    const exifCache = new Map(state.exifCache).set(path, data)
    const cameraRuleActive =
      state.cameraFilter.trim() !== '' ||
      state.collections.some(
        (c) => c.enabled && c.id === state.activeCollectionId && c.rules.some((r) => r.field.startsWith('camera'))
      )
    if (!cameraRuleActive) {
      set({ exifCache })
      return
    }
    // A newly known camera can change what matches, so the view is recomputed -
    // but from the map that is about to be stored, not from the pre-write one,
    // so the recompute sees the value it is being done for.
    set({
      exifCache,
      visible: visibleIndices(state.photos, criteriaOf(state), state.photoTags, exifCache)
    })
  },

  async loadExif(path) {
    const cached = get().exifCache.get(path)
    if (cached !== undefined) return cached
    const data = await bridge.library.exif(path)
    // Re-read the store *after* the await, so a second read that landed first is
    // carried forward rather than overwritten by this one.
    get().setExif(path, data)
    return data
  },

  setActiveCollection(id) {
    set({ activeCollectionId: id })
    applyFilterChange(get, set, {})
  },

  addCollection(name) {
    const collection: SmartCollection = {
      id: `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim() || 'Untitled collection',
      rules: [],
      enabled: true
    }
    const collections = [...get().collections, collection]
    set({ collections })
    void get().patch({ aiCollections: collections })
    return collection
  },

  addCollectionFromFilters(name) {
    const state = get()
    const rules: SmartCollectionRule[] = []
    if (state.typeFilter !== 'all') rules.push({ field: 'type', op: 'eq', value: state.typeFilter })
    if (state.dateStart !== null) rules.push({ field: 'date', op: 'gte', value: state.dateStart })
    if (state.dateEnd !== null) rules.push({ field: 'date', op: 'lte', value: state.dateEnd })
    if (state.sizeMin !== null) rules.push({ field: 'size', op: 'gte', value: state.sizeMin })
    if (state.sizeMax !== null) rules.push({ field: 'size', op: 'lte', value: state.sizeMax })
    if (state.cameraFilter.trim() !== '') {
      rules.push({ field: 'camera', op: 'contains', value: state.cameraFilter.trim() })
    }
    for (const tag of state.tagFilter) rules.push({ field: 'tag', op: 'eq', value: tag })
    if (state.query.trim() !== '') rules.push({ field: 'name', op: 'contains', value: state.query.trim() })
    const collection: SmartCollection = {
      id: `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim() || 'Untitled collection',
      rules,
      enabled: true
    }
    const collections = [...state.collections, collection]
    set({ collections, activeCollectionId: collection.id })
    void get().patch({ aiCollections: collections })
    applyFilterChange(get, set, {})
    return collection
  },

  removeCollection(id) {
    const collections = get().collections.filter((c) => c.id !== id)
    set({
      collections,
      activeCollectionId: get().activeCollectionId === id ? null : get().activeCollectionId
    })
    void get().patch({ aiCollections: collections })
    applyFilterChange(get, set, {})
  },

  renameCollection(id, name) {
    const trimmed = name.trim()
    if (trimmed === '') return
    const collections = get().collections.map((c) => (c.id === id ? { ...c, name: trimmed } : c))
    set({ collections })
    void get().patch({ aiCollections: collections })
  },

  select(index, mode) {
    const { photos, anchor } = get()
    if (index < 0 || index >= photos.length) return
    const selected = new Set<number>()
    if (mode === 'replace') {
      selected.add(index)
    } else if (mode === 'toggle') {
      const current = get().selected
      for (const i of current) selected.add(i)
      if (current.has(index)) selected.delete(index)
      else selected.add(index)
    } else {
      // Range walks `visible`, not library indices. Walking the raw span would
      // sweep in every filtered-out photo between the two endpoints, and the
      // selection bar hands `selected` straight to the Recycle Bin with no
      // second look - so a shift-click under a filter could bin thousands of
      // pictures nobody ever saw. `visible` is ascending, so the anchors can be
      // resolved by position and the span taken between them.
      const { visible } = get()
      const from = anchor < 0 ? index : anchor
      const startAt = visible.indexOf(from)
      const endAt = visible.indexOf(index)
      if (startAt < 0 || endAt < 0) {
        // One endpoint is filtered out, so there is no row range to describe.
        // Taking just the clicked tile is the only honest answer available.
        selected.add(index)
      } else {
        const lo = Math.min(startAt, endAt)
        const hi = Math.max(startAt, endAt)
        for (let i = lo; i <= hi; i++) {
          const member = visible[i]
          if (member !== undefined) selected.add(member)
        }
      }
    }
    set({ cursor: index, anchor: mode === 'range' ? anchor : index, selected })
  },

  selectAll() {
    const { visible, cursor } = get()
    set({
      selected: new Set(visible),
      anchor: -1,
      cursor: visible.includes(cursor) ? cursor : (visible[0] ?? -1)
    })
  },

  invertSelection() {
    const { visible, selected } = get()
    const next = new Set<number>()
    for (const index of visible) {
      if (!selected.has(index)) next.add(index)
    }
    set({ selected: next, anchor: -1 })
  },

  clearSelection() {
    if (get().selected.size === 0 && get().anchor === -1) return
    set({ selected: new Set(), anchor: -1 })
  },

  moveCursor(delta, extend = false) {
    const { visible, cursor } = get()
    if (visible.length === 0) return
    const at = visible.indexOf(cursor)
    const from = at >= 0 ? at : delta > 0 ? -1 : visible.length
    const next = Math.min(visible.length - 1, Math.max(0, from + delta))
    get().select(visible[next]!, extend ? 'range' : 'replace')
  },

  open(index) {
    if (index < 0) return
    set({ openIndex: index, slideshowPlaying: false })
  },

  openForEdit(index) {
    const { photos } = get()
    if (index < 0 || index >= photos.length) return
    // A clip has no picture to edit, and the viewer's editor is built for stills.
    if (photos[index]?.kind !== 'photo') return
    get().open(index)
    set({ editRequest: get().editRequest + 1 })
  },

  close() {
    set({ openIndex: null, slideshowPlaying: false, showInfo: false })
  },

  forgetPaths(paths) {
    if (paths.length === 0) return
    const { raw, photos, cursor, anchor, selected, openIndex } = get()
    // Windows compares paths without regard to case, so this has to as well. A
    // mismatch here would leave a deleted file sitting in the grid forever.
    const gone = new Set(paths.map((path) => path.toLowerCase()))
    const keep = (list: Photo[]): Photo[] => list.filter((photo) => !gone.has(photo.path.toLowerCase()))
    const nextPhotos = keep(photos)
    const nextRaw = keep(raw)
    if (nextPhotos.length === photos.length) return

    /**
     * Where each surviving photo ended up.
     *
     * Built from the photo's own path rather than by counting removals, so a
     * path the caller did not mention cannot shift an index that matters.
     */
    const moved = new Map<string, number>()
    nextPhotos.forEach((photo, index) => moved.set(photo.path, index))
    const remap = (path: string | undefined): number =>
      path === undefined ? -1 : (moved.get(path) ?? -1)

    /**
     * Keeps an index meaningful after the list it points into has shrunk.
     *
     * A surviving photo keeps pointing at itself; one that was deleted falls back
     * to the nearest photo still standing, which is the row the user is now
     * looking at anyway.
     */
    const settle = (index: number): number => {
      if (index < 0) return -1
      const survived = remap(photos[index]?.path)
      if (survived >= 0) return survived
      for (let i = index; i < photos.length; i++) {
        const found = remap(photos[i]?.path)
        if (found >= 0) return found
      }
      for (let i = index - 1; i >= 0; i--) {
        const found = remap(photos[i]?.path)
        if (found >= 0) return found
      }
      return -1
    }

    const nextSelected = new Set<number>()
    for (const index of selected) {
      const found = remap(photos[index]?.path)
      if (found >= 0) nextSelected.add(found)
    }

    /**
     * What to do with the viewer, given the file it was showing.
     *
     * If the open file was deleted, the viewer has to close: it would be showing
     * bytes that are gone, and any editor session belongs to those bytes. If the
     * open file survived, the viewer stays open but has to follow it to its new
     * index, or deleting some *other* picture in the same row would silently swap
     * the viewer onto a different one.
     */
    const viewer =
      openIndex === null
        ? {}
        : remap(photos[openIndex]?.path) < 0
          ? { openIndex: null, slideshowPlaying: false, showInfo: false }
          : { openIndex: remap(photos[openIndex]?.path) }

    // EXIF reads for deleted files go with them. Tags stay: they are user data,
    // and the settings record keeps them for a file that comes back.
    const exifCache = new Map<string, unknown>()
    for (const [path, data] of get().exifCache) {
      if (!gone.has(path.toLowerCase())) exifCache.set(path, data)
    }

    set({
      raw: nextRaw,
      photos: nextPhotos,
      visible: visibleIndices(nextPhotos, criteriaOf(get()), get().photoTags, exifCache),
      exifCache,
      cursor: settle(cursor),
      anchor: settle(anchor),
      selected: nextSelected,
      ...viewer
    })
  },

  step(delta) {
    const { photos, openIndex, visible } = get()
    if (photos.length === 0) return
    const from = openIndex ?? get().cursor
    if (from < 0) return
    // Navigate the same set the grid shows, so a filtered library never
    // advances into a photo the user cannot see.
    const order = visible.length > 0 ? visible : photos.map((_, index) => index)
    const at = order.indexOf(from)
    const next = at < 0 ? order[0]! : order[(at + delta + order.length) % order.length]!
    set({ openIndex: next, cursor: next, anchor: next, selected: new Set([next]) })
  },

  learnClip(index, media) {
    const { photos, raw } = get()
    const current = photos[index]
    // A failed or zero-length read leaves the item exactly as the scan wrote it,
    // which is better than storing a width of 0 next to a real duration.
    if (!current || current.kind !== 'video') return
    if (media.width <= 0 || media.height <= 0) return
    // `raw` is written too, not just `photos`. Changing the sort re-derives
    // `photos` from `raw`, so a measurement kept only in `photos` was thrown
    // away on the next sort change and every clip fell back to the scan's
    // width and height of 0 - which is the whole state this call exists to
    // avoid. `photos` is written directly because re-sorting here would move
    // the item the caller just measured out from under `index`.
    const nextPhotos = [...photos]
    nextPhotos[index] = { ...current, ...media }
    const rawIndex = raw.findIndex((item) => item.path === current.path)
    if (rawIndex < 0) {
      set({ photos: nextPhotos })
      return
    }
    const nextRaw = [...raw]
    nextRaw[rawIndex] = { ...raw[rawIndex]!, ...media }
    set({ photos: nextPhotos, raw: nextRaw })
  },

  setSlideshow(playing) {
    set({ slideshowPlaying: playing })
  },

  toggleSlideshow() {
    const { openIndex, slideshowPlaying } = get()
    if (openIndex === null) {
      const { cursor, visible } = get()
      const start = visible.includes(cursor) ? cursor : (visible[0] ?? -1)
      if (start < 0) return
      get().select(start, 'replace')
      set({ openIndex: start, slideshowPlaying: true })
      return
    }
    set({ slideshowPlaying: !slideshowPlaying })
  },

  toggleInfo() {
    const { openIndex, showInfo, cursor, visible } = get()
    if (openIndex === null) {
      // Asked for details from the grid, so open the picture being asked about.
      const target = visible.includes(cursor) ? cursor : (visible[0] ?? -1)
      if (target < 0) return
      get().select(target, 'replace')
      set({ openIndex: target, showInfo: true, slideshowPlaying: false })
      return
    }
    set({ showInfo: !showInfo })
  },

  toggleShortcuts() {
    set({ showShortcuts: !get().showShortcuts })
  },

  // Settings and Creatives are both full pages, so only one can be showing. Each
  // close is written into the other rather than left to whoever renders them,
  // which keeps the two flags from ever disagreeing about what is on screen.
  setShowSettings(open) {
    // Opening a full page unmounts the viewer, so close it explicitly. Leaving
    // its index behind would resurrect the viewer when the library returns.
    set(open ? { showSettings: true, showCreatives: false, openIndex: null, slideshowPlaying: false, showInfo: false } : { showSettings: false })
  },

  setShowCreatives(open) {
    set(open ? { showCreatives: true, showSettings: false, openIndex: null, slideshowPlaying: false, showInfo: false } : { showCreatives: false })
  },

  setTerminalOpen(open) {
    set({ terminalOpen: open })
  },

  toggleTerminal() {
    set({ terminalOpen: !get().terminalOpen })
  },

  // One flag for the dock. It used to be mirrored into a second `aiOpen` that
  // nothing read, which meant two sources of truth for one panel and a collapse
  // that could be undone by whichever one was written last.
  toggleAi() {
    const next = !get().aiDockExpanded
    set({ aiDockExpanded: next })
    void get().patch({ aiDockExpanded: next })
  },

  setAiDockExpanded(expanded) {
    set({ aiDockExpanded: expanded })
    void get().patch({ aiDockExpanded: expanded })
  },

  openChat() {
    // A chat request answered behind the viewer or a settings page is no answer
    // at all, so this always lands back on the library with the dock expanded.
    // The tab switch and composer focus happen in the dock, which watches
    // `chatRequest` - it owns both, and it may not even be mounted right now.
    set({
      showSettings: false,
      showCreatives: false,
      openIndex: null,
      slideshowPlaying: false,
      showInfo: false,
      aiDockExpanded: true,
      chatRequest: get().chatRequest + 1
    })
    void get().patch({ aiDockExpanded: true })
  },

  setAiDockWidth(width, viewportWidth?) {
    // A drag commits an explicit width for the viewport it happened in. When the
    // viewport is known, the shared clamp keeps the persisted preference inside
    // the same rule the screen uses; when it is not known, keep the historical
    // 240-720 clamp so older callers do not change behavior.
    const clamped =
      viewportWidth === undefined
        ? Math.min(720, Math.max(240, Math.round(width)))
        : clampDockWidth(width, viewportWidth)
    set({ aiDockWidth: clamped })
    void get().patch({ aiDockWidth: clamped })
  },

  appendAiDelta(delta) {
    if (delta === '') return
    set((current) => {
      const messages = current.aiMessages.slice()
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content: last.content + delta }
      } else {
        messages.push({ role: 'assistant', content: delta })
      }
      return { aiMessages: messages }
    })
  },

  setAiActivity(activity) {
    set({ aiActivity: activity })
  },

  async sendAiMessage(text) {
    const message = text.trim()
    if (message === '') return
    const state = get()
    // The dock disables its send button while thinking, but two submits can still
    // arrive before React re-renders. Checking the store synchronously here is
    // what makes the second one a no-op instead of a second interleaved stream.
    if (state.aiThinking) return
    const requestId = state.aiRequestId + 1
    // Only pictures are sent: main can decode those into the vision request, and
    // the note about the selection should not promise the model saw a video.
    const paths = Array.from(state.selected)
      .map((index) => state.photos[index])
      .filter((photo): photo is NonNullable<typeof photo> => photo?.kind === 'photo')
      .map((photo) => photo.path)
    const history = takeRecentHistory(
      state.aiMessages.map((turn) => ({ role: turn.role, content: turn.content }))
    )
    set({
      aiRequestId: requestId,
      aiMessages: [
        ...state.aiMessages,
        { role: 'user', content: message },
        { role: 'assistant', content: '' }
      ],
      aiThinking: true,
      aiActivity: null
    })
    const current = (): boolean => get().aiRequestId === requestId
    try {
      const reply = await bridge.ai.chat(message, { paths, history, library: cachedLibrarySnapshot(state) }, requestId)
      // A newer send or an explicit stop has taken over since this request left.
      // Landing its ending here would overwrite whatever the user asked next.
      if (!current()) return
      if (reply.cancelled) {
        set((stale) => {
          const messages = stale.aiMessages.slice()
          const last = messages[messages.length - 1]
          if (last && last.role === 'assistant' && last.content === '') {
            messages[messages.length - 1] = { ...last, content: 'Stopped.' }
          }
          return { aiMessages: messages, aiThinking: false, aiActivity: null }
        })
        return
      }
      set((stale) => {
        const messages = stale.aiMessages.slice()
        const last = messages[messages.length - 1]
        if (last && last.role === 'assistant') {
          messages[messages.length - 1] = {
            ...last,
            content: reply.content || last.content || 'The model returned nothing.'
          }
        }
        return { aiMessages: messages, aiThinking: false }
      })
    } catch (error) {
      if (!current()) return
      const detail = error instanceof Error ? error.message : String(error)
      set((stale) => {
        const messages = stale.aiMessages.slice()
        const last = messages[messages.length - 1]
        const note = `Error: ${detail}`
        if (last && last.role === 'assistant' && last.content === '') {
          messages[messages.length - 1] = { ...last, content: note }
        } else {
          messages.push({ role: 'assistant', content: note })
        }
        return { aiMessages: messages, aiThinking: false }
      })
    }
  },

  cancelAiMessage() {
    const state = get()
    if (!state.aiThinking) return
    const cancelledId = state.aiRequestId
    // Invalidate first, then tell main to stop: anything already on its way back
    // carries the old ID and is ignored, so stopping cannot corrupt the next
    // answer the user starts immediately afterwards.
    set((current) => {
      const messages = current.aiMessages.slice()
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.content === '') {
        messages[messages.length - 1] = { ...last, content: 'Stopped.' }
      }
      return { aiRequestId: cancelledId + 1, aiMessages: messages, aiThinking: false, aiActivity: null }
    })
    void bridge.ai.cancel(cancelledId).catch(() => {})
  },

  retryAiMessage() {
    const state = get()
    if (state.aiThinking) return
    // Walk back to the last thing the user asked: anything after it - a failed
    // answer, a stopped one - is discarded, and the question goes again
    // unchanged through the normal send path.
    let at = state.aiMessages.length - 1
    while (at >= 0 && state.aiMessages[at]!.role !== 'user') at--
    if (at < 0) return
    const text = state.aiMessages[at]!.content
    set({ aiMessages: state.aiMessages.slice(0, at) })
    void get().sendAiMessage(text)
  },

  setAiDockTab(tab) {
    set({ aiDockTab: tab })
  },

  setAiDraft(draft) {
    set({ aiDraft: draft })
  },

  mergePhotoTags(entries) {
    if (entries.length === 0) return
    const next = new Map(get().photoTags)
    for (const entry of entries) {
      const tags = normalizeTags(entry.tags)
      if (tags.length === 0) next.delete(entry.path)
      else next.set(entry.path, tags)
    }
    // The map is set before the patch so `patch` recomputes `visible` against the
    // new tags, letting a tag filter or a tag rule pick them up in one render.
    set({ photoTags: next })
    void get().patch({ aiTags: Object.fromEntries(next) })
  },

  setPhotoTags(path, tags) {
    get().mergePhotoTags([{ path, tags }])
  },

  async tagSelection() {
    const state = get()
    const targets = Array.from(state.selected)
      .map((index) => state.photos[index])
      .filter((photo): photo is Photo => photo !== undefined)
      .slice(0, AUTOTAG_LIMIT)
      .map((photo) => ({ id: photo.path, path: photo.path }))
    if (targets.length === 0) return 0
    set({ aiTagging: true, aiTagNote: null })
    try {
      const results = await bridge.ai.autotag(targets)
      get().mergePhotoTags(results.map((result) => ({ path: result.photoId, tags: result.tags })))
      return results.filter((result) => result.tags.length > 0).length
    } catch (error) {
      // A refusal (agent tools blocked) and a real failure both used to read as
      // "0 tagged" with no explanation. The note says which one it was.
      const detail = error instanceof Error ? error.message : String(error)
      set({ aiTagNote: detail })
      return 0
    } finally {
      set({ aiTagging: false })
    }
  },

  async findSimilar(path) {
    const state = get()
    const candidates = state.visible
      .map((index) => state.photos[index]?.path)
      .filter((candidate): candidate is string => Boolean(candidate))
    if (path === '' || candidates.length < 2) {
      set({ aiSimilar: null })
      return
    }
    set({ aiSimilarBusy: true })
    try {
      const results = await bridge.ai.similar(path, candidates)
      set({ aiSimilar: { path, results } })
    } catch {
      set({ aiSimilar: null })
    } finally {
      set({ aiSimilarBusy: false })
    }
  },

  clearSimilar() {
    set({ aiSimilar: null })
  }
}))

/**
 * Wires Windows' file hand-off into the store, once for the life of the window.
 *
 * Returns nothing and renders nothing; it exists to own the subscription so the
 * listener is not re-registered on every render of the component that calls it.
 */
export function useOpenFilesSubscription(): void {
  useEffect(() => {
    // No handshake to send here. Preload holds a file that arrives before this
    // effect exists and flushes it as soon as the listener is attached, and main
    // queues anything that arrives before the renderer is loaded at all. The
    // overlap those two buffers cover is why `openFiles` can await the boot scan
    // rather than racing it.
    return bridge.library.onOpenFiles((paths) => {
      void useLibrary.getState().openFiles(paths)
    })
  }, [])
}

/**
 * Streams AI reply pieces into whatever assistant message is on screen.
 *
 * Owned here so the listener lives for the life of the window rather than being
 * re-registered whenever the dock re-renders.
 */
export function useAiDeltaSubscription(): void {
  useEffect(() => {
    return bridge.ai.onDelta((update) => {
      const state = useLibrary.getState()
      if (update.requestId !== state.aiRequestId) return
      state.appendAiDelta(update.delta)
    })
  }, [])
}

/**
 * Which tool the assistant is running, for the stretch of a reply where no text
 * is arriving.
 *
 * A search takes seconds and produces nothing to stream, so without this the dock
 * sits on "Thinking…" while the model works and the user cannot tell a slow tool
 * from a stuck one.
 */
export function useAiToolSubscription(): void {
  useEffect(() => {
    return bridge.ai.onTool((update) => {
      const state = useLibrary.getState()
      if (update.requestId !== state.aiRequestId) return
      state.setAiActivity(update.activity)
    })
  }, [])
}

/**
 * Opens the assistant on an outside request, for the life of the window.
 *
 * Owned here rather than in the dock because the dock unmounts on the Settings
 * and Creatives pages: a `--chat` that arrives there still has to land on the
 * library first, which only the store can do.
 */
export function useOpenChatSubscription(): void {
  useEffect(() => {
    return bridge.onOpenChat(() => {
      useLibrary.getState().openChat()
    })
  }, [])
}

/**
 * Re-points the library at a command-line folder, for the life of the window.
 *
 * Owned here next to the files subscription for the same reason: the listener
 * has to exist from the first paint, whatever page is showing.
 */
export function useOpenFoldersSubscription(): void {
  useEffect(() => {
    return bridge.library.onOpenFolders((folders) => {
      void useLibrary.getState().openFolders(folders)
    })
  }, [])
}

export function useVisibleEntries(): PhotoEntry[] {
  const photos = useLibrary((s) => s.photos)
  const visible = useLibrary((s) => s.visible)
  return useMemo(
    () => visible.map((index) => ({ photo: photos[index]!, index })),
    [photos, visible]
  )
}