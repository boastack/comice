/**
 * test/mosaic-palette — packages/mosaic/src/palette.ts + brand-colour fills
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec: mosaic's `palette: string[] | number` — "Brand colours, or a count."
 * A colour list was accepted and silently ignored (only its length reached
 * the shader). These cover parsing, ordering, the error cases, and that
 * each fill's generated GLSL actually reads the colours.
 */

import { describe, expect, it } from 'bun:test'
import { buildPalette, parseColor } from '../packages/mosaic/src/palette.js'
import { buildFragmentShader, type MosaicFill } from '../packages/mosaic/src/shader.js'

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 3))

describe('parseColor', () => {
  it('reads hex in every length', () => {
    close(parseColor('#f06'), [1, 0, 0x66 / 255])
    close(parseColor('#ff0066'), [1, 0, 0x66 / 255])
    close(parseColor('#ff006680'), [1, 0, 0x66 / 255]) // alpha ignored
    close(parseColor('#F06F'), [1, 0, 0x66 / 255])
  })

  it('reads rgb()/rgba() with numbers or percentages', () => {
    close(parseColor('rgb(255, 0, 102)'), [1, 0, 102 / 255])
    close(parseColor('rgba(255 0 102 / 0.5)'), [1, 0, 102 / 255])
    close(parseColor('rgb(100%, 0%, 40%)'), [1, 0, 0.4])
  })

  it('hands anything else (named, hsl, oklch) to the browser\'s own parser', () => {
    // happy-dom resolves named colours through computed style, as a browser does.
    const original = globalThis.getComputedStyle
    ;(globalThis as any).getComputedStyle = () => ({ color: 'rgb(255, 99, 71)' })
    try {
      close(parseColor('tomato'), [1, 99 / 255, 71 / 255])
    } finally {
      globalThis.getComputedStyle = original
    }
  })

  it('throws naming the bad value when nothing can parse it', () => {
    expect(() => parseColor('not-a-colour')).toThrow(/'not-a-colour' in `palette` is not a colour/)
  })

  it('throws when the browser accepts the value but its computed form is unreadable', () => {
    const original = globalThis.getComputedStyle
    ;(globalThis as any).getComputedStyle = () => ({ color: '' })
    try {
      expect(() => parseColor('red')).toThrow(/not a colour/)
    } finally {
      globalThis.getComputedStyle = original
    }
  })

  it('throws (rather than guessing) where there is no document to ask', () => {
    const doc = globalThis.document
    ;(globalThis as any).document = undefined
    try {
      expect(() => parseColor('tomato')).toThrow(/not a colour/)
    } finally {
      globalThis.document = doc
    }
  })
})

describe('buildPalette', () => {
  it('sorts darkest to lightest, whatever order the caller used', () => {
    const p = buildPalette(['#ffffff', '#000000', '#ff0066'])
    close(Array.from(p), [0, 0, 0, 1, 0, 0x66 / 255, 1, 1, 1])
  })

  it('needs at least two colours: every palette fill maps dark to one end, light to the other', () => {
    expect(() => buildPalette(['#ff0066'])).toThrow(/at least two colours/)
  })
})

describe('brand colours in the generated GLSL', () => {
  const withColors = (fill: MosaicFill) => buildFragmentShader({ fill, paletteCount: 3, paletteColors: true })
  const withoutColors = (fill: MosaicFill) => buildFragmentShader({ fill, paletteCount: 3 })

  it('dither: each level IS a brand colour', () => {
    expect(withColors('dither')).toContain('uniform vec3 u_palette[3];')
    expect(withColors('dither')).toContain('color.rgb = u_palette[level];')
  })

  it('halftone and crosshatch: darkest is the ink, lightest the paper, blended in OKLab', () => {
    for (const fill of ['halftone', 'crosshatch'] as const) {
      expect(withColors(fill)).toContain('paletteMix(u_palette[2], u_palette[0]')
      expect(withColors(fill)).toContain('vec3 toOklab(')
    }
  })

  it('pixelate: each cell snaps to the nearest brand colour, measured in OKLab', () => {
    expect(withColors('pixelate')).toContain('distance(lab, toOklab(u_palette[i]))')
  })

  it('dither reads one brightness per cell, at its centre (per-pixel brightness split cells into specks)', () => {
    expect(withColors('dither')).toContain('vec3 cellColor = texture(u_media, clamp(cellUv, 0.0, 1.0)).rgb;')
    expect(withoutColors('dither')).toContain('float luma = dot(cellColor,')
  })

  it('riso and images ignore colours (their look is RGB drums / tiles)', () => {
    for (const fill of ['riso', 'images'] as const) expect(withColors(fill)).not.toContain('u_palette')
  })

  it('without a colour list, output is unchanged from before', () => {
    for (const fill of ['dither', 'halftone', 'pixelate', 'crosshatch'] as const) expect(withoutColors(fill)).not.toContain('u_palette')
    expect(withoutColors('halftone')).toContain('color.rgb = vec3(1.0 - dot);')
  })
})
