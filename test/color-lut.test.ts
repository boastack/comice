/**
 * test/color-lut.test — packages/color/src/lut.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure parsing/packing, no DOM/GL — covers parseCubeLut() and
 * packLutTexture() against small synthetic .cube fixtures.
 */

import { describe, expect, it } from 'bun:test'
import { packLutTexture, parseCubeLut } from '../packages/color/src/lut.js'

/** Builds a minimal, valid identity .cube file text for a given size —
 *  every entry is r/(size-1), g/(size-1), b/(size-1) in .cube's own
 *  r-fastest ordering, so decoding it is trivially checkable. */
function buildIdentityCube(size: number): string {
  const lines = [`TITLE "test"`, `LUT_3D_SIZE ${size}`]
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(`${r / (size - 1)} ${g / (size - 1)} ${b / (size - 1)}`)
      }
    }
  }
  return lines.join('\n')
}

describe('parseCubeLut', () => {
  it('parses a valid identity cube of size 2', () => {
    const parsed = parseCubeLut(buildIdentityCube(2))
    expect(parsed.size).toBe(2)
    expect(parsed.data.length).toBe(2 * 2 * 2 * 3)
  })

  it('parses a valid cube of size 4', () => {
    const parsed = parseCubeLut(buildIdentityCube(4))
    expect(parsed.size).toBe(4)
    expect(parsed.data.length).toBe(4 * 4 * 4 * 3)
  })

  it('ignores comment lines', () => {
    const text = `# a comment\nLUT_3D_SIZE 2\n# another\n${buildIdentityCube(2).split('\n').slice(2).join('\n')}`
    expect(() => parseCubeLut(text)).not.toThrow()
  })

  it('ignores TITLE/DOMAIN_MIN/DOMAIN_MAX/LUT_1D_SIZE lines', () => {
    const text = ['TITLE "x"', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1', 'LUT_1D_SIZE 2', 'LUT_3D_SIZE 2', ...buildIdentityCube(2).split('\n').slice(2)].join('\n')
    expect(() => parseCubeLut(text)).not.toThrow()
  })

  it('handles CRLF line endings', () => {
    const text = buildIdentityCube(2).split('\n').join('\r\n')
    expect(() => parseCubeLut(text)).not.toThrow()
  })

  it('throws when LUT_3D_SIZE is missing', () => {
    expect(() => parseCubeLut('0 0 0\n1 1 1')).toThrow()
  })

  it('throws when LUT_3D_SIZE is 0 or 1', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 1\n0 0 0')).toThrow()
  })

  it('throws when the row count does not match size^3', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n1 1 1')).toThrow()
  })

  it('the first row (identity cube) is [0,0,0]', () => {
    const parsed = parseCubeLut(buildIdentityCube(2))
    expect(parsed.data[0]).toBeCloseTo(0)
    expect(parsed.data[1]).toBeCloseTo(0)
    expect(parsed.data[2]).toBeCloseTo(0)
  })
})

describe('packLutTexture', () => {
  it('produces a width*height RGBA buffer of the right size', () => {
    const parsed = parseCubeLut(buildIdentityCube(4))
    const packed = packLutTexture(parsed)
    expect(packed.width).toBe(4 * 4)
    expect(packed.height).toBe(4)
    expect(packed.pixels.length).toBe(packed.width * packed.height * 4)
  })

  it('alpha channel is always fully opaque', () => {
    const parsed = parseCubeLut(buildIdentityCube(2))
    const packed = packLutTexture(parsed)
    for (let i = 3; i < packed.pixels.length; i += 4) {
      expect(packed.pixels[i]).toBe(255)
    }
  })

  it('the r=0,g=0,b=0 identity entry packs to [0,0,0,255] at tile 0, pixel (0,0)', () => {
    const parsed = parseCubeLut(buildIdentityCube(4))
    const packed = packLutTexture(parsed)
    expect(packed.pixels[0]).toBe(0)
    expect(packed.pixels[1]).toBe(0)
    expect(packed.pixels[2]).toBe(0)
    expect(packed.pixels[3]).toBe(255)
  })

  it('the max-corner identity entry (r=g=b=size-1) packs to [255,255,255]', () => {
    const size = 4
    const parsed = parseCubeLut(buildIdentityCube(size))
    const packed = packLutTexture(parsed)
    // Last tile (b = size-1), last pixel within it (r = g = size-1).
    const tileX = (size - 1) * size + (size - 1)
    const py = size - 1
    const idx = (py * packed.width + tileX) * 4
    expect(packed.pixels[idx]).toBe(255)
    expect(packed.pixels[idx + 1]).toBe(255)
    expect(packed.pixels[idx + 2]).toBe(255)
  })

  it('clamps out-of-[0,1] values rather than wrapping/throwing', () => {
    const parsed = { size: 2, data: new Float32Array([-0.5, 1.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }
    const packed = packLutTexture(parsed)
    expect(packed.pixels[0]).toBe(0)
    expect(packed.pixels[1]).toBe(255)
    expect(packed.pixels[2]).toBeCloseTo(128, -1)
  })
})
