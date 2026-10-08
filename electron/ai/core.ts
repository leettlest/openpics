import { nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { loadSettings, saveSettings } from '../settings'
import { pickDefaultModel } from './manager'
import { getVisionMmprojPath, getVisionModelPath } from './paths'
import { ensurePromptFile, readPromptFile } from './prompt'
import { ChatCancelledError, chat, chatWithTools, getRuntimeError, isRuntimeRunning, stopRuntime, warmRuntime, type ChatMessage } from './runtime'
import { buildVisionMessage, MAX_VISION_IMAGES } from '../../shared/ai-vision'
import { AI_TOOL_SPECS, runToolLoop } from '../../core/ai-tools'
import { basenameOf } from '../../shared/paths'
import { runAiTool, toolLabel } from './tools'
import type { AiChatContext, AiChatReply, AiToolActivity } from '../../shared/ai-types'

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
      modelName: modelPath ? basenameOf(modelPath) : null,
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
 * Switch the chat model to another file, for real this time.
 *
 * The previous handler built a new state object and returned it without saving,
 * validating, or restarting anything, so the caller was told `ready: true` for a
 * path that might not exist while the runtime kept serving the old weights.
 * This validates the file, persists the choice, restarts the resident server
 * onto the new weights, and reports the warmed state - so `ready: true` means a
 * question asked right now will be answered by this model.
 */
export async function setAiModel(path: string): Promise<AiState> {
  const trimmed = path.trim()
  if (trimmed === '' || !existsSync(trimmed)) {
    throw new Error(
      `Model file not found: ${path.trim() === '' ? '(no path given)' : path}. Put a .gguf file in the bundled models folder and try again.`
    )
  }
  saveSettings({ aiModelPath: trimmed })
  // The resident server holds the old weights mapped; it has to go before the
  // new file can be served. Stopping first also means a failed warm leaves no
  // server running, rather than one serving the wrong model.
  stopRuntime()
  state = {
    ...state,
    modelPath: trimmed,
    modelName: basenameOf(trimmed),
    ready: true,
    thinking: false,
    lastError: null
  }
  const warmed = await warmRuntime(trimmed)
  if (!warmed) {
    state = { ...state, ready: false, lastError: getRuntimeError() ?? 'The model file exists but could not be started.' }
  }
  return getAiState()
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

/**
 * Prompt text the user can edit, with a fallback if the file cannot be read.
 *
 * The fallback is deliberately plain about what the assistant is and says nothing
 * about where it runs. Running on the user's own machine is an implementation
 * detail of the app, not a limitation to volunteer, and repeating it reads as an
 * apology attached to every reply.
 */
function systemPrompt(): string {
  try {
    const text = readPromptFile()
    if (text && text.trim() !== '') return text
  } catch {
    // Fall through to the built-in default.
  }
  return [
    'You are the assistant built into OpenPics, the app the user is looking at.',
    'You can see the photos they have selected and you have tools that search their library,',
    'read file details, set a wallpaper, and open files in Explorer or their default app.',
    'Use a tool whenever a question is about their own files; never guess at a file name or path.',
    'Keep replies short and plain, do not describe your own abilities unless asked, and never open',
    'with a disclaimer.'
  ].join(' ')
}

/**
 * The same switch that gates MCP also gates the dock assistant's tools.
 *
 * One switch, one meaning: a user who has blocked agent tools should not find the
 * assistant in their own dock able to change the desktop background anyway. Tag
 * suggestions are gated too - they send pictures to the model and write tags -
 * while similarity search is not: it is local arithmetic with no model involved.
 */
export function toolsEnabled(): boolean {
  try {
    return loadSettings().enableMcp !== false
  } catch {
    return false
  }
}

/** A short, factual note about the photos the user is asking about. */
function contextNote(context?: AiChatContext): string | null {
  const paths = context?.paths ?? []
  if (paths.length === 0) return null
  const shown = paths.slice(0, 20)
  const names = shown.map((p) => basenameOf(p))
  const more = paths.length > shown.length ? ` (and ${paths.length - shown.length} more)` : ''
  // Names for reading, full paths for acting: tools only accept a path from the
  // snapshot or from this list, so a name without its path is a dead end the
  // model can only guess at. Twenty is the most a person usefully selects.
  return `The user has selected ${paths.length} photo${paths.length === 1 ? '' : 's'}: ${names.join(', ')}${more}. Their full paths, usable with tools: ${shown.join(', ')}.`
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
 * How many times the model may ask for tools before we answer anyway.
 *
 * Every round is a whole generation on a 0.5B model, so an unbounded loop is a
 * hang behind a spinner rather than a visible failure. Three covers the real
 * shapes - look the file up, check it, then act on it - and stops short of the
 * circle where the model re-runs the same search because the answer did not say
 * what it expected.
 */
const MAX_TOOL_ROUNDS = 3

/**
 * Answer one message, streaming pieces through `onDelta`.
 *
 * History comes from the renderer because it already holds the visible
 * conversation; main only assembles the request. When photos are attached and the
 * bundled vision model is present, the message carries the images and runs on that
 * model; otherwise it is a text question answered by the smaller model.
 *
 * Tools are offered on the text path only. The vision model is a captioner whose
 * chat template has no room for function definitions, so offering tools there
 * would produce calls nothing could answer.
 */
export async function chatAi(
  message: string,
  context: AiChatContext | undefined,
  onDelta: (delta: string) => void,
  onActivity?: (activity: AiToolActivity | null) => void,
  signal?: AbortSignal
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
        // Tools are not offered on this path - the vision template has no room
        // for function definitions - so say so outright. Otherwise the prompt's
        // standing "use a tool" instruction makes the model promise searches it
        // cannot run, and the user watches it describe files it never looked up.
        `${systemPrompt()}\n\nAnswer conversationally. You cannot use tools for this question: describe only what is visible in the attached pictures and the file names and paths given above. ${promptText}`,
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
    if (signal?.aborted) throw new ChatCancelledError()
    const maxTokens = useVision ? 256 : 512
    const reply = useVision
      ? await chat(modelPath, { messages, maxTokens, mmprojPath: visionMmproj ?? undefined }, onDelta, signal)
      : await answerWithTools(modelPath, messages, context, maxTokens, onDelta, onActivity, signal)
    state = { ...state, thinking: false }
    return { content: reply }
  } catch (e: unknown) {
    if (e instanceof ChatCancelledError || signal?.aborted) {
      state = { ...state, thinking: false }
      throw new ChatCancelledError()
    }
    const detail = e instanceof Error ? e.message : String(e)
    state = { ...state, thinking: false, lastError: detail }
    throw e
  }
}

/**
 * The tool loop: generate, run whatever it asked for, generate again.
 *
 * Text streamed before a call is kept. "Let me find that" arriving before the
 * search runs is the difference between an assistant that is working and one that
 * has gone quiet for eight seconds.
 */
async function answerWithTools(
  modelPath: string,
  messages: ChatMessage[],
  context: AiChatContext | undefined,
  maxTokens: number,
  onDelta: (delta: string) => void,
  onActivity: ((activity: AiToolActivity | null) => void) | undefined,
  signal?: AbortSignal
): Promise<string> {
  const tools = toolsEnabled() ? AI_TOOL_SPECS : []
  try {
    const { reply, stopped } = await runToolLoop(messages, MAX_TOOL_ROUNDS, {
      generate: async (msgs) => {
        // The gap label belongs to a finished tool, not to the generation that
        // follows it, so it clears when the next round starts.
        onActivity?.(null)
        if (signal?.aborted) throw new ChatCancelledError()
        const result = await chatWithTools(modelPath, { messages: msgs, maxTokens, tools }, onDelta, signal)
        return { text: result.text, toolCalls: result.toolCalls }
      },
      act: async (call) => {
        if (signal?.aborted) throw new ChatCancelledError()
        onActivity?.({ name: call.name, label: toolLabel(call.name) })
        return runAiTool(call.name, call.arguments, context)
      }
    })
    if (!stopped) return reply
    // Rounds, not calls: one round can carry several calls, and promising a number
    // of calls would be a promise the loop does not keep.
    const capped = `I stopped after ${MAX_TOOL_ROUNDS} rounds of tool use. Tell me where to go from here.`
    return reply.trim() === '' ? capped : `${reply}\n\n${capped}`
  } finally {
    onActivity?.(null)
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
