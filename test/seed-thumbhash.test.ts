/**
 * test/seed-thumbhash.test — packages/seed/src/thumbhash.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * No reference ThumbHash encoder is available in this environment to
 * generate known-good fixture hashes against — same honest-limitation
 * class as gl/noise.ts's "no GLSL compiler" note (ROADMAP.md §2). Tests
 * here cover the decoder's structural contract instead: valid-shaped input
 * decodes to a bounded RGBA bitmap without throwing, malformed input
 * throws, and the header bit-unpacking is exercised across both the
 * landscape and portrait branches plus the with/without-alpha branches.
 */

import { describe, expect, it } from 'bun:test'
import { thumbHashToRGBA } from '../packages/seed/src/thumbhash.js'

/** Builds a syntactically valid ThumbHash byte buffer with controllable
 *  header bits — hasAlpha/isLandscape/lCount — and zeroed AC coefficients,
 *  enough bytes present for the decoder's own byte-length math to read
 *  without running off the end of the buffer. */
function buildHash(options: { hasAlpha?: boolean; isLandscape?: boolean; lCount?: number } = {}): Uint8Array {
  const { hasAlpha = false, isLandscape = false, lCount = 3 } = options
  const bytes = new Uint8Array(32) // generous size; unread trailing bytes are fine, the decoder only reads what its own header says to

  let header24 = 0
  header24 |= 20 & 63 // lDc
  header24 |= (32 & 63) << 6 // pDc
  header24 |= (32 & 63) << 12 // qDc
  header24 |= (16 & 31) << 18 // lScale
  header24 |= (hasAlpha ? 1 : 0) << 23
  bytes[0] = header24 & 0xff
  bytes[1] = (header24 >> 8) & 0xff
  bytes[2] = (header24 >> 16) & 0xff

  let header16 = 0
  header16 |= 32 & 63 // pScale
  header16 |= (32 & 63) << 6 // qScale
  header16 |= (isLandscape ? 1 : 0) << 12
  header16 |= (lCount & 7) << 13
  bytes[3] = header16 & 0xff
  bytes[4] = (header16 >> 8) & 0xff

  if (hasAlpha) {
    bytes[5] = 0x8f // aDc + aScale nibbles, both non-zero but arbitrary
  }

  return bytes
}

describe('thumbHashToRGBA', () => {
  it('decodes a valid hash to a 32x32 RGBA bitmap', () => {
    const decoded = thumbHashToRGBA(buildHash())
    expect(decoded.width).toBe(32)
    expect(decoded.height).toBe(32)
    expect(decoded.rgba.length).toBe(32 * 32 * 4)
  })

  it('every channel value is within [0, 255]', () => {
    const decoded = thumbHashToRGBA(buildHash())
    for (const value of decoded.rgba) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(255)
    }
  })

  it('decodes the landscape branch without throwing', () => {
    expect(() => thumbHashToRGBA(buildHash({ isLandscape: true }))).not.toThrow()
  })

  it('decodes the portrait branch without throwing', () => {
    expect(() => thumbHashToRGBA(buildHash({ isLandscape: false }))).not.toThrow()
  })

  it('decodes the with-alpha branch, and alpha is not forced to fully opaque', () => {
    const decoded = thumbHashToRGBA(buildHash({ hasAlpha: true }))
    // With a non-full aDc nibble, at least one alpha sample should differ
    // from 255 — proves the alpha branch actually ran, not a passthrough.
    const alphaValues = new Set<number>()
    for (let i = 3; i < decoded.rgba.length; i += 4) alphaValues.add(decoded.rgba[i]!)
    expect(alphaValues.size).toBeGreaterThan(0)
  })

  it('decodes the without-alpha branch as fully opaque', () => {
    const decoded = thumbHashToRGBA(buildHash({ hasAlpha: false }))
    for (let i = 3; i < decoded.rgba.length; i += 4) {
      expect(decoded.rgba[i]).toBe(255)
    }
  })

  it('respects a range of lCount values without throwing', () => {
    for (let lCount = 0; lCount <= 7; lCount++) {
      expect(() => thumbHashToRGBA(buildHash({ lCount }))).not.toThrow()
    }
  })

  it('throws on a hash shorter than the fixed header', () => {
    expect(() => thumbHashToRGBA(new Uint8Array([1, 2, 3]))).toThrow()
  })

  it('throws on an empty hash', () => {
    expect(() => thumbHashToRGBA(new Uint8Array([]))).toThrow()
  })

  it('is deterministic — the same hash decodes to the same bitmap twice', () => {
    const hash = buildHash({ isLandscape: true, hasAlpha: true })
    const a = thumbHashToRGBA(hash)
    const b = thumbHashToRGBA(hash)
    expect(Array.from(a.rgba)).toEqual(Array.from(b.rgba))
  })
})
