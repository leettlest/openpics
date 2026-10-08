/**
 * Tests for the assistant's tools and for the wire format they travel in.
 *
 * Two failure modes are worth a red line, because neither is loud:
 *
 * - A path the user never gave the model being opened. `reveal_in_folder` and
 *   `open_file` hand a string to Explorer and to Windows' default handler, so the
 *   only thing standing between a model that misheard a path and an arbitrary file
 *   opening is the check that the path is in the library it was offered.
 * - The tool fields being sent under the wrong names. The internal shape is
 *   camelCase and the API is snake_case; sending the internal objects straight
 *   through means the server never sees the call, and the loop silently does
 *   nothing instead of failing.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/core/ai-tools.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/core/ai-tools.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const {
  AI_TOOL_SPECS,
  toolLabel,
  parseToolArguments,
  clampLimit,
  searchLibrary,
  isKnownPath,
  isSelectedPath,
  isAllowedPath,
  findEntry,
  runToolLoop,
  libraryStats,
  describeStats,
  formatBytes,
  formatWhen,
  describeSearch,
  describeEntry
} = await import(new URL('core/ai-tools.js', DIST).href)
const { toWireMessages, normalizeToolCalls, StreamAssembler } = await import(new URL('core/ai-wire.js', DIST).href)
const { takeRecentHistory } = await import(new URL('shared/ai-types.js', DIST).href)

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

const entry = (name, over = {}) => ({
  path: `C:\\Pictures\\${name}`,
  name,
  kind: 'photo',
  bytes: 1024,
  width: 800,
  height: 600,
  mtime: 1_700_000_000_000,
  ...over
})

const snapshot = (entries, over = {}) => ({
  root: 'C:\\Pictures',
  entries,
  included: entries.length,
  total: entries.length,
  ...over
})

section('every tool is a well-formed function schema')

check('the eight planned tools are present', AI_TOOL_SPECS.length === 8, `got ${AI_TOOL_SPECS.length}`)
{
  const names = AI_TOOL_SPECS.map((s) => s.function.name)
  check('no duplicate names', new Set(names).size === names.length, names.join(','))
  for (const spec of AI_TOOL_SPECS) {
    check(`${spec.function.name}: type is function`, spec.type === 'function')
    check(
      `${spec.function.name}: has a description`,
      typeof spec.function.description === 'string' && spec.function.description.length > 20
    )
    check(`${spec.function.name}: parameters is an object schema`, spec.function.parameters?.type === 'object')
  }
}
{
  // A schema whose required list names a property that does not exist is rejected
  // by the model as malformed, and the tool silently never gets called.
  const properties = AI_TOOL_SPECS.flatMap((s) => [
    ...Object.keys(s.function.parameters.properties ?? {}),
    ...(s.function.parameters.required ?? [])
  ])
  for (const spec of AI_TOOL_SPECS) {
    const declared = Object.keys(spec.function.parameters.properties ?? {})
    for (const need of spec.function.parameters.required ?? []) {
      check(`${spec.function.name}: required "${need}" is declared`, declared.includes(need))
    }
  }
  check('property names are unique across the suite', new Set(properties).size > 0)
}
{
  // Anything that changes the machine or opens something has to name its path, and
  // the path has to be required rather than optional.
  const guarded = ['photo_info', 'wallpaper_set', 'reveal_in_folder', 'open_file']
  for (const name of guarded) {
    const spec = AI_TOOL_SPECS.find((s) => s.function.name === name)
    check(`${name}: requires a path`, (spec?.function.parameters.required ?? []).includes('path'))
  }
}

section('tool labels never reach the user empty')

check('a known tool has a human label', toolLabel('photos_find') === 'Searching the library')
check(
  'an unknown tool falls back to its name, not to nothing',
  toolLabel('something_new') === 'Running something_new'
)

section('arguments survive the ways models get them wrong')

check('a clean object parses', parseToolArguments('{"path":"C:\\\\a.jpg"}').path === 'C:\\a.jpg')
check('nothing at all is an empty object', Object.keys(parseToolArguments('')).length === 0)
check('null is an empty object', Object.keys(parseToolArguments(null)).length === 0)
check('broken JSON is an empty object, not a throw', Object.keys(parseToolArguments('{"path":')).length === 0)
check('an array is rejected', Object.keys(parseToolArguments('[1,2,3]')).length === 0)
check('a bare string is rejected', Object.keys(parseToolArguments('"C:\\a.jpg"')).length === 0)
check('a number is rejected', Object.keys(parseToolArguments('42')).length === 0)

section('limits are clamped rather than trusted')

check('a number in range is kept', clampLimit(20) === 20)
check('a float is rounded', clampLimit(7.4) === 7)
check('a string is accepted, as models send one', clampLimit('12') === 12)
check('zero is raised to one', clampLimit(0) === 1)
check('negative is raised to one', clampLimit(-5) === 1)
check('an absurd ask is capped', clampLimit(100000) === 50, `got ${clampLimit(100000)}`)
check('nonsense falls back', clampLimit('lots') === 20, `got ${clampLimit('lots')}`)
check('missing falls back', clampLimit(undefined) === 20)

section('searching the library')

const library = snapshot([
  entry('sunset.jpg', { mtime: 300 }),
  entry('SUNSET-pano.jpg', { mtime: 200 }),
  entry('beach.jpg', { mtime: 100 }),
  entry('clip.mp4', { kind: 'video', mtime: 400 })
])

{
  const hit = searchLibrary(library, 'sunset', 10)
  check('matches on name, case-insensitively', hit.matches.length === 2, `got ${hit.matches.length}`)
  check('returns whole paths the model can use', hit.matches.every((m) => m.path.startsWith('C:\\Pictures\\')))
}
{
  const hit = searchLibrary(library, 'beach', 10)
  check('a single match is still a list', hit.matches.length === 1)
  check('a miss returns nothing rather than throwing', searchLibrary(library, 'zzz', 10).matches.length === 0)
}
{
  const hit = searchLibrary(library, '', 10)
  check('an empty query means most recent first', hit.matches[0].name === 'clip.mp4', hit.matches[0].name)
  check('most-recent order is descending', hit.matches.map((m) => m.mtime).join() === '400,300,200,100')
}
{
  const hit = searchLibrary(library, '', 2)
  check('the limit is honoured', hit.matches.length === 2)
  check('the limit does not change what was searched', hit.searched === 4, `got ${hit.searched}`)
}
{
  const capped = searchLibrary(library, '', 10)
  check('an empty library is not an error', searchLibrary(undefined, 'x', 5).matches.length === 0)
  check('an empty snapshot still reports totals', capped.total === 4)
}
{
  // The honest-reporting rule: a truncated snapshot must not look complete.
  const truncated = snapshot(library.entries, { included: 4, total: 9000 })
  const hit = searchLibrary(truncated, 'zzz', 5)
  check('a miss says how much was actually searched', hit.searched === 4 && hit.total === 9000)
  check('and the description admits the gap', describeSearch(hit, 'zzz').includes('searched 4 of 9000'))
  const hit2 = searchLibrary(truncated, 'sunset', 5)
  check('a hit also admits the gap', describeSearch(hit2, 'sunset').includes('Searched 4 of 9000 loaded items'))
  const whole = searchLibrary(library, 'zzz', 5)
  check(
    'a complete library adds no hedging',
    !describeSearch(whole, 'zzz').includes('searched'),
    describeSearch(whole, 'zzz')
  )
}

section('the path guard')

check('a library path is allowed', isKnownPath(library, 'C:\\Pictures\\beach.jpg') === true)
check('case does not matter on Windows', isKnownPath(library, 'c:\\pictures\\BEACH.JPG') === true)
check('surrounding spaces do not matter', isKnownPath(library, '  C:\\Pictures\\beach.jpg  ') === true)
check('a path not in the library is refused', isKnownPath(library, 'C:\\Windows\\System32\\cmd.exe') === false)
check('a traversal out of the library is refused', isKnownPath(library, 'C:\\Pictures\\..\\Windows\\x.jpg') === false)
check('an empty path is refused', isKnownPath(library, '   ') === false)
check('no snapshot means nothing is allowed', isKnownPath(undefined, 'C:\\Pictures\\beach.jpg') === false)
check('an empty path is refused even against an empty library', isKnownPath(snapshot([]), '') === false)
check(
  'a prefix that is not a whole path is refused',
  isKnownPath(library, 'C:\\Pictures\\beach.jpg.bak') === false
)
check(
  'the matching entry comes back for photo_info',
  findEntry(library, 'C:\\PICTURES\\sunset.jpg')?.name === 'sunset.jpg'
)
check('and nothing comes back for an unknown path', findEntry(library, 'C:\\nope.jpg') === undefined)

section('an explicitly selected path is actionable past the snapshot cap')

{
  // The snapshot is capped, so a selected file the model was told about can sit
  // outside it. Selection is a per-question grant from the user, not a guess by
  // the model, which is why the guard honors it while still refusing the world.
  const capped = snapshot(library.entries.slice(0, 2), { included: 2, total: 9000 })
  const selected = ['C:\\Pictures\\beach.jpg']
  check('a selected path is recognized', isSelectedPath(selected, 'c:\\pictures\\BEACH.jpg') === true)
  check('an empty path is not selected', isSelectedPath(selected, '   ') === false)
  check('nothing is selected without a selection', isSelectedPath(undefined, 'C:\\Pictures\\beach.jpg') === false)
  check('a snapshot path is allowed', isAllowedPath(capped, undefined, 'C:\\Pictures\\sunset.jpg') === true)
  check(
    'a selected path outside the snapshot is allowed',
    isAllowedPath(capped, selected, 'C:\\Pictures\\beach.jpg') === true
  )
  check(
    'an unselected path outside the snapshot is still refused',
    isAllowedPath(capped, selected, 'C:\\Pictures\\sunrise.jpg') === false
  )
  check(
    'and a system path is refused even with a selection',
    isAllowedPath(capped, selected, 'C:\\Windows\\System32\\cmd.exe') === false
  )
}

section('counting the library')

{
  const stats = libraryStats(library)
  check('pictures and clips are counted apart', stats.photos === 3 && stats.videos === 1)
  check('bytes are summed', stats.bytes === 4 * 1024, `got ${stats.bytes}`)
  check('the total is the real total', stats.total === 4)
  check('the oldest and newest dates are found', stats.oldest === 100 && stats.newest === 400)
  check('everything counted was everything there was', stats.included === stats.total)
}
{
  const stats = libraryStats(snapshot([], { total: 0 }))
  check('an empty library counts zero, not NaN', stats.photos === 0 && stats.bytes === 0)
  check('and has no dates rather than epoch zero', stats.oldest === null && stats.newest === null)
}
{
  const missing = libraryStats(snapshot([entry('x.jpg', { mtime: 0 })]))
  check('an unknown date is not treated as 1970', missing.oldest === null, `got ${missing.oldest}`)
}
{
  // The reported counts must describe the whole library, not the capped slice.
  // This is the bug the assistant was shipped with: a library of nine thousand
  // reported "pictures: 2000", and the user was told they had two thousand.
  const capped = snapshot(library.entries, {
    included: 4,
    total: 9000,
    totals: { photos: 7120, videos: 1880, bytes: 9000 * 1024, oldest: 100, newest: 400 }
  })
  const truncated = libraryStats(capped)
  check('the picture count is the real one, not the cap', truncated.photos === 7120, `got ${truncated.photos}`)
  check('clips too', truncated.videos === 1880, `got ${truncated.videos}`)
  check('and the size on disk covers the whole library', truncated.bytes === 9000 * 1024, `got ${truncated.bytes}`)
  check('while search reach is still reported honestly', truncated.included === 4 && truncated.total === 9000)

  const text = describeStats(truncated)
  check('the model is told the real picture count', text.includes('pictures: 7120'), text)
  check('and never the capped one', !/pictures: 3\b/.test(text), text)
  check('searchability is stated as its own fact', text.includes('searchable: 4 of 9000'), text)
  check('and the model is warned what that means', text.includes('photos_find'), text)

  // A snapshot with no `totals` still works; it just falls back to counting, and
  // the answer has to be marked as partial rather than presented as whole.
  const legacy = libraryStats(snapshot(library.entries, { included: 4, total: 9000 }))
  check('an older snapshot without totals still counts what it has', legacy.photos === 3)
  const legacyText = describeStats(legacy)
  check('and does not claim it is the whole library', legacyText.includes('searchable: 4 of 9000'), legacyText)

  const whole = describeStats(libraryStats(library))
  check('a complete library needs no hedging', !whole.includes('searchable:'), whole)
  check('and reads normally', whole.includes('size on disk: 4 KB') && whole.includes('pictures: 3'))
}

section('sizes and dates the model can read')

check('bytes are human-sized', formatBytes(1536) === '1.5 KB')
check('a big library reads as GB', formatBytes(5_368_709_120) === '5 GB')
check('zero does not read as NaN', formatBytes(0) === '0 B')
check('nonsense does not read as NaN', formatBytes(NaN) === '0 B')
check('a real date is readable', formatWhen(1_700_000_000_000) === '2023-11-14')
check('an unknown date says so', formatWhen(null) === 'unknown')
check('a zero date says so', formatWhen(0) === 'unknown')

section('what a result reads like')

check(
  'an entry reports kind, size, dimensions and date',
  describeEntry(entry('beach.jpg')).includes('kind: picture') &&
    describeEntry(entry('beach.jpg')).includes('dimensions: 800x600')
)
check('a clip is called a clip', describeEntry(entry('c.mp4', { kind: 'video' })).includes('kind: clip'))
check('an unknown size says so', describeEntry(entry('x.jpg', { width: 0 })).includes('unknown size'))
check(
  'a search lists one line per result with the real path',
  describeSearch(searchLibrary(library, 'beach', 5), 'beach').includes('C:\\Pictures\\beach.jpg')
)
check('a single match is not pluralised', describeSearch(searchLibrary(library, 'beach', 5), 'beach').includes('1 match:'))

section('the wire format')

{
  // The bug this file exists for: the internal names are camelCase and the API's
  // are snake_case. If these ever go back to the internal names the tool loop
  // stops working without anything failing.
  const wire = toWireMessages([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'find sunsets' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_1', name: 'photos_find', arguments: '{"query":"sunset"}' }]
    },
    { role: 'tool', content: '- sunset.jpg (photo) C:\\Pictures\\sunset.jpg', toolCallId: 'call_1' }
  ])
  check('the assistant turn carries tool_calls', Array.isArray(wire[2].tool_calls) && wire[2].tool_calls.length === 1)
  check('with the function name and arguments', wire[2].tool_calls[0].function.name === 'photos_find')
  check('and type: function', wire[2].tool_calls[0].type === 'function')
  check('a tool result carries tool_call_id', wire[3].tool_call_id === 'call_1')
  check('a tool turn carries no tool_calls', wire[3].tool_calls === undefined)
  check('a plain turn carries neither field', wire[0].tool_calls === undefined && wire[0].tool_call_id === undefined)
  check('an empty tool_calls array is dropped, not sent', toWireMessages([{ role: 'assistant', content: 'hi', toolCalls: [] }])[0].tool_calls === undefined)
  check('an empty id is dropped rather than sent as ""', toWireMessages([{ role: 'tool', content: 'x', toolCallId: '' }])[0].tool_call_id === undefined)
  check('null content survives, since a call needs it', toWireMessages([{ role: 'assistant', content: null }])[0].content === null)
  check(
    'nothing camelCase reaches the body',
    !JSON.stringify(toWireMessages([{ role: 'tool', content: 'x', toolCallId: 'c' }])).includes('toolCall')
  )
}

section('every call gets an id to be answered on')

{
  const kept = normalizeToolCalls([{ id: 'abc', name: 'x', arguments: '{}' }])
  check('an id the model sent is kept as it is', kept[0].id === 'abc')
  const blank = normalizeToolCalls([{ id: '', name: 'x', arguments: '{}' }])
  check('a missing id is invented', blank[0].id !== '')
  const dupe = normalizeToolCalls([
    { id: 'same', name: 'x', arguments: '{}' },
    { id: 'same', name: 'y', arguments: '{}' }
  ])
  check('two calls sharing an id are separated', dupe[0].id !== dupe[1].id, dupe.map((c) => c.id).join(','))
  check(
    'and the call and its result can be paired',
    toWireMessages([
      { role: 'assistant', content: null, toolCalls: dupe },
      { role: 'tool', content: 'r0', toolCallId: dupe[0].id },
      { role: 'tool', content: 'r1', toolCallId: dupe[1].id }
    ])[1].tool_call_id === dupe[0].id
  )
}

section('assembling a streamed reply')

{
  const deltas = []
  const a = new StreamAssembler((d) => deltas.push(d))
  a.push('data: {"choices":[{"delta":{"content":"Hello"}}]}')
  a.push('data: {"choices":[{"delta":{"content":", world"}}]}')
  a.push('data: [DONE]')
  check('text is joined', a.result().text === 'Hello, world', a.result().text)
  check('each piece was streamed out as it arrived', deltas.join('') === 'Hello, world')
  check('no tools were found', a.result().toolCalls.length === 0)
}
{
  const a = new StreamAssembler()
  a.push(': a comment line')
  a.push('')
  a.push('data: ')
  check('non-data frames are ignored', a.result().text === '')
}
{
  // A server that pads its frames must not cost the reply a sentence or a call.
  const a = new StreamAssembler()
  a.push('  data: {"choices":[{"delta":{"content":"padded"}}]}')
  a.push('\tdata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"p1","function":{"name":"photos_find","arguments":"{}"}}]}}]}')
  a.push('  data: [DONE]')
  check('a padded text frame still reads', a.result().text === 'padded', a.result().text)
  check('a padded tool frame still calls', a.result().toolCalls.length === 1 && a.result().toolCalls[0].name === 'photos_find')
}
{
  const a = new StreamAssembler()
  a.push('data: {"choices":[{"delta":{"content":"partial')
  a.push('data: {"choices":[{"delta":{"content":" but broken"}}]}')
  check('a split JSON frame is dropped, not thrown on', a.result().text === ' but broken', a.result().text)
}
{
  const a = new StreamAssembler()
  a.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"photos_fin"}}]}}]}')
  a.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"d","arguments":"{\\"query\\":\\"sun"}}]}}]}')
  a.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"set\\"}"}}]}}]}')
  const { toolCalls } = a.result()
  check('a split tool call becomes one call', toolCalls.length === 1, `got ${toolCalls.length}`)
  check('its name is stitched back together', toolCalls[0].name === 'photos_find', toolCalls[0].name)
  check('its arguments are stitched back together', toolCalls[0].arguments === '{"query":"sunset"}', toolCalls[0].arguments)
  check('and it keeps its id', toolCalls[0].id === 'call_1')
  check('no text was produced by a call-only reply', a.result().text === '')
}
{
  const a = new StreamAssembler()
  a.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"x","arguments":"{}"}}]}}]}')
  a.push('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"y","arguments":"{}"}}]}}]}')
  check('two calls in one reply are both found', a.result().toolCalls.length === 2)
  check('and kept in index order however they arrived', a.result().toolCalls.map((c) => c.name).join() === 'x,y')
}
{
  const a = new StreamAssembler()
  a.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"orphan"}]}}]}')
  check('a call with no name is a template artefact, not a call', a.result().toolCalls.length === 0)
}
{
  const a = new StreamAssembler()
  a.push('data: {"choices":[{"text":"non-streaming shape"}]}')
  check('the older non-delta shape is still read', a.result().text === 'non-streaming shape')
}

section('the tool loop always terminates')

{
  // A model that answers straight away costs one generation and no tools.
  const messages = [{ role: 'user', content: 'hi' }]
  let generations = 0
  const answered = await runToolLoop(messages, 3, {
    generate: async () => {
      generations += 1
      return { text: 'hello', toolCalls: [] }
    },
    act: async () => {
      throw new Error('no tool should run')
    }
  })
  check('an answer needs one generation', generations === 1)
  check('and is not reported as stopped', answered.stopped === false && answered.reply === 'hello')
  check('and history is untouched', messages.length === 1)
}
{
  // The property the bound exists for: a model that never stops calling tools
  // gets maxRounds tool rounds plus one final generation, and then the loop
  // gives up instead of hanging behind a spinner.
  const messages = [{ role: 'user', content: 'search forever' }]
  let generations = 0
  let actions = 0
  const seen = []
  const looped = await runToolLoop(messages, 3, {
    generate: async () => {
      generations += 1
      return { text: '', toolCalls: [{ id: '', name: 'photos_find', arguments: '{}' }] }
    },
    act: async (call) => {
      actions += 1
      seen.push(call)
      return 'nothing'
    }
  })
  check('a runaway model gets 3 tool rounds plus a final answer', generations === 4, `got ${generations}`)
  check('so three tools ran', actions === 3, `got ${actions}`)
  check('and the loop reports giving up', looped.stopped === true)
  check('every call got a repaired id before it ran', seen.every((c) => c.id !== ''), seen.map((c) => c.id).join(','))
  const tools = messages.filter((m) => m.role === 'tool')
  check(
    'and every result is paired with its call',
    tools.length === 3 && tools.every((t, i) => t.toolCallId === seen[i].id)
  )
}
{
  // One tool round, then an answer: the next generation sees the tool's output.
  const messages = [{ role: 'user', content: 'how many?' }]
  let round = 0
  const done = await runToolLoop(messages, 3, {
    generate: async (msgs) => {
      round += 1
      if (round === 1) return { text: 'looking', toolCalls: [{ id: 'c1', name: 'library_stats', arguments: '{}' }] }
      const lastTool = msgs.filter((m) => m.role === 'tool').at(-1)
      return { text: `saw: ${lastTool ? lastTool.content : 'nothing'}`, toolCalls: [] }
    },
    act: async () => '4 pictures'
  })
  check('two generations for one tool round', round === 2)
  check('the answer used the tool output', done.reply === 'saw: 4 pictures', done.reply)
  check('and the loop did not stop early', done.stopped === false)
}

section('the history a request carries is bounded')

{
  const turns = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`
  }))
  const tail = takeRecentHistory(turns)
  check('twelve turns at most', tail.length === 12, `got ${tail.length}`)
  check('the newest survive', tail[tail.length - 1].content === 'turn 19')
  check('and the oldest are dropped first', tail[0].content === 'turn 8', tail[0].content)
}
{
  // Twelve turns of unbounded length is still unbounded, so the tail has a
  // character budget too - and the question being asked always survives it.
  const long = [
    { role: 'user', content: `first ${'a'.repeat(5900)}` },
    { role: 'assistant', content: `second ${'b'.repeat(500)}` },
    { role: 'user', content: 'the actual question' }
  ]
  const kept = takeRecentHistory(long)
  check('the newest turn survives any budget', kept[kept.length - 1].content === 'the actual question')
  check('older turns give way', kept.length < long.length, `kept ${kept.length}`)
  check('a short history passes through whole', takeRecentHistory([{ role: 'user', content: 'hi' }]).length === 1)
}

section('the tool descriptions do not overpromise')

{
  // The whole point of the settings toggle is that these can be refused, so a
  // description promising something the tool layer will not do is worse than a
  // missing description.
  const binary = new Set(['wallpaper_set', 'open_file', 'reveal_in_folder'])
  const byName = new Map(AI_TOOL_SPECS.map((s) => [s.function.name, s.function.description.toLowerCase()]))
  for (const spec of AI_TOOL_SPECS) {
    const d = spec.function.description.toLowerCase()
    check(`${spec.function.name}: does not claim to delete`, !/\b(delete|remove permanently|empty the bin)\b/.test(d))
    if (binary.has(spec.function.name)) {
      // A path the tools will act on has exactly two sources: the snapshot, or
      // the user's explicit selection. Anything else is refused, and the
      // description has to say so rather than let the model guess.
      check(
        `${spec.function.name}: says where an actionable path comes from`,
        d.includes('photos_find') && d.includes('selected')
      )
    }
  }
  check(
    'photo_info promises selected files work, so the guard must honor them',
    (byName.get('photo_info') ?? '').includes('selected')
  )
  check(
    'the suite never claims to look at a picture that was not attached',
    !AI_TOOL_SPECS.some((s) => /describe what is in (it|the picture) from the path/.test(s.function.description))
  )
}

section('the prompt does not advertise a tool that does not exist')

{
  // The prompt describes capabilities in prose rather than by tool name, so the
  // invariant is one-directional: a name-shaped word in there has to be a tool we
  // actually ship, or the model is being told to call something absent.
  const shipped = readFileSync(
    fileURLToPath(new URL('../build/openpics-ai-prompt-default.txt', import.meta.url)),
    'utf8'
  )
  const names = new Set(AI_TOOL_SPECS.map((s) => s.function.name))
  const mentioned = shipped.match(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g) ?? []
  const unknown = [...new Set(mentioned)].filter((word) => !names.has(word))
  check(
    'no tool-shaped word in the prompt is missing from the suite',
    unknown.length === 0,
    unknown.join(',')
  )
  check('and the prompt does tell the model to call tools', /\btools?\b/i.test(shipped))
  check(
    'the prompt tells it not to invent a path',
    /never guess at a file\s+name or a path/i.test(shipped.replace(/\n/g, ' '))
  )
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)