/**
 * test/aura-sample.test — packages/aura/src/sample.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions, no DOM/GL.
 */

import { describe, expect, it } from 'bun:test'
import { clampToContrast, contrastRatio, sampleEdges, samplePalette, type RGB } from '../packages/aura/src/sample.js'

describe('contrastRatio', () => {
  it('is 1 for identical colors', () => {
    expect(contrastRatio([100, 100, 100], [100, 100, 100])).toBeCloseTo(1)
  })

  it('is 21 for pure black vs pure white', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0)
  })

  it('is symmetric', () => {
    const a: RGB = [10, 200, 50]
    const b: RGB = [220, 20, 90]
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a))
  })

  it('is always >= 1', () => {
    expect(contrastRatio([128, 64, 200], [50, 180, 10])).toBeGreaterThanOrEqual(1)
  })
})

describe('clampToContrast', () => {
  it('returns the color unchanged if it already meets the minimum ratio', () => {
    const color: RGB = [0, 0, 0]
    const background: RGB = [255, 255, 255]
    expect(clampToContrast(color, background, 4.5)).toEqual(color)
  })

  it('darkens a light color against a light background to meet the ratio', () => {
    const color: RGB = [240, 240, 240]
    const background: RGB = [255, 255, 255]
    const clamped = clampToContrast(color, background, 4.5)
    expect(contrastRatio(clamped, background)).toBeGreaterThanOrEqual(4.5 - 0.1)
  })

  it('lightens a dark color against a dark background to meet the ratio', () => {
    const color: RGB = [10, 10, 10]
    const background: RGB = [0, 0, 0]
    const clamped = clampToContrast(color, background, 4.5)
    expect(contrastRatio(clamped, background)).toBeGreaterThanOrEqual(4.5 - 0.1)
  })

  it('bottoms out at pure black rather than looping forever', () => {
    // An unreachable ratio against a mid-gray background still terminates.
    const color: RGB = [200, 200, 200]
    const background: RGB = [128, 128, 128]
    expect(() => clampToContrast(color, background, 21)).not.toThrow()
  })

  it('tops out at pure white rather than looping forever', () => {
    const color: RGB = [50, 50, 50]
    const background: RGB = [128, 128, 128]
    expect(() => clampToContrast(color, background, 21)).not.toThrow()
  })
})

describe('sampleEdges', () => {
  it('averages only the border ring, ignoring the center', () => {
    const width = 6
    const height = 6
    const rgba = new Uint8ClampedArray(width * height * 4)
    // Fill everything red, then make the center 2x2 blue.
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = 255
      rgba[i * 4 + 3] = 255
    }
    for (let y = 2; y < 4; y++) {
      for (let x = 2; x < 4; x++) {
        const idx = (y * width + x) * 4
        rgba[idx] = 0
        rgba[idx + 2] = 255
      }
    }
    const [r, g, b] = sampleEdges(rgba, width, height, 1)
    expect(r).toBe(255) // border ring is pure red, center-blue never sampled
    expect(b).toBe(0)
  })

  it('returns [0,0,0] for a zero-size buffer without throwing', () => {
    expect(sampleEdges(new Uint8ClampedArray(0), 0, 0)).toEqual([0, 0, 0])
  })
})

describe('samplePalette', () => {
  it('returns exactly `count` colors', () => {
    const width = 8
    const height = 8
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = 255
    const palette = samplePalette(rgba, width, height, 3)
    expect(palette.length).toBe(3)
  })

  it('clusters two distinct colors into two centroids close to each original', () => {
    const width = 4
    const height = 4
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      const isLeft = i % width < width / 2
      rgba[i * 4] = isLeft ? 255 : 0
      rgba[i * 4 + 2] = isLeft ? 0 : 255
      rgba[i * 4 + 3] = 255
    }
    const palette = samplePalette(rgba, width, height, 2)
    const hasNearRed = palette.some(([r, , b]) => r > 200 && b < 50)
    const hasNearBlue = palette.some(([r, , b]) => r < 50 && b > 200)
    expect(hasNearRed).toBe(true)
    expect(hasNearBlue).toBe(true)
  })

  it('handles a zero-pixel buffer without throwing', () => {
    expect(() => samplePalette(new Uint8ClampedArray(0), 0, 0, 3)).not.toThrow()
  })

  it('is deterministic given the same input', () => {
    const width = 6
    const height = 6
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = (i * 37) % 255
      rgba[i * 4 + 1] = (i * 71) % 255
      rgba[i * 4 + 2] = (i * 13) % 255
      rgba[i * 4 + 3] = 255
    }
    const a = samplePalette(rgba, width, height, 4)
    const b = samplePalette(rgba, width, height, 4)
    expect(a).toEqual(b)
  })

  it('requesting more colors than pixels does not throw', () => {
    const width = 2
    const height = 1
    const rgba = new Uint8ClampedArray(width * height * 4)
    rgba[3] = 255
    rgba[7] = 255
    expect(() => samplePalette(rgba, width, height, 10)).not.toThrow()
  })
})
