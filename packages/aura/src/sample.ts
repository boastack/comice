/**
 * @comice/aura/sample
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure color-sampling and contrast math, no DOM/GL — index.ts owns turning
 * a live media texture into pixel data (via a tiny offscreen downsample +
 * readPixels(), see its own header) and calling into these functions with
 * the result.
 *
 * TWO SAMPLE MODES, PER SPEC: `'edges'` (default) averages a thin border
 * ring of the downsampled frame — spec's own "colour escaping its frame"
 * language points directly at the pixels nearest the frame's own edge,
 * the ones that would visually bleed into the page if the media were a
 * physical object. `'palette'` runs a small k-means-style clustering over
 * every downsampled pixel to extract N dominant colors — the "5 button
 * colours from this scene" case spec's own example describes.
 */

export type RGB = readonly [number, number, number]

/** Relative luminance, WCAG's own formula (sRGB gamma-corrected), used by
 *  both contrastRatio() and the clamp step. */
function relativeLuminance([r, g, b]: RGB): number {
  const toLinear = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

/** WCAG contrast ratio between two colors, always >= 1. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Darkens or lightens `color` (moving it toward black or white, whichever
 * is cheaper) until its contrast ratio against `background` reaches
 * `minRatio`, or until it bottoms/tops out at pure black/white. Spec's
 * own "Contrast clamping is not optional by default... An unreadable
 * page is a bug, not a style" — this is that clamp's actual mechanism,
 * not just a documented intent.
 */
export function clampToContrast(color: RGB, background: RGB, minRatio: number): RGB {
  if (contrastRatio(color, background) >= minRatio) return color

  const bgLuma = relativeLuminance(background)
  // Move toward black if the background is light, toward white if dark —
  // whichever direction can actually reach the target ratio.
  const towardBlack = bgLuma > 0.5

  let [r, g, b] = color
  for (let i = 0; i < 32; i++) {
    if (contrastRatio([r, g, b], background) >= minRatio) break
    const step = towardBlack ? -8 : 8
    r = Math.max(0, Math.min(255, r + step))
    g = Math.max(0, Math.min(255, g + step))
    b = Math.max(0, Math.min(255, b + step))
    if ((towardBlack && r === 0 && g === 0 && b === 0) || (!towardBlack && r === 255 && g === 255 && b === 255)) break
  }
  return [r, g, b]
}

/** Averages a thin ring around the border of a `width`x`height` RGBA
 *  buffer — the 'edges' sample mode. `ringWidth` is in pixels of the
 *  (already-downsampled) buffer, not the source media's real size. */
export function sampleEdges(rgba: Uint8ClampedArray, width: number, height: number, ringWidth = 2): RGB {
  let r = 0
  let g = 0
  let b = 0
  let count = 0

  function accumulate(x: number, y: number): void {
    const idx = (y * width + x) * 4
    r += rgba[idx]!
    g += rgba[idx + 1]!
    b += rgba[idx + 2]!
    count++
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onEdge = x < ringWidth || x >= width - ringWidth || y < ringWidth || y >= height - ringWidth
      if (onEdge) accumulate(x, y)
    }
  }

  if (count === 0) return [0, 0, 0]
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)]
}

/**
 * A small, deterministic k-means over every pixel in an RGBA buffer,
 * returning `count` dominant colors. Seeded from evenly-spaced pixels
 * (not random) so results are reproducible frame to frame for a static
 * image, and don't jitter between nearly-identical clusters on a slowly
 * changing video frame the way a random-seed k-means would.
 */
export function samplePalette(rgba: Uint8ClampedArray, width: number, height: number, count: number): RGB[] {
  const pixelCount = width * height
  const k = Math.max(1, Math.min(count, pixelCount))
  if (pixelCount === 0) return Array.from({ length: k }, () => [0, 0, 0] as RGB)

  const centroids: RGB[] = []
  for (let i = 0; i < k; i++) {
    const pixelIndex = Math.floor((i / k) * pixelCount)
    const idx = pixelIndex * 4
    centroids.push([rgba[idx]!, rgba[idx + 1]!, rgba[idx + 2]!])
  }

  const ITERATIONS = 6
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const sums = centroids.map(() => ({ r: 0, g: 0, b: 0, n: 0 }))
    for (let p = 0; p < pixelCount; p++) {
      const idx = p * 4
      const r = rgba[idx]!
      const g = rgba[idx + 1]!
      const b = rgba[idx + 2]!
      let bestIdx = 0
      let bestDist = Infinity
      for (let c = 0; c < centroids.length; c++) {
        const [cr, cg, cb] = centroids[c]!
        const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
        if (dist < bestDist) {
          bestDist = dist
          bestIdx = c
        }
      }
      const bucket = sums[bestIdx]!
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.n++
    }
    for (let c = 0; c < centroids.length; c++) {
      const bucket = sums[c]!
      if (bucket.n > 0) {
        centroids[c] = [Math.round(bucket.r / bucket.n), Math.round(bucket.g / bucket.n), Math.round(bucket.b / bucket.n)]
      }
    }
  }

  return centroids
}
