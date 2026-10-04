/**
 * @comice/particles/sampler
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns a source into particles, CPU side, once per source and box size.
 *
 * TWO STEPS:
 * 1. rasterizeSource(): the source drawn into a canvas at the STAGE's
 *    aspect — an image or video cover-fitted (cropped, never stretched),
 *    text fitted and centred in the stage's own font and colour. This
 *    canvas is also the texture the shader colours particles from, so
 *    video stays live and shatter tiles show real pieces of the picture.
 * 2. sampleGrid(): that canvas reduced to a grid of about `count` cells,
 *    one particle (or tile) per cell that isn't transparent.
 *
 * It used to sample everything into a fixed 128x128 square: `count`
 * capped at ~16k whatever was asked (the spec's example asks 120,000),
 * and a wide stage stretched the square, squashing `{ text: 'COMICE' }`.
 */

export type ParticleSample = {
  /** UV-space [x, y] cell centres, one pair per particle, y down. */
  positions: Float32Array
  count: number
  /** The grid the sample was taken on — a shatter tile is one cell. */
  columns: number
  rows: number
}

/** A text source: drawn in the stage's own font family and colour unless
 *  given (`font` is a family, e.g. 'Inter'); sized to fit the stage. */
export type TextSource = { text: string; font?: string; color?: string }

/** Below this alpha (of 255) a cell is empty and gets no particle. */
const ALPHA_THRESHOLD = 16
/** The longest side of a source's canvas (and texture), px. */
const MAX_TEXTURE_SIDE = 1024

/** Grid columns x rows of about `count` cells at `aspect` (width / height). */
export function gridFor(count: number, aspect: number): { columns: number; rows: number } {
  const n = Math.max(1, Math.round(count))
  const columns = Math.max(1, Math.round(Math.sqrt(n * aspect)))
  return { columns, rows: Math.max(1, Math.round(n / columns)) }
}

/** The source rect that covers a `boxWidth` x `boxHeight` box, centred —
 *  CSS object-fit: cover. */
export function coverRect(sourceWidth: number, sourceHeight: number, boxWidth: number, boxHeight: number): { x: number; y: number; width: number; height: number } {
  const scale = Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight)
  const width = boxWidth / scale
  const height = boxHeight / scale
  return { x: (sourceWidth - width) / 2, y: (sourceHeight - height) / 2, width, height }
}

/** Canvas size for a stage of `boxWidth` x `boxHeight`: its aspect, the
 *  longer side at most MAX_TEXTURE_SIDE. */
export function canvasSizeFor(boxWidth: number, boxHeight: number): { width: number; height: number } {
  const w = Math.max(1, boxWidth)
  const h = Math.max(1, boxHeight)
  const scale = Math.min(1, MAX_TEXTURE_SIDE / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

function mediaSize(media: HTMLImageElement | HTMLVideoElement): [number, number] {
  return media instanceof HTMLVideoElement ? [media.videoWidth, media.videoHeight] : [media.naturalWidth, media.naturalHeight]
}

/**
 * Draws `source` into `canvas` (already sized to the stage's aspect).
 * Returns false, never throws, if there's no 2D context or the media has
 * no size yet. `style` supplies the stage's font and colour for text.
 */
export function rasterizeSource(canvas: HTMLCanvasElement, source: HTMLImageElement | HTMLVideoElement | TextSource, style: { fontFamily: string; fontWeight: string; color: string }): boolean {
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  if ('text' in source) {
    const fontAt = (size: number) => `${style.fontWeight} ${size}px ${source.font ?? style.fontFamily}`
    // Fit: as large as fits 90% of the width and 70% of the height.
    let size = Math.round(height * 0.7)
    ctx.font = fontAt(size)
    const measured = ctx.measureText(source.text).width
    if (measured > width * 0.9) size = Math.max(1, Math.floor((size * width * 0.9) / measured))
    ctx.font = fontAt(size)
    ctx.fillStyle = source.color ?? style.color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(source.text, width / 2, height / 2)
    return true
  }
  const [sourceWidth, sourceHeight] = mediaSize(source)
  if (!sourceWidth || !sourceHeight) return false
  const rect = coverRect(sourceWidth, sourceHeight, width, height)
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height)
  return true
}

/**
 * Reduces `canvas` to a grid of about `count` cells and returns one
 * particle per cell that isn't transparent. Returns null, never throws,
 * without a 2D context.
 */
export function sampleGrid(canvas: HTMLCanvasElement, count: number): ParticleSample | null {
  const { columns, rows } = gridFor(count, canvas.width / canvas.height)
  const grid = document.createElement('canvas')
  grid.width = columns
  grid.height = rows
  const ctx = grid.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(canvas, 0, 0, columns, rows) // averages each cell's pixels
  const { data } = ctx.getImageData(0, 0, columns, rows)
  const positions: number[] = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      if (data[(y * columns + x) * 4 + 3]! < ALPHA_THRESHOLD) continue
      positions.push((x + 0.5) / columns, (y + 0.5) / rows)
    }
  }
  return { positions: new Float32Array(positions), count: positions.length / 2, columns, rows }
}

/**
 * Pads or truncates `sample` to exactly `targetCount` particles, so a
 * from/to pair with different counts (a photo and a short wordmark) line
 * up 1:1 — the spec's "each particle carries its destination as well as
 * its origin". Extra slots cycle through the sample (they used to all
 * repeat the LAST particle, piling thousands onto one point).
 */
export function resampleToCount(sample: ParticleSample, targetCount: number): ParticleSample {
  if (sample.count === targetCount) return sample
  const positions = new Float32Array(targetCount * 2)
  if (sample.count === 0) {
    positions.fill(0.5) // nothing to land on: gather at the centre
    return { ...sample, positions, count: targetCount }
  }
  for (let i = 0; i < targetCount; i++) {
    const src = i % sample.count
    positions[i * 2] = sample.positions[src * 2]!
    positions[i * 2 + 1] = sample.positions[src * 2 + 1]!
  }
  return { ...sample, positions, count: targetCount }
}
