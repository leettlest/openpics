/**
 * Tag parsing, kept apart from the AI runtime so it can be tested under plain
 * Node.
 *
 * The model answers free-form text ("sunset, beach ,Sunset\n", or a whole
 * sentence when it misbehaves), so every suggestion has to be cut down to the
 * same shape before it can be stored or filter on. A tag is one lowercase word
 * or short phrase; anything longer is the model talking, not tagging.
 */

/** Longest tag accepted, in characters. A label, not a caption. */
export const TAG_MAX_LENGTH = 24

/** Most tags kept per photo. Beyond this the strip stops being scannable. */
export const TAGS_PER_PHOTO = 5

/** Splits on commas and newlines, which is how the model separates tags. */
function splitTagText(text: string): string[] {
  return text.split(/[,\n]/)
}

/** Trims, lowercases and collapses internal whitespace; '' when empty. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Turns a raw model reply into at most `TAGS_PER_PHOTO` tags, in order, unique.
 *
 * A tag with spaces is kept (the model may answer "golden retriever"), but one
 * longer than `TAG_MAX_LENGTH` is dropped rather than truncated, since a cut
 * word reads as a different tag.
 */
export function parseTags(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of splitTagText(text)) {
    const tag = normalizeTag(raw)
    if (tag === '' || tag.length > TAG_MAX_LENGTH) continue
    if (seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= TAGS_PER_PHOTO) break
  }
  return out
}

/**
 * Cleans a list of tags coming from anywhere but the model (settings on disk, a
 * manual add), applying the same length and count rules and de-duplicating.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  return parseTags(tags.join(','))
}
