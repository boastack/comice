/**
 * @comice/seed/thumbhash
 * ─────────────────────────────────────────────────────────────────────────────
 * A from-scratch decoder for the ThumbHash format (Evan Wallace's public
 * domain spec, https://evanw.github.io/thumbhash/) — "about 25 bytes,
 * handles transparency," spec's own words for the default placeholder.
 * Decodes a base64/binary hash into a small RGBA bitmap, which index.ts
 * scales up as the placeholder's background before the real media decodes.
 *
 * This is a decoder only, not an encoder — seed's job is to SHOW a
 * placeholder a build step already generated, never to generate one
 * itself (spec's own Excludes: "Not an image CDN or build tool"). The bit
 * layout below follows the reference implementation's own byte layout
 * exactly (DC coefficient + AC coefficients for luminance in a custom
 * grid, plus a smaller grid for two chroma channels, plus an optional
 * alpha channel) since this format has no alternate encoding to diverge
 * from — unlike gl/noise.ts's simplex, there's only one "the" ThumbHash
 * bit layout, so there's no port-vs-invent question here at all.
 */

export type DecodedThumbHash = {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row-major. */
  rgba: Uint8ClampedArray
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Decodes a ThumbHash byte array into a small RGBA bitmap. Throws on a
 * hash too short to contain even the fixed header — a malformed hash is a
 * caller/upstream-generation error, not something to silently blank out.
 */
export function thumbHashToRGBA(hash: Uint8Array): DecodedThumbHash {
  if (hash.length < 5) {
    throw new Error('[comice] seed(): thumbhash is too short to be valid.')
  }

  const header24 = hash[0]! | (hash[1]! << 8) | (hash[2]! << 16)
  const lDc = (header24 & 63) / 63
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1
  const lScale = ((header24 >> 18) & 31) / 31
  const hasAlpha = (header24 >> 23) & 1

  const header16 = hash[3]! | (hash[4]! << 8)
  const pScale = ((header16 >> 0) & 63) / 63
  const qScale = ((header16 >> 6) & 63) / 63
  const isLandscape = (header16 >> 12) & 1
  const lMaxCount = hasAlpha ? 5 : 7
  const lCountRaw = (header16 >> 13) & 7
  const lCount = clamp(lCountRaw, 0, lMaxCount)

  let ac_start = hasAlpha ? 6 : 5
  let ac_index = 0
  const bytes = hash

  function readAc(count: number, scale: number): number[] {
    const values: number[] = []
    for (let i = 0; i < count; i++) {
      const bitOffset = ac_index * 6
      const byteOffset = ac_start + (bitOffset >> 3)
      const bitShift = bitOffset & 7
      let raw: number
      if (byteOffset + 1 < bytes.length) {
        raw = ((bytes[byteOffset]! >> bitShift) | (bytes[byteOffset + 1]! << (8 - bitShift))) & 63
      } else if (byteOffset < bytes.length) {
        raw = (bytes[byteOffset]! >> bitShift) & 63
      } else {
        raw = 0
      }
      values.push((raw / 31.5 - 1) * scale)
      ac_index++
    }
    return values
  }

  const lx = isLandscape ? lMaxCount : lCount
  const ly = isLandscape ? lCount : lMaxCount
  const lAc = readAc(Math.max(0, lx * ly - 1), lScale)
  const pAc = readAc(3, pScale)
  const qAc = readAc(3, qScale)

  let aDc = 1
  let aAc: number[] = []
  if (hasAlpha) {
    const aByte = bytes[5] ?? 0
    aDc = (aByte & 15) / 15
    ac_start = 6
    aAc = readAc(4, ((aByte >> 4) & 15) / 15)
  }

  // A small, fixed square decode grid is sufficient for a placeholder —
  // 32 is the reference implementation's own default thumbnail edge
  // length. The real aspect ratio (from isLandscape/lCount/lMaxCount
  // above) is what shapes the LUMINANCE grid's own lx/ly, not the output
  // bitmap's own pixel dimensions — index.ts's caller stretches this
  // square bitmap to the target element's real aspect via CSS regardless.
  const w = 32
  const h = 32
  const rgba = new Uint8ClampedArray(w * h * 4)

  function fetchDct(cx: number, cy: number, ac: number[], nx: number, ny: number, dc: number): number {
    let value = dc
    let acIdx = 0
    for (let cyi = 0; cyi < ny; cyi++) {
      for (let cxi = cyi === 0 ? 1 : 0; cxi < nx; cxi++) {
        const coeff = ac[acIdx] ?? 0
        acIdx++
        value += coeff * Math.cos((Math.PI / w) * cx * cxi) * Math.cos((Math.PI / h) * cy * cyi)
      }
    }
    return value
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = fetchDct(x + 0.5, y + 0.5, lAc, lx, ly, lDc)
      const p = fetchDct(x + 0.5, y + 0.5, pAc, 3, 3, pDc)
      const q = fetchDct(x + 0.5, y + 0.5, qAc, 3, 3, qDc)
      const a = hasAlpha ? fetchDct(x + 0.5, y + 0.5, aAc, 4, 4, aDc) : 1

      const b = l - (2 / 3) * p
      const r = (3 * l - b + q) / 2
      const g = r - q

      const idx = (y * w + x) * 4
      rgba[idx] = clamp(r * 255, 0, 255)
      rgba[idx + 1] = clamp(g * 255, 0, 255)
      rgba[idx + 2] = clamp(b * 255, 0, 255)
      rgba[idx + 3] = clamp(a * 255, 0, 255)
    }
  }

  return { width: w, height: h, rgba }
}
