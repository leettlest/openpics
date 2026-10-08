/**
 * Tests for the renderer store, `src/store/library.ts`.
 *
 * This file exists because two of the defects fixed this session were only
 * reproducible here. Every other suite in this repo exercises `core/`,
 * `electron/` or the MCP server over a real child process; the store was covered
 * by nothing, and it holds the two that mattered most:
 *
 *   - a range selection that walked library indices instead of the visible list,
 *     so a shift-click under a filter selected - and could then bin - every photo
 *     filtered out between the two endpoints;
 *   - a settings patch that recomputed `visible` unconditionally, so collapsing
 *     the AI dock re-filtered the whole library and invalidated the grid layout.
 *
 * `photos_find` on the MCP server and `photos.deselect` here are the same class
 * of bug in the same shape, which is why both are pinned.
 *
 * The store is bundled rather than typechecked-and-imported: `tsc` leaves the
 * `@/` and `@shared/` aliases in the emitted JavaScript, which Node cannot
 * resolve. `scripts/build-store.mjs` runs esbuild over it instead, with `zustand`
 * and `react` left external so the test drives the same module instance the app
 * would.
 *
 * Run `npm run build:store` first, or use `npm test`, which does.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, 'dist-test', 'store', 'library.mjs')
if (!existsSync(BUNDLE)) {
  console.error(`the store is not built: ${BUNDLE}\nrun "npm run build:store" first, or use "npm test".`)
  process.exit(1)
}

/* ------------------------------------------------------------------ stub */

/**
 * The slice of the preload bridge the store actually calls.
 *
 * A recording stub rather than a mock library: these tests are about what the
 * store *asked for*, so each call is appended to a log the assertions read back.
 * That is what makes "patching the dock width did not re-filter" a claim about
 * behaviour rather than about implementation shape.
 */
const calls = []

/** Every library snapshot handed to the assistant, in order. */
const aiChatContexts = []
/** Set per test to control what settings.patch resolves to. */
let settingsPatchResult = null

function record(name) {
  return (...args) => {
    calls.push({ name, args })
  }
}

const subscriptions = {
  onCommand: () => () => {},
  onOpenFiles: () => () => {},
  onOpenFolders: () => () => {},
  onAiDelta: () => () => {},
  onAiTool: () => () => {},
  onOpenChat: () => () => {},
  onCreativesChanged: () => () => {},
  onTerminalData: () => () => {},
  onTerminalExit: () => () => {},
  onScanProgress: () => () => {}
}

const settingsBase = {
  theme: 'dark',
  root: '',
  recursive: false,
  scanMode: 'folder',
  rowHeight: 160,
  slideIntervalMs: 4000,
  sortKey: 'name',
  sortDir: 'asc',
  terminalHeight: 200,
  enableMcp: false,
  aiEnabled: true,
  aiDockExpanded: true,
  aiDockWidth: 360,
  aiTags: {},
  aiCollections: []
}

/**
 * The stub, installed on the global the build points at.
 *
 * `scripts/build-store.mjs` rewrites `window.opencpics` to this name, because
 * `bridge.ts` reads the bridge at module scope and Node has no `window` - so
 * without the rewrite the bundle throws on import, before any of this runs.
 *
 * Assigned here, before the dynamic import at the end of the preamble, which is
 * what the module-scope read picks up. The value is the bridge object itself
 * rather than `{ openpics: bridge }`: a property named `opencpics` on this Node
 * build is visible to `Object.keys` and `JSON.stringify` but answers `undefined`
 * to a dot read, so building the bundle against a name that behaves is cheaper
 * than fighting it.
 */
globalThis.__openpicsBridge = {
    settings: {
      get: async () => ({ ...settingsBase }),
      patch: async (patch) => {
        calls.push({ name: 'settings.patch', args: [patch] })
        settingsPatchResult = { ...(settingsPatchResult ?? settingsBase), ...patch }
        return settingsPatchResult
      }
    },
    library: {
      defaultRoot: record('library.defaultRoot'),
      pick: record('library.pick'),
      scan: async () => ({ root: '', photos: [], unreadable: 0, skippedDirs: 0, ms: 0, truncated: false, roots: [] }),
      drives: async () => [],
      scanComputer: async () => ({ root: '', photos: [], unreadable: 0, skippedDirs: 0, ms: 0, truncated: false, roots: [] }),
      cancelScan: record('library.cancelScan'),
      onScanProgress: subscriptions.onScanProgress,
      onOpenFiles: subscriptions.onOpenFiles,
      onOpenFolders: subscriptions.onOpenFolders,
      exif: async () => ({}),
      thumbStats: async () => ({ memory: 0, disk: 0 }),
      rendererReady: record('library.rendererReady')
    },
    ai: {
      init: async () => ({ ready: false, visionReady: false, models: [] }),
      state: async () => ({ ready: false }),
      chat: async (_message, context) => {
    // Captured so the library snapshot the assistant is actually handed can be
    // inspected. Without this the counts it reports are unverifiable from here.
    if (context && context.library) aiChatContexts.push(context.library)
    return { content: '', cancelled: false }
  },
      cancel: record('ai.cancel'),
      autotag: async () => ({ tagged: 0, notes: [] }),
      similar: async () => ({ hits: [] })
    },
    shell: {
      open: record('shell.open'),
      reveal: record('shell.reveal'),
      sendToBin: async () => [],
      openUrl: record('shell.openUrl'),
      fileAssociations: async () => false,
      setFileAssociations: async () => false
    },
    wallpaper: { get: async () => ({ path: '', fit: 'fill' }), set: record('wallpaper.set') },
    win: {
      hide: record('win.hide'),
      show: record('win.show'),
      minimize: record('win.minimize'),
      isFullscreen: async () => false,
      setFullscreen: record('win.setFullscreen'),
      quit: record('win.quit'),
      state: async () => ({ visible: true, fullscreen: false, maximized: false }),
      toggleMaximize: record('win.toggleMaximize'),
      setAlwaysOnTop: record('win.setAlwaysOnTop'),
      isAlwaysOnTop: async () => false
    },
    edit: {
      open: async () => ({ id: 'edit-1', width: 60, height: 40, removed: 0, softened: 0 }),
      cutoutAuto: async () => ({ info: {}, reference: [0, 0, 0] }),
      brush: async () => ({}),
      selection: async () => ({}),
      output: async () => ({}),
      undo: async () => ({}),
      redo: async () => ({}),
      history: async () => ({ canUndo: false, canRedo: false, recent: [] }),
      preview: async () => ({}),
      apply: async () => ({ path: 'out.png', bytes: 1 }),
      inspect: async () => ({}),
      reset: async () => ({}),
      close: async () => ({})
    },
    terminal: {
      available: async () => false,
      create: record('terminal.create'),
      attach: record('terminal.attach'),
      write: record('terminal.write'),
      resize: record('terminal.resize'),
      kill: record('terminal.kill'),
      onData: subscriptions.onTerminalData,
      onExit: subscriptions.onTerminalExit
    },
    creatives: { load: async () => null, save: record('creatives.save') },
    video: {
      probe: async () => ({}),
      trim: record('video.trim'),
      split: record('video.split'),
      concat: record('video.concat'),
      frame: record('video.frame'),
      addons: async () => []
    },
    addons: { list: async () => [], refresh: record('addons.refresh') },
    onCommand: subscriptions.onCommand,
    onCreativesChanged: subscriptions.onCreativesChanged,
    onOpenChat: subscriptions.onOpenChat,
    onAiDelta: subscriptions.onAiDelta,
    onAiTool: subscriptions.onAiTool
}

/* ------------------------------------------------------------- test rig */

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) } else {
    fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
  }
}
function section(title) { console.log(`\n== ${title}`) }

// Through a file:// URL rather than a bare path: on Windows a path like `C:\...`
// reaches Node's ESM loader as a URL with the scheme `c:`, which it refuses.
const { useLibrary } = await import(pathToFileURL(BUNDLE).href)

/** A photo whose name and folder make it easy to assert about. */
function photo(index, extra = {}) {
  return {
    path: `C:\\pics\\${String(index).padStart(3, '0')}.jpg`,
    name: `${String(index).padStart(3, '0')}.jpg`,
    ext: 'jpg',
    kind: 'photo',
    bytes: 1000 + index,
    mtime: 1_700_000_000_000 + index,
    width: 600,
    height: 400,
    durationSeconds: 0,
    relDir: '',
    ...extra
  }
}

/** Puts the library into a known state. `raw` and the sorted `photos` are set together. */
function seed(count, extra = {}) {
  const raw = Array.from({ length: count }, (_, i) => photo(i))
  useLibrary.setState({
    raw,
    photos: raw,
    visible: raw.map((_, i) => i),
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
    selected: new Set(),
    anchor: -1,
    cursor: -1,
    openIndex: null,
    scanInfo: { root: 'C:\\pics', photos: raw, unreadable: 0, skippedDirs: 0, ms: 1, truncated: false },
    photoTags: new Map(),
    exifCache: new Map(),
    settings: { ...settingsBase },
    ...extra
  })
}

/* ========================================================================== */

section('range selection stays inside the filter')

// The defect: with a query active, shift-clicking two visible tiles walked the
// library indices between them, so every filtered-out photo in that span joined
// the selection - and the selection bar feeds `selected` straight to the bin.
seed(50)
useLibrary.getState().setQuery('01')
// "01" matches 010..019 plus the 01 in 001..009, so visible is a known subset.
const visible = useLibrary.getState().visible
check('the query actually filters something', visible.length < 50 && visible.length > 1, `visible=${visible.length}`)

const first = visible[0]
const last = visible[visible.length - 1]
useLibrary.getState().select(first, 'replace')
useLibrary.getState().select(last, 'range')
const ranged = useLibrary.getState().selected

const hidden = [...ranged].filter((index) => !visible.includes(index))
check('a range selects only what is visible', hidden.length === 0, `swept in ${hidden.length} hidden: ${hidden.slice(0, 8)}`)
check('the range covers every visible photo between the ends', ranged.size === visible.length, `got ${ranged.size}, expected ${visible.length}`)

// The range that walks raw indices is exactly what would have binned the rest.
const rawSpan = last - first + 1
check('the old behaviour would have selected far more than this', rawSpan > ranged.size, `raw span=${rawSpan}, fixed=${ranged.size}`)

section('range selection covers the whole visible set with no filter')

seed(30)
useLibrary.getState().select(3, 'replace')
useLibrary.getState().select(11, 'range')
check('an unfiltered range is contiguous', useLibrary.getState().selected.size === 9, `got ${useLibrary.getState().selected.size}`)
check('the range runs to the high index', useLibrary.getState().selected.has(11))

section('a reverse range selects the same set')

seed(30)
useLibrary.getState().select(11, 'replace')
useLibrary.getState().select(3, 'range')
check('clicking backwards covers the same span', useLibrary.getState().selected.size === 9, `got ${useLibrary.getState().selected.size}`)
check('both endpoints are in it', useLibrary.getState().selected.has(3) && useLibrary.getState().selected.has(11))

section('a range from an anchor that has been filtered away')

seed(50)
useLibrary.getState().select(40, 'replace') // anchor on a photo the query will hide
useLibrary.getState().setQuery('01')
useLibrary.getState().select(useLibrary.getState().visible[1], 'range')
check('a vanished anchor falls back to the clicked tile only', useLibrary.getState().selected.size === 1, `got ${useLibrary.getState().selected.size}`)

section('patch no longer re-filters for a setting that cannot change matching')

seed(100)
const before = useLibrary.getState().visible
settingsPatchResult = null
await useLibrary.getState().patch({ aiDockExpanded: false })
const afterDock = useLibrary.getState().visible
// Same contents is the point; a new array identity is what invalidates
// `useVisibleEntries` and re-runs `layoutJustified` over the library.
check('collapsing the dock keeps the same visible array', afterDock === before, 'the array was rebuilt')

await useLibrary.getState().patch({ aiDockWidth: 420 })
check('resizing the dock keeps the same visible array', useLibrary.getState().visible === before, 'the array was rebuilt')

await useLibrary.getState().patch({ slideIntervalMs: 9000 })
check('changing the slideshow interval keeps the same visible array', useLibrary.getState().visible === before, 'the array was rebuilt')

section('patch still re-filters when the inputs really change')

seed(60)
// `size` rather than `bytes`: SortKey is name | size | mtime | dimensions.
const preSort = useLibrary.getState().visible
await useLibrary.getState().patch({ sortKey: 'size', sortDir: 'desc' })
const postSort = useLibrary.getState().visible
check('a sort rebuilds visible', postSort !== preSort, 'visible was reused across a re-sort')

// `visible` holds positions into `photos`, not library identities, so a re-sort
// legitimately returns the same index list - what changes is which photo each
// index names. Asserting on the photos is what actually proves the sort happened;
// the first draft of this test compared the index arrays, which are equal by
// construction and would have failed while the sort worked.
const sorted = useLibrary.getState().photos
check(
  'descending size puts the biggest file first',
  sorted[0].bytes > sorted[sorted.length - 1].bytes,
  `first=${sorted[0].bytes}, last=${sorted[sorted.length - 1].bytes}`
)
check(
  'the first visible index names the biggest file',
  sorted[postSort[0]].bytes === Math.max(...sorted.map((p) => p.bytes)),
  `visible[0]=${postSort[0]} -> bytes=${sorted[postSort[0]].bytes}`
)

seed(40)
const preTags = useLibrary.getState().visible
await useLibrary.getState().patch({ aiTags: { 'C:\\pics\\000.jpg': ['sunset'] } })
check('a tag change rebuilds visible', useLibrary.getState().visible !== preTags, 'visible was reused across a tag change')

section('learnClip survives a re-sort')

seed(20)
// A clip the scan left unmeasured, which is the state the call exists to fix.
const raw = useLibrary.getState().raw
useLibrary.setState({
  raw: raw.map((p, i) => (i === 2 ? { ...p, kind: 'video', width: 0, height: 0, durationSeconds: 0 } : p)),
  photos: useLibrary.getState().raw.map((p, i) => (i === 2 ? { ...p, kind: 'video', width: 0, height: 0, durationSeconds: 0 } : p)),
  visible: raw.map((_, i) => i)
})
useLibrary.getState().learnClip(2, { width: 1920, height: 1080, durationSeconds: 12.5 })
check('the clip is measured in photos', useLibrary.getState().photos[2].width === 1920, `${useLibrary.getState().photos[2].width}`)
check('the clip is measured in raw too', useLibrary.getState().raw[2].width === 1920, `${useLibrary.getState().raw[2].width}`)

// The regression: `patch` re-derives photos from raw, so a measurement kept only
// in photos was discarded here and the clip reverted to width 0.
await useLibrary.getState().patch({ sortKey: 'bytes', sortDir: 'asc' })
const afterSort = useLibrary.getState().photos.find((p) => p.path.endsWith('002.jpg'))
check('the measurement survives a re-sort', afterSort.width === 1920, `width=${afterSort.width}`)
check('the duration survives too', afterSort.durationSeconds === 12.5, `duration=${afterSort.durationSeconds}`)

section('learnClip refuses a nonsense measurement')

seed(10)
useLibrary.setState({
  raw: useLibrary.getState().raw.map((p, i) => (i === 1 ? { ...p, kind: 'video' } : p)),
  photos: useLibrary.getState().photos.map((p, i) => (i === 1 ? { ...p, kind: 'video' } : p))
})
useLibrary.getState().learnClip(1, { width: 0, height: 0, durationSeconds: 0 })
check('a zero measurement is ignored', useLibrary.getState().photos[1].width === 600, `${useLibrary.getState().photos[1].width}`)

useLibrary.getState().learnClip(1, { width: 640, height: 480, durationSeconds: 3 })
useLibrary.getState().learnClip(0, { width: 640, height: 480, durationSeconds: 3 })
check('a still picture is not measured as a clip', useLibrary.getState().photos[0].width === 600, `${useLibrary.getState().photos[0].width}`)

section('setExif does not lose a concurrent read')

seed(10)
useLibrary.getState().setExif('C:\\pics\\000.jpg', { camera: 'A' })
useLibrary.getState().setExif('C:\\pics\\001.jpg', { camera: 'B' })
const cache = useLibrary.getState().exifCache
check('both EXIF reads are kept', cache.has('C:\\pics\\000.jpg') && cache.has('C:\\pics\\001.jpg'), `size=${cache.size}`)
check('the first value is intact', cache.get('C:\\pics\\000.jpg').camera === 'A')

// The second `set` for the same path replaces rather than accumulating.
useLibrary.getState().setExif('C:\\pics\\000.jpg', { camera: 'C' })
check('a re-read replaces the value', useLibrary.getState().exifCache.get('C:\\pics\\000.jpg').camera === 'C')
check('the map did not grow on replace', useLibrary.getState().exifCache.size === 2, `size=${useLibrary.getState().exifCache.size}`)

section('loadExif re-reads state after the await')

seed(5)
await Promise.all([
  useLibrary.getState().loadExif('C:\\pics\\000.jpg'),
  useLibrary.getState().loadExif('C:\\pics\\001.jpg')
])
check('both concurrent loads are recorded', useLibrary.getState().exifCache.size === 2, `size=${useLibrary.getState().exifCache.size}`)

section('a camera filter rebuilds visible when EXIF arrives')

seed(30)
useLibrary.setState({ visible: [0, 1, 2, 3, 4] })
useLibrary.getState().setCameraFilter('nikon')
useLibrary.getState().setExif('C:\\pics\\000.jpg', { camera: 'nikon z5' })
check('a camera match changes the visible set', useLibrary.getState().visible.length === 1, `visible=${useLibrary.getState().visible.length}`)

// With no camera rule active the recompute is skipped, so the array identity holds.
seed(30)
useLibrary.getState().setCameraFilter('')
useLibrary.setState({ visible: [0, 1, 2] })
useLibrary.getState().setExif('C:\\pics\\005.jpg', { camera: 'canon r5' })
check('EXIF with no camera rule does not re-filter', useLibrary.getState().visible.length === 3, `visible=${useLibrary.getState().visible.length}`)

section('selectAll and invertSelection agree with the filter')

seed(50)
useLibrary.getState().setQuery('02')
const vis = useLibrary.getState().visible
useLibrary.getState().selectAll()
check('select all takes only what is visible', useLibrary.getState().selected.size === vis.length, `${useLibrary.getState().selected.size} vs ${vis.length}`)
// Inverting a full selection leaves it empty, which is the arithmetic a user
// expects; the point being pinned is that both operations agree with the filter,
// so nothing outside `visible` is ever named.
useLibrary.getState().invertSelection()
check('inverting a full selection empties it', useLibrary.getState().selected.size === 0, `${useLibrary.getState().selected.size}`)

// From empty, invert takes exactly the visible set.
useLibrary.getState().clearSelection()
useLibrary.getState().invertSelection()
check('inverting an empty selection takes the visible set', useLibrary.getState().selected.size === vis.length, `${useLibrary.getState().selected.size}`)
const inverted = [...useLibrary.getState().selected]
check('nothing hidden is in the inverted set', inverted.every((i) => vis.includes(i)), `hidden: ${inverted.filter((i) => !vis.includes(i))}`)

section('the selection bar could never bin a hidden photo')

// The end-to-end shape of the first defect: whatever ends up in `selected` is
// what `SelectionBar.binSelected` maps to paths and hands to the shell.
seed(50)
useLibrary.getState().setQuery('03')
const vis2 = useLibrary.getState().visible
useLibrary.getState().select(vis2[0], 'replace')
useLibrary.getState().select(vis2[vis2.length - 1], 'range')
const { photos } = useLibrary.getState()
const pathsToBin = [...useLibrary.getState().selected].map((i) => photos[i]?.path).filter(Boolean)
const hiddenPaths = pathsToBin.filter((p) => !vis2.includes(photos.findIndex((x) => x.path === p)))
check('every path that would be binned is one the user can see', hiddenPaths.length === 0, `${hiddenPaths.length} hidden paths would be binned`)

section('the library snapshot the assistant is handed')

{
  // The defect that shipped: the assistant was told "pictures: 2000" about a
  // library of fifty thousand, because every count was taken over the 2,000
  // entries the snapshot is allowed to carry. The renderer holds the whole scan,
  // so it reduces it to `totals` before slicing - and these assertions are on
  // the object that actually crosses the bridge, not on the helper.
  //
  // Seeded past the 2,000 cap on purpose. A library smaller than the cap cannot
  // tell a correct count from a truncated one, so a test at 50 proves nothing -
  // the first draft of this section did exactly that and passed against the bug.
  const TOTAL = 2500
  seed(TOTAL)
  const expectedBytes = useLibrary.getState().raw.reduce((sum, p) => sum + p.bytes, 0)

  const before = aiChatContexts.length
  await useLibrary.getState().sendAiMessage('how many pictures do I have?')
  check('the assistant was given a library snapshot', aiChatContexts.length > before)

  const snapshot = aiChatContexts[aiChatContexts.length - 1]
  check('it carries whole-library totals', snapshot?.totals !== undefined, JSON.stringify(Object.keys(snapshot ?? {})))
  check(
    'the picture count is every one, not the capped slice',
    snapshot?.totals?.photos === TOTAL,
    `got ${snapshot?.totals?.photos}, expected ${TOTAL}`
  )
  check('clips too', snapshot?.totals?.videos === 0, `got ${snapshot?.totals?.videos}`)
  check(
    'the size is the real total',
    snapshot?.totals?.bytes === expectedBytes,
    `${snapshot?.totals?.bytes} vs ${expectedBytes}`
  )
  check('the entry list is still capped at 2000', snapshot?.entries.length === 2000, `got ${snapshot?.entries.length}`)
  check(
    'so the totals and the entries now disagree, as they must',
    snapshot?.totals?.photos > snapshot?.entries.length,
    `${snapshot?.totals?.photos} vs ${snapshot?.entries.length}`
  )
  check('the total agrees with the real library too', snapshot?.total === TOTAL, `got ${snapshot?.total}`)
  check('the date range comes from the whole library', typeof snapshot?.totals?.newest === 'number')
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(' - ' + f) }
process.exit(fail === 0 ? 0 : 1)