#!/usr/bin/env node
/**
 * GUI probe for OpenPics: drives the real app like a user and reports back.
 *
 * What it does:
 * - Builds nothing. It launches the already-built app (`npm run build` first)
 *   under Playwright's Electron driver, in a throwaway `--user-data-dir`, with
 *   the app's own `--probe` flag (no model warm-up, no registry writes, no tray
 *   icon), pointed at three copied fixture pictures.
 * - Clicks through Library / Creatives / Settings, draws one stroke, collapses
 *   and re-opens the AI dock, narrows the window to its 720px minimum, and
 *   screenshots every step into `probe/shots/`.
 * - Fails on any page error, any console error, or any step whose assertion
 *   does not hold, and writes `probe/report.json`.
 *
 * What it does NOT do:
 * - Touch your real profile, library, settings, registry, or tray. Everything
 *   the app writes lands in a temp dir that is deleted on success.
 * - Send a chat message. Answering needs the local model; that stays a manual
 *   check with the real build.
 * - Replace `npm test`. This needs a screen and a built app, so it stays out of
 *   the test script on purpose.
 *
 * Usage:
 *   npm run build
 *   npm run probe              # run everything, clean up the temp profile
 *   npm run probe -- --keep    # keep the temp profile for forensics
 *   npm run probe -- --help    # this text
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright-core')
// OPENPICS_EXE points the probe at a packaged build instead of the dev
// checkout: the packaged app reads the same argv, so handoff, probe flags and
// the temp profile all work unchanged. This is how the shipped artifact gets
// the same workout as the source tree.
const electronExe = process.env.OPENPICS_EXE || require('electron')

const args = new Set(process.argv.slice(2))
if (args.has('--help') || args.has('-h')) {
  console.log('usage: npm run probe [-- --keep]')
  console.log('  --keep   leave the temp profile behind for inspection')
  console.log('')
  console.log('  OPENPICS_PROBE_CHAT=1  launch with --chat: asserts the assistant opens')
  console.log('  focused on arrival instead of the viewer handoff checks')
  console.log('  OPENPICS_EXE=<path>  drive a packaged OpenPics.exe instead of the checkout')
  process.exit(0)
}
const KEEP = args.has('--keep')
// Cold-start --chat path: the chat request races the file handoff, so the first
// step asserts the composer ends up focused rather than the viewer open.
const WITH_CHAT = process.env.OPENPICS_PROBE_CHAT === '1'

const MAIN_ENTRY = join(ROOT, 'out', 'main', 'index.js')
const FIXTURE_SRC = join(ROOT, 'build', 'icon.png')
const OUT_DIR = join(ROOT, 'probe')
const SHOTS_DIR = join(OUT_DIR, 'shots')

function fail(message) {
  console.error(`probe setup: ${message}`)
  process.exit(2)
}
if (!existsSync(MAIN_ENTRY)) fail(`built app not found at ${MAIN_ENTRY} -- run "npm run build" first.`)
if (typeof electronExe !== 'string' || !existsSync(electronExe)) fail('electron executable not found -- run "npm install" first.')
if (!existsSync(FIXTURE_SRC)) fail(`fixture source not found at ${FIXTURE_SRC}.`)

mkdirSync(SHOTS_DIR, { recursive: true })

// Three copies under different names, so the grid, search and counts have more
// than one file to chew on. Real PNGs: the scanner must decode them.
const profileDir = mkdtempSync(join(tmpdir(), 'openpics-probe-'))
const fixtures = ['photo-sunset-01.png', 'photo-harbor-02.png', 'photo-trail-03.png'].map((name) => {
  const dest = join(profileDir, name)
  copyFileSync(FIXTURE_SRC, dest)
  return dest
})

// A three-second clip with a tone, so the custom player has something to play.
// Generated with the bundled ffmpeg; without it the player step is skipped.
// Encoded with OpenH264: the LGPL build has no libx264, and its default mp4
// encoder is MPEG-4 Part 2, which Chromium cannot decode - the same reason a
// user-encoded odd clip may play audio over a black frame.
const CLIP_NAME = 'clip-test.mp4'
let clipPath = null
{
  const { spawnSync } = await import('node:child_process')
  const ffmpeg = join(ROOT, 'vendor', 'addons', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (existsSync(ffmpeg)) {
    clipPath = join(profileDir, CLIP_NAME)
    const made = spawnSync(
      ffmpeg,
      ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', '-shortest', clipPath],
      { timeout: 60000 }
    )
    if (made.status !== 0 || !existsSync(clipPath)) clipPath = null
    else fixtures.push(clipPath)
  }
}

const consoleErrors = []
const pageErrors = []
const steps = []
let shot = 0

async function screenshot(page, name) {
  shot += 1
  const file = join(SHOTS_DIR, `${String(shot).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

async function step(page, name, fn) {
  const started = Date.now()
  try {
    const detail = (await fn()) ?? ''
    steps.push({ name, ok: true, ms: Date.now() - started, detail })
    console.log(`  ok   ${name}${detail ? ` -- ${detail}` : ''}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    steps.push({ name, ok: false, ms: Date.now() - started, detail })
    console.log(`  FAIL ${name} -- ${detail}`)
    try {
      await screenshot(page, `fail-${name.replace(/[^a-z0-9]+/gi, '-')}`)
    } catch {}
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

let electronApp = null
let outcome = 1
try {
  electronApp = await electron.launch({
    executablePath: electronExe,
    cwd: ROOT,
    args: ['.', `--user-data-dir=${profileDir}`, '--probe', ...(WITH_CHAT ? ['--chat'] : []), ...fixtures],
    timeout: 120000
  })
  const page = await electronApp.firstWindow({ timeout: 120000 })
  // No setViewportSize: the window opens at the app's own 1280x840, and
  // Playwright's viewport emulation fights subsequent window resizes (the
  // narrow step's setSize silently stops working). Drive size through the
  // window handle only.
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const tabs = page.locator('nav[aria-label="Sections"]')
  const canvas = page.locator('svg[aria-label^="Drawing canvas"]')

  await step(page, 'handed-off files open in the viewer, escape closes it', async () => {
    // Files handed to the app on the command line open straight into the viewer
    // by design, so the probe starts there rather than on the grid. One Escape
    // must return to the library; if it does not, every later click lands on
    // the viewer instead of the UI under test.
    //
    // With OPENPICS_PROBE_CHAT=1 the --chat request instead wins the race: the
    // viewer is closed by openChat and the composer ends up focused.
    await page.getByText('AI assistant').first().waitFor({ timeout: 60000 })
    if (WITH_CHAT) {
      await screenshot(page, 'chat-on-arrival')
      const focused = await page.evaluate(() => {
        const active = document.activeElement
        return active ? `${active.tagName}:${active.getAttribute('aria-label') ?? ''}` : 'nothing'
      })
      assert(
        focused === 'TEXTAREA:Message the AI assistant',
        `composer is not focused on arrival (focused: ${focused})`
      )
      return 'chat opened with the composer focused'
    }
    await screenshot(page, 'viewer-on-handoff')
    await page.keyboard.press('Escape')
    await page.getByText(/of 3/).waitFor({ state: 'hidden', timeout: 10000 })
    await tabs.waitFor({ state: 'visible', timeout: 10000 })
    // The grid must show the handed-off fixtures, not whatever the launcher's
    // own arguments resolved to: a folder picker that mistakes Electron's `.`
    // app-path argument for a user folder re-points the library at the checkout
    // and this is the assertion that catches it.
    await page.getByText('photo-sunset-01.png').first().waitFor({ timeout: 15000 })
    await page.getByText('photo-harbor-02.png').first().waitFor({ timeout: 15000 })
    await screenshot(page, 'library')
    return 'viewer closed, section tabs visible'
  })

  await step(page, 'the custom player plays a clip', async () => {
    // No clip fixture, no player to prove: without the bundled ffmpeg this step
    // bows out instead of failing the run for an environment gap.
    if (!clipPath) return 'skipped: bundled ffmpeg not present'
    try {
      await page.getByText(CLIP_NAME).first().dblclick({ timeout: 15000 })
      await page.getByRole('button', { name: 'Play (K)' }).waitFor({ timeout: 15000 })
      const timeText = () => page.getByText(/^\d+:\d\d \/ \d+:\d\d$/).first().textContent()
      // Playing starts the clock; the label reads 0:00 before the first frame.
      await page.keyboard.press('k')
      await page.waitForFunction(
        () => {
          const el = [...document.querySelectorAll('span')].find((s) => /^\d+:\d\d \/ \d+:\d\d$/.test(s.textContent || '') && !s.textContent.startsWith('0:00 /'));
          return el ? el.textContent : false
        },
        null,
        { timeout: 20000 }
      )
      const before = await timeText()
      await page.keyboard.press('k')
      await screenshot(page, 'player')
      // Time advancing only proves the clock runs - audio alone does that.
      // Decoded dimensions prove the video track paints: an MPEG-4 Part 2 clip
      // plays its soundtrack over black with videoWidth stuck at zero, and that
      // must fail here rather than pass as playback. (Pixel readback is out:
      // the custom protocol serves no CORS headers, so the canvas taints.)
      const decoded = await page.evaluate(() => {
        const v = document.querySelector('div[data-viewer-stage] video');
        if (!v) return 'no-video';
        return v.videoWidth > 0 ? `decoded:${v.videoWidth}x${v.videoHeight}` : 'no-dimensions';
      })
      assert(decoded.startsWith('decoded'), `clip paints no picture (${decoded})`)
      return `time advanced to ${before}, ${decoded}`
    } finally {
      // The viewer must not stay open into the grid steps, whatever failed.
      // Escape on the library with an empty query is a harmless no-op.
      await page.keyboard.press('Escape')
    }
  })

  await step(page, 'dock is visible', async () => {
    await page.getByText('AI assistant').first().waitFor({ state: 'visible', timeout: 10000 })
    const tiles = await page.locator('main img, [role="grid"] img').count().catch(() => -1)
    return tiles >= 0 ? `${tiles} thumbnail images in the DOM` : 'grid present'
  })

  await step(page, 'creatives tab opens', async () => {
    await tabs.getByRole('button', { name: /creatives/i }).click({ timeout: 10000 })
    await canvas.waitFor({ state: 'visible', timeout: 10000 })
    await screenshot(page, 'creatives')
    return 'canvas visible'
  })

  await step(page, 'one drawn stroke counts as one', async () => {
    const box = await canvas.boundingBox()
    assert(box && box.width > 100 && box.height > 100, 'canvas has no usable size')
    await page.mouse.move(box.x + 30, box.y + 30)
    await page.mouse.down()
    await page.mouse.move(box.x + 110, box.y + 80, { steps: 8 })
    await page.mouse.up()
    await page.getByText('1 stroke').waitFor({ timeout: 5000 })
    await screenshot(page, 'drawn')
    return 'stroke counter reads "1 stroke"'
  })

  await step(page, 'a shape tool draws a shape', async () => {
    // The suite grew past one brush: prove a shape gesture commits through the
    // same path. One stroke already exists, so the counter must read two after.
    await page.getByRole('group', { name: 'Shape tool' }).getByRole('button', { name: 'Rectangle' }).click({ timeout: 10000 })
    const box = await canvas.boundingBox()
    assert(box && box.width > 100 && box.height > 100, 'canvas has no usable size')
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, { steps: 8 })
    await page.mouse.up()
    await page.getByText('2 strokes').waitFor({ timeout: 5000 })
    await screenshot(page, 'shaped')
    return 'rectangle committed, counter reads "2 strokes"'
  })

  await step(page, 'escape leaves creatives', async () => {
    await page.keyboard.press('Escape')
    await canvas.waitFor({ state: 'hidden', timeout: 10000 })
    return 'canvas hidden, library back'
  })

  await step(page, 'settings tab opens', async () => {
    await tabs.getByRole('button', { name: /settings/i }).click({ timeout: 10000 })
    await page.getByRole('heading', { name: 'Agent tools' }).waitFor({ timeout: 10000 })
    await screenshot(page, 'settings')
    return '"Agent tools" section visible'
  })

  await step(page, 'escape leaves settings', async () => {
    await page.keyboard.press('Escape')
    await page.getByRole('heading', { name: 'Agent tools' }).waitFor({ state: 'hidden', timeout: 10000 })
    return 'settings hidden, library back'
  })

  await step(page, 'dock collapses and re-opens', async () => {
    await page.getByRole('button', { name: 'Collapse AI' }).click({ timeout: 10000 })
    await page.getByRole('button', { name: 'Open AI assistant' }).waitFor({ timeout: 10000 })
    await screenshot(page, 'collapsed')
    await page.getByRole('button', { name: 'Open AI assistant' }).click({ timeout: 10000 })
    await page.getByText('AI assistant').first().waitFor({ timeout: 10000 })
    return 'rail shown, then dock restored'
  })

  await step(page, 'impossible filter names itself and clears', async () => {
    // The empty state must say which filter hides everything and clear all of
    // it: the old button only cleared the text query and silently did nothing
    // when another filter was the cause.
    await page.getByPlaceholder('Filter by name').fill('zzz-no-such-photo')
    await page.getByText(/No picture matches/).waitFor({ timeout: 10000 })
    const summary = await page.getByText(/No picture matches/).first().textContent()
    assert(summary && summary.includes('search'), `empty state names the filter (got: ${summary})`)
    // The filter box has its own icon-only "Clear filter" button and the bar a
    // "Clear filters (n)" one, so this matches the exact visible text: only the
    // empty-state button carries exactly these words.
    await page.locator('button:text-is("Clear filter")').click({ timeout: 10000 })
    await page.getByText('photo-sunset-01.png').first().waitFor({ timeout: 15000 })
    return 'filter named, cleared, grid back'
  })

  await step(page, 'terminal spawns through the shared route', async () => {
    // The drawer's output subscription lives in the panel, not in each view, so
    // this proves the routing: enable, open with Ctrl+backtick, and a live shell
    // must appear. xterm renders rows as DOM text, so the assertion is the shell
    // prompt itself - bytes that traveled PTY, main, the shared route, and the
    // view. No text, no proof the route is connected.
    await tabs.getByRole('button', { name: /settings/i }).click({ timeout: 10000 })
    const toggle = page.getByRole('switch', { name: 'Terminal' })
    await toggle.waitFor({ timeout: 10000 })
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      await toggle.click({ timeout: 10000 })
    }
    await page.keyboard.press('Escape')
    // The drawer shortcut is Ctrl+backtick (a bare backtick is unbound), matching
    // the app's global shortcuts.
    await page.keyboard.press('Control+`')
    const unavailable = page.getByText('The terminal is not available on this system.')
    if (await unavailable.first().isVisible().catch(() => false)) {
      return 'skipped: terminal unavailable in this environment'
    }
    const rows = page.locator('.xterm-rows')
    await rows.getByText(/PS .*>/).first().waitFor({ timeout: 30000 })
    await screenshot(page, 'terminal')
    return 'shell prompt rendered through the shared route'
  })

  await step(page, 'narrow window keeps the dock inside its share', async () => {
    const browserWindow = await electronApp.browserWindow(page)
    await browserWindow.evaluate((win) => win.setSize(720, 800))
    await page.waitForTimeout(600)
    // The resize itself is asserted first: every check below is meaningless at
    // full width, and a silent no-op resize would pass them all vacuously.
    const viewport = await page.evaluate(() => window.innerWidth)
    assert(viewport <= 730, `window did not narrow (innerWidth ${viewport})`)
    const width = await page.locator('aside').first().evaluate((el) => el.getBoundingClientRect().width)
    await screenshot(page, 'narrow')
    assert(width > 0 && width <= 720 * 0.6 + 1, `dock is ${Math.round(width)}px on a 720px window`)
    // Below 900px the secondary toolbar controls live in the More menu rather
    // than wrapping to three rows: it must exist, open, and offer sorting.
    const more = page.getByRole('button', { name: 'More toolbar controls' })
    await more.waitFor({ state: 'visible', timeout: 10000 })
    await more.click({ timeout: 10000 })
    await page.getByRole('menu', { name: 'More toolbar controls' }).waitFor({ timeout: 10000 })
    await screenshot(page, 'overflow')
    await page.keyboard.press('Escape')
    return `dock ${Math.round(width)}px of 720px, overflow menu opens`
  })

  await step(page, 'console stayed quiet', async () => {
    const all = [...pageErrors, ...consoleErrors]
    assert(all.length === 0, `${all.length} problem(s): ${all.slice(0, 3).join(' | ')}`)
    return 'no page errors, no console errors'
  })

  const failed = steps.filter((s) => !s.ok)
  outcome = failed.length === 0 ? 0 : 1
  console.log(`\n==== ${steps.length - failed.length} passed, ${failed.length} failed ====`)
} catch (err) {
  steps.push({ name: 'launch', ok: false, ms: 0, detail: err instanceof Error ? err.message : String(err) })
  console.log(`  FAIL launch -- ${steps[steps.length - 1].detail}`)
  console.log('\n==== 0 passed, 1 failed ====')
} finally {
  const report = {
    at: new Date().toISOString(),
    profileKept: KEEP || outcome !== 0,
    consoleErrors,
    pageErrors,
    steps
  }
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`report: ${join(OUT_DIR, 'report.json')}`)
  try {
    if (electronApp) await electronApp.close()
  } catch {}
  if (!KEEP && outcome === 0) {
    rmSync(profileDir, { recursive: true, force: true })
  } else {
    console.log(`profile kept: ${profileDir}`)
  }
}
process.exit(outcome)
