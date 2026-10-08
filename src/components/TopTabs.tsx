import { GearSix, ImageSquare, PaintBrush } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { useLibrary } from '@/store/library'
import clsx from 'clsx'

type Page = 'library' | 'creatives' | 'settings'

/**
 * The three things this app is, one row above everything else.
 *
 * Creatives used to live inside the assistant dock, which made drawing something
 * you had to first open a chat panel to reach, and then find a tab inside it. It
 * is a page of its own now, and this row is how you get back.
 *
 * The row stays mounted on every page on purpose. A nav that only exists while
 * you are already on one of its destinations is not a nav, it is a label.
 */
export function TopTabs() {
  const showSettings = useLibrary((s) => s.showSettings)
  const showCreatives = useLibrary((s) => s.showCreatives)
  const setShowSettings = useLibrary((s) => s.setShowSettings)
  const setShowCreatives = useLibrary((s) => s.setShowCreatives)

  // Settings and Creatives each own their flag, so the current page is whichever
  // is set. Neither set means the library, which is why closing both lands here.
  const page: Page = showSettings ? 'settings' : showCreatives ? 'creatives' : 'library'

  const go = (next: Page): void => {
    if (next === 'settings') setShowSettings(true)
    else if (next === 'creatives') setShowCreatives(true)
    else {
      setShowCreatives(false)
      setShowSettings(false)
    }
  }

  return (
    <nav aria-label="Sections" className="flex shrink-0 items-center gap-1 border-b border-line bg-base px-2 py-1.5">
      <Tab active={page === 'library'} onClick={() => go('library')} icon={<ImageSquare size={15} />} label="Library" />
      <Tab
        active={page === 'creatives'}
        onClick={() => go('creatives')}
        icon={<PaintBrush size={15} />}
        label="Creatives"
      />
      <div className="mx-1 h-4 w-px bg-line" aria-hidden />
      <Tab active={page === 'settings'} onClick={() => go('settings')} icon={<GearSix size={15} />} label="Settings" />
    </nav>
  )
}

function Tab({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium',
        'transition-[background-color,color] duration-150',
        active ? 'bg-tint text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
      )}
    >
      <span aria-hidden className={active ? 'text-accent' : undefined}>
        {icon}
      </span>
      {label}
    </button>
  )
}