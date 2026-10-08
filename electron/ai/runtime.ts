/**
 * The local llama.cpp runtime.
 *
 * OpenPics ships `llama-server.exe` (see scripts/fetch-llama.mjs) and drives it
 * over its loopback HTTP API. A server rather than one process per message: the
 * GGUF's own chat template is applied by llama-server, and keeping the model
 * resident means the second question is answered without re-reading half a
 * gigabyte from disk.
 *
 * Nothing here leaves the machine. The server binds 127.0.0.1 on a port chosen
 * free at launch and is started as soon as the app is ready, then kept warm for
 * the whole session: the weights stay resident so the first question after a
 * pause is answered without re-reading half a gigabyte from disk. A watchdog
 * pings it and restarts it if it ever dies, and it is stopped only on quit.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { getLlamaDir, getLlamaServerPath } from './paths'
import type { AiToolSpec } from '../../core/ai-tools'
import { StreamAssembler, toWireMessages, type ChatMessage, type ChatResult, type ToolCall } from '../../core/ai-wire'

// The message shape and the stream parser live in core/ai-wire.ts, where the
// tests can reach them; they are re-exported here because callers already import
// them from this file.
export type { ChatMessage, ChatResult, ToolCall }

export type ChatOptions = {
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  /** When set, the server is started with this projector so it can read images. */
  mmprojPath?: string
  /**
   * Function schemas the model may call. Omitted entirely when there is nothing
   * to offer: sending an empty array makes some templates believe tools exist
   * and exist in a form it cannot satisfy.
   */
  tools?: AiToolSpec[]
  /**
   * Cancels the HTTP stream and, through the callers, the tool loop. The signal
   * is how the Stop button reaches a generation that is already on the wire.
   */
  signal?: AbortSignal
}

/** Thrown when the user stops a request rather than when the request fails. */
export class ChatCancelledError extends Error {
  constructor() {
    super('The chat request was cancelled.')
    this.name = 'ChatCancelledError'
  }
}

/** How often the watchdog checks the resident server is still healthy. */
const KEEPALIVE_INTERVAL_MS = 60 * 1000
/** The probe is local and cheap, but a saturated CPU can slow it; be generous. */
const KEEPALIVE_TIMEOUT_MS = 10 * 1000
/** A cold load of a 0.5B Q4 model is quick; this is generous for a slow disk. */
const STARTUP_TIMEOUT_MS = 120 * 1000

let child: ChildProcess | null = null
let port = 0
let runningModel: string | null = null
let runningMmproj: string | null = null
let starting: Promise<number> | null = null
let keepAlive: NodeJS.Timeout | null = null
/** The weights we want resident; the watchdog restarts the server to match this. */
let wantedModel: string | null = null
let wantedMmproj: string | null = null
let lastError: string | null = null
const recentLog: string[] = []

function remember(line: string): void {
  const trimmed = line.trim()
  if (trimmed === '') return
  recentLog.push(trimmed)
  if (recentLog.length > 40) recentLog.shift()
}

function tail(): string {
  return recentLog.slice(-8).join('\n')
}

export function isRuntimeRunning(): boolean {
  return child !== null && port > 0
}

export function getRuntimeError(): string | null {
  return lastError
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(chosen))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function waitForHealth(serverPort: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`the local AI runtime exited during startup${tail() ? `\n${tail()}` : ''}`)
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const res = await fetch(`http://127.0.0.1:${serverPort}/health`, { signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) {
        const body = (await res.json()) as { status?: string }
        if (body.status === 'ok') return
      }
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    await sleep(250)
  }
  throw new Error(`the local AI runtime did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s`)
}

function stopKeepAlive(): void {
  if (keepAlive) {
    clearInterval(keepAlive)
    keepAlive = null
  }
}

function startKeepAlive(): void {
  if (keepAlive) return
  keepAlive = setInterval(() => {
    void keepWarm()
  }, KEEPALIVE_INTERVAL_MS)
  keepAlive.unref?.()
}

/**
 * Confirm the resident server is still answering and bring it back if not.
 *
 * The model is meant to stay loaded for the whole session, so a check that only
 * observed would leave a crashed server dead until the user asked a question.
 * When the probe fails the process is killed and the weights we want are loaded
 * again; `ensureRuntime` collapses concurrent restarts.
 */
async function keepWarm(): Promise<void> {
  if (!wantedModel || starting) return
  if (isRuntimeRunning()) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), KEEPALIVE_TIMEOUT_MS)
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) return
    } catch {
      // Unreachable or unhappy; fall through and restart it.
    }
    stopKeepAlive()
    killRuntime()
  }
  try {
    await ensureRuntime(wantedModel, wantedMmproj ?? undefined)
  } catch {
    // `ensureRuntime` already stopped the runtime; the next request retries.
  }
}

async function start(modelPath: string, mmprojPath: string | null): Promise<number> {
  const exe = getLlamaServerPath()
  if (!existsSync(exe)) {
    throw new Error(
      'The local AI runtime is missing. Run "npm run llama" in a checkout, or reinstall the app.'
    )
  }

  const chosen = await freePort()
  const threads = Math.max(2, Math.min(8, cpus().length - 1))
  const args = [
    '-m',
    modelPath,
    '-c',
    '4096',
    '-t',
    String(threads),
    '--host',
    '127.0.0.1',
    '--port',
    String(chosen)
  ]
  if (mmprojPath) {
    // Reading photos. The projector is passed explicitly so no network fetch is
    // attempted; `--mmproj-auto` belongs to the download-on-demand mode.
    args.push('--mmproj', mmprojPath, '--no-mmproj-auto')
  } else {
    // A text-only request against a possibly multimodal model must not make
    // llama-server reach for the internet to find a projector.
    args.push('--no-mmproj')
  }

  recentLog.length = 0
  const proc = spawn(exe, args, {
    cwd: getLlamaDir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child = proc
  port = chosen
  runningModel = modelPath
  runningMmproj = mmprojPath
  wantedModel = modelPath
  wantedMmproj = mmprojPath

  proc.stdout?.on('data', (chunk: Buffer) => remember(chunk.toString()))
  proc.stderr?.on('data', (chunk: Buffer) => remember(chunk.toString()))
  proc.on('exit', () => {
    const wasRunning = child === proc
    if (wasRunning) {
      child = null
      port = 0
      runningModel = null
      runningMmproj = null
    }
  })
  proc.on('error', (err) => {
    lastError = err.message
    if (child === proc) {
      child = null
      port = 0
      runningModel = null
      runningMmproj = null
    }
  })

  try {
    await waitForHealth(chosen, proc)
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    stopRuntime()
    throw err
  }

  lastError = null
  startKeepAlive()
  return chosen
}

/**
 * Points the runtime at a model, restarting the server if it is serving another.
 *
 * A conversation without photos stays on the small text model; one with photos
 * switches to the vision model. The two are never resident at once, so the app
 * pays for the weights it is actually using. Whatever is loaded is then held
 * warm for the rest of the session by the watchdog.
 */
export async function ensureRuntime(modelPath: string, mmprojPath?: string): Promise<number> {
  const mmproj = mmprojPath ?? null
  wantedModel = modelPath
  wantedMmproj = mmproj
  if (isRuntimeRunning()) {
    if (runningModel === modelPath && runningMmproj === mmproj) {
      startKeepAlive()
      return port
    }
    // Serving the wrong weights; the next request needs the other model.
    killRuntime()
  }
  if (starting) await starting
  if (isRuntimeRunning()) {
    if (runningModel === modelPath && runningMmproj === mmproj) {
      startKeepAlive()
      return port
    }
    killRuntime()
  }
  if (!starting) {
    starting = start(modelPath, mmproj).finally(() => {
      starting = null
    })
  }
  return starting
}

/**
 * Streams a completion, invoking `onDelta` as text arrives.
 *
 * Returns the text plus any tool calls the model asked for. Deltas are what make
 * the dock feel alive; the return value is what the store settles on so a dropped
 * delta cannot leave a half-written answer on screen.
 *
 * Tool calls arrive as fragments in the same stream as the text: the name once,
 * then the JSON arguments a few characters at a time, tagged by index. They are
 * accumulated here rather than in the caller so that the shape of the wire
 * protocol stops at this file.
 */
export async function chatWithTools(
  modelPath: string,
  options: ChatOptions,
  onDelta: (delta: string) => void,
  signal: AbortSignal | undefined = options.signal
): Promise<ChatResult> {
  const serverPort = await ensureRuntime(modelPath, options.mmprojPath)
  if (signal?.aborted) throw new ChatCancelledError()
  const tools = options.tools ?? []

  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${serverPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Not the internal objects: `toWireMessages` renames the tool fields into
        // the snake_case the API reads. See core/ai-wire.ts for why that has to
        // happen here rather than being left to the JSON.
        messages: toWireMessages(options.messages),
        max_tokens: options.maxTokens ?? 512,
        temperature: options.temperature ?? 0.7,
        stream: true,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
      }),
      signal
    })
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      throw new ChatCancelledError()
    }
    throw err
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new Error(`the local AI returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const assembler = new StreamAssembler(onDelta)

  // Returns true once the stream has ended, so the read loop can stop early.
  const consume = (line: string): boolean => {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:') && trimmed.slice(5).trim() === '[DONE]') return true
    assembler.push(line)
    return false
  }

  try {
    let done = false
    while (!done) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {})
        throw new ChatCancelledError()
      }
      const { value, done: finished } = await reader.read()
      if (finished) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (consume(line)) {
          done = true
          break
        }
        newline = buffer.indexOf('\n')
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    if (signal?.aborted || err instanceof ChatCancelledError || (err instanceof DOMException && err.name === 'AbortError')) {
      throw new ChatCancelledError()
    }
    throw err
  }
  // A server that closes without sending [DONE] still leaves a last frame sitting
  // in the buffer, so the tail is drained rather than dropped.
  if (!signal?.aborted && buffer.trim() !== '') {
    for (const line of buffer.split('\n')) consume(line.replace(/\r$/, ''))
  }
  if (signal?.aborted) throw new ChatCancelledError()

  return assembler.result()
}

/**
 * Chat without tools, for the callers that only ever want text.
 *
 * Autotagging and the vision path both want a completion, not a conversation, and
 * giving them the tool loop would mean a picture caption could turn into a
 * wallpaper change.
 */
export async function chat(
  modelPath: string,
  options: ChatOptions,
  onDelta: (delta: string) => void,
  signal: AbortSignal | undefined = options.signal
): Promise<string> {
  const result = await chatWithTools(modelPath, options, onDelta, signal)
  return result.text
}

/** Kill the child and forget it, without touching the keep-alive intent. */
function killRuntime(): void {
  const proc = child
  child = null
  port = 0
  runningModel = null
  runningMmproj = null
  if (proc && proc.exitCode === null) {
    try {
      proc.kill()
    } catch {
      // Already gone.
    }
  }
}

/**
 * Load the weights now and keep them resident, if not already serving them.
 *
 * Called once at launch so the model is ready before the user's first question,
 * and again by the watchdog. Returns false rather than throwing when the runtime
 * or model is missing, so a broken install still opens the app.
 */
export async function warmRuntime(modelPath: string, mmprojPath?: string): Promise<boolean> {
  try {
    await ensureRuntime(modelPath, mmprojPath)
    return true
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    return false
  }
}

/** Shut the server down for good, e.g. when the app quits. */
export function stopRuntime(): void {
  stopKeepAlive()
  wantedModel = null
  wantedMmproj = null
  killRuntime()
}
