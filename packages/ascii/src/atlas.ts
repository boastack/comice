/**
 * @comice/ascii/atlas
 * ─────────────────────────────────────────────────────────────────────────────
 * Rasterizes `charset`'s glyphs into one horizontal-strip signed-distance-
 * field texture, at setup() only (never per frame — same "rasterize once,
 * re-rasterize only when the source actually changes" discipline
 * gl/mask.ts's own createRasterizedMask() holds to for shape/text masks).
 *
 * THE SAME TWO-PASS CHAMFER DISTANCE TRANSFORM AS gl/mask.ts's OWN SDF
 * BAKE, reimplemented here rather than imported: `gl/mask.ts`'s
 * `bakeSignedDistanceField()`/`distanceTransform()` are private to that
 * module (mask.ts's own producers are the only intended callers — no
 * public "give me an SDF from any ImageData" API is exported, and adding
 * one now would be new core surface for a single downstream consumer,
 * which is a bigger call than this pass should make unilaterally). The
 * algorithm is genuinely the same math (this is real prior art being
 * applied to glyphs instead of shapes/text-as-mask), so it's ported
 * faithfully rather than re-derived from scratch — "port, don't
 * reinvent" applies exactly as much to porting from a sibling module in
 * this same codebase as it does to porting from legacy/.
 */

export type GlyphAtlas = {
  width: number
  height: number
  /** R8 grayscale SDF values, one byte per pixel, row-major. */
  pixels: Uint8Array
  glyphCount: number
}

const GLYPH_CELL_PX = 32 // per-glyph raster resolution before SDF encoding
const SDF_MAX_DISTANCE = 8 // px, matching gl/mask.ts's own default maxDistance scale

function distanceTransform(inside: Uint8Array, width: number, height: number, target: 0 | 1): Float32Array {
  const INF = width + height
  const dist = new Float32Array(width * height)
  for (let i = 0; i < inside.length; i++) {
    dist[i] = inside[i] === target ? 0 : INF
  }

  // Forward sweep
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      let best = dist[index]!
      if (x > 0) best = Math.min(best, dist[index - 1]! + 1)
      if (y > 0) best = Math.min(best, dist[index - width]! + 1)
      dist[index] = best
    }
  }
  // Reverse sweep
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x
      let best = dist[index]!
      if (x < width - 1) best = Math.min(best, dist[index + 1]! + 1)
      if (y < height - 1) best = Math.min(best, dist[index + width]! + 1)
      dist[index] = best
    }
  }

  return dist
}

function bakeGlyphSDF(imageData: ImageData, maxDistance: number): Uint8Array {
  const { width, height, data } = imageData
  const inside = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    inside[i] = data[i * 4 + 3]! > 96 ? 1 : 0
  }

  const toOutside = distanceTransform(inside, width, height, 0)
  const toInside = distanceTransform(inside, width, height, 1)

  const encoded = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const signedDistance = inside[i] === 1 ? toOutside[i]! : -toInside[i]!
    const normalized = 0.5 + 0.5 * Math.max(-1, Math.min(1, signedDistance / maxDistance))
    encoded[i] = Math.round(normalized * 255)
  }
  return encoded
}

/**
 * Builds a horizontal glyph-strip SDF atlas for `charset` — one
 * GLYPH_CELL_PX-wide cell per character, in `charset` order (shader.ts's
 * own `atlasStep = 1.0 / glyphCount` UV math assumes this exact layout).
 * Returns null, never throws, if 2D canvas is unavailable —
 * degrade-never-disappear: no atlas means ascii's own drawAscii() no-ops
 * (its texture-null guard), same as every other GL primitive's fallback.
 */
export function buildGlyphAtlas(charset: string): GlyphAtlas | null {
  const glyphs = Array.from(charset)
  const glyphCount = Math.max(1, glyphs.length)

  const canvas = document.createElement('canvas')
  canvas.width = GLYPH_CELL_PX * glyphCount
  canvas.height = GLYPH_CELL_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.font = `${Math.round(GLYPH_CELL_PX * 0.8)}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  glyphs.forEach((glyph, i) => {
    ctx.fillText(glyph, i * GLYPH_CELL_PX + GLYPH_CELL_PX / 2, GLYPH_CELL_PX / 2)
  })

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const pixels = bakeGlyphSDF(imageData, SDF_MAX_DISTANCE)

  return { width: canvas.width, height: canvas.height, pixels, glyphCount }
}
