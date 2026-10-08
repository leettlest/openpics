#!/usr/bin/env node
/**
 * Runs one or more test suites by name, without running the whole chain.
 *
 * Usage:
 *   npm run test:file -- dock-width
 *   npm run test:file -- ai-tools ai-prompt
 *   node scripts/test-file.mjs --list
 *
 * Names match suite file stems as substrings, so `ai` runs every AI suite.
 * The test build runs first, exactly like `npm test`, so the suites exercise
 * current sources rather than a stale dist-test. Stops at the first failing
 * suite, preserving the main script's rule that a failure aborts the rest.
 */

import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TESTS = join(ROOT, 'tests')
const suites = readdirSync(TESTS)
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--help') || args.includes('-h') || args.includes('--list')) {
  console.log('usage: npm run test:file -- <name> [<name> ...]')
  console.log('')
  console.log('suites:')
  for (const suite of suites) console.log(`  ${suite.replace(/\.test\.mjs$/, '')}`)
  process.exit(args.length === 0 ? 1 : 0)
}

const picked = []
for (const want of args.filter((arg) => !arg.startsWith('-'))) {
  const stem = want.endsWith('.test.mjs') ? want : `${want}.test.mjs`
  const matches =
    suites.find((file) => file === stem) !== undefined
      ? [suites.find((file) => file === stem)]
      : suites.filter((file) => file.replace(/\.test\.mjs$/, '').includes(want))
  if (matches.length === 0) {
    console.error(`no suite matches ${JSON.stringify(want)}`);
    process.exit(2)
  }
  for (const match of matches) {
    if (!picked.includes(match)) picked.push(match)
  }
}

// The test build runs through the repo's own TypeScript directly. Spawning npm
// from inside an npm script fails on Windows (npm.cmd needs a shell), and going
// through a shell would trade that for quoting pain, so neither.
const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
for (const project of picked.includes('mcp.test.mjs') ? ['tsconfig.mcp.json', 'tsconfig.test.json'] : ['tsconfig.test.json']) {
  const built = spawnSync(process.execPath, [tsc, '-p', project], { cwd: ROOT, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

for (const suite of picked) {
  console.log(`\n### ${suite}`)
  const run = spawnSync(process.execPath, [join(TESTS, suite)], { cwd: ROOT, stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
