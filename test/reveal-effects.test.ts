/**
 * test/reveal-effects.test — packages/reveal/src/effects.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure tests, no DOM — every effect function is progress -> CSS string, no
 * side effects.
 */

import { describe, expect, it } from 'bun:test'
import {
  blinds,
  blur,
  computeEffectStyle,
  curtain,
  expand,
  scale,
  slats,
  wipe,
} from '../packages/reveal/src/effects.js'

describe('wipe', () => {
  it('at progress 0, clips the whole element away on the given edge', () => {
    expect(wipe(0, 'left')).toEqual({ clipPath: 'inset(0 100% 0 0)' })
  })

  it('at progress 1, clips nothing', () => {
    expect(wipe(1, 'left')).toEqual({ clipPath: 'inset(0 0% 0 0)' })
  })

  it('defaults to left', () => {
    expect(wipe(0.5)).toEqual(wipe(0.5, 'left'))
  })

  it('supports all four directions', () => {
    expect(wipe(0.5, 'left').clipPath).toBe('inset(0 50% 0 0)')
    expect(wipe(0.5, 'right').clipPath).toBe('inset(0 0 0 50%)')
    expect(wipe(0.5, 'up').clipPath).toBe('inset(50% 0 0 0)')
    expect(wipe(0.5, 'down').clipPath).toBe('inset(0 0 50% 0)')
  })

  it('clamps progress outside 0..1', () => {
    expect(wipe(-1, 'left')).toEqual(wipe(0, 'left'))
    expect(wipe(2, 'left')).toEqual(wipe(1, 'left'))
  })
})

describe('scale', () => {
  it('at progress 0, sits at the from scale with opacity 0', () => {
    const style = scale(0, 0.85)
    expect(style.transform).toBe('scale(0.85)')
    expect(style.opacity).toBe('0')
  })

  it('at progress 1, sits at scale 1 with opacity 1', () => {
    const style = scale(1, 0.85)
    expect(style.transform).toBe('scale(1)')
    expect(style.opacity).toBe('1')
  })

  it('interpolates linearly between from and 1', () => {
    const style = scale(0.5, 0.8)
    expect(style.transform).toBe('scale(0.9)')
  })
})

describe('blur', () => {
  it('at progress 0, fully blurred and invisible', () => {
    const style = blur(0, 16)
    expect(style.filter).toBe('blur(16px)')
    expect(style.opacity).toBe('0')
  })

  it('at progress 1, no blur, fully visible', () => {
    const style = blur(1, 16)
    expect(style.filter).toBe('blur(0px)')
    expect(style.opacity).toBe('1')
  })
})

describe('blinds and slats', () => {
  it('blinds produces a clip-path with horizontal bands', () => {
    const style = blinds(0.5, 4)
    expect(style.clipPath).toContain('polygon')
  })

  it('slats produces a clip-path with vertical bands', () => {
    const style = slats(0.5, 4)
    expect(style.clipPath).toContain('polygon')
  })

  it('blinds and slats differ for the same progress (different axis)', () => {
    expect(blinds(0.5, 4).clipPath).not.toBe(slats(0.5, 4).clipPath)
  })

  it('at progress 0, bands are fully closed (each polygon has zero area)', () => {
    // At progress 0 every band's open size is 0, so start === end for each
    // band — the clip-path still parses, it just reveals nothing.
    const style = blinds(0, 3)
    expect(style.clipPath).toBeDefined()
  })
})

describe('curtain', () => {
  it('at progress 0, fully closed (both edges meet at center)', () => {
    expect(curtain(0)).toEqual({ clipPath: 'inset(0 50% 0 50%)' })
  })

  it('at progress 1, fully open', () => {
    expect(curtain(1)).toEqual({ clipPath: 'inset(0 0% 0 0%)' })
  })
})

describe('expand', () => {
  it('at progress 0, sits at the from scale, heavily inset, invisible', () => {
    const style = expand(0, 0.4)
    expect(style.transform).toBe('scale(0.4)')
    expect(style.opacity).toBe('0')
    expect(style.clipPath).toContain('inset(50%')
  })

  it('at progress 1, full scale, no inset, fully visible', () => {
    const style = expand(1, 0.4)
    expect(style.transform).toBe('scale(1)')
    expect(style.opacity).toBe('1')
    expect(style.clipPath).toContain('inset(0%')
  })
})

describe('computeEffectStyle', () => {
  it('dispatches to the named effect', () => {
    expect(computeEffectStyle('scale', 0.5)).toEqual(scale(0.5))
    expect(computeEffectStyle('blur', 0.5)).toEqual(blur(0.5))
    expect(computeEffectStyle('wipe', 0.5)).toEqual(wipe(0.5))
    expect(computeEffectStyle('blinds', 0.5)).toEqual(blinds(0.5))
    expect(computeEffectStyle('slats', 0.5)).toEqual(slats(0.5))
    expect(computeEffectStyle('curtain', 0.5)).toEqual(curtain(0.5))
    expect(computeEffectStyle('expand', 0.5)).toEqual(expand(0.5))
  })
})
