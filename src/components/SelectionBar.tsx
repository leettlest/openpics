import { AUTOTAG_LIMIT, useLibrary } from '../store/library'
import { bridge } from '@/lib/bridge'
import { Button } from './ui'

export function SelectionBar() {
  const selected = useLibrary((s) => s.selected)
  const visible = useLibrary((s) => s.visible)
  const photos = useLibrary((s) => s.photos)
  const selectAll = useLibrary((s) => s.selectAll)
  const invertSelection = useLibrary((s) => s.invertSelection)
  const clearSelection = useLibrary((s) => s.clearSelection)
  const forgetPaths = useLibrary((s) => s.forgetPaths)
  const tagSelection = useLibrary((s) => s.tagSelection)
  const aiTagging = useLibrary((s) => s.aiTagging)

  const count = selected.size
  if (count < 1) return null

  // The size check first: a partial selection can never cover the view, so the
  // common case skips the walk and only a full selection pays for it.
  const hasAll = visible.length > 0 && selected.size >= visible.length && visible.every((index) => selected.has(index))

  async function openSelected() {
    const paths = Array.from(selected)
      .map((index) => photos[index]?.path)
      .filter((path): path is string => Boolean(path))
    // Together, not one by one: opening is one shell call per file either way,
    // and serial awaits turn ten files into ten round trips of doing nothing.
    await Promise.allSettled(paths.map((path) => bridge.shell.open(path)))
  }

  async function revealSelected() {
    const index = Array.from(selected)[0]
    const photo = index === undefined ? undefined : photos[index]
    if (photo) await bridge.shell.reveal(photo.path)
  }

  async function binSelected() {
    const paths = Array.from(selected)
      .map((index) => photos[index]?.path)
      .filter((path): path is string => Boolean(path))
    if (paths.length === 0) return
    const results = await bridge.shell.sendToBin(paths)
    const gone = results.filter((result) => result.ok).map((result) => result.path)
    // Only what actually moved leaves the library. A partial failure used to
    // clear the whole selection, which read as everything going to the bin while
    // the refused files sat there unselected; now they stay selected, and
    // forgetPaths remaps the survivors by path.
    if (gone.length > 0) forgetPaths(gone)
  }

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="flex items-center gap-2 border-b border-line bg-raised px-3 py-1.5"
    >
      <span className="num text-[12px] text-ink-2">{count} selected</span>
      <div className="mx-1 h-4 w-px bg-line" />
      <Button size="sm" variant="solid" onClick={() => (hasAll ? clearSelection() : selectAll())}>
        {hasAll ? 'Clear all' : 'Select all'}
      </Button>
      <Button size="sm" variant="solid" onClick={invertSelection}>
        Invert
      </Button>
      <Button size="sm" variant="solid" onClick={() => void openSelected()}>
        Open
      </Button>
      <Button size="sm" variant="solid" onClick={() => void revealSelected()}>
        Reveal
      </Button>
      <Button
        size="sm"
        variant="solid"
        disabled={aiTagging}
        title={count > AUTOTAG_LIMIT ? `Tags the first ${AUTOTAG_LIMIT} selected photos` : undefined}
        onClick={() => void tagSelection()}
      >
        {aiTagging ? 'Tagging…' : 'Tag with AI'}
      </Button>
      <Button size="sm" variant="danger" onClick={() => void binSelected()}>
        Move to Recycle Bin
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={clearSelection}>
        Cancel
      </Button>
    </div>
  )
}
