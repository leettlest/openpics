import { HardDrives, FolderOpen, ImageSquare, MagnifyingGlass, ArrowClockwise } from '@phosphor-icons/react'
import { useLibrary } from '@/store/library'
import { formatCount, prettyPath } from '@/lib/format'
import { Button } from './ui'

/**
 * Shown while a walk is in flight and the library has nothing to display yet.
 *
 * Distinct from the empty state because there is nothing to offer here beyond
 * waiting and stopping: the counts come from live progress rather than a result,
 * and in computer mode the wording has to describe drives instead of a folder.
 */
export function ScanningState() {
  // `progress` changes on every scan tick and is genuinely wanted here - it is
  // the readout. `settings` and the action are pulled apart so the component
  // re-renders for the tick and not for unrelated writes.
  const progress = useLibrary((s) => s.progress)
  const cancelScan = useLibrary((s) => s.cancelScan)
  const scanMode = useLibrary((s) => s.settings.scanMode)
  const computer = scanMode === 'computer'

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center"
      role="status"
      aria-live="polite"
    >
      <span className="num text-[11px] uppercase tracking-[0.14em] text-ink-3">
        {computer ? 'reading this pc' : 'reading disk'}
      </span>
      {progress ? (
        <>
          <p className="num text-[13px] text-ink-2">
            {formatCount(progress.found)} {progress.found === 1 ? 'picture' : 'pictures'} in{' '}
            {formatCount(progress.dirs)} {progress.dirs === 1 ? 'folder' : 'folders'}
          </p>
          {/* A long whole-machine walk looks identical to a hang without a way out,
              so the only action offered here is stopping it. */}
          <Button size="sm" onClick={() => void cancelScan()}>
            Stop
          </Button>
        </>
      ) : null}
    </div>
  )
}

export function EmptyState({ filtered = false }: { filtered?: boolean }) {
  const pickFolder = useLibrary((s) => s.pickFolder)
  const rescan = useLibrary((s) => s.rescan)
  const scanComputer = useLibrary((s) => s.scanComputer)
  const status = useLibrary((s) => s.status)
  const error = useLibrary((s) => s.error)
  const settings = useLibrary((s) => s.settings)
  const query = useLibrary((s) => s.query)
  const typeFilter = useLibrary((s) => s.typeFilter)
  const dateStart = useLibrary((s) => s.dateStart)
  const dateEnd = useLibrary((s) => s.dateEnd)
  const sizeMin = useLibrary((s) => s.sizeMin)
  const sizeMax = useLibrary((s) => s.sizeMax)
  const cameraFilter = useLibrary((s) => s.cameraFilter)
  const tagFilter = useLibrary((s) => s.tagFilter)
  const activeCollectionId = useLibrary((s) => s.activeCollectionId)
  const collections = useLibrary((s) => s.collections)
  const clearAllFilters = useLibrary((s) => s.clearAllFilters)
  const computer = settings.scanMode === 'computer'

  if (filtered) {
    // The old button cleared only the text query, so with a date or tag filter
    // active it visibly did nothing. Name what is actually hiding the pictures
    // and clear all of it.
    const active: string[] = []
    if (query.trim() !== '') active.push(`search “${query.trim()}”`)
    if (typeFilter !== 'all') active.push(typeFilter === 'image' ? 'images only' : 'videos only')
    if (dateStart !== null || dateEnd !== null) active.push('date range')
    if (sizeMin !== null || sizeMax !== null) active.push('size range')
    if (cameraFilter.trim() !== '') active.push(`camera “${cameraFilter.trim()}”`)
    if (tagFilter.length > 0) active.push(tagFilter.length === 1 ? `tag “${tagFilter[0]}”` : `${tagFilter.length} tags`)
    const collection = collections.find((c) => c.id === activeCollectionId && c.enabled)
    if (collection) active.push(`collection “${collection.name}”`)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <MagnifyingGlass size={26} weight="light" className="text-ink-3" />
        <p className="text-[13px] text-ink-2">
          {active.length === 0 ? 'No picture matches.' : `No picture matches ${active.join(' · ')}.`}
        </p>
        <Button size="sm" onClick={() => clearAllFilters()}>
          {active.length > 1 ? 'Clear all filters' : 'Clear filter'}
        </Button>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="text-[14px] font-medium text-ink">
          {computer ? 'This PC could not be scanned' : 'This folder could not be read'}
        </p>
        <p className="max-w-[420px] text-[12px] text-ink-3">{error}</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="solid"
            onClick={() => void (computer ? scanComputer() : rescan())}
          >
            <ArrowClockwise size={13} weight="bold" />
            Try again
          </Button>
          <Button size="sm" onClick={() => void pickFolder()}>
            <FolderOpen size={13} weight="regular" />
            Choose a folder
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      {computer ? <HardDrives size={30} weight="light" className="text-ink-3" /> : null}
      {!computer ? <ImageSquare size={30} weight="light" className="text-ink-3" /> : null}
      <div className="space-y-1">
        <p className="text-[14px] font-medium text-ink">
          {computer ? 'No pictures on this PC' : 'No pictures here yet'}
        </p>
        <p className="text-[12px] text-ink-3">
          {computer ? (
            'None of the readable drives hold an image file this app can open.'
          ) : (
            <>
              <span className="num">{prettyPath(settings.root)}</span> holds no image files.
            </>
          )}
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void pickFolder()}>
          <FolderOpen size={13} weight="regular" />
          Open a folder
        </Button>
        {computer ? (
          <Button variant="solid" size="sm" onClick={() => void scanComputer()}>
            <HardDrives size={13} weight="regular" />
            Scan this PC
          </Button>
        ) : null}
      </div>
    </div>
  )
}
