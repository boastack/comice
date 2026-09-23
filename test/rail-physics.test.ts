/**
 * test/rail-physics.test — packages/rail/src/physics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions, no DOM — same category as morph's sdf.test.ts/effects.ts
 * tests. Covers the rail state graph's helper math independent of any
 * pointer/keyboard wiring, which test/rail.test.ts covers separately.
 */

import { describe, expect, it } from 'bun:test'
import { clampPosition, computeItemTransform, decayVelocity, nearestIndex, SETTLE_THRESHOLD, wrapIndex, type RailMode } from '../packages/rail/src/physics.js'

const MODES: RailMode[] = ['canvas', 'strip', 'compare', 'stack', 'marquee', 'arc', 'coverflow']

describe('decayVelocity', () => {
  it('multiplies velocity by inertia', () => {
    expect(decayVelocity(1, 0.5)).toBeCloseTo(0.5)
  })

  it('snaps to exactly 0 once below SETTLE_THRESHOLD', () => {
    expect(decayVelocity(SETTLE_THRESHOLD * 1.5, 0.1)).toBe(0)
  })

  it('handles negative velocity symmetrically', () => {
    expect(decayVelocity(-1, 0.5)).toBeCloseTo(-0.5)
  })
})

describe('wrapIndex', () => {
  it('wraps a positive out-of-range index', () => {
    expect(wrapIndex(5, 4)).toBe(1)
  })

  it('wraps a negative index into range', () => {
    expect(wrapIndex(-1, 4)).toBe(3)
  })

  it('returns 0 for a zero or negative itemCount', () => {
    expect(wrapIndex(3, 0)).toBe(0)
    expect(wrapIndex(3, -2)).toBe(0)
  })

  it('leaves an in-range index unchanged', () => {
    expect(wrapIndex(2, 5)).toBe(2)
  })
})

describe('clampPosition', () => {
  it('clamps below 0 up to 0', () => {
    expect(clampPosition(-3, 5)).toBe(0)
  })

  it('clamps above itemCount - 1 down to itemCount - 1', () => {
    expect(clampPosition(10, 5)).toBe(4)
  })

  it('returns 0 for itemCount <= 1', () => {
    expect(clampPosition(3, 1)).toBe(0)
    expect(clampPosition(3, 0)).toBe(0)
  })

  it('passes through an in-range value unchanged', () => {
    expect(clampPosition(2.5, 5)).toBe(2.5)
  })
})

describe('nearestIndex', () => {
  it('rounds to the nearest whole index', () => {
    expect(nearestIndex(2.4, 5)).toBe(2)
    expect(nearestIndex(2.6, 5)).toBe(3)
  })

  it('clamps to [0, itemCount - 1]', () => {
    expect(nearestIndex(-2, 5)).toBe(0)
    expect(nearestIndex(99, 5)).toBe(4)
  })

  it('returns 0 for itemCount <= 0', () => {
    expect(nearestIndex(2, 0)).toBe(0)
  })
})

describe('computeItemTransform', () => {
  it.each(MODES)('returns a finite ItemTransform for every mode ("%s")', (mode) => {
    const t = computeItemTransform(mode, 2, 2.3, 6)
    expect(Number.isFinite(t.offset)).toBe(true)
    expect(Number.isFinite(t.scale)).toBe(true)
    expect(Number.isFinite(t.rotate)).toBe(true)
    expect(Number.isFinite(t.opacity)).toBe(true)
    expect(Number.isFinite(t.z)).toBe(true)
  })

  it('the active item (index === position) is centred for every non-marquee mode', () => {
    for (const mode of MODES) {
      if (mode === 'marquee') continue
      const t = computeItemTransform(mode, 3, 3, 6)
      expect(t.offset).toBeCloseTo(0)
    }
  })

  it('stack mode: distance from the active item reduces scale and opacity', () => {
    const active = computeItemTransform('stack', 0, 0, 5)
    const far = computeItemTransform('stack', 4, 0, 5)
    expect(far.scale).toBeLessThan(active.scale)
    expect(far.opacity).toBeLessThan(active.opacity)
  })

  it('coverflow mode: items away from center rotate and shrink', () => {
    const active = computeItemTransform('coverflow', 2, 2, 5)
    const neighbor = computeItemTransform('coverflow', 3, 2, 5)
    expect(active.rotate).toBeCloseTo(0)
    expect(Math.abs(neighbor.rotate)).toBeGreaterThan(0)
    expect(neighbor.scale).toBeLessThan(active.scale)
  })

  it('compare mode: items beyond +/-1.5 delta are fully transparent', () => {
    const far = computeItemTransform('compare', 5, 0, 10)
    expect(far.opacity).toBe(0)
  })

  it('marquee mode: wraps delta the short way around the loop', () => {
    // itemCount 4, item 0 at position 3 — the short path is +1 (wrap), not -3.
    const t = computeItemTransform('marquee', 0, 3, 4)
    expect(Math.abs(t.offset)).toBeLessThanOrEqual(2)
  })

  it('arc mode: rotation scales linearly with delta', () => {
    const near = computeItemTransform('arc', 1, 0, 5)
    const far = computeItemTransform('arc', 3, 0, 5)
    expect(Math.abs(far.rotate)).toBeGreaterThan(Math.abs(near.rotate))
  })

  it('canvas mode: offset scales up and scale shrinks slightly with distance', () => {
    const active = computeItemTransform('canvas', 0, 0, 5)
    const away = computeItemTransform('canvas', 2, 0, 5)
    expect(Math.abs(away.offset)).toBeGreaterThan(Math.abs(active.offset))
    expect(away.scale).toBeLessThanOrEqual(active.scale)
  })

  it('strip mode: offset is exactly the linear delta, identity otherwise', () => {
    const t = computeItemTransform('strip', 4, 1, 8)
    expect(t.offset).toBeCloseTo(3)
    expect(t.scale).toBe(1)
    expect(t.rotate).toBe(0)
    expect(t.opacity).toBe(1)
  })
})
