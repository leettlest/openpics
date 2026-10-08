import { nativeImage } from 'electron'
import { statSync } from 'node:fs'
import {
  HASH_HEIGHT,
  HASH_WIDTH,
  SIMILAR_MAX_DISTANCE,
  grayFromBgra,
  hashFromGray,
  hammingDistance,
  type SimilarHit
} from '../../shared/ai-similar'

type CachedHash = {
  hash: string | null
  /** The file this hash was computed from; an edit changes one of these. */
  mtimeMs: number
  size: number
}

/**
 * dHash per file, for the life of the process.
 *
 * Two guards keep it honest. Each entry records the file's mtime and size, so
 * an overwritten photo re-hashes instead of matching by its old bytes forever.
 * And the map is capped with oldest-first eviction, so a large library cannot
 * grow it without bound - and a rescan clears it outright, because a new walk
 * can rename everything the old keys meant.
 */
const hashCache = new Map<string, CachedHash>()
const HASH_CACHE_MAX = 4000

/** Drops every cached hash; called when a scan replaces the library. */
export function clearSimilarCache(): void {
  hashCache.clear()
}

/**
 * Reduces one file to its 64-bit dHash, or null when it is not a decodable
 * still image (a video, an SVG, a file that has moved).
 */
function hashOf(path: string): string | null {
  let mtimeMs = -1
  let size = -1
  try {
    const stat = statSync(path)
    mtimeMs = stat.mtimeMs
    size = stat.size
  } catch {
    // Gone or unreadable: no fingerprint, so nothing is cached and it simply
    // hashes as null. A stat is microseconds; retrying it per search is cheaper
    // than forever remembering a file that may come back.
  }
  const cached = hashCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hash

  let hash: string | null = null
  try {
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) {
      // Stretched to the 9x8 grid on purpose: dHash compares neighbours, so the
      // aspect ratio is deliberately discarded rather than letterboxed.
      const small = image.resize({ width: HASH_WIDTH, height: HASH_HEIGHT, quality: 'good' })
      const { width, height } = small.getSize()
      if (width >= 2 && height >= 1) {
        hash = hashFromGray(grayFromBgra(small.toBitmap(), width, height), width, height)
      }
    }
  } catch {
    hash = null
  }
  if (mtimeMs >= 0) {
    if (hashCache.size >= HASH_CACHE_MAX) {
      const oldest = hashCache.keys().next()
      if (!oldest.done) hashCache.delete(oldest.value)
    }
    hashCache.set(path, { hash, mtimeMs, size })
  }
  return hash
}

/**
 * The candidates that look like `path`, closest first.
 *
 * Only the given candidates are hashed, and each result is cached, so a search
 * over the current view costs one decode per file the first time and almost
 * nothing afterwards. `limit` caps what the dock has to render; the distance
 * cutoff is what decides whether a photo is similar at all.
 *
 * Async with periodic yields: hashing a large view is hundreds of synchronous
 * decodes, and awaiting them all at once would hold the main thread - and with
 * it IPC and thumbnails - until the last one finishes.
 */
export async function findSimilar(path: string, candidates: readonly string[], limit = 24): Promise<SimilarHit[]> {
  const target = hashOf(path)
  if (target === null) return []

  const hits: SimilarHit[] = []
  let sinceYield = 0
  for (const candidate of candidates) {
    if (candidate === path) continue
    const hash = hashOf(candidate)
    if (hash === null) continue
    const distance = hammingDistance(target, hash)
    if (distance <= SIMILAR_MAX_DISTANCE) hits.push({ path: candidate, distance })
    sinceYield += 1
    if (sinceYield >= 32) {
      sinceYield = 0
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  hits.sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path))
  return hits.slice(0, limit)
}
