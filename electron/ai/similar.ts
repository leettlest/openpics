import { nativeImage } from 'electron'
import {
  HASH_HEIGHT,
  HASH_WIDTH,
  SIMILAR_MAX_DISTANCE,
  grayFromBgra,
  hashFromGray,
  hammingDistance,
  type SimilarHit
} from '../../shared/ai-similar'

/**
 * dHash per file, for the life of the process. `null` records a file that could
 * not be decoded, so a run of unreadable files is not retried on every search.
 */
const hashCache = new Map<string, string | null>()

/**
 * Reduces one file to its 64-bit dHash, or null when it is not a decodable
 * still image (a video, an SVG, a file that has moved).
 */
function hashOf(path: string): string | null {
  const cached = hashCache.get(path)
  if (cached !== undefined) return cached

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
  hashCache.set(path, hash)
  return hash
}

/**
 * The candidates that look like `path`, closest first.
 *
 * Only the given candidates are hashed, and each result is cached, so a search
 * over the current view costs one decode per file the first time and almost
 * nothing afterwards. `limit` caps what the dock has to render; the distance
 * cutoff is what decides whether a photo is similar at all.
 */
export function findSimilar(path: string, candidates: readonly string[], limit = 24): SimilarHit[] {
  const target = hashOf(path)
  if (target === null) return []

  const hits: SimilarHit[] = []
  for (const candidate of candidates) {
    if (candidate === path) continue
    const hash = hashOf(candidate)
    if (hash === null) continue
    const distance = hammingDistance(target, hash)
    if (distance <= SIMILAR_MAX_DISTANCE) hits.push({ path: candidate, distance })
  }
  hits.sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path))
  return hits.slice(0, limit)
}
