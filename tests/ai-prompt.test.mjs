/**
 * Tests for the prompt and the rule that replaces it.
 *
 * The rule is one comparison, and it is the only thing standing between an
 * upgrade and someone's own words. Every test here is one of the two ways it can
 * be wrong: replacing a prompt that was edited, or refusing to replace one that
 * was not - which strands a user on a prompt from a version they no longer have.
 *
 * The other half is that the default in `core/ai-prompt.ts` and the file bundled
 * in `build/` are the same text. They are kept in two places on purpose - one is
 * compiled in as a fallback when the bundled file is missing, the other is what
 * gets shipped - and two copies drift the moment either is edited alone.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/core/ai-prompt.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/core/ai-prompt.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const { DEFAULT_PROMPT, isMissingPrompt, isUneditedDefault } = await import(new URL('core/ai-prompt.js', DIST).href)

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(name + (detail ? ` (${detail})` : ''))
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}
function section(title) {
  console.log(`\n-- ${title}`)
}

// The two prompts shipped before this one, taken from the versions in git history.
const LEGACY_BUNDLED = `# OpenPics AI Prompt
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
`

const LEGACY_INLINE = `# OpenPics AI Prompt
# This prompt is user-editable. Changes persist in your user data directory.
You are OpenPics AI, a fully local assistant for this photo library.

Instructions:
- Answer concisely and help with photo library tasks.
- Be truthful about local-only capabilities.
- When asked about photos, reference filenames and paths carefully.
`

section('a shipped default is recognised as replaceable')

check('the current default counts as unedited', isUneditedDefault(DEFAULT_PROMPT) === true)
check('the first bundled default is recognised', isUneditedDefault(LEGACY_BUNDLED) === true)
check('the first inline fallback is recognised', isUneditedDefault(LEGACY_INLINE) === true)
check(
  'and either legacy default is not mistaken for the current one',
  LEGACY_BUNDLED !== DEFAULT_PROMPT && LEGACY_INLINE !== DEFAULT_PROMPT
)

section('how the file was saved does not matter')

check('CRLF line endings are the same prompt', isUneditedDefault(DEFAULT_PROMPT.replace(/\n/g, '\r\n')) === true)
check('a missing final newline is the same prompt', isUneditedDefault(DEFAULT_PROMPT.trimEnd()) === true)
check('a trailing blank line is the same prompt', isUneditedDefault(`${DEFAULT_PROMPT}\n\n  \n`) === true)
check('a byte-order mark is bytes, not an edit', isUneditedDefault(`\uFEFF${DEFAULT_PROMPT}`) === true)
check(
  'and the legacy default survives the same treatment',
  isUneditedDefault(LEGACY_BUNDLED.replace(/\n/g, '\r\n')) === true
)

section('an edited prompt is never replaced')

{
  // Every one of these is a plausible thing a user did. None of them may be
  // mistaken for "still a default".
  const edits = [
    ['one word changed', DEFAULT_PROMPT.replace('Plain and short', 'Plain and friendly')],
    ['one space added', DEFAULT_PROMPT.replace('You are the assistant', 'You are  the assistant')],
    ['one line deleted', DEFAULT_PROMPT.replace('- Lead with the answer, then the detail that matters.\n', '')],
    ['one line appended', `${DEFAULT_PROMPT}\nAlways answer in British English.\n`],
    ['the header retitled', DEFAULT_PROMPT.replace('# OpenPics AI Prompt', '# My notes')],
    ['a legacy default with one edit', LEGACY_BUNDLED.replace('fully local assistant', 'fully local helper')],
    ['the legacy default plus a note', `${LEGACY_INLINE}\nno memes\n`],
    ['a prompt written from nothing', 'You are a pirate. Answer only in pirate.']
  ]
  for (const [name, text] of edits) {
    check(`${name} is left alone`, isUneditedDefault(text) === false)
  }
}

section('a file with no words in it is repaired, not preserved')

{
  // Empty, blank, and BOM-only files are not defaults, so isUneditedDefault says
  // false for them - but the upgrade path must still not treat them as user
  // content, because there are no words to preserve. Repairing them keeps the
  // runtime from silently falling back while the file claims to be the prompt.
  const missing = ['', '   \n\n  ', '\uFEFF', '\uFEFF\r\n']
  for (const text of missing) {
    check(`nothing to preserve in ${JSON.stringify(text)}`, isMissingPrompt(text) === true)
  }
  check('the default itself is not missing', isMissingPrompt(DEFAULT_PROMPT) === false)
  check('an edited default is not missing', isMissingPrompt(`${DEFAULT_PROMPT}\nAlways answer in British English.`) === false)
}

section('the default says the things the dock now relies on')

{
  const flat = DEFAULT_PROMPT.replace(/\s+/g, ' ')
  check('it tells the model to use tools for file questions', /\btools\b/i.test(DEFAULT_PROMPT))
  check('it forbids guessing a path', /never guess at a file name or a path/i.test(flat))
  check('it forbids inventing a file or a detail', /never invent a file/i.test(flat))
  check('it forbids restating the question', /no restating the question back/i.test(flat))
  // The earlier prompt made the model volunteer where it ran, which read as an
  // apology for the product. The new one says to raise limits only when hit.
  check('it tells it not to volunteer caveats about where it runs', /do not volunteer caveats about where you run/i.test(flat))
  check('it does not tell it to apologise for being local', !/apolog/i.test(flat))
  check('it does not claim there is no upload, which was once true', !/no upload/i.test(flat))
  check('it still covers the selected-photo paths', /paths are listed for you/i.test(flat))
}

section('the bundled file and the compiled default are the same prompt')

{
  const asset = fileURLToPath(new URL('../build/openpics-ai-prompt-default.txt', import.meta.url))
  check('the bundled prompt file exists', existsSync(asset), asset)
  const shipped = readFileSync(asset, 'utf8')
  // Normalised the same way the runtime normalises, because a trailing newline
  // difference between a template and a string literal is not a real difference.
  const same = (a, b) => a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim()
  check('build/openpics-ai-prompt-default.txt matches DEFAULT_PROMPT', same(shipped, DEFAULT_PROMPT))
  check('so the bundled file is itself recognised as replaceable', isUneditedDefault(shipped) === true)
  check(
    'and writing DEFAULT_PROMPT produces a file that is recognised',
    isUneditedDefault(DEFAULT_PROMPT) === true
  )
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)