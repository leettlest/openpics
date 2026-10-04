import { nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { loadSettings } from '../settings'
import { pickDefaultModel } from './manager'
import { getVisionMmprojPath, getVisionModelPath } from './paths'
import { ensurePromptFile, readPromptFile } from './prompt'
import { chat, getRuntimeError, isRuntimeRunning, stopRuntime, warmRuntime, type ChatMessage } from './runtime'
import { buildVisionMessage, MAX_VISION_IMAGES } from '../../shared/ai-vision'
import type { AiChatContext, AiChatReply } from '../../shared/ai-types'

export type AiState = {
  ready: boolean
  visionReady: boolean
  modelPath: string | null
  modelName: string | null
  promptPath: string | null
  thinking: boolean
  lastError: string | null
}

let state: AiState = {
  ready: false,
  visionReady: false,
  modelPath: null,
  modelName: null,
  promptPath: null,
  thinking: false,
  lastError: null,
}

function getSettings() {
  return loadSettings()
}

function nameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function getAiState(): AiState {
  return { ...state }
}

export async function initAi(): Promise<AiState> {
  try {
    const settings = getSettings()
    const promptPath = await ensurePromptFile()
    let modelPath = settings.aiModelPath
    // A model path in settings can point at a file the user has since moved, so
    // it is only trusted while it still exists; otherwise fall back to whatever
    // the package shipped.
    if (modelPath && !existsSync(modelPath)) modelPath = ''
    if (!modelPath) {
      const def = pickDefaultModel()
      if (def) modelPath = def.path
    }
    state = {
      ready: !!modelPath,
      visionReady: !!(getVisionModelPath() && getVisionMmprojPath()),
      modelPath: modelPath || null,
      modelName: modelPath ? nameOf(modelPath) : null,
      promptPath,
      thinking: false,
      lastError: modelPath ? null : 'No local model was found.'
    }
    return getAiState()
  } catch (e: unknown) {
    state = { ...state, ready: false, lastError: e instanceof Error ? e.message : 'init failed' }
    return getAiState()
  }
}

export async function ensureReady(): Promise<boolean> {
  if (!state.ready) {
    await initAi()
  }
  return state.ready
}

/**
 * Load the default model now instead of on the first question.
 *
 * Called once at launch: the weights are read from disk while the user is still
 * orienting themselves and the server is left resident for the whole session.
 * Failures are quiet, because a missing model must not stop the app from opening
 * and the next real request will surface the reason in the dock.
 */
export async function warmAi(): Promise<boolean> {
  if (!(await ensureReady()) || !state.modelPath) return false
  return warmRuntime(state.modelPath)
}

/** Prompt text the user can edit, with a fallback if the file cannot be read. */
function systemPrompt(): string {
  try {
    const text = readPromptFile()
    if (text && text.trim() !== '') return text
  } catch {
    // Fall through to the built-in default.
  }
  return 'You are the assistant built into OpenPics, a local photo browser. Answer briefly and helpfully.'
}

/** A short, factual note about the photos the user is asking about. */
function contextNote(context?: AiChatContext): string | null {
  const paths = context?.paths ?? []
  if (paths.length === 0) return null
  const names = paths.slice(0, 20).map((p) => nameOf(p))
  const more = paths.length > names.length ? ` (and ${paths.length - names.length} more)` : ''
  return `The user has selected ${paths.length} photo${paths.length === 1 ? '' : 's'}: ${names.join(', ')}${more}.`
}

/**
 * Re-encode one photo as a small JPEG `data:` URL.
 *
 * A full-resolution photo is needless tokens and slow to encode on a CPU, so the
 * longest edge is capped before encoding. Anything Electron cannot decode as an
 * image - a video, a file that has since moved - returns null and is left out of
 * the request rather than failing the whole message.
 */
const VISION_MAX_EDGE = 512

export function imageDataUrl(path: string): string | null {
  try {
    let image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return null
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    if (longest > VISION_MAX_EDGE) {
      const scale = VISION_MAX_EDGE / longest
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good'
      })
    }
    return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`
  } catch {
    return null
  }
}

/** The first few readable photos among the selection, as inline images. */
function attachedImages(context?: AiChatContext): string[] {
  const urls: string[] = []
  for (const path of context?.paths ?? []) {
    if (urls.length >= MAX_VISION_IMAGES) break
    const url = imageDataUrl(path)
    if (url) urls.push(url)
  }
  return urls
}

/**
 * Answer one message, streaming pieces through `onDelta`.
 *
 * History comes from the renderer because it already holds the visible
 * conversation; main only assembles the request. When photos are attached and
 * the bundled vision model is present, the message carries the images and runs
 * on that model; otherwise it is a text question answered by the smaller model.
 */
export async function chatAi(
  message: string,
  context: AiChatContext | undefined,
  onDelta: (delta: string) => void
): Promise<AiChatReply> {
  if (!(await ensureReady()) || !state.modelPath) {
    return {
      content:
        state.lastError ??
        'No local model is available, so I cannot answer. Run "npm run model" in a checkout or reinstall the app.'
    }
  }

  const images = state.visionReady ? attachedImages(context) : []
  const visionModel = images.length > 0 ? getVisionModelPath() : null
  const visionMmproj = images.length > 0 ? getVisionMmprojPath() : null
  const useVision = visionModel !== null && visionMmproj !== null
  const modelPath = useVision ? visionModel : state.modelPath

  const note = contextNote(context)
  const promptText = note ? `${note}\n\n${message}` : message
  const messages: ChatMessage[] = []

  if (useVision) {
    // SmolVLM's template has no system role, so the instruction is folded into
    // the user turn instead. Earlier turns stay plain text and are still useful.
    for (const turn of context?.history ?? []) {
      if (turn.content.trim() === '') continue
      messages.push({ role: turn.role, content: turn.content })
    }
    messages.push({
      role: 'user',
      content: buildVisionMessage(
        `${systemPrompt()}\n\nAnswer conversationally. ${promptText}`,
        images
      )
    })
  } else {
    messages.push({ role: 'system', content: systemPrompt() })
    for (const turn of context?.history ?? []) {
      if (turn.content.trim() === '') continue
      messages.push({ role: turn.role, content: turn.content })
    }
    messages.push({ role: 'user', content: promptText })
  }

  state = { ...state, thinking: true, lastError: null }
  try {
    const reply = await chat(
      modelPath,
      { messages, maxTokens: useVision ? 256 : 512, mmprojPath: visionMmproj ?? undefined },
      onDelta
    )
    state = { ...state, thinking: false }
    return { content: reply }
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e)
    state = { ...state, thinking: false, lastError: detail }
    throw e
  }
}

/** Shut the runtime down; called when the app quits so no child is orphaned. */
export function stopAi(): void {
  stopRuntime()
}

export function aiRuntimeRunning(): boolean {
  return isRuntimeRunning()
}

export function aiRuntimeError(): string | null {
  return getRuntimeError()
}
