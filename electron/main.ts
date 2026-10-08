import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, shell } from 'electron'
import { statSync, watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DriveInfo, ScanProgress, ScanResult, Settings, ThumbnailStats, WallpaperFit } from '../shared/protocol'
import type {
  ApplyOptions,
  BrushOptions,
  CutoutOptions,
  OutputSettings,
  PreviewOptions,
  SelectionCommand
} from '../shared/edit'
import { isImage, THUMB_SCHEME } from '../shared/protocol'
import { AI_DELTA_CHANNEL, AI_TOOL_CHANNEL, CREATIVES_CHANGED_CHANNEL, OPEN_CHAT_CHANNEL, OPEN_FILES_CHANNEL, OPEN_FOLDERS_CHANNEL, SCAN_PROGRESS_CHANNEL } from '../shared/bridge'
import type { AiChatContext, AiToolActivity } from '../shared/ai-types'
import { cancelScan, listDrives, scanComputer, scanFolder } from './scanner'
import {
  disposeEdits,
  handleApply,
  handleBrush,
  handleClose,
  handleCutoutAuto,
  handleHistory,
  handleInspect,
  handleOpen,
  handleOutput,
  handlePreview,
  handleRedo,
  handleReset,
  handleSelection,
  handleUndo
} from './editing'
import {
  allowedRootList,
  clearThumbMemory,
  hasAllowedRoots,
  isAllowed,
  registerThumbScheme,
  setAllowedRoots,
  thumbStats
} from './thumbs'
import { loadCreatives, saveCreatives } from './creatives'
import type { Stroke } from '../shared/creatives-draw'
import { probeExif } from './imageinfo'
import { defaultRoot, loadSettings, saveSettings } from './settings'
import {
  attachTerminal,
  createTerminal,
  killAllTerminals,
  killTerminal,
  killTerminalsForOwner,
  resizeTerminal,
  terminalAvailable,
  writeTerminal
} from './terminal'
import type { TerminalCreateOptions } from '../shared/terminal'
import { ensureFileAssociations, fileAssociationsEnabled, setFileAssociations } from './shellassoc'
import { getWallpaper, setWallpaper } from '../core/wallpaper'
import { sendToBin } from '../core/recyclebin'
import { addonStatuses, refreshAddonStatuses } from '../core/addons/detect'
import { concatVideos, extractFrame, splitVideo, trimVideo } from '../core/video/edit'
import { probeVideo } from '../core/video/probe'
import { isVideoName, type ConcatRequest, type FrameRequest, type SplitRequest, type TrimRequest } from '../shared/video'
import { buildTray, updateTray, type TrayRef } from './tray'

const WINDOW_W = 1280
const WINDOW_H = 840
const MIN_W = 720
const MIN_H = 520
const TITLEBAR_H = 44

/**
 * GUI probe mode, entered with the `--probe` flag (see scripts/gui-probe.mjs).
 *
 * A probe launches the real app but must not touch the user's machine: no model
 * warm-up (seconds of CPU and a child process for a UI check), no registry
 * writes, no tray icon. The probe script pairs this with a throwaway
 * `--user-data-dir`, so settings, thumbnails and the prompt file stay isolated
 * too. Nothing here changes what the app can do, only what it starts eagerly.
 */
const PROBE_MODE = process.argv.includes('--probe')

let win: BrowserWindow | null = null
let tray: TrayRef | null = null
let quitting = false

/**
 * The thumbnail protocol must be declared privileged before the app is ready,
 * otherwise Chromium treats it as an opaque scheme with no fetch support.
 *
 * `bypassCSP` is required, not cosmetic. It defaults to false, and without it
 * Chromium's CSP parser does not recognise a runtime-registered scheme, so the
 * renderer's own `img-src 'self' openpics-thumb: data: blob:` blocks every
 * thumbnail and every full-size viewer image. Only this one allowlisted scheme
 * is exempt; scripts, inline script and foreign connections stay blocked.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: THUMB_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

function broadcast(command: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('opencpics:command', command)
}

/** Locks the renderer down: no popups, no foreign navigation, no device permissions. */
function hardenWindow(target: BrowserWindow): void {
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  target.webContents.on('will-navigate', (event, url) => {
    const here = target.webContents.getURL()
    try {
      if (new URL(url).origin === new URL(here).origin) return
    } catch {
      /* an unparseable target is not a same-origin navigation */
    }
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  target.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  target.webContents.session.setPermissionCheckHandler(() => false)
}

function createWindow(): BrowserWindow {
  const settings = loadSettings()

  const created = new BrowserWindow({
    width: WINDOW_W,
    height: WINDOW_H,
    minWidth: MIN_W,
    minHeight: MIN_H,
    show: false,
    backgroundColor: '#0b0b0c',
    autoHideMenuBar: true,
    // Native caption buttons drawn over our own titlebar. CSS reserves the right
    // padding via --titlebar-h so nothing renders underneath them.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0b0c',
      symbolColor: '#8e8e97',
      height: TITLEBAR_H
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  hardenWindow(created)

  // Captured now: a destroyed webContents cannot be asked for its id later.
  const owner = created.webContents.id
  // A reload wipes the renderer's tabs, so any shell it started would be orphaned
  // with no way to reach it. Taking them down with the document is the safe read.
  //
  // Edit sessions go the same way. The renderer normally closes them itself on
  // unmount, but a reload that skips unmount - a crash, or a reload held down at
  // the wrong moment - leaves the main process holding a decoded original and a
  // mask for every edit that was open, with no id anywhere that could reach them.
  // The budget would refuse new work and nothing would free it. There is only ever
  // one window (`createWindow` has a single caller path), so closing them all here
  // cannot take out a session another window is still using.
  created.webContents.on('did-navigate', () => {
    killTerminalsForOwner(owner)
    disposeEdits()
  })

  created.once('ready-to-show', () => {
    if (settings.launchMinimized) {
      created.hide()
      broadcast('hide')
    } else {
      created.show()
    }
  })

  created.on('close', (event) => {
    if (quitting) return
    if (loadSettings().closeToTray) {
      event.preventDefault()
      created.hide()
      broadcast('hide')
      tray?.flash()
    }
  })

  created.on('closed', () => {
    killTerminalsForOwner(owner)
    win = null
    // A closed window reloads with a fresh renderer, which must re-announce.
    rendererReady = false
  })

  void created.loadURL(process.env['ELECTRON_RENDERER_URL'] ?? join(__dirname, '../renderer/index.html'))

  return created
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Image paths handed to us by Windows, from the context-menu verb or an
 * "Open with" launch.
 *
 * Queued until the renderer announces it is listening, rather than until the
 * document finishes loading. `did-finish-load` fires before React has mounted and
 * subscribed, so it is too early: a cold start from "Open with" would deliver the
 * paths to a preload buffer nobody was reading yet. The renderer announces itself
 * once its subscription exists, and the preload script buffers anything that
 * arrives even earlier, so no delivery can be lost in between.
 */
let pendingFiles: string[] = []
let rendererReady = false

function deliverFiles(paths: string[]): void {
  if (paths.length === 0) return
  if (!rendererReady) {
    pendingFiles = [...pendingFiles, ...paths]
    return
  }
  if (win && !win.isDestroyed()) win.webContents.send(OPEN_FILES_CHANNEL, paths)
}

/**
 * Watches the drawing file for outside edits - an agent working over MCP, or
 * another window - and tells the renderer to reload it.
 *
 * The channel carries no drawing data, only the news that it changed: the
 * renderer re-reads through the validated load path, so a corrupt file can
 * never arrive as shapes. Debounced, because one save lands as several
 * filesystem events and the renderer must not reload five times for it.
 * Watching our own saves too is harmless for the same reason the renderer
 * ignores them: a reload that changes nothing changes nothing.
 */
let creativesWatcher: FSWatcher | null = null
let creativesNotifyTimer: NodeJS.Timeout | null = null

function watchCreatives(): void {
  if (creativesWatcher) return
  let dir: string
  try {
    dir = app.getPath('userData')
  } catch {
    return
  }
  try {
    creativesWatcher = watch(dir, (event, filename) => {
      if (filename !== null && filename !== 'creatives.json') return
      if (event !== 'change' && event !== 'rename') return
      if (creativesNotifyTimer) clearTimeout(creativesNotifyTimer)
      creativesNotifyTimer = setTimeout(() => {
        creativesNotifyTimer = null
        if (win && !win.isDestroyed()) win.webContents.send(CREATIVES_CHANGED_CHANNEL)
      }, 300)
    })
  } catch {
    creativesWatcher = null
  }
}

/**
 * Whether an argv vector asks for the assistant: the `--chat` CLI flag.
 *
 * Flags never reach the file picker - anything starting with a dash is skipped
 * there - so this is checked separately, on both the cold-start and the
 * second-instance paths.
 */
function wantsChat(argv: string[]): boolean {
  return argv.includes('--chat')
}

/**
 * Ask the renderer to open the assistant, whenever it is listening.
 *
 * Same queueing as files: a cold start asks before React has mounted, so the
 * request waits for `renderer-ready` instead of being sent at a subscriber that
 * does not exist yet and lost.
 */
let pendingChat = false

function requestChat(): void {
  pendingChat = true
  if (rendererReady && win && !win.isDestroyed()) {
    pendingChat = false
    win.webContents.send(OPEN_CHAT_CHANNEL)
  }
}

/**
 * Picks openable files out of an argv vector: pictures and clips.
 *
 * Chromium injects its own switches (`--user-data-dir=...` in particular, which
 * the test harness relies on), so anything starting with a dash is skipped, and
 * each remaining argument is confirmed to be an existing file rather than trusted
 * on the strength of its extension alone.
 *
 * Renamed from `imagePathsFromArgv` because it no longer opens only images. The
 * name was the reason a clip on the command line was silently dropped: the
 * extension check read `isImage`, and the old name made that look deliberate.
 */
function libraryPathsFromArgv(argv: string[]): string[] {
  const found: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-')) continue
    if (!isImage(arg) && !isVideoName(arg)) continue
    try {
      const full = resolve(arg)
      if (statSync(full).isFile()) found.push(full)
    } catch {
      /* a path that no longer exists is not worth reporting */
    }
  }
  return found
}

/**
 * Picks folders out of an argv vector: existing directories.
 *
 * A folder argument used to fall through every check and do nothing, which
 * reads as the app ignoring you. The renderer re-points the library at the
 * first one; the rest are ignored, because the library has one root and
 * silently picking one of several would be worse than saying so.
 *
 * The lone `.` is skipped on purpose: it is Electron's own app-path argument
 * (`electron .`), not a folder the user named, and without the skip every dev
 * launch would re-point the library at the checkout. Pass the full path when
 * the working directory is really what is wanted.
 */
function libraryFoldersFromArgv(argv: string[]): string[] {
  const found: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-') || arg === '.') continue
    try {
      const full = resolve(arg)
      if (statSync(full).isDirectory()) found.push(full)
    } catch {
      /* a path that no longer exists is not worth reporting */
    }
  }
  return found
}

let pendingFolders: string[] = []

function deliverFolders(folders: string[]): void {
  if (folders.length === 0) return
  if (!rendererReady) {
    pendingFolders = [...pendingFolders, ...folders]
    return
  }
  if (win && !win.isDestroyed()) win.webContents.send(OPEN_FOLDERS_CHANNEL, folders)
}

/** Forwards a walk's progress to the renderer, which is the only thing that can show it. */
function sendProgress(progress: ScanProgress): void {
  if (win && !win.isDestroyed()) win.webContents.send(SCAN_PROGRESS_CHANNEL, progress)
}

import { ChatCancelledError, autotagPhoto, chatAi, clearSimilarCache, ensurePromptFile, findBundledModels, findSimilar, getAiState, initAi, setAiModel, stopAi, toolsEnabled, warmAi } from './ai'

/**
 * Abort controllers for in-flight chat requests, by renderer request ID.
 *
 * Each chat gets its own controller so stopping one answer cannot stop another.
 * Renderers invalidate stale requests by ID as well, because a delta already on
 * its way down the channel can arrive after the abort that should have stopped
 * it.
 */
const activeChats = new Map<number, AbortController>()
/** Requests cancelled before their chat handler registered a controller. */
const cancelledChats = new Set<number>()

function pruneCancelledChats(): void {
  while (cancelledChats.size > 50) {
    const oldest = cancelledChats.values().next()
    if (oldest.done) return
    cancelledChats.delete(oldest.value)
  }
}

function wireIpc(): void {
  ipcMain.handle('settings:get', () => loadSettings())

  ipcMain.handle('settings:patch', (_e, patch: Partial<Settings>) => {
    const wasTerminalOn = loadSettings().enableTerminal
    const next = saveSettings(patch)
    nativeTheme.themeSource = next.theme
    // Turning the terminal off only stopped *new* shells from being created:
    // `createTerminal` re-reads the setting and refuses, but every already-open
    // PTY kept running with full filesystem access. A user who switches it off
    // expects the shells to go, not to go quiet.
    if (wasTerminalOn && !next.enableTerminal) killAllTerminals()
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(next.alwaysOnTop)
      win.setTitleBarOverlay?.({
        color: next.theme === 'dark' ? '#0b0b0c' : '#fafafa',
        symbolColor: next.theme === 'dark' ? '#8e8e97' : '#55555c',
        height: TITLEBAR_H
      })
    }
    return next
  })

  ipcMain.handle('library:default-root', () => defaultRoot())

  ipcMain.handle(
    'library:pick',
    async (): Promise<{ canceled: boolean; path?: string }> => {
      if (!win) return { canceled: true }
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose a folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: loadSettings().root || defaultRoot()
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      return { canceled: false, path: result.filePaths[0]! }
    }
  )

  ipcMain.handle('library:scan', async (_e, root: string, recursive: boolean): Promise<ScanResult> => {
    // Every scan re-pins the allowlist, so the protocol can never serve a path
    // from a folder the user did not just choose.
    setAllowedRoots([root])
    clearThumbMemory()
    // A new walk can rename everything the similarity hashes meant, so they go
    // with the old thumbnails rather than matching stale bytes.
    clearSimilarCache()
    // Folder walks report progress too: a deep tree on a spinning disk takes
    // long enough that the window would otherwise look frozen.
    return scanFolder(root, recursive, sendProgress)
  })

  ipcMain.handle('library:drives', (): DriveInfo[] => listDrives())

  ipcMain.handle('library:scan-computer', async (): Promise<ScanResult> => {
    // Computer mode needs thumbnails from every drive, so the allowlist becomes
    // the whole machine. This is the same trust decision as a folder scan, just
    // wider: the protocol can only serve an image path, and the renderer already
    // has arbitrary code execution over the user's own pictures.
    const drives = listDrives().filter((drive) => !drive.unreadable)
    setAllowedRoots(drives.map((drive) => drive.root))
    clearThumbMemory()
    clearSimilarCache()
    return scanComputer(sendProgress)
  })

  ipcMain.handle('library:cancel-scan', () => {
    cancelScan()
  })

  // Sent by the preload script the moment the renderer has a file listener, which
  // is strictly later than the document load and strictly earlier than any user
  // interaction. Only then is it safe to hand over queued paths.
  ipcMain.handle('library:renderer-ready', () => {
    rendererReady = true
    if (pendingFiles.length !== 0) {
      const queued = pendingFiles
      pendingFiles = []
      if (win && !win.isDestroyed()) win.webContents.send(OPEN_FILES_CHANNEL, queued)
    }
    if (pendingFolders.length !== 0) {
      const queued = pendingFolders
      pendingFolders = []
      if (win && !win.isDestroyed()) win.webContents.send(OPEN_FOLDERS_CHANNEL, queued)
    }
    if (pendingChat) {
      pendingChat = false
      if (win && !win.isDestroyed()) win.webContents.send(OPEN_CHAT_CHANNEL)
    }
  })

  ipcMain.handle('thumb:stats', (): ThumbnailStats => ({ ...thumbStats }))

  ipcMain.handle('library:exif', (_event, path: string) => probeExif(path))

  // Drawing persistence. The canvas restores from here on mount and saves a
  // debounced copy on change; validation lives on the main side so a corrupt
  // file can never reach the renderer as anything but null.
  ipcMain.handle('creatives:load', () => loadCreatives())
  ipcMain.handle('creatives:save', (_e, strokes: Stroke[]) => {
    saveCreatives(Array.isArray(strokes) ? strokes : [])
  })

  ipcMain.handle('edit:cutout-auto', (_e, path: string, options: CutoutOptions) => handleCutoutAuto(path, options))
  ipcMain.handle('edit:open', (_e, path: string, edit?: string) => handleOpen(path, edit))
  ipcMain.handle('edit:brush', (_e, edit: string, options: BrushOptions) => handleBrush(edit, options))
  ipcMain.handle('edit:selection', (_e, edit: string, command: SelectionCommand) => handleSelection(edit, command))
  ipcMain.handle('edit:output', (_e, edit: string, settings: OutputSettings | null) => handleOutput(edit, settings))
  ipcMain.handle('edit:undo', (_e, edit: string) => handleUndo(edit))
  ipcMain.handle('edit:redo', (_e, edit: string) => handleRedo(edit))
  ipcMain.handle('edit:history', (_e, edit: string) => handleHistory(edit))
  ipcMain.handle('edit:preview', (_e, edit: string, options: PreviewOptions) => handlePreview(edit, options))
  ipcMain.handle('edit:apply', (_e, edit: string, options: ApplyOptions) => handleApply(edit, options))
  ipcMain.handle('edit:inspect', (_e, edit?: string) => handleInspect(edit))
  ipcMain.handle('edit:reset', (_e, edit: string) => handleReset(edit))
  ipcMain.handle('edit:close', (_e, edit: string) => handleClose(edit))

  ipcMain.handle('ai:init', async () => {
    const state = await initAi()
    return state
  })

  ipcMain.handle('ai:state', async () => getAiState())

  ipcMain.handle('ai:listModels', async () => findBundledModels())

  ipcMain.handle('ai:setModel', async (_e, path: string) => {
    return setAiModel(path)
  })

  ipcMain.handle('ai:getPrompt', async () => {
    const p = await ensurePromptFile()
    const { readPromptFile } = await import('./ai/prompt')
    return { path: p, content: readPromptFile() }
  })

  ipcMain.handle('ai:setPrompt', async (_e, content: string) => {
    const { writePromptFile } = await import('./ai/prompt')
    await writePromptFile(content)
    const p = await ensurePromptFile()
    const { readPromptFile } = await import('./ai/prompt')
    return { path: p, content: readPromptFile() }
  })

  ipcMain.handle('ai:chat', async (event, message: string, context?: AiChatContext, requestId?: number) => {
    const id = Number.isFinite(requestId) ? Number(requestId) : 0
    if (cancelledChats.has(id)) return { content: '', cancelled: true }
    const controller = new AbortController()
    activeChats.set(id, controller)
    const onDelta = (delta: string): void => {
      if (!event.sender.isDestroyed()) event.sender.send(AI_DELTA_CHANNEL, { requestId: id, delta })
    }
    // A tool call is silent from the outside: the model asks, main runs it, and
    // the next text arrives seconds later. The dock shows this in that gap.
    const onActivity = (activity: AiToolActivity | null): void => {
      if (!event.sender.isDestroyed()) event.sender.send(AI_TOOL_CHANNEL, { requestId: id, activity })
    }
    try {
      return await chatAi(message, context, onDelta, onActivity, controller.signal)
    } catch (err) {
      onActivity(null)
      if (err instanceof ChatCancelledError || controller.signal.aborted) {
        return { content: '', cancelled: true }
      }
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      if (activeChats.get(id) === controller) activeChats.delete(id)
      cancelledChats.delete(id)
    }
  })

  ipcMain.handle('ai:cancel', (_e, requestId?: number) => {
    const id = Number.isFinite(requestId) ? Number(requestId) : 0
    // Remember the cancellation even if the chat handler has not registered yet:
    // the renderer may stop a request while main is still starting its runtime.
    cancelledChats.add(id)
    pruneCancelledChats()
    activeChats.get(id)?.abort()
  })

  ipcMain.handle('ai:autotag', async (_e, targets: Array<{ id: string; path: string }>) => {
    // Tag suggestions send pictures to the model and write tags, so they are an
    // agent tool like the chat tools - not a local computation like similarity
    // search, which stays available. Refusing loudly beats tagging nothing while
    // the button says Tagging.
    if (!toolsEnabled()) {
      throw new Error('Agent tools are blocked for this profile. Turn them on in Settings to suggest tags.')
    }
    const results: Array<{ photoId: string; tags: string[] }> = []
    for (const target of targets ?? []) {
      const tagged = await autotagPhoto(target.id, target.path)
      results.push({ photoId: tagged.photoId, tags: tagged.tags })
    }
    return results
  })
  ipcMain.handle('ai:similar', (_e, path: string, candidates: string[]) =>
    findSimilar(path, candidates ?? [])
  )
  ipcMain.handle('wallpaper:get', () => getWallpaper())
// Deliberately not debounced or rate-limited: the user asked for this desktop
  // and is watching it change. Nothing else in the app calls it.
  ipcMain.handle('wallpaper:set', (_e, path: string, fit: WallpaperFit) => {
    // The picture becomes the desktop, so it is the one write a renderer could
    // make that a user would notice without being in the app to ask for it.
    assertWithinLibrary(path, 'set as wallpaper')
    return setWallpaper(path, fit)
  })

  /**
   * Refuses a path that is not inside the library currently open.
   *
   * Uses the same roots as the thumbnail protocol, so "a file the app will show"
   * and "a file the shell may act on" cannot drift apart - and both are re-pinned
   * on every scan, so opening a folder is what grants this. Throws rather than
   * returning a flag, because every caller here is a one-line body that would
   * otherwise have to remember to check a second time.
   *
   * The refusal text distinguishes "nothing is open" from "that is elsewhere",
   * since `isAllowed` reports both as false.
   */
  function assertWithinLibrary(path: string, action: string): void {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error(`cannot ${action}: no path given`)
    }
    if (isAllowed(path)) return
    if (!hasAllowedRoots()) {
      throw new Error(`cannot ${action}: no folder is open yet. Open one first.`)
    }
    throw new Error(
      `cannot ${action} ${JSON.stringify(path)}: it is outside the open library. ` +
        `Open: ${allowedRootList().join(', ')}`
    )
  }

ipcMain.handle('shell:reveal', (_e, path: string) => {
    // Same containment rule as shell:open below, and for the same reason: this
    // path arrives from the renderer, and handing an arbitrary one to Explorer is
    // a way to have the OS do something with a file the app never listed.
    assertWithinLibrary(path, 'show in folder')
    shell.showItemInFolder(path)
  })

  ipcMain.handle('shell:open', async (_e, path: string) => {
    // `openPath` is Windows `ShellExecute`, so this hands the path to whatever
    // the registry says handles that extension. Only a file the library contains
    // gets there, which means a compromised renderer cannot name an `.exe`, a
    // `.bat` or a `.lnk` and have it launched. This was the one shell channel
    // with neither a guard nor a note saying why it was safe; open-url beside it
    // validates for exactly this reason.
    assertWithinLibrary(path, 'open')
    await shell.openPath(path)
  })

ipcMain.handle('shell:open-url', async (_e, url: string) => {
      // Anything but http(s) is refused rather than handed to the OS: file:// and
      // smb:// would let a compromised renderer open local content off-screen.
      if (!/^https?:\/\//i.test(url)) return
      await shell.openExternal(url)
    })

    ipcMain.handle('shell:bin', (_e, paths: string[]) => {
      // Containment as well. Moving to the bin is recoverable, which is why it is
      // not treated as an emergency, but a renderer that could name any path
      // could still clear out a folder the app has never listed.
      for (const path of paths) assertWithinLibrary(path, 'move to the Recycle Bin')
      return sendToBin(paths)
    })

  ipcMain.handle('shell:associations', async (_e, enabled: boolean) => {
    const next = await setFileAssociations(enabled)
    // The setting is the user's stated preference, so keep the two in step.
    saveSettings({ shellIntegration: next })
    return next
  })
  ipcMain.handle('shell:associations-status', () => fileAssociationsEnabled())

  ipcMain.handle('win:always-on-top', (_e, value: boolean) => {
    win?.setAlwaysOnTop(value)
    return win?.isAlwaysOnTop() ?? value
  })
  ipcMain.handle('win:fullscreen', (_e, value: boolean) => {
    win?.setFullScreen(value)
    return win?.isFullScreen() ?? value
  })
  ipcMain.handle('win:hide', () => win?.hide())
  ipcMain.handle('win:show', () => showWindow())
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:state', () => ({
    maximized: win?.isMaximized() ?? false,
    fullScreen: win?.isFullScreen() ?? false,
    visible: win?.isVisible() ?? false
  }))
  ipcMain.handle('win:toggle-maximize', () => {
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('win:quit', () => {
    quitting = true
    app.quit()
  })

  // The renderer never names a program: it opens a shell from the fixed list and
  // then talks to it by opaque id. Every call is scoped to the window that owns
  // the session, so one window cannot drive another's shell.
  ipcMain.handle('terminal:available', () => terminalAvailable())
  ipcMain.handle('terminal:create', (event, options: TerminalCreateOptions) =>
    createTerminal(event.sender.id, options ?? {})
  )
  ipcMain.handle('terminal:attach', (event, id: string) => attachTerminal(event.sender.id, id))
  ipcMain.handle('terminal:write', (event, id: string, data: string) => {
    writeTerminal(event.sender.id, id, data)
  })
  ipcMain.handle('terminal:resize', (event, id: string, cols: number, rows: number) => {
    resizeTerminal(event.sender.id, id, cols, rows)
  })
  ipcMain.handle('terminal:kill', (event, id: string) => {
    killTerminal(event.sender.id, id)
  })

  // Addon detection. `list` is cached inside core, so repeated calls from the
  // Settings panel cost nothing; `refresh` exists because the user may have
  // installed something since the app started, and a stale tick would be worse
  // than a re-probe.
  //
  // There is no `install` handler, and that is deliberate. Everything OpenPics
  // ships is already inside the installer, so there is nothing for it to fetch,
  // and a handler taking a URL would let a renderer name any binary on the disk.
  // A missing optional tool gets a link to its vendor instead.
  ipcMain.handle('addons:list', () => addonStatuses())
  ipcMain.handle('addons:refresh', () => refreshAddonStatuses())

  // Video. All of these write a new file and refuse to touch a source, so there is
  // no confirmation prompt here - unlike shell:associations, nothing the renderer
  // can ask for is irreversible.
  ipcMain.handle('video:probe', (_e, path: string) => probeVideo(path))
  ipcMain.handle('video:trim', (_e, request: TrimRequest) => trimVideo(request))
  ipcMain.handle('video:split', (_e, request: SplitRequest) => splitVideo(request))
  ipcMain.handle('video:concat', (_e, request: ConcatRequest) => concatVideos(request))
  ipcMain.handle('video:frame', (_e, request: FrameRequest) => extractFrame(request))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A second launch, from the context menu or "Open with", carries the file
  // arguments. The first element is always the executable, so it is skipped.
  app.on('second-instance', (_event, argv) => {
    showWindow()
    const args = argv.slice(1)
    deliverFiles(libraryPathsFromArgv(args))
    deliverFolders(libraryFoldersFromArgv(args))
    if (wantsChat(args)) requestChat()
  })

  // `.catch` rather than a bare `.then`, so a throw anywhere in startup is
  // reported rather than surfacing as an unhandled rejection. Electron shows
  // nothing for those by default: no dialog, no log line, just an app that
  // never opens a window. A window that fails to appear is the single worst
  // failure mode for a desktop app to have, and it is the one this silence makes
  // undiagnosable.
  app.whenReady().then(() => {
    const settings = loadSettings()
    nativeTheme.themeSource = settings.theme

    registerThumbScheme()
    wireIpc()
    // Live drawing sync: agent edits over MCP land here while the app is open.
    watchCreatives()
    win = createWindow()
    win.setAlwaysOnTop(settings.alwaysOnTop)

    // A cold start with files on the command line: the window is not listening
    // yet, so these queue until did-finish-load.
    const launchArgs = process.argv.slice(1)
    deliverFiles(libraryPathsFromArgv(launchArgs))
    deliverFolders(libraryFoldersFromArgv(launchArgs))
    if (wantsChat(launchArgs)) requestChat()

    // Load the local model in the background so the first question is instant.
    // Starting a child process is not something first paint should wait on.
    // Skipped in probe mode: a UI check must not pay for a model load.
    if (settings.aiEnabled && !PROBE_MODE) void warmAi()


    // Registering the context-menu entries is a handful of registry writes plus a
    // PowerShell round trip, which has no business blocking first paint. The
    // setting stays the source of truth; the registry is reconciled to it.
    //
    // A failure here is not fatal: the app works with the entries absent, and the
    // toggle in Settings reports the real state next time it is opened. Swallowing
    // it keeps a locked-down or policy-restricted registry from surfacing as an
    // unhandled rejection with nothing to show for it.
    // Skipped in probe mode: a UI check must not write the user's registry.
    if (!PROBE_MODE) void ensureFileAssociations(settings.shellIntegration).catch(() => false)

    // No tray icon in probe mode either: it would outlive the probe window and
    // pollute the user's tray. `tray` stays null and every use is optional.
    if (!PROBE_MODE) {
      tray = buildTray({
        onShow: showWindow,
        onCommand: broadcast,
        onQuit: () => {
          quitting = true
          app.quit()
        }
      })
      updateTray(tray, { slideshow: false, count: 0 })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
      else showWindow()
    })
  }).catch((err: unknown) => {
    // Startup failed. Electron shows no dialog for an unhandled rejection, so
    // without this the app looks like it did nothing at all. Quitting is the
    // honest outcome: a half-built main process with no window and no way for the
    // user to reach Settings is worse than one that says it stopped.
    dialog.showErrorBox(
      'OpenPics could not start',
      err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}`.trim() : String(err)
    )
    app.exit(1)
  })

  app.on('before-quit', () => {
    quitting = true
    disposeEdits()
    // Shells are child processes of the app: they must not be left running.
    killAllTerminals()
    // The AI server is a child process too; stop it so no orphan holds the model.
    stopAi()
  })

  app.on('window-all-closed', () => {
    // Close-to-tray prevents the close entirely, so this only fires on a real quit.
    app.quit()
  })
}



