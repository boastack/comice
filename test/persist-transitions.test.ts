/**
 * test/persist-transitions.test — packages/persist/src/transitions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions, no DOM.
 */

import { describe, expect, it } from 'bun:test'
import { blendTransition, computeTransitionStyle, curtainTransition, irisTransition, sharedTransition, type Rect } from '../packages/persist/src/transitions.js'

const FROM: Rect = { x: 0, y: 0, width: 100, height: 50 }
const TO: Rect = { x: 200, y: 100, width: 400, height: 300 }

describe('sharedTransition', () => {
  it('returns exactly fromRect at progress 0', () => {
    expect(sharedTransition(FROM, TO, 0).rect).toEqual(FROM)
  })

  it('returns exactly toRect at progress 1', () => {
    expect(sharedTransition(FROM, TO, 1).rect).toEqual(TO)
  })

  it('interpolates linearly at progress 0.5', () => {
    const style = sharedTransition(FROM, TO, 0.5)
    expect(style.rect.x).toBeCloseTo(100)
    expect(style.rect.y).toBeCloseTo(50)
    expect(style.rect.width).toBeCloseTo(250)
    expect(style.rect.height).toBeCloseTo(175)
  })

  it('opacity is always 1 — a plain geometric move, no fade', () => {
    expect(sharedTransition(FROM, TO, 0).opacity).toBe(1)
    expect(sharedTransition(FROM, TO, 0.5).opacity).toBe(1)
    expect(sharedTransition(FROM, TO, 1).opacity).toBe(1)
  })

  it('clamps progress outside [0, 1]', () => {
    expect(sharedTransition(FROM, TO, -1).rect).toEqual(FROM)
    expect(sharedTransition(FROM, TO, 2).rect).toEqual(TO)
  })
})

describe('blendTransition', () => {
  it('opacity is 1 at both ends', () => {
    expect(blendTransition(FROM, TO, 0).opacity).toBeCloseTo(1)
    expect(blendTransition(FROM, TO, 1).opacity).toBeCloseTo(1)
  })

  it('opacity dips at the midpoint', () => {
    const mid = blendTransition(FROM, TO, 0.5).opacity
    expect(mid).toBeLessThan(1)
    expect(mid).toBeCloseTo(0.5, 1)
  })

  it('still interpolates the rect the same as sharedTransition', () => {
    expect(blendTransition(FROM, TO, 0.5).rect).toEqual(sharedTransition(FROM, TO, 0.5).rect)
  })
})

describe('curtainTransition', () => {
  it('produces a clip-path inset string', () => {
    const style = curtainTransition(FROM, TO, 0.5)
    expect(style.clipPath).toContain('inset(')
  })

  it('is fully open (inset 0%) at both ends', () => {
    expect(curtainTransition(FROM, TO, 0).clipPath).toContain('inset(0 0% 0 0%)')
    expect(curtainTransition(FROM, TO, 1).clipPath).toContain('inset(0 0% 0 0%)')
  })

  it('is fully closed (inset 50%) at the midpoint', () => {
    expect(curtainTransition(FROM, TO, 0.5).clipPath).toContain('inset(0 50% 0 50%)')
  })

  it('opacity stays 1 throughout', () => {
    expect(curtainTransition(FROM, TO, 0.5).opacity).toBe(1)
  })
})

describe('irisTransition', () => {
  it('produces a clip-path circle string', () => {
    const style = irisTransition(FROM, TO, 0.5)
    expect(style.clipPath).toContain('circle(')
    expect(style.clipPath).toContain('at 50% 50%')
  })

  it('is fully open (largest radius) at both ends', () => {
    const start = irisTransition(FROM, TO, 0)
    const end = irisTransition(FROM, TO, 1)
    expect(start.clipPath).toContain('circle(76.00%')
    expect(end.clipPath).toContain('circle(76.00%')
  })

  it('is nearly fully closed (smallest radius) at the midpoint, never exactly 0', () => {
    const mid = irisTransition(FROM, TO, 0.5)
    expect(mid.clipPath).toContain('circle(1.00%')
  })
})

describe('computeTransitionStyle', () => {
  it.each(['shared', 'blend', 'curtain', 'iris'] as const)('dispatches to the correct function for "%s"', (name) => {
    const viaDispatch = computeTransitionStyle(name, FROM, TO, 0.5)
    const direct = { shared: sharedTransition, blend: blendTransition, curtain: curtainTransition, iris: irisTransition }[name](FROM, TO, 0.5)
    expect(viaDispatch).toEqual(direct)
  })
})
