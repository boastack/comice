/**
 * @comice/color/lut
 * ─────────────────────────────────────────────────────────────────────────────
 * Parses a real Adobe/Iridas .cube 3D LUT file — "the format colourists
 * already use," spec's own words — into a flat RGB Float32Array plus its
 * cube size, and re-packs it into the tiled 2D-strip layout shader.ts's
 * `buildLutGLSL()` expects (size*size wide, size tall; blue tile-indexed
 * across the width, red/green addressed within each tile). Pure parsing/
 * packing, no DOM, no GL — index.ts owns turning the packed array into an
 * actual uploaded texture.
 */

export type ParsedLut = {
  size: number
  /** RGB triples, `size * size * size` entries, in the raw .cube file's
   *  own r-fastest, then g, then b ordering. */
  data: Float32Array
}

/**
 * Parses a .cube file's text content. Recognizes `LUT_3D_SIZE`, a bare
 * `TITLE`/`DOMAIN_MIN`/`DOMAIN_MAX` (ignored — domain remapping is a
 * follow-up, every real-world LUT this needs to interoperate with ships
 * with the default 0..1 domain), comment lines (`#...`), and one `r g b`
 * triple per non-comment, non-keyword line. Throws on a missing or
 * zero `LUT_3D_SIZE`, or a row count that doesn't match `size^3` — a
 * malformed LUT is a caller configuration error, not something to
 * silently half-apply.
 */
export function parseCubeLut(text: string): ParsedLut {
  const lines = text.split(/\r?\n/)
  let size = 0
  const rows: number[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    if (line.startsWith('LUT_3D_SIZE')) {
      const parts = line.split(/\s+/)
      size = Number.parseInt(parts[1] ?? '', 10)
      continue
    }
    if (line.startsWith('TITLE') || line.startsWith('DOMAIN_MIN') || line.startsWith('DOMAIN_MAX') || line.startsWith('LUT_1D_SIZE')) {
      continue
    }

    const parts = line.split(/\s+/).map(Number)
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      rows.push(parts[0]!, parts[1]!, parts[2]!)
    }
  }

  if (!size || size < 2) {
    throw new Error('[comice] color(): .cube file is missing a valid LUT_3D_SIZE.')
  }
  const expected = size * size * size * 3
  if (rows.length !== expected) {
    throw new Error(`[comice] color(): .cube file has ${rows.length / 3} entries, expected ${size ** 3} for LUT_3D_SIZE ${size}.`)
  }

  return { size, data: new Float32Array(rows) }
}

/**
 * Re-packs a ParsedLut's raw r-fastest ordering into the tiled 2D-strip
 * RGBA layout shader.ts's `buildLutGLSL()` samples: width `size*size`,
 * height `size`, blue-tile index along the width. Returns Uint8Array RGBA
 * (WebGL2's most universally supported uploadable format) — colour
 * precision loss from float->8-bit is the same tradeoff every non-HDR LUT
 * pipeline accepts.
 */
export function packLutTexture(lut: ParsedLut): { width: number; height: number; pixels: Uint8Array } {
  const { size, data } = lut
  const width = size * size
  const height = size
  const pixels = new Uint8Array(width * height * 4)

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        // .cube ordering: r varies fastest, then g, then b.
        const srcIndex = (b * size * size + g * size + r) * 3
        const px = r
        const py = g
        const tileX = b * size + px
        const dstIndex = (py * width + tileX) * 4
        pixels[dstIndex] = Math.round(Math.max(0, Math.min(1, data[srcIndex]!)) * 255)
        pixels[dstIndex + 1] = Math.round(Math.max(0, Math.min(1, data[srcIndex + 1]!)) * 255)
        pixels[dstIndex + 2] = Math.round(Math.max(0, Math.min(1, data[srcIndex + 2]!)) * 255)
        pixels[dstIndex + 3] = 255
      }
    }
  }

  return { width, height, pixels }
}
