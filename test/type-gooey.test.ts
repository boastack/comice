/**
 * test/type-gooey — packages/type/src/gooey.ts, melt's maths
 */

import { describe, expect, it } from 'bun:test'
import { ease, meltFrame, thresholdMatrix, wordFilter } from '../packages/type/src/gooey.js'

describe('ease (melt.curve)', () => {
  it('every named curve runs 0 -> 1 and clamps', () => {
    for (const curve of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(ease(curve, 0)).toBe(0)
      expect(ease(curve, 1)).toBeCloseTo(1)
      expect(ease(curve, -1)).toBe(0)
      expect(ease(curve, 2)).toBeCloseTo(1)
    }
  })

  it('the curves differ where they should', () => {
    expect(ease('linear', 0.25)).toBe(0.25)
    expect(ease('easeIn', 0.5)).toBeCloseTo(0.125)
    expect(ease('easeOut', 0.5)).toBeCloseTo(0.875)
    expect(ease('easeInOut', 0.25)).toBeCloseTo(0.0625)
    expect(ease('easeInOut', 0.75)).toBeCloseTo(0.9375)
    expect(ease(undefined, 0.25)).toBeCloseTo(0.0625) // default easeInOut
  })

  it('a function is its own curve, clamped', () => {
    expect(ease((t) => t * t, 0.5)).toBe(0.25)
    expect(ease(() => 7, 0.5)).toBe(1)
  })
})

describe('meltFrame', () => {
  it('at the ends, one word fully there and unblurred, the other gone', () => {
    expect(meltFrame(0)).toEqual({ from: { opacity: 1, blur: 0 }, to: { opacity: 0, blur: 0 } })
    expect(meltFrame(1)).toEqual({ from: { opacity: 0, blur: 0 }, to: { opacity: 1, blur: 0 } })
  })

  it('at the midpoint both words sit at `blur`, half there', () => {
    const { from, to } = meltFrame(0.5, { blur: 20 })
    expect(from.blur).toBeCloseTo(20)
    expect(to.blur).toBeCloseTo(20)
    expect(from.opacity).toBeCloseTo(0.5 ** 0.4)
  })

  it('a word blurs out as it fades, capped at 100px; default blur 14', () => {
    expect(meltFrame(0.25).to.blur).toBeCloseTo(42) // 14 * 0.75 / 0.25
    expect(meltFrame(0.001, { blur: 14 }).to.blur).toBe(100)
    expect(meltFrame(0.75).from.blur).toBeCloseTo(42)
  })
})

describe('thresholdMatrix', () => {
  it('welds alpha around the cutoff with the given sharpness; colour untouched', () => {
    // [0.5, 18]: alpha' = 18a - 8.5, so a = 0.5 -> 0.5.
    expect(thresholdMatrix([0.5, 18])).toBe('1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8.5')
    expect(thresholdMatrix()).toBe(thresholdMatrix([0.5, 18]))
  })
})

describe('wordFilter', () => {
  it('blur, or none', () => {
    expect(wordFilter({ opacity: 1, blur: 0 })).toBe('none')
    expect(wordFilter({ opacity: 0.5, blur: 3.456 })).toBe('blur(3.46px)')
  })
})
