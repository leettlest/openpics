/**
 * Perceptual image hashing, kept free of Electron so it can be tested.
 *
 * This is a difference hash (dHash): the picture is reduced to a 9x8 grayscale
 * grid and each row becomes eight bits saying whether a pixel is brighter than
 * the one to its right. The result is a 64-bit fingerprint that survives
 * resizing and mild re-encoding, which is what makes near-duplicates and
 * look-alikes findable without a model or a network call.
 *
 * It is not semantic search: two photos of the same concept that look nothing
 * alike will not match, and that limitation is stated in the UI rather than
 * hidden.
 */

/** Grid the image is reduced to. One more column than bits per row. */
export const HASH_WIDTH = 9
export const HASH_HEIGHT = 8

/**
 * Largest Hamming distance still called "similar".
 *
 * A dHash of the same photo shifted a little lands within a few bits; 10 is the
 * commonly used cutoff that keeps re-saves and crops together without pulling
 * in unrelated pictures. Compared against the 64-bit hash, so it is exact.
 */
export const SIMILAR_MAX_DISTANCE = 10

/** One result of a similarity search: a file and how far its hash differs. */
export type SimilarHit = {
  path: string
  /** Hamming distance from the queried photo; 0 is a pixel-for-pixel match. */
  distance: number
}

/**
 * Luminance of each pixel of a BGRA bitmap, in row-major order.
 *
 * Electron's `nativeImage.toBitmap()` yields 4 bytes per pixel in blue, green,
 * red, alpha order. Rec. 601 weights are used because they match what a human
 * eye calls "brightness" closely enough for a comparison of neighbours.
 */
export function grayFromBgra(bitmap: Uint8Array, width: number, height: number): number[] {
  const gray = new Array<number>(width * height)
  for (let i = 0; i < width * height; i++) {
    const b = bitmap[i * 4] ?? 0
    const g = bitmap[i * 4 + 1] ?? 0
    const r = bitmap[i * 4 + 2] ?? 0
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }
  return gray
}

/**
 * A 64-bit dHash as sixteen lowercase hex digits.
 *
 * A string rather than a `BigInt` because this value crosses IPC and is stored
 * as JSON, and both would need a special case for a numeric width the platform
 * does not have natively.
 */
export function hashFromGray(gray: readonly number[], width: number, height: number): string {
  let hash = 0n
  let bit = 0n
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = gray[y * width + x] ?? 0
      const right = gray[y * width + x + 1] ?? 0
      if (left < right) hash |= 1n << bit
      bit += 1n
    }
  }
  return hash.toString(16).padStart(16, '0')
}

/** How many bits differ between two hashes: 0 identical, 64 opposite. */
export function hammingDistance(a: string, b: string): number {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let count = 0
  while (value > 0n) {
    count += Number(value & 1n)
    value >>= 1n
  }
  return count
}
