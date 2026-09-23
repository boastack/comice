/**
 * test/particles-sampler.test — packages/particles/src/sampler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * sampleParticles()/resampleToCount() are pure (no DOM), tested directly
 * against synthetic ImageData-shaped input. sampleSource() rasterizes via
 * an offscreen 2D canvas, so those tests install the same
 * installFake2DContext() fake test/seed.test.ts uses (happy-dom has no
 * real 2D canvas — see that file's own header for why).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resampleToCount, sampleParticles, sampleSource } from '../packages/particles/src/sampler.js'
import { installFake2DContext } from './fake-webgl2.js'

function makeImageData(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y)
      const idx = (y * width + x) * 4
      data[idx] = r
      data[idx + 1] = g
      data[idx + 2] = b
      data[idx + 3] = a
    }
  }
  return { width, height, data } as unknown as ImageData
}

describe('sampleParticles', () => {
  it('samples one particle per non-transparent pixel when count >= total pixels', () => {
    const imageData = makeImageData(4, 4, () => [255, 0, 0, 255])
    const sample = sampleParticles(imageData, 100) // count far exceeds 16 pixels -> stride 1
    expect(sample.count).toBe(16)
    expect(sample.positions.length).toBe(32)
    expect(sample.colors.length).toBe(64)
  })

  it('skips fully-transparent pixels', () => {
    const imageData = makeImageData(4, 4, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 0, 0, 0]))
    const sample = sampleParticles(imageData, 100)
    expect(sample.count).toBe(8) // only the left half is opaque
  })

  it('produces roughly `count` particles for a large, fully-opaque source', () => {
    const imageData = makeImageData(64, 64, () => [1, 2, 3, 255])
    const sample = sampleParticles(imageData, 100)
    // Grid-stride sampling won't hit the count exactly, but should be in
    // the right order of magnitude, never wildly over it.
    expect(sample.count).toBeGreaterThan(0)
    expect(sample.count).toBeLessThanOrEqual(64 * 64)
  })

  it('positions are normalized to [0, 1) UV space', () => {
    const imageData = makeImageData(8, 8, () => [10, 20, 30, 255])
    const sample = sampleParticles(imageData, 100)
    for (let i = 0; i < sample.positions.length; i++) {
      expect(sample.positions[i]).toBeGreaterThanOrEqual(0)
      expect(sample.positions[i]).toBeLessThan(1)
    }
  })

  it('colors are normalized to [0, 1]', () => {
    const imageData = makeImageData(4, 4, () => [255, 128, 0, 255])
    const sample = sampleParticles(imageData, 100)
    expect(sample.colors[0]).toBeCloseTo(1)
    expect(sample.colors[1]).toBeCloseTo(0.5, 1)
    expect(sample.colors[2]).toBeCloseTo(0)
    expect(sample.colors[3]).toBeCloseTo(1)
  })

  it('a fully transparent source samples zero particles', () => {
    const imageData = makeImageData(4, 4, () => [0, 0, 0, 0])
    const sample = sampleParticles(imageData, 100)
    expect(sample.count).toBe(0)
  })
})

describe('resampleToCount', () => {
  it('returns the same sample object when count already matches', () => {
    const sample = { positions: new Float32Array([0.1, 0.2]), colors: new Float32Array([1, 1, 1, 1]), count: 1 }
    expect(resampleToCount(sample, 1)).toBe(sample)
  })

  it('pads a shorter sample by repeating the last particle', () => {
    const sample = { positions: new Float32Array([0.1, 0.2, 0.5, 0.5]), colors: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]), count: 2 }
    const resampled = resampleToCount(sample, 4)
    expect(resampled.count).toBe(4)
    // Index 2 and 3 repeat index 1's (the last real particle's) position.
    expect(resampled.positions[4]).toBeCloseTo(0.5)
    expect(resampled.positions[5]).toBeCloseTo(0.5)
    expect(resampled.positions[6]).toBeCloseTo(0.5)
    expect(resampled.positions[7]).toBeCloseTo(0.5)
  })

  it('truncates a longer sample', () => {
    const sample = { positions: new Float32Array([0.1, 0.1, 0.2, 0.2, 0.3, 0.3]), colors: new Float32Array(12), count: 3 }
    const resampled = resampleToCount(sample, 2)
    expect(resampled.count).toBe(2)
    expect(resampled.positions.length).toBe(4)
  })

  it('a zero-count source resamples to zeroed positions at the target count', () => {
    const sample = { positions: new Float32Array(0), colors: new Float32Array(0), count: 0 }
    const resampled = resampleToCount(sample, 5)
    expect(resampled.count).toBe(5)
    expect(resampled.positions.length).toBe(10)
    expect(Array.from(resampled.positions).every((v) => v === 0)).toBe(true)
  })
})

describe('sampleSource', () => {
  let uninstall2D: () => void

  beforeEach(() => {
    ;({ uninstall: uninstall2D } = installFake2DContext({ imageDataAlpha: 255 }))
  })

  afterEach(() => {
    uninstall2D()
  })

  it('samples an <img> source without throwing', () => {
    const img = document.createElement('img')
    expect(() => sampleSource(img, 100)).not.toThrow()
  })

  it('samples a { text } source without throwing', () => {
    expect(() => sampleSource({ text: 'COMICE' }, 100)).not.toThrow()
  })

  it('returns a ParticleSample with particles when the fake reports full alpha coverage', () => {
    const img = document.createElement('img')
    const sample = sampleSource(img, 200, 16)
    expect(sample).not.toBeNull()
    expect(sample!.count).toBeGreaterThan(0)
  })

  it('returns null when 2D canvas is unavailable', () => {
    uninstall2D() // revert to happy-dom's real (null) getContext('2d')
    const img = document.createElement('img')
    expect(sampleSource(img, 100)).toBeNull()
    // reinstall so afterEach's own uninstall call doesn't throw on a
    // second, already-reverted teardown
    ;({ uninstall: uninstall2D } = installFake2DContext())
  })
})
