import { ArrowClockwise, CaretRight, MagnifyingGlass, PaperPlaneRight, Sparkle, Tag, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { thumbUrl } from '@shared/protocol'
import { bridge } from '@/lib/bridge'
import { AUTOTAG_LIMIT, useLibrary } from '@/store/library'
import { Button, IconButton, Segmented } from './ui'
import { Creatives } from './Creatives'

type DockTab = 'chat' | 'tags' | 'similar' | 'creatives'

const TAB_OPTIONS: { value: DockTab; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'tags', label: 'Tags' },
  { value: 'similar', label: 'Similar' },
  { value: 'creatives', label: 'Creatives' },
]

/**
 * The local-AI dock. It sits to the right of the grid, remembers its width, and
 * is honest when no model is installed rather than pretending a reply is coming.
 * Three views share it: the chat, tag suggestions, and a look-alike search.
 */
export function AiDock() {
  const expanded = useLibrary((s) => s.aiDockExpanded)
  const width = useLibrary((s) => s.aiDockWidth)
  const messages = useLibrary((s) => s.aiMessages)
  const thinking = useLibrary((s) => s.aiThinking)
  const modelReady = useLibrary((s) => s.aiModelReady)
  const visionReady = useLibrary((s) => s.aiVisionReady)

  const photos = useLibrary((s) => s.photos)
  const visible = useLibrary((s) => s.visible)
  const cursor = useLibrary((s) => s.cursor)
  const selectedCount = useLibrary((s) => s.selected.size)
  const photoTags = useLibrary((s) => s.photoTags)
  const aiTagging = useLibrary((s) => s.aiTagging)
  const aiSimilar = useLibrary((s) => s.aiSimilar)
  const aiSimilarBusy = useLibrary((s) => s.aiSimilarBusy)

  const { toggleAi, setAiDockExpanded, setAiDockWidth, sendAiMessage, tagSelection, setPhotoTags, findSimilar, clearSimilar } =
    useLibrary()

  const [tab, setTab] = useState<DockTab>('chat')
  useEffect(() => {
    const unsub = window.opencpics?.onOpenChat?.(() => {
      setTab('chat')
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
    })
    return () => unsub?.()
  }, [])

  const [draft, setDraft] = useState('')
  const [reloading, setReloading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, thinking])

  const reload = async (): Promise<void> => {
    setReloading(true)
    try {
      const ai = await bridge.ai.init()
      useLibrary.setState({ aiModelReady: ai.ready, aiVisionReady: ai.visionReady })
    } finally {
      setReloading(false)
    }
  }

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || !modelReady || thinking) return
    setDraft('')
    void sendAiMessage(text)
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = useLibrary.getState().aiDockWidth
    const onMove = (move: PointerEvent): void => {
      const next = Math.min(720, Math.max(240, Math.round(startWidth + (startX - move.clientX))))
      useLibrary.setState({ aiDockWidth: next })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setAiDockWidth(useLibrary.getState().aiDockWidth)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setAiDockExpanded(true)}
        title="Open AI"
        aria-label="Open AI"
        className="flex h-full w-9 shrink-0 flex-col items-center gap-2 border-l border-line bg-surface py-3 text-ink-3 transition-colors duration-150 hover:text-ink"
      >
        <Sparkle size={15} weight="regular" />
      </button>
    )
  }

  const current = cursor >= 0 ? photos[cursor] : undefined
  const currentTags = current ? (photoTags.get(current.path) ?? []) : []
  const tagTargets = Math.min(selectedCount, AUTOTAG_LIMIT)

  const openHit = (path: string): void => {
    const index = photos.findIndex((photo) => photo.path === path)
    if (index < 0) return
    const library = useLibrary.getState()
    library.select(index, 'replace')
    library.open(index)
  }

  const removeTag = (tag: string): void => {
    if (!current) return
    setPhotoTags(
      current.path,
      currentTags.filter((owned) => owned !== tag)
    )
  }

  const noModelNote = !modelReady ? (
    <div className="rounded-[8px] border border-line bg-raised p-3">
      <p className="text-ink-2">No local model was found.</p>
      <p className="mt-1">
        Add a <span className="num">.gguf</span> model to the bundled models folder, then reload.
      </p>
      <Button size="sm" variant="solid" className="mt-2" onClick={() => void reload()}>
        <ArrowClockwise size={13} weight="regular" />
        {reloading ? 'Checking…' : 'Reload'}
      </Button>
    </div>
  ) : null

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-line bg-surface"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startResize}
        className="absolute -left-0.5 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors duration-150 hover:bg-accent"
      />

      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Sparkle size={14} weight="fill" className="text-accent-text" />
        <span className="text-[12px] font-semibold">AI assistant</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
          {modelReady
            ? visionReady
              ? 'Local model ready · can read photos and chat'
              : 'Local model ready'
            : 'No local model'}
        </span>
        <IconButton label="Collapse AI" onClick={toggleAi}>
          <CaretRight size={15} weight="regular" />
        </IconButton>
      </header>

      <div className="shrink-0 border-b border-line px-3 py-1.5">
        <Segmented value={tab} label="AI dock view" options={TAB_OPTIONS} onChange={setTab} />
      </div>

      {tab === 'chat' ? (
        <>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {messages.length === 0 ? (
              <div className="flex flex-col gap-2 text-[12px] leading-relaxed text-ink-3">
                <p>
                  Ask anything about your pictures, or chat normally. Select photos to give them context.{visionReady ? " It can also look at selected photos." : ""}
                </p>
                {noModelNote}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {messages.map((message, index) => {
                  // An assistant bubble with no text yet is the streaming placeholder;
                  // the Thinking row below already says so.
                  if (message.role === 'assistant' && message.content === '' && thinking) return null
                  return (
                    <div
                      key={index}
                      className={
                        message.role === 'user'
                          ? 'ml-6 rounded-[8px] bg-tint px-3 py-2 text-[12px] leading-relaxed text-ink'
                          : 'mr-6 whitespace-pre-wrap rounded-[8px] border border-line px-3 py-2 text-[12px] leading-relaxed text-ink-2'
                      }
                    >
                      {message.content}
                    </div>
                  )
                })}
                {thinking ? (
                  <div className="mr-6 rounded-[8px] border border-line px-3 py-2 text-[12px] text-ink-3">
                    Thinking…
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <footer className="shrink-0 border-t border-line p-2">
            <div className="flex items-end gap-1.5">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submit()
                  }
                }}
                rows={2}
                disabled={!modelReady || thinking}
                placeholder={modelReady ? 'Ask about your pictures or chat.' : 'Add a model to chat'}
                aria-label="Message the AI assistant"
                className="min-h-[44px] flex-1 resize-none rounded-[8px] border border-line bg-raised px-2.5 py-2 text-[12px] text-ink placeholder:text-ink-3 transition-colors duration-150 focus:border-line-strong focus:outline-none disabled:opacity-50"
              />
              <Button
                size="sm"
                variant="accent"
                className="mb-0.5 px-2"
                disabled={!modelReady || thinking || draft.trim() === ''}
                onClick={submit}
              >
                <PaperPlaneRight size={14} weight="regular" />
              </Button>
            </div>
          </footer>
        </>
      ) : null}

      {tab === 'tags' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[12px] leading-relaxed text-ink-3">
          <div className="flex flex-col gap-3">
            <p>
              Tags are suggestions from the local model{visionReady ? ', read from the picture itself' : ''}. They show up
              as filters above the grid.
            </p>
            {noModelNote}
            <div className="flex flex-col gap-1.5">
              <Button
                size="sm"
                variant="solid"
                disabled={selectedCount === 0 || aiTagging}
                onClick={() => void tagSelection()}
              >
                <Tag size={13} weight="regular" />
                {aiTagging
                  ? 'Tagging…'
                  : selectedCount > AUTOTAG_LIMIT
                    ? `Suggest tags (first ${tagTargets} of ${selectedCount})`
                    : `Suggest tags (${selectedCount})`}
              </Button>
              {selectedCount === 0 ? <span className="text-[11px]">Select photos in the grid first.</span> : null}
            </div>

            {current ? (
              <div className="flex flex-col gap-1.5 border-t border-line pt-3">
                <span className="truncate text-[11px] uppercase tracking-wide">{current.name}</span>
                {currentTags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {currentTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        title="Remove tag"
                        onClick={() => removeTag(tag)}
                        className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
                      >
                        {tag}
                        <X size={9} weight="bold" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="text-ink-3">No tags on this photo yet.</span>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === 'similar' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[12px] leading-relaxed text-ink-3">
          <div className="flex flex-col gap-3">
            <p>
              Finds photos in the current view that look like the one under the cursor. This compares how pictures look,
              not what they mean.
            </p>
            <Button
              size="sm"
              variant="solid"
              disabled={!current || visible.length < 2 || aiSimilarBusy}
              onClick={() => current && void findSimilar(current.path)}
            >
              <MagnifyingGlass size={13} weight="regular" />
              {aiSimilarBusy ? 'Searching…' : 'Find similar in this view'}
            </Button>
            {!current ? <span className="text-[11px]">Click a photo in the grid first.</span> : null}

            {aiSimilar ? (
              aiSimilar.results.length > 0 ? (
                <div className="flex flex-col gap-1 border-t border-line pt-3">
                  {aiSimilar.results.map((hit) => {
                    const photo = photos.find((candidate) => candidate.path === hit.path)
                    return (
                      <button
                        key={hit.path}
                        type="button"
                        onClick={() => openHit(hit.path)}
                        className="flex items-center gap-2 rounded-[6px] border border-line p-1 text-left transition-colors duration-150 hover:bg-hover"
                      >
                        <img src={thumbUrl(hit.path)} alt="" className="h-9 w-9 shrink-0 rounded-[4px] object-cover" />
                        <span className="min-w-0 flex-1 truncate text-ink-2">{photo?.name ?? hit.path}</span>
                        <span className="num shrink-0 text-[10px]">{hit.distance}</span>
                      </button>
                    )
                  })}
                  <Button size="sm" variant="ghost" className="mt-1 self-start" onClick={clearSimilar}>
                    Clear
                  </Button>
                </div>
              ) : (
                <span className="border-t border-line pt-3">No close matches in this view.</span>
              )
            ) : null}
          </div>
        </div>
      ) : null}
      {tab === 'creatives' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[12px] leading-relaxed text-ink-3">
          <Creatives />
        </div>
      ) : null}
    </aside>
  )
}







