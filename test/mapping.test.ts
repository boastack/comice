/**
 * test/mapping.test — packages/core/src/mapping.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure tests, no DOM — matches mapping.ts's own zero-DOM contract.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createMapping } from '../packages/core/src/mapping.js'
import type { MappableTarget } from '../packages/core/src/types.js'

function fakeTarget(): MappableTarget & { values: Record<string, number> } {
  const values: Record<string, number> = {}
  return {
    values,
    getParam: (name) => values[name] ?? 0,
    setParam: (name, value) => {
      values[name] = value
    },
  }
}

describe('createMapping — identity passthrough', () => {
  it('with no options, maps a 0..1 signal straight through', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount')
    mapping.apply({ bass: 0.42 })
    expect(target.values.amount).toBeCloseTo(0.42)
  })

  it('does nothing when the source key is absent', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount')
    mapping.apply({ mid: 0.5 })
    expect(target.values.amount).toBeUndefined()
  })

  it('does nothing when the source value is an array (spectrum)', () => {
    const target = fakeTarget()
    const mapping = createMapping('spectrum', target, 'amount')
    mapping.apply({ spectrum: [0.1, 0.2, 0.3] })
    expect(target.values.amount).toBeUndefined()
  })
})

describe('createMapping — range and output', () => {
  it('remaps a custom input range to the default output', () => {
    const target = fakeTarget()
    // Input 0..100, output defaults to the same as range when unset —
    // but here we set output explicitly to 0..1 to prove independent remapping.
    const mapping = createMapping('bass', target, 'amount', {
      range: [0, 100],
      output: [0, 1],
    })
    mapping.apply({ bass: 50 })
    expect(target.values.amount).toBeCloseTo(0.5)
  })

  it('remaps into a narrower output range', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', {
      output: [0, 0.8],
    })
    mapping.apply({ bass: 1 })
    expect(target.values.amount).toBeCloseTo(0.8)
    mapping.apply({ bass: 0 })
    expect(target.values.amount).toBeCloseTo(0)
    mapping.apply({ bass: 0.5 })
    expect(target.values.amount).toBeCloseTo(0.4)
  })

  it('clamps input to range by default', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount')
    mapping.apply({ bass: 5 })
    expect(target.values.amount).toBeCloseTo(1)
    mapping.apply({ bass: -5 })
    expect(target.values.amount).toBeCloseTo(0)
  })

  it('does not clamp when clamp is false', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { clamp: false, output: [0, 10] })
    mapping.apply({ bass: 2 })
    expect(target.values.amount).toBeCloseTo(20)
  })
})

describe('createMapping — invert, multiplier, offset', () => {
  it('inverts within the output range', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { invert: true })
    mapping.apply({ bass: 0.2 })
    expect(target.values.amount).toBeCloseTo(0.8)
  })

  it('applies a multiplier after remapping', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { multiplier: 2 })
    mapping.apply({ bass: 0.3 })
    expect(target.values.amount).toBeCloseTo(0.6)
  })

  it('applies an offset after the multiplier', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { multiplier: 2, offset: 0.1 })
    mapping.apply({ bass: 0.3 })
    expect(target.values.amount).toBeCloseTo(0.7)
  })
})

describe('createMapping — easing', () => {
  it('linear is a no-op at the midpoint', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { easing: 'linear' })
    mapping.apply({ bass: 0.5 })
    expect(target.values.amount).toBeCloseTo(0.5)
  })

  it('easeIn pulls the midpoint down', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { easing: 'easeIn' })
    mapping.apply({ bass: 0.5 })
    expect(target.values.amount).toBeCloseTo(0.25)
  })

  it('easeOut pushes the midpoint up', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { easing: 'easeOut' })
    mapping.apply({ bass: 0.5 })
    expect(target.values.amount).toBeCloseTo(0.75)
  })

  it('all easings agree at the endpoints', () => {
    for (const easing of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      const target = fakeTarget()
      const mapping = createMapping('bass', target, 'amount', { easing })
      mapping.apply({ bass: 0 })
      expect(target.values.amount).toBeCloseTo(0)
      mapping.apply({ bass: 1 })
      expect(target.values.amount).toBeCloseTo(1)
    }
  })
})

describe('createMapping — smoothing', () => {
  it('with smoothing 0, tracks the raw value exactly every frame', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { smoothing: 0 })
    mapping.apply({ bass: 0.9 })
    expect(target.values.amount).toBeCloseTo(0.9)
    mapping.apply({ bass: 0.1 })
    expect(target.values.amount).toBeCloseTo(0.1)
  })

  it('with smoothing > 0, the first frame snaps to the raw value', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { smoothing: 0.9 })
    mapping.apply({ bass: 0.8 })
    expect(target.values.amount).toBeCloseTo(0.8)
  })

  it('with smoothing > 0, subsequent frames lag toward the new value rather than snapping', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { smoothing: 0.9 })
    mapping.apply({ bass: 0 })
    mapping.apply({ bass: 1 })
    // 90% smoothing: moves only 10% of the way from 0 toward 1 in one frame.
    expect(target.values.amount).toBeCloseTo(0.1, 1)
    expect(target.values.amount).toBeLessThan(1)
  })

  it('reset() clears smoothing state so the next apply() snaps instead of easing in', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount', { smoothing: 0.9 })
    mapping.apply({ bass: 0 })
    mapping.reset()
    mapping.apply({ bass: 1 })
    expect(target.values.amount).toBeCloseTo(1)
  })
})

describe('createMapping — pipeline order', () => {
  it('applies clamp -> remap -> invert -> multiplier -> offset -> easing -> smoothing in that fixed order', () => {
    const target = fakeTarget()
    // range [0,10], output [0,1], invert, multiplier 2, offset 0.1, easeIn.
    // input 5 -> clamp(5,[0,10])=5 -> normalize=0.5 -> easeIn(0.5)=0.25
    // -> invert=0.75 -> denorm into [0,1]=0.75 -> *2=1.5 -> +0.1=1.6
    const mapping = createMapping('bass', target, 'amount', {
      range: [0, 10],
      output: [0, 1],
      invert: true,
      multiplier: 2,
      offset: 0.1,
      easing: 'easeIn',
    })
    mapping.apply({ bass: 5 })
    expect(target.values.amount).toBeCloseTo(1.6)
  })
})

describe('createMapping — does not mutate the target beyond setParam', () => {
  it('calls setParam exactly once per apply()', () => {
    const target = fakeTarget()
    const setSpy = mock(target.setParam)
    target.setParam = setSpy
    const mapping = createMapping('bass', target, 'amount')
    mapping.apply({ bass: 0.5 })
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy).toHaveBeenCalledWith('amount', 0.5)
  })
})

describe('createMapping — construction-time validation (programmer error throws)', () => {
  // A malformed config object throws once, loudly, at the call site
  // where it's easy to fix — it does not silently misbehave every frame
  // forever. Bad *runtime* signal data (the next describe block below)
  // is the opposite: it degrades, it never throws.

  it('throws on a reversed range (min >= max)', () => {
    const target = fakeTarget()
    expect(() => createMapping('bass', target, 'amount', { range: [1, 0] })).toThrow(RangeError)
  })

  it('throws on a degenerate range (min === max)', () => {
    const target = fakeTarget()
    expect(() => createMapping('bass', target, 'amount', { range: [1, 1] })).toThrow(RangeError)
  })

  it('throws on a reversed output range', () => {
    const target = fakeTarget()
    expect(() => createMapping('bass', target, 'amount', { output: [1, 0] })).toThrow(RangeError)
  })

  it('throws on a non-finite range', () => {
    const target = fakeTarget()
    expect(() => createMapping('bass', target, 'amount', { range: [0, Infinity] })).toThrow(RangeError)
    expect(() => createMapping('bass', target, 'amount', { range: [NaN, 1] })).toThrow(RangeError)
  })

  it('throws on a non-finite multiplier or offset', () => {
    const target = fakeTarget()
    expect(() => createMapping('bass', target, 'amount', { multiplier: NaN })).toThrow(RangeError)
    expect(() => createMapping('bass', target, 'amount', { offset: Infinity })).toThrow(RangeError)
  })

  it('throws on smoothing outside [0, 1)', () => {
    const target = fakeTarget()
    expect(() => createMapping('bass', target, 'amount', { smoothing: 1 })).toThrow(RangeError)
    expect(() => createMapping('bass', target, 'amount', { smoothing: 1.5 })).toThrow(RangeError)
    expect(() => createMapping('bass', target, 'amount', { smoothing: -0.1 })).toThrow(RangeError)
    expect(() => createMapping('bass', target, 'amount', { smoothing: NaN })).toThrow(RangeError)
  })

  it('accepts smoothing at the valid boundary (0)', () => {
    const target = fakeTarget()
    expect(() => createMapping('bass', target, 'amount', { smoothing: 0 })).not.toThrow()
  })

  it('accepts a valid range/output combination without throwing', () => {
    const target = fakeTarget()
    expect(() =>
      createMapping('bass', target, 'amount', { range: [0, 100], output: [0, 0.8], smoothing: 0.5 }),
    ).not.toThrow()
  })
})

describe('createMapping — bad runtime signal data degrades instead of throwing', () => {
  it('skips a frame silently when the live signal value is NaN', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount')
    expect(() => mapping.apply({ bass: NaN })).not.toThrow()
    expect(target.values.amount).toBeUndefined()
  })

  it('skips a frame silently when the live signal value is Infinity', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount')
    expect(() => mapping.apply({ bass: Infinity })).not.toThrow()
    expect(target.values.amount).toBeUndefined()
  })

  it('recovers on the next frame once the signal is finite again', () => {
    const target = fakeTarget()
    const mapping = createMapping('bass', target, 'amount')
    mapping.apply({ bass: NaN })
    mapping.apply({ bass: 0.6 })
    expect(target.values.amount).toBeCloseTo(0.6)
  })
})
