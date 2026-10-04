/**
 * The wire shape for a vision request, kept separate from the runtime so it can
 * be tested without Electron.
 *
 * llama-server speaks the OpenAI chat format, where a user message may be a
 * string or a list of parts. A part is either `text` or an `image_url` whose URL
 * is a `data:` URI, so the bytes ride inside the JSON body and never touch the
 * network. This mirrors that format exactly; the names are not ours to choose.
 */

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * Four photos is enough to answer "what are these", and each one costs the
 * vision encoder time on a CPU. More than this and the wait stops being worth
 * it, so the caller caps the selection rather than the user finding out slowly.
 */
export const MAX_VISION_IMAGES = 4

/**
 * The prompt text followed by the images it refers to.
 *
 * The text part comes first on purpose: the model reads the question before it
 * sees the pixels, which measurably improves short answers on SmolVLM, and it
 * keeps a text-free fallback meaningful when no images decode.
 */
export function buildVisionMessage(text: string, imageDataUrls: readonly string[]): ChatContentPart[] {
  const parts: ChatContentPart[] = [{ type: 'text', text }]
  for (const url of imageDataUrls) {
    parts.push({ type: 'image_url', image_url: { url } })
  }
  return parts
}

/** True when a URL is an inlined image, i.e. one this app produced. */
export function isInlineImage(url: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(url)
}
