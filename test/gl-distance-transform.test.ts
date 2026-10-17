/**
 * test/gl-distance-transform: the distance field behind every SDF mask is an
 * exact Euclidean transform. Legacy's two-pass chamfer was off by several
 * percent over long distances, which opened thin slits through shapes halfway
 * through a morph (a ring of tick marks into a squircle showed a cross).
 */

import { describe, expect, it } from 'bun:test'
import { distanceTransform } from '../packages/core/src/gl/mask.js'

function brute(inside: Uint8Array, width: number, height: number, target: 0 | 1): Float32Array {
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let best = Infinity
    for (let v = 0; v < height; v += 1) for (let u = 0; u < width; u += 1) {
      if (inside[v * width + u] === target) best = Math.min(best, (u - x) ** 2 + (v - y) ** 2)
    }
    out[y * width + x] = Math.sqrt(best)
  }
  return out
}

describe('distanceTransform', () => {
  it('matches the true Euclidean distance on random masks, wide and tall', () => {
    let seed = 7
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    for (const [width, height] of [[23, 17], [9, 31], [40, 12]] as const) {
      for (const density of [0.02, 0.1, 0.5]) {
        const inside = new Uint8Array(width * height).map(() => (random() < density ? 1 : 0))
        inside[0] = 1
        for (const target of [0, 1] as const) {
          const got = distanceTransform(inside, width, height, target)
          const want = brute(inside, width, height, target)
          for (let i = 0; i < got.length; i += 1) {
            if (Number.isFinite(want[i]!)) expect(got[i]!).toBeCloseTo(want[i]!, 3)
          }
        }
      }
    }
  })

  it('is zero on the target and measures a single point as a circle', () => {
    const width = 31
    const inside = new Uint8Array(width * width)
    inside[15 * width + 15] = 1
    const d = distanceTransform(inside, width, width, 1)
    expect(d[15 * width + 15]).toBe(0)
    expect(d[15 * width + 25]).toBeCloseTo(10, 5)
    expect(d[25 * width + 25]).toBeCloseTo(Math.SQRT2 * 10, 4)
    expect(d[0]).toBeCloseTo(Math.SQRT2 * 15, 4)
  })

  it('reports a very large distance when nothing matches', () => {
    const d = distanceTransform(new Uint8Array(16), 4, 4, 1)
    expect(d[0]).toBe(1e6)
  })
})
