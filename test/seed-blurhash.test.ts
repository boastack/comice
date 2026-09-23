/**
 * test/seed-blurhash.test — packages/seed/src/blurhash.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BlurHash's base83 alphabet and encoding are simple enough to hand-build
 * valid fixture strings directly (unlike ThumbHash's packed-bit header,
 * see seed-thumbhash.test.ts's own note on why that file can't do the
 * same) — buildHash() below is a tiny reference ENCODER, used only to
 * produce test fixtures, not shipped in packages/seed/src (seed only ever
 * decodes, per spec's "not an image CDN or build tool" exclusion).
 */

import { describe, expect, it } from 'bun:test'
import { blurHashToRGBA } from '../packages/seed/src/blurhash.js'

const BASE83_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'

function encodeBase83(value: number, length: number): string {
  let result = ''
  let v = Math.round(value)
  for (let i = 0; i < length; i++) {
    const digit = v % 83
    result = BASE83_CHARS[digit] + result
    v = Math.floor(v / 83)
  }
  return result
}

/** A minimal valid BlurHash for a `numX`x`numY` component grid — the DC
 *  term is mid-grey, every AC term is the base83 zero-offset value
 *  (encodes to exactly 0 after the format's own -9..9 remap), so the
 *  decoded bitmap should read as flat grey everywhere. */
function buildFlatGreyHash(numX: number, numY: number): string {
  const sizeFlag = (numY - 1) * 9 + (numX - 1)
  const maxAc = numX * numY - 1
  const quantizedMaxValue = maxAc > 0 ? 10 : 0 // arbitrary small AC scale
  let hash = encodeBase83(sizeFlag, 1) + encodeBase83(quantizedMaxValue, 1)
  // DC: mid-grey (128, 128, 128)
  const dc = (128 << 16) | (128 << 8) | 128
  hash += encodeBase83(dc, 4)
  for (let i = 1; i < numX * numY; i++) {
    // The format's own zero point: value 0 maps through
    // signPow(Math.floor(0/(19*19))/9 - 9, 2) etc. — 9*19*19 encodes
    // exactly the ac "center" (all three channels at their zero offset).
    hash += encodeBase83(9 * 19 * 19 + 9 * 19 + 9, 2)
  }
  return hash
}

describe('blurHashToRGBA', () => {
  it('decodes a valid 1x1 hash to the requested width/height', () => {
    const decoded = blurHashToRGBA(buildFlatGreyHash(1, 1), 16, 16)
    expect(decoded.width).toBe(16)
    expect(decoded.height).toBe(16)
    expect(decoded.rgba.length).toBe(16 * 16 * 4)
  })

  it('a flat-grey hash decodes to a uniform mid-grey bitmap', () => {
    const decoded = blurHashToRGBA(buildFlatGreyHash(1, 1), 8, 8)
    const first = decoded.rgba[0]!
    for (let i = 0; i < decoded.rgba.length; i += 4) {
      expect(decoded.rgba[i]).toBeCloseTo(first, -1)
    }
  })

  it('alpha channel is always fully opaque', () => {
    const decoded = blurHashToRGBA(buildFlatGreyHash(1, 1), 8, 8)
    for (let i = 3; i < decoded.rgba.length; i += 4) {
      expect(decoded.rgba[i]).toBe(255)
    }
  })

  it('every channel value is within [0, 255]', () => {
    const decoded = blurHashToRGBA(buildFlatGreyHash(3, 3), 12, 12)
    for (const value of decoded.rgba) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(255)
    }
  })

  it('decodes a larger component grid (4x3) without throwing', () => {
    expect(() => blurHashToRGBA(buildFlatGreyHash(4, 3), 20, 20)).not.toThrow()
  })

  it('is deterministic — the same hash decodes to the same bitmap twice', () => {
    const hash = buildFlatGreyHash(2, 2)
    const a = blurHashToRGBA(hash, 10, 10)
    const b = blurHashToRGBA(hash, 10, 10)
    expect(Array.from(a.rgba)).toEqual(Array.from(b.rgba))
  })

  it('throws on a hash shorter than the fixed 6-character header', () => {
    expect(() => blurHashToRGBA('ABC', 8, 8)).toThrow()
  })

  it('throws on an invalid base83 character', () => {
    const hash = buildFlatGreyHash(1, 1)
    const corrupted = ' ' + hash.slice(1) // a space is not in the base83 alphabet
    expect(() => blurHashToRGBA(corrupted, 8, 8)).toThrow()
  })

  it('throws when the hash length does not match its declared component grid', () => {
    const hash = buildFlatGreyHash(2, 2)
    expect(() => blurHashToRGBA(hash.slice(0, -2), 8, 8)).toThrow()
  })
})
