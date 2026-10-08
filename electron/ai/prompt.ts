import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { getBundledPromptPath, getPromptUserPath, ensureUserDataDir } from './paths'
import { DEFAULT_PROMPT, isMissingPrompt, isUneditedDefault } from '../../core/ai-prompt'

/**
 * Make sure a prompt file exists, and return its path.
 *
 * Three cases, in order:
 *
 * 1. The user has a prompt. If it is still a default we shipped, it is upgraded
 *    to the current default - otherwise they would be stuck on the first version
 *    they ever installed, which is the one that tells the model to apologise for
 *    being local.
 * 2. The user has a prompt they wrote. Nothing is touched. Ever.
 * 3. There is no prompt. Copy the bundled one in, or write the default if the
 *    bundled file is missing.
 */
export async function ensurePromptFile(): Promise<string> {
  ensureUserDataDir()
  const userPath = getPromptUserPath()

  if (existsSync(userPath)) {
    upgradeIfUnedited(userPath)
    return userPath
  }

  const bundled = getBundledPromptPath()
  if (bundled && existsSync(bundled)) {
    try {
      await copyFile(bundled, userPath)
      return userPath
    } catch {}
  }
  try {
    writeFileSync(userPath, DEFAULT_PROMPT, 'utf8')
  } catch {}
  return userPath
}

/**
 * Replace the file, but only when it still reads exactly as one of our defaults.
 *
 * A failure here is swallowed: the existing prompt is already usable, so the
 * worst case is that a user stays on an older default rather than losing the
 * ability to chat at all.
 */
function upgradeIfUnedited(userPath: string): void {
  let current: string
  try {
    current = readFileSync(userPath, 'utf8')
  } catch {
    return
  }
  if (!isUneditedDefault(current)) {
    // An empty file carries no words to preserve, so it is repaired rather than
    // kept: leaving it means the runtime silently falls back while the file
    // claims to be the prompt, and the next upgrade would skip it again as
    // "edited". Anything with actual content is still never touched here.
    if (!isMissingPrompt(current)) return
  }
  try {
    writeFileSync(userPath, DEFAULT_PROMPT, 'utf8')
  } catch {}
}

export function readPromptFile(): string {
  try {
    return readFileSync(getPromptUserPath(), 'utf8')
  } catch {
    return ''
  }
}

export async function writePromptFile(content: string): Promise<void> {
  ensureUserDataDir()
  writeFileSync(getPromptUserPath(), content, 'utf8')
}