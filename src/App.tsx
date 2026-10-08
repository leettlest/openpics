import { useCallback, useEffect, useState } from 'react'
import { Titlebar } from './components/Titlebar'
import { TopTabs } from './components/TopTabs'
import { Toolbar } from './components/Toolbar'
import { Breadcrumbs } from './components/Breadcrumbs'
import { FilterBar } from './components/FilterBar'
import { Grid } from './components/Grid'
import { AiDock } from './components/AiDock'
import { Creatives } from './components/Creatives'
import { Viewer } from './components/Viewer'
import { StatusBar } from './components/StatusBar'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { SettingsPanel } from './components/SettingsPanel'
import { TerminalPanel } from './components/TerminalPanel'
import {
  useAiDeltaSubscription,
  useAiToolSubscription,
  useLibrary,
  useOpenChatSubscription,
  useOpenFilesSubscription,
  useOpenFoldersSubscription
} from './store/library'
import { bridge } from './lib/bridge'

export default function App() {
  // One selector per field, not a bare `useLibrary()`. The bare form returns the
  // whole state object, and zustand rebuilds that object on every `set`, so this
  // component - the root of the tree - re-rendered on every store write and
  // took every unmemoised child with it. That includes `appendAiDelta`, which
  // fires once per streamed token, and the scan progress write, which fires
  // about every 120ms. The actions below never change identity, so subscribing
  // to each individually costs nothing and only the three real state reads
  // (`settings`, `showSettings`, `showCreatives`) can re-render this component.
  // AiDock.tsx carries the same note for the same reason.
  const boot = useLibrary((s) => s.boot)
  const settings = useLibrary((s) => s.settings)
  const showSettings = useLibrary((s) => s.showSettings)
  const showCreatives = useLibrary((s) => s.showCreatives)
  const setShowSettings = useLibrary((s) => s.setShowSettings)
  const setShowCreatives = useLibrary((s) => s.setShowCreatives)
  const step = useLibrary((s) => s.step)
  const toggleInfo = useLibrary((s) => s.toggleInfo)
  const toggleShortcuts = useLibrary((s) => s.toggleShortcuts)
  const toggleSlideshow = useLibrary((s) => s.toggleSlideshow)
  const toggleTerminal = useLibrary((s) => s.toggleTerminal)
  const selectAll = useLibrary((s) => s.selectAll)
  const invertSelection = useLibrary((s) => s.invertSelection)
  const toggleAi = useLibrary((s) => s.toggleAi)
  const open = useLibrary((s) => s.open)
  const cursor = useLibrary((s) => s.cursor)
  const select = useLibrary((s) => s.select)
  const moveCursor = useLibrary((s) => s.moveCursor)
  const setQuery = useLibrary((s) => s.setQuery)
  const rescan = useLibrary((s) => s.rescan)
  const pickFolder = useLibrary((s) => s.pickFolder)

  useEffect(() => {
    void boot()
  }, [boot])

  // Windows can hand the app file paths at any time, including before boot has
  // finished, so the subscription is owned here rather than by a child.
  useOpenFilesSubscription()

  // Folders arrive the same way, on their own channel so file hand-off keeps
  // its open-the-file meaning instead of gaining a second one.
  useOpenFoldersSubscription()

  // Streamed AI reply pieces are appended to the dock's last message.
  useAiDeltaSubscription()

  // Which tool the assistant is running, for the gap where no text is arriving.
  useAiToolSubscription()

  // Outside requests to open the chat (CLI --chat). Owned here because the dock
  // unmounts on the Settings and Creatives pages, and a request that arrives
  // there still has to land on the library first.
  useOpenChatSubscription()

  const onDismissSettings = useCallback(() => setShowSettings(false), [setShowSettings])
  const onDismissCreatives = useCallback(() => setShowCreatives(false), [setShowCreatives])

  // Theme lives on the document element so both the UI and the native caption
  // overlay can read it, rather than duplicating the tokens in JS.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // Tray menu and close-to-tray both arrive on one channel.
  useEffect(() => {
    return bridge.onCommand((command) => {
      switch (command) {
        case 'hide':
          void bridge.win.hide()
          break
        case 'show':
          void bridge.win.show()
          break
        case 'minimize':
          void bridge.win.minimize()
          break
        case 'quit':
          void bridge.win.quit()
          break
        case 'next':
          step(1)
          break
        case 'previous':
          step(-1)
          break
        case 'slideshow':
          toggleSlideshow()
          break
        case 'info':
          toggleInfo()
          break
        default:
          break
      }
    })
  }, [step, toggleInfo, toggleSlideshow])

  // Global shortcuts. While the viewer is open it owns the keyboard, so this
  // handler steps aside: both used to act on the same key press, which made an
  // arrow in the viewer skip two photos and left I dead on arrival.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (typing) return

      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'o') {
          event.preventDefault()
          void pickFolder()
        } else if (event.key.toLowerCase() === 'r') {
          event.preventDefault()
          void rescan()
        } else if (event.key.toLowerCase() === 'a') {
          event.preventDefault()
          if (event.shiftKey) toggleAi()
          else selectAll()
        } else if (event.key.toLowerCase() === 'i') {
          event.preventDefault()
          invertSelection()
        } else if (event.key.toLowerCase() === 'h') {
          event.preventDefault()
          void bridge.win.hide()
        } else if (event.key === '`') {
          event.preventDefault()
          toggleTerminal()
        }
        return
      }

      // Help is the one shortcut that stays available everywhere.
      if (event.key === '?') {
        event.preventDefault()
        toggleShortcuts()
        return
      }

      if (useLibrary.getState().openIndex !== null) return

      // Settings and Creatives are pages now, not dialogs over the grid, so nothing
      // here is modal about them. But the library they replaced is unmounted, so
      // arrows would move a cursor nothing can see and keys like space would start
      // a slideshow over a selection the user cannot see. While one is up, only the
      // modifier shortcuts above and Back apply; everything else belongs to the page.
      // Escape is handled by the listener below, not here.
      if (useLibrary.getState().showSettings || useLibrary.getState().showCreatives) return

      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault()
          moveCursor(1, event.shiftKey)
          break
        case 'ArrowLeft':
          event.preventDefault()
          moveCursor(-1, event.shiftKey)
          break
        case 'ArrowDown':
          event.preventDefault()
          moveCursor(rowStep(), event.shiftKey)
          break
        case 'ArrowUp':
          event.preventDefault()
          moveCursor(-rowStep(), event.shiftKey)
          break
        case 'Home': {
          event.preventDefault()
          const first = useLibrary.getState().visible[0]
          if (first !== undefined) select(first, 'replace')
          break
        }
        case 'End': {
          event.preventDefault()
          const visible = useLibrary.getState().visible
          const last = visible[visible.length - 1]
          if (last !== undefined) select(last, 'replace')
          break
        }
        case 'Enter':
          event.preventDefault()
          open(cursor)
          break
        case ' ':
        case 's':
        case 'S':
          event.preventDefault()
          toggleSlideshow()
          break
        case 'i':
        case 'I':
          event.preventDefault()
          toggleInfo()
          break
        case 'Escape':
          event.preventDefault()
          // The shortcuts overlay and the viewer are modal and own Escape
          // themselves, so App only clears a filter when neither is showing.
          if (useLibrary.getState().showShortcuts) break
          if (useLibrary.getState().query !== '') setQuery('')
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    cursor,
    moveCursor,
    select,
    open,
    pickFolder,
    rescan,
    toggleShortcuts,
    toggleSlideshow,
    toggleInfo,
    toggleTerminal,
    selectAll,
    invertSelection,
    toggleAi,
    setQuery
  ])

  // Escape leaves whichever page replaced the library. It is handled here rather
  // than only in each page's own header so the habit of Escape-means-back carries
  // over from the dialog this replaced, and so the grid handler above stops at the
  // page branch rather than also clearing the filter behind it.
  const onPage = showSettings ? 'settings' : showCreatives ? 'creatives' : null

  // See the note at the render: Creatives stays mounted after its first visit.
  const [creativesMounted, setCreativesMounted] = useState(showCreatives)
  useEffect(() => {
    if (showCreatives) setCreativesMounted(true)
  }, [showCreatives])

  useEffect(() => {
    if (onPage === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Inside a field, Escape has to mean "stop editing", not "leave the page".
      const target = event.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      ) {
        return
      }
      event.preventDefault()
      if (onPage === 'settings') onDismissSettings()
      else onDismissCreatives()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPage, onDismissSettings, onDismissCreatives])

  return (
    <div className="flex h-full flex-col bg-base">
      <Titlebar />
      <TopTabs />

      {showSettings && (
        // Settings replaces the library rather than covering it. Keeping the grid
        // mounted underneath would leave it scrolling and selectable through a
        // "modal" that no longer looks like one, and the panel is tall enough that
        // a floating card either clipped its own content or covered the whole window.
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SettingsPanel />
        </div>
      )}

      {!showSettings && !showCreatives && (
        <>
          <Toolbar />
          <Breadcrumbs />
          <FilterBar />
          {/* min-w-0 is load-bearing: without it the grid refuses to give up any
              width, so the dock's remembered width pushes it off screen instead of
              taking space from it. */}
          <div className="flex min-h-0 min-w-0 flex-1">
            <Grid />
            <AiDock />
          </div>
          <TerminalPanel />
          <StatusBar />
          <Viewer />
        </>
      )}

      {creativesMounted && (
        // Hidden, not unmounted, once it has been opened: the strokes live in
        // component state, so tearing the canvas down on a tab switch throws away
        // whatever was being drawn. The first mount waits for the page to be on
        // screen, because a canvas sized while display:none has no width to measure
        // and would come up blank.
        <div className={showCreatives ? 'min-h-0 flex-1 overflow-hidden' : 'hidden'}>
          <Creatives />
        </div>
      )}
      <ShortcutsOverlay />
    </div>
  )
}

/** Vertical arrow step, derived from the current row height so it tracks density. */
function rowStep(): number {
  const rowHeight = useLibrary.getState().settings.rowHeight
  const width = window.innerWidth - 24
  const perRow = Math.max(1, Math.floor(width / (rowHeight * 1.3 + 6)))
  return Math.max(1, Math.round(perRow * 0.5))
}
