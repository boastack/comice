/**
 * test/ascii-atlas.test — packages/ascii/src/atlas.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * buildGlyphAtlas() rasterizes via an offscreen 2D canvas, so these tests
 * install the shared fake 2D context (happy-dom has no real one).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildGlyphAtlas } from '../packages/ascii/src/atlas.js'
import { installFake2DContext } from './fake-webgl2.js'

describe('buildGlyphAtlas', () => {
  let uninstall2D: () => void

  beforeEach(() => {
    ;({ uninstall: uninstall2D } = installFake2DContext({ imageDataAlpha: 255 }))
  })

  afterEach(() => {
    uninstall2D()
  })

  it('builds an atlas sized for the default charset (10 glyphs)', () => {
    const atlas = buildGlyphAtlas(' .:-=+*#%@')
    expect(atlas).not.toBeNull()
    expect(atlas!.glyphCount).toBe(10)
    expect(atlas!.width).toBe(32 * 10)
    expect(atlas!.height).toBe(32)
  })

  it('builds an atlas for a single-character charset', () => {
    const atlas = buildGlyphAtlas('#')
    expect(atlas!.glyphCount).toBe(1)
    expect(atlas!.width).toBe(32)
  })

  it('pixels array matches width * height exactly (single R8 channel)', () => {
    const atlas = buildGlyphAtlas('AB')
    expect(atlas!.pixels.length).toBe(atlas!.width * atlas!.height)
  })

  it('every pixel value is within [0, 255]', () => {
    const atlas = buildGlyphAtlas('X')
    for (const value of atlas!.pixels) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(255)
    }
  })

  it('returns null, never throws, when 2D canvas is unavailable', () => {
    uninstall2D()
    expect(buildGlyphAtlas('#')).toBeNull()
    ;({ uninstall: uninstall2D } = installFake2DContext())
  })

  it('handles an empty charset without throwing (glyphCount clamped to 1)', () => {
    expect(() => buildGlyphAtlas('')).not.toThrow()
    expect(buildGlyphAtlas('')!.glyphCount).toBe(1)
  })

  it('is deterministic for the same charset', () => {
    const a = buildGlyphAtlas('.:=')
    const b = buildGlyphAtlas('.:=')
    expect(Array.from(a!.pixels)).toEqual(Array.from(b!.pixels))
  })
})
