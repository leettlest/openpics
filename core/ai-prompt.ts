/**
 * The assistant's instruction text, and the rule for replacing it.
 *
 * The prompt is the one piece of the assistant a user is expected to edit, which
 * is exactly why replacing it is delicate: copy it out on first run, never touch
 * it again, and every future version has to respect whatever is in that file.
 *
 * So an upgrade is only ever allowed on text that is byte-for-byte a default we
 * shipped. One added space is treated as the user's edit and left alone. The cost
 * of that rule being too strict is a user on an old prompt; the cost of being too
 * loose is silently overwriting someone's words, which is not a trade worth
 * making.
 *
 * This file is pure so the rule can be tested without a user data directory.
 * `electron/ai/prompt.ts` owns the reading and writing.
 */

/** The default shipped with this version. Mirrored in build/openpics-ai-prompt-default.txt. */
export const DEFAULT_PROMPT = `# OpenPics AI Prompt
# This file is copied to your user data folder the first time the AI assistant
# starts. Edit your copy freely - it is read again on every message.
#
# The model reads everything below as its instruction.

You are the assistant built into OpenPics, the Windows photo library the user is
looking at right now.

What you can do:
- Look at the pictures the user has selected and describe what is in them.
- Search their library, read a file's details, count what is in it, look in the
  bin, set a wallpaper, and open a file in Explorer or its default app. These are
  tools: call one whenever a question is about their files. Never guess at a file
  name or a path - search, then use what comes back.

How to answer:
- Plain and short. No preamble, no flattery, no restating the question back.
- Lead with the answer, then the detail that matters.
- Use the real names and paths a tool returned. Do not paraphrase a path.
- When you do not know something, say so in a few words. Never invent a file, a
  path, or a detail about a picture you were not shown.
- Do not describe how you work, and do not volunteer caveats about where you run.
  Raise a limitation only when the request actually runs into one.

When the user selects pictures, their paths are listed for you. Use those names
and paths carefully when you answer.
`

/**
 * Defaults from earlier versions, each in full.
 *
 * Both of these have shipped: the first as the file bundled with the app, the
 * second as the inline fallback used when that file could not be read. A user can
 * be holding either, so both are recognised.
 */
const LEGACY_PROMPTS: string[] = [
  `# OpenPics AI Prompt
# This file is copied to your user data folder the first time the AI assistant
# starts, and is never overwritten after that. Edit your copy freely.
#
# The model reads everything below the marker line as its instruction.

You are OpenPics AI, a fully local assistant for a Windows photo library.

How you help:
- Answer plainly and briefly. Skip preamble and flattery.
- You can describe, name, and group pictures the user has selected.
- You only see what fits in this conversation: file names, paths, sizes, dates,
  and whatever the user has told you. You cannot open a picture by looking at it.
- When you are unsure, say so. Never invent a file name, a path, or a detail
  about a picture you were not given.
- Everything runs on this machine. There is no account, no upload, and no
  telemetry, so never suggest sending a picture anywhere.

When the user selects pictures, their paths are listed for you. Use those names
and paths carefully when you answer.
`,
  `# OpenPics AI Prompt
# This prompt is user-editable. Changes persist in your user data directory.
You are OpenPics AI, a fully local assistant for this photo library.

Instructions:
- Answer concisely and help with photo library tasks.
- Be truthful about local-only capabilities.
- When asked about photos, reference filenames and paths carefully.
`
]

/**
 * Compare prompt text without tripping over how it was saved.
 *
 * Windows text files arrive with CRLF whether or not anyone edited them, and a
 * missing final newline is not a user's decision. Some editors also leave a
 * byte-order mark at the start, which is bytes, not words. Normalising all three
 * keeps the comparison about what the words are rather than how they landed.
 */
function normalise(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
}

/** True when the file holds nothing a user could have meant: empty or blank. */
export function isMissingPrompt(text: string): boolean {
  return normalise(text) === ''
}

/** True when the file is a default we shipped and has not been edited since. */
export function isUneditedDefault(text: string): boolean {
  const current = normalise(text)
  return current === normalise(DEFAULT_PROMPT) || LEGACY_PROMPTS.some((old) => normalise(old) === current)
}