/**
 * @comice/particles/sampler
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure CPU-side sampling: turns a media element (or text, per spec's own
 * `SourceSpec` — "cloud: from: { image }, to: { text }" example) into a
 * flat array of particle origins, one per instance — position (UV space,
 * 0..1) plus color (RGBA). index.ts uploads the result as instanced
 * vertex attributes.
 *
 * WHY CPU-SIDE, NOT A GPU COMPUTE PASS: WebGL2 has no compute shaders, so
 * "which pixels become particles" has to be decided somewhere — an
 * offscreen 2D canvas readback (getImageData) is the same mechanism
 * `gl/mask.ts`'s own rasterizer and `seed`'s placeholder decoders already
 * use for "get pixel data from something drawable," done once at setup()
 * (or on a from/to change), never per frame — matching every other
 * primitive's "allocate/compute once, not in the render loop" discipline.
 *
 * SPARSE SAMPLING, NOT EVERY PIXEL: a source image easily has millions of
 * pixels; `count` (spec's own option, e.g. "count: 120000") is the
 * requested particle count, so pixels are sampled on a grid stride
 * computed to hit approximately that count, not read exhaustively then
 * downsampled — avoids allocating and immediately discarding a
 * full-resolution buffer for a `count` far below the source's own pixel
 * count, which is the common case.
 */

export type ParticleSample = {
  /** UV-space [x, y] position, one pair per particle, packed flat. */
  positions: Float32Array
  /** RGBA color, one quad per particle, packed flat, 0..1 range. */
  colors: Float32Array
  count: number
}

/** Renders `source` to an offscreen canvas at `sampleWidth`x`sampleHeight`
 *  and reads back its pixel data. Returns null, never throws, if 2D
 *  canvas is unavailable — degrade-never-disappear, matching seed's own
 *  rgbaToDataUrl() fallback. */
function rasterize(source: CanvasImageSource, sampleWidth: number, sampleHeight: number): ImageData | null {
  const canvas = document.createElement('canvas')
  canvas.width = sampleWidth
  canvas.height = sampleHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, sampleWidth, sampleHeight)
  return ctx.getImageData(0, 0, sampleWidth, sampleHeight)
}

/** Renders `text` centered in an offscreen canvas — the `to: { text }`
 *  SourceSpec case spec's own card example uses (image dissolving into a
 *  wordmark). */
function rasterizeText(text: string, sampleWidth: number, sampleHeight: number): ImageData | null {
  const canvas = document.createElement('canvas')
  canvas.width = sampleWidth
  canvas.height = sampleHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${Math.round(sampleHeight * 0.7)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, sampleWidth / 2, sampleHeight / 2)
  return ctx.getImageData(0, 0, sampleWidth, sampleHeight)
}

/** A minimum alpha (0..255) for a pixel to become a particle at all —
 *  skips fully transparent background so text/logo sources don't spend
 *  particles on empty space, the same "only draw what's actually there"
 *  reasoning gl/mask.ts's SDF bake applies to inside/outside classification. */
const ALPHA_THRESHOLD = 16

/**
 * Samples `imageData` on an approximately-`count`-sized grid, returning
 * one particle per sampled pixel whose alpha clears ALPHA_THRESHOLD.
 * The actual returned count may be somewhat below `count` (transparent
 * regions contribute no particles) — never above it, since the stride is
 * computed from the grid's own total cell count, not backfilled.
 */
export function sampleParticles(imageData: ImageData, count: number): ParticleSample {
  const { width, height, data } = imageData
  const totalPixels = width * height
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / Math.max(1, count))))

  const positions: number[] = []
  const colors: number[] = []

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4
      const alpha = data[idx + 3]!
      if (alpha < ALPHA_THRESHOLD) continue
      positions.push(x / width, y / height)
      colors.push(data[idx]! / 255, data[idx + 1]! / 255, data[idx + 2]! / 255, alpha / 255)
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    count: positions.length / 2,
  }
}

/** Samples an <img>/<video>/text SourceSpec into a ParticleSample at
 *  roughly `count` particles. Returns null, never throws, on any
 *  rasterization failure. */
export function sampleSource(source: HTMLImageElement | HTMLVideoElement | { text: string }, count: number, sampleSize = 128): ParticleSample | null {
  const imageData = 'text' in source ? rasterizeText(source.text, sampleSize, sampleSize) : rasterize(source, sampleSize, sampleSize)
  if (!imageData) return null
  return sampleParticles(imageData, count)
}

/**
 * Pads or truncates `sample` to exactly `targetCount` particles, so a
 * `from`/`to` pair with different natural particle counts (a photo vs. a
 * short wordmark, say) still line up 1:1 for per-particle interpolation —
 * spec's own "each particle carries its destination as well as its
 * origin" constraint requires equal-length buffers on both sides. Extra
 * slots repeat the LAST sampled particle (cheap, visually harmless: they
 * collapse onto an already-occupied point) rather than being left as
 * zeroed positions, which would visibly clump particles at the origin.
 */
export function resampleToCount(sample: ParticleSample, targetCount: number): ParticleSample {
  if (sample.count === targetCount) return sample
  if (sample.count === 0) {
    return { positions: new Float32Array(targetCount * 2), colors: new Float32Array(targetCount * 4), count: targetCount }
  }

  const positions = new Float32Array(targetCount * 2)
  const colors = new Float32Array(targetCount * 4)
  for (let i = 0; i < targetCount; i++) {
    const src = Math.min(i, sample.count - 1)
    positions[i * 2] = sample.positions[src * 2]!
    positions[i * 2 + 1] = sample.positions[src * 2 + 1]!
    colors[i * 4] = sample.colors[src * 4]!
    colors[i * 4 + 1] = sample.colors[src * 4 + 1]!
    colors[i * 4 + 2] = sample.colors[src * 4 + 2]!
    colors[i * 4 + 3] = sample.colors[src * 4 + 3]!
  }
  return { positions, colors, count: targetCount }
}
