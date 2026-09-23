/**
 * test/type-gooey.test — packages/type/src/gooey.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions, no DOM.
 */

import { describe, expect, it } from 'bun:test'
import { meltBlur, meltContrast, meltFilter } from '../packages/type/src/gooey.js'

describe('meltBlur', () => {
  it('is 0 at progress 0 and 1', () => {
    expect(meltBlur(0)).toBeCloseTo(0)
    expect(meltBlur(1)).toBeCloseTo(0)
  })

  it('peaks at the default blur value at progress 0.5', () => {
    expect(meltBlur(0.5)).toBeCloseTo(14)
  })

  it('respects a custom blur peak', () => {
    expect(meltBlur(0.5, { blur: 30 })).toBeCloseTo(30)
  })

  it('is symmetric around 0.5', () => {
    expect(meltBlur(0.3)).toBeCloseTo(meltBlur(0.7))
  })

  it('clamps progress outside [0, 1]', () => {
    expect(meltBlur(-1)).toBeCloseTo(meltBlur(0))
    expect(meltBlur(2)).toBeCloseTo(meltBlur(1))
  })
})

describe('meltContrast', () => {
  it('is the gentle threshold at progress 0 and 1', () => {
    expect(meltContrast(0)).toBeCloseTo(0.5)
    expect(meltContrast(1)).toBeCloseTo(0.5)
  })

  it('peaks at the steep threshold at progress 0.5', () => {
    expect(meltContrast(0.5)).toBeCloseTo(18)
  })

  it('respects a custom [gentle, steep] threshold', () => {
    expect(meltContrast(0, { threshold: [1, 10] })).toBeCloseTo(1)
    expect(meltContrast(0.5, { threshold: [1, 10] })).toBeCloseTo(10)
  })
})

describe('meltFilter', () => {
  it('returns "none" when blur rounds to ~0 (progress 0)', () => {
    expect(meltFilter(0)).toBe('none')
  })

  it('returns a blur()+contrast() filter string mid-transition', () => {
    const filter = meltFilter(0.5)
    expect(filter).toContain('blur(')
    expect(filter).toContain('contrast(')
  })

  it('respects custom options end to end', () => {
    const filter = meltFilter(0.5, { blur: 20, threshold: [2, 30] })
    expect(filter).toContain('blur(20.00px)')
    expect(filter).toContain('contrast(30.00)')
  })
})
