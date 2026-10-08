import { X } from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'
import { useLibrary } from '@/store/library'

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Library',
    items: [
      ['Arrow keys', 'move the selection'],
      ['Shift + arrows', 'extend the selection'],
      ['Ctrl + click', 'add or remove one picture'],
      ['Shift + click', 'select a range'],
      ['Enter or double click', 'open the viewer'],
      ['Escape', 'close the viewer'],
      ['/', 'jump to the filter box'],
      ['Ctrl + O', 'open another folder'],
      ['Ctrl + R', 'rescan the folder'],
      ['Ctrl + A', 'select everything shown'],
      ['Ctrl + I', 'invert the selection']
    ]
  },
  {
    title: 'Viewer',
    items: [
      ['Space or S', 'play or pause the slideshow'],
      ['Right / Left', 'next or previous shot'],
      ['Wheel or + and -', 'zoom at the pointer'],
      ['0', 'fit to the window'],
      ['Double click', 'switch between fit and 1:1'],
      ['Drag', 'pan while zoomed in'],
      ['Arrows when zoomed', 'pan instead of navigating'],
      ['K', 'play or pause the clip'],
      ['J / L', 'back or forward ten seconds'],
      [', / .', 'step one frame back or forward'],
      ['E', 'edit the background away'],
      ['Drag while editing', 'paint with the brush'],
      ['Escape while editing', 'put the picture back'],
      ['F', 'full screen'],
      ['I', 'show details']
    ]
  },
  {
    title: 'App',
    items: [
      ['Ctrl + `', 'show or hide the terminal'],
      ['Ctrl + Shift + A', 'show or hide the AI assistant'],
      ['Ctrl + H', 'hide the window'],
      ['?', 'keyboard shortcuts']
    ]
  }
]

export function ShortcutsOverlay() {
  const show = useLibrary((s) => s.showShortcuts)
  const toggle = useLibrary((s) => s.toggleShortcuts)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!show) return
    // A modal that documents the keyboard has to answer Escape, otherwise the
    // only ways out are a backdrop click or the close button. Focus starts on
    // Close, stays trapped inside while open, and returns to whatever opened it.
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        toggle()
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const items = [...root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )].filter((el) => !el.hasAttribute('disabled'))
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      returnFocus.current?.focus()
    }
  }, [show, toggle])

  if (!show) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={toggle}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--c-scrim)] p-6"
    >
      <div
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[620px] rounded-[6px] border border-line bg-surface shadow-[var(--shadow-tint)]"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold">Keyboard shortcuts</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={toggle}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <X size={14} weight="bold" />
          </button>
        </header>

        <div className="grid grid-cols-2 gap-x-8 gap-y-5 px-4 py-4">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-ink-3">
                {group.title}
              </h3>
              <dl className="space-y-1">
                {group.items.map(([key, description]) => (
                  <div key={key} className="flex items-baseline gap-2">
                    <dt className="num w-[124px] shrink-0 text-[11px] text-accent-text">{key}</dt>
                    <dd className="text-[12px] text-ink-2">{description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
