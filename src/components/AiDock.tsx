import {
  ArrowClockwise,
  CaretRight,
  MagnifyingGlass,
  PaperPlaneRight,
  Sparkle,
  Tag,
  X
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { thumbUrl } from '@shared/protocol'
import { clampDockWidth, dragDockWidth, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH } from '@shared/dock-width'
import type { AiDockTab } from '@shared/ai-types'
import { bridge } from '@/lib/bridge'
import { AUTOTAG_LIMIT, useLibrary } from '@/store/library'
import { Button, IconButton, Segmented } from './ui'

type DockTab = AiDockTab

const TAB_OPTIONS: { value: DockTab; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'tags', label: 'Tags' },
  { value: 'similar', label: 'Similar' }
]

// Offered when the transcript is empty. Each one is something the dock can
// actually do with what it has, which is the point: they advertise the tools
// without a paragraph explaining them.
const EXAMPLES = [
  'How many photos do I have?',
  'Find photos with sunsets in the name',
  'What is in the bin?'
]

/**
 * The local-AI dock. It sits to the right of the grid, remembers its width, and
 * is honest when no model is installed rather than pretending a reply is coming.
 * Two things share it besides the chat: tag suggestions and a look-alike search.
 */
export function AiDock() {
  const expanded = useLibrary((s) => s.aiDockExpanded)
  const width = useLibrary((s) => s.aiDockWidth)
  const messages = useLibrary((s) => s.aiMessages)
  const thinking = useLibrary((s) => s.aiThinking)
  const activity = useLibrary((s) => s.aiActivity)
  const modelReady = useLibrary((s) => s.aiModelReady)
  const visionReady = useLibrary((s) => s.aiVisionReady)

  const photos = useLibrary((s) => s.photos)
  const visible = useLibrary((s) => s.visible)
  const cursor = useLibrary((s) => s.cursor)
  const selectedCount = useLibrary((s) => s.selected.size)
  const photoTags = useLibrary((s) => s.photoTags)
  const aiTagging = useLibrary((s) => s.aiTagging)
  const aiTagNote = useLibrary((s) => s.aiTagNote)
  const toolsAllowed = useLibrary((s) => s.settings.enableMcp !== false)
  const aiSimilar = useLibrary((s) => s.aiSimilar)
  const aiSimilarBusy = useLibrary((s) => s.aiSimilarBusy)

  // Actions are stable references, so each gets its own selector: one bare
  // `useLibrary()` here re-rendered the whole dock on every store change -
  // scan progress, cursor moves, selection - while a generation streamed.
  const toggleAi = useLibrary((s) => s.toggleAi)
  const setAiDockExpanded = useLibrary((s) => s.setAiDockExpanded)
  const setAiDockWidth = useLibrary((s) => s.setAiDockWidth)
  const sendAiMessage = useLibrary((s) => s.sendAiMessage)
  const cancelAiMessage = useLibrary((s) => s.cancelAiMessage)
  const tagSelection = useLibrary((s) => s.tagSelection)
  const setPhotoTags = useLibrary((s) => s.setPhotoTags)
  const findSimilar = useLibrary((s) => s.findSimilar)
  const clearSimilar = useLibrary((s) => s.clearSimilar)

  const retryAiMessage = useLibrary((s) => s.retryAiMessage)
  const tab = useLibrary((s) => s.aiDockTab)
  const setTab = useLibrary((s) => s.setAiDockTab)
  const chatRequest = useLibrary((s) => s.chatRequest)
  // Which outside open-chat requests this mount has already answered. A request
  // that arrived while the dock was unmounted (Settings page) is still new to
  // this mount, so it is answered rather than skipped.
  const seenChatRequest = useRef(0)
  useEffect(() => {
    if (seenChatRequest.current === chatRequest) return
    seenChatRequest.current = chatRequest
    setTab('chat')
    // The request came from outside the dock, so put the cursor where the reply
    // goes. The old code blurred instead, which left focus nowhere and made a
    // tray-opened chat feel dead.
    composerRef.current?.focus()
  }, [chatRequest])

// A remembered width is a preference, not a promise: on a narrower window it is
  // capped for as long as the window stays narrow and comes back when it does not.
  // Clamping on resize instead of rewriting the stored value is what keeps that
  // reversible, so dragging the window wider does not permanently shrink the dock.
  const [limit, setLimit] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setLimit(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // A drag is transient until release: writing every pointer move into the stored
  // width would let a capped or pinned window rewrite the preference the user had
  // before touching the separator. The ref carries the latest move into the
  // pointer-up handler, which the render closure cannot otherwise see.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragWidthRef = useRef<number | null>(null)
  const shown = dragWidth ?? clampDockWidth(width, limit)

  const draft = useLibrary((s) => s.aiDraft)
  const setDraft = useLibrary((s) => s.setAiDraft)
  const [reloading, setReloading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // While a tool runs there is no text to scroll, so this watches the label too.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, thinking, activity])

  const reload = useCallback(async (): Promise<void> => {
    setReloading(true)
    try {
      const ai = await bridge.ai.init()
      useLibrary.setState({ aiModelReady: ai.ready, aiVisionReady: ai.visionReady })
    } finally {
      setReloading(false)
    }
  }, [])

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || !modelReady || thinking) return
    setDraft('')
    void sendAiMessage(text)
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    // The drag starts from what is on screen, not from the stored width: on a
    // window narrow enough to be capping the dock those differ, and starting
    // from the stored value would snap the dock wider before the pointer moved.
    const startWidth = shown
    const onMove = (move: PointerEvent): void => {
      // The viewport is read per move, so a window resized mid-drag is honoured.
      const next = dragDockWidth(startWidth, startX, move.clientX, window.innerWidth)
      dragWidthRef.current = next
      setDragWidth(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const endWidth = dragWidthRef.current
      dragWidthRef.current = null
      setDragWidth(null)
      // A pinned window cannot move, so there is nothing to commit. Persisting the
      // transient width here would rewrite the stored preference with the cap.
      if (endWidth === null || endWidth === startWidth) return
      setAiDockWidth(endWidth, window.innerWidth)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // What the model is doing right now, in the dock's own words rather than the
  // tool name, because "photos_find" means nothing to the person asking.
  //
  // This hook lives above the collapsed-rail early return on purpose. A hook
  // below it renders on some passes and not others, and collapsing the dock
  // then unmounts the whole app with React error #300 (fewer hooks than
  // expected). Hooks are unconditional; only the JSX branches.
  const status = useMemo(() => {
    if (thinking) return activity ? `Working · ${activity.label}` : 'Thinking…'
    if (!modelReady) return 'No local model'
    return visionReady ? 'Ready · can see selected photos' : 'Ready'
  }, [thinking, activity, modelReady, visionReady])

  if (!expanded) {
    // A bare glyph reads as decoration and is easy to miss, so the rail carries a
    // label and a rule that only appear on hover.
    return (
      <button
        type="button"
        onClick={() => setAiDockExpanded(true)}
        title="Open AI assistant"
        aria-label="Open AI assistant"
        className="group flex h-full w-11 shrink-0 cursor-pointer flex-col items-center gap-2 border-l border-line bg-surface py-3 text-ink-3 transition-colors duration-150 hover:bg-raised hover:text-ink"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-[6px] transition-colors duration-150 group-hover:bg-tint group-hover:text-accent-text">
          <Sparkle size={16} weight="regular" />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] [writing-mode:vertical-rl] group-hover:text-ink-2">
          AI
        </span>
        <span
          aria-hidden
          className="mt-1 h-8 w-px bg-gradient-to-b from-transparent via-line-strong to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        />
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
      <p className="mt-1">Add a <span className="num">.gguf</span> model to the bundled models folder, then reload.</p>
      <Button size="sm" variant="solid" className="mt-2" onClick={() => void reload()}>
        <ArrowClockwise size={13} weight="regular" />
        {reloading ? 'Checking…' : 'Reload'}
      </Button>
    </div>
  ) : null

  // Keyboard resizing goes through the same clamp as the drag, so the two
  // cannot disagree about what fits. Left widens (the edge moves left), right
  // narrows, and a width that does not move - a pinned window - commits nothing,
  // exactly like a drag that goes nowhere.
  const stepResize = (direction: -1 | 1): void => {
    const next = dragDockWidth(shown, 0, 20 * direction, window.innerWidth)
    if (next === shown) return
    setAiDockWidth(next, window.innerWidth)
  }

  return (
    <aside
      style={{ width: shown }}
      className="relative flex h-full min-w-0 shrink-0 flex-col border-l border-line bg-surface"
    >
      <div
        role="slider"
        aria-label="Assistant panel width"
        aria-orientation="vertical"
        aria-valuemin={DOCK_MIN_WIDTH}
        aria-valuemax={DOCK_MAX_WIDTH}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${Math.round(shown)} pixels wide. Arrow keys resize, double-click resets.`}
        tabIndex={0}
        onPointerDown={startResize}
        onDoubleClick={() => setAiDockWidth(360, window.innerWidth)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            stepResize(-1)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            stepResize(1)
          }
        }}
        title="Drag to resize. Arrow keys resize, double-click resets."
        className="absolute -left-0.5 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors duration-150 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      />

      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Sparkle size={14} weight="fill" className="shrink-0 text-accent-text" />
        <span className="shrink-0 text-[12px] font-semibold">AI assistant</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">{status}</span>
        <IconButton label="Collapse AI" onClick={toggleAi} className="shrink-0">
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
              <div className="flex flex-col gap-3 text-[12px] leading-relaxed text-ink-3">
                <p>
                  Everything here runs on this machine. Ask about your library and the assistant can use it — find
                  photos, read the bin, set a wallpaper, open something.
                  {visionReady ? ' Selected photos are sent to the vision model as pictures.' : ''}
                </p>
                {noModelNote}
                {modelReady ? (
                  <div className="flex flex-wrap gap-1.5">
                    {EXAMPLES.map((example) => (
                      <button
                        key={example}
                        type="button"
                        disabled={thinking}
                        onClick={() => {
                          // One click asks, not two: filling the composer and
                          // waiting for Enter turned the empty state into a form
                          // to decipher rather than something to try.
                          if (!modelReady || thinking) return
                          void sendAiMessage(example)
                        }}
                        className="rounded-full border border-line px-2.5 py-1 text-[11px] text-ink-2 transition-colors duration-150 hover:bg-tint hover:text-ink disabled:opacity-50"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {messages.map((message, index) => {
                  // An assistant bubble with no text yet is the streaming placeholder;
                  // the status line above already says a reply is coming.
                  if (message.role === 'assistant' && message.content === '' && thinking) return null
                  const mine = message.role === 'user'
                  // A failed or stopped answer gets a way back: without it the only
                  // recovery is retyping the question from memory.
                  const retryable =
                    !mine &&
                    !thinking &&
                    (message.content.startsWith('Error:') || message.content === 'Stopped.')
                  return (
                    <div key={index} className={mine ? 'ml-8' : 'mr-8'}>
                      <div
                        className={
                          mine
                            ? 'rounded-[10px] rounded-br-[3px] bg-tint px-3 py-2 text-[12px] leading-relaxed text-ink'
                            : 'whitespace-pre-wrap rounded-[10px] rounded-bl-[3px] border border-line bg-raised px-3 py-2 text-[12px] leading-relaxed text-ink-2'
                        }
                      >
                        {message.content}
                      </div>
                      {retryable ? (
                        <button
                          type="button"
                          onClick={() => void retryAiMessage()}
                          className="mt-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2 transition-colors duration-150 hover:bg-tint hover:text-ink"
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  )
                })}
                {thinking ? (
                  <div className="mr-8 flex items-center gap-1.5 pl-1 text-[11px] text-ink-3" role="status">
                    <span className="flex gap-1">
                      <Dot delay="0ms" />
                      <Dot delay="150ms" />
                      <Dot delay="300ms" />
                    </span>
                    {activity ? activity.label : 'Thinking'}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <footer className="shrink-0 border-t border-line p-2">
            <div className="flex items-end gap-1.5">
              <textarea
                ref={composerRef}
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
                placeholder={modelReady ? 'Ask about your library…' : 'Add a model to chat'}
                aria-label="Message the AI assistant"
                className="min-h-[44px] min-w-0 flex-1 resize-none rounded-[8px] border border-line bg-raised px-2.5 py-2 text-[12px] text-ink placeholder:text-ink-3 transition-colors duration-150 focus:border-line-strong focus:outline-none disabled:opacity-50"
              />
              {thinking ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mb-0.5 shrink-0 px-2"
                  onClick={cancelAiMessage}
                  aria-label="Stop response"
                >
                  <X size={14} weight="regular" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="accent"
                  className="mb-0.5 shrink-0 px-2"
                  disabled={!modelReady || thinking || draft.trim() === ''}
                  onClick={submit}
                  aria-label="Send message"
                >
                  <PaperPlaneRight size={14} weight="regular" />
                </Button>
              )}
            </div>
            <p className="mt-1.5 px-0.5 text-[10px] text-ink-3">
              {thinking ? 'Stop ends the current response' : 'Enter sends · Shift+Enter for a new line'}
            </p>
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
                disabled={selectedCount === 0 || aiTagging || !toolsAllowed}
                onClick={() => void tagSelection()}
              >
                <Tag size={13} weight="regular" />
                {aiTagging
                  ? 'Tagging…'
                  : selectedCount > AUTOTAG_LIMIT
                    ? `Suggest tags (first ${tagTargets} of ${selectedCount})`
                    : `Suggest tags (${selectedCount})`}
              </Button>
              {!toolsAllowed ? (
                <span className="text-[11px]">Agent tools are blocked for this profile. Turn them on in Settings to suggest tags.</span>
              ) : aiTagNote ? (
                <span className="text-[11px]">{aiTagNote}</span>
              ) : selectedCount === 0 ? (
                <span className="text-[11px]">Select photos in the grid first.</span>
              ) : null}
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
    </aside>
  )
}

/** One of three dots in the thinking row, staggered so they read as a pulse. */
function Dot({ delay }: { delay: string }) {
  return (
    <span
      style={{ animationDelay: delay }}
      className="h-1 w-1 animate-pulse rounded-full bg-ink-3"
    />
  )
}