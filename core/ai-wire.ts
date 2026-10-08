/**
 * The conversation as it goes over the wire, and the streaming that produces it.
 *
 * This exists as its own file, in `core/`, for two reasons that both cost
 * something the first time they were wrong:
 *
 * 1. The internal message shape is camelCase and the API is not. `toolCalls` and
 *    `toolCallId` are what the rest of the app reads; `tool_calls` and
 *    `tool_call_id` are what llama-server reads. Serialising the internal objects
 *    straight through `JSON.stringify` does not fail loudly - the server simply
 *    never sees that a tool was called, answers the question again, and the tool
 *    loop quietly does nothing. The rename happens here, once, at the boundary.
 *
 * 2. Streamed tool calls arrive as fragments that have to be stitched back
 *    together by index before they mean anything. That is pure string work, and it
 *    belongs somewhere the node test build can reach - `electron/` is not compiled
 *    into it.
 */

import type { ChatContentPart } from '../shared/ai-vision'

/** One tool call the model asked for, reassembled from the stream fragments. */
export type ToolCall = {
  id: string
  name: string
  /** Raw JSON text as the model produced it; parsed by the tool layer. */
  arguments: string
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * A string for text turns, OpenAI-style parts when images are attached, or
   * null on an assistant turn that is only a tool call - which is how the API
   * expects a call to be answered, and sending "" instead makes some templates
   * answer the question a second time.
   */
  content: string | ChatContentPart[] | null
  /** Set on an assistant turn that requested tools. */
  toolCalls?: ToolCall[]
  /** Set on a tool turn, tying the result back to the call that asked for it. */
  toolCallId?: string
}

/** One message as the chat API wants it: the same data, snake_cased. */
type WireMessage = {
  role: ChatMessage['role']
  content: string | ChatContentPart[] | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/**
 * Rename the tool fields on their way out, and drop the empty ones.
 *
 * Absent rather than empty matters here. An assistant turn that called a tool has
 * `content: null` and a `tool_calls` array; a tool turn has the text and an id.
 * Sending `tool_calls: []` on a plain message, or `tool_call_id: ''` on a user
 * message, invites the template to add tool plumbing that does not belong.
 */
export function toWireMessages(messages: readonly ChatMessage[]): WireMessage[] {
  return messages.map((message) => {
    const wire: WireMessage = { role: message.role, content: message.content }
    if (message.toolCalls && message.toolCalls.length > 0) {
      wire.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments }
      }))
    }
    if (message.toolCallId !== undefined && message.toolCallId !== '') {
      wire.tool_call_id = message.toolCallId
    }
    return wire
  })
}

/** What one streamed completion produced. */
export type ChatResult = {
  text: string
  toolCalls: ToolCall[]
}

/**
 * Give every call an id, inventing one where the model did not send any.
 *
 * The id is how a tool result is matched back to the call that asked for it, and
 * a result without one is a message the model has no way to place. Small models
 * sometimes omit it, and a dropped id would otherwise show up as the tool working
 * and the assistant answering as if it had never heard of it. Inventing here
 * rather than at the point of use keeps the assistant turn and the result
 * carrying the same id, which is the only thing that makes them a pair.
 */
export function normalizeToolCalls(calls: readonly ToolCall[], round = 0): ToolCall[] {
  const seen = new Set<string>()
  return calls.map((call, index) => {
    let id = call.id.trim()
    if (id === '' || seen.has(id)) id = `call_${round}_${index}`
    seen.add(id)
    return id === call.id ? call : { ...call, id }
  })
}

/**
 * Collects streamed deltas into one reply.
 *
 * Held apart from the fetch loop so it can be tested without a socket: the loop
 * only decides where a line ends, and everything that decides what a line means
 * happens here.
 */
export class StreamAssembler {
  private text = ''
  private readonly calls = new Map<number, ToolCall>()
  private readonly onDelta: (delta: string) => void

  constructor(onDelta: (delta: string) => void = () => {}) {
    this.onDelta = onDelta
  }

  /**
   * Feed one SSE `data:` payload, or any line at all - lines that are not data
   * carry nothing and are ignored, so the caller can pass the whole frame.
   */
  push(line: string): void {
    // Some servers indent or pad their frames. The meaning of a line does not
    // live in its leading whitespace, so it is stripped before the check rather
    // than letting a padded frame silently drop a tool call or a sentence.
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    let parsed: StreamFrame
    try {
      parsed = JSON.parse(payload) as StreamFrame
    } catch {
      // A partial frame. The next read completes it, and dropping this half is
      // what keeps a split JSON object from aborting the whole reply.
      return
    }
    const choice = parsed.choices?.[0]
    const delta = choice?.delta
    const piece = delta?.content ?? choice?.text ?? ''
    if (piece) {
      this.text += piece
      this.onDelta(piece)
    }
    for (const fragment of delta?.tool_calls ?? []) {
      // The model emits one call split across many frames, sometimes with the
      // name itself in pieces, so fragments accumulate by index rather than
      // replacing each other.
      const index = typeof fragment.index === 'number' ? fragment.index : 0
      const held = this.calls.get(index) ?? { id: '', name: '', arguments: '' }
      if (fragment.id) held.id = fragment.id
      if (fragment.function?.name) held.name += fragment.function.name
      if (fragment.function?.arguments) held.arguments += fragment.function.arguments
      this.calls.set(index, held)
    }
  }

  /**
   * What was collected.
   *
   * Only calls that named a tool are real: a fragment with an id but no name is a
   * template artefact, and running it would call a function called "".
   */
  result(): ChatResult {
    const toolCalls = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((call) => call.name !== '')
    return { text: this.text, toolCalls }
  }
}

type StreamFrame = {
  choices?: Array<{
    delta?: {
      content?: string
      text?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    text?: string
  }>
}