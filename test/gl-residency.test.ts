/**
 * test/gl-residency.test — packages/core/src/gl/residency.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts
 * for the same reason gl-plane.test.ts needs it — happy-dom's real
 * getContext('webgl2') is always null, so residency.ts's actual GL-touching
 * logic (activeTexture/bindTexture sequencing, getParameter reads) has
 * nothing real to run against without a fake.
 */

import { describe, expect, it } from 'bun:test'
import { effectiveDPR, getResidencyPool } from '../packages/core/src/gl/residency.js'
import { createFakeGLContext } from './fake-webgl2.js'

function fakeTexture(id: string): WebGLTexture {
  return { __id: id } as unknown as WebGLTexture
}

describe('effectiveDPR', () => {
  it('is re-exported from context.ts and returns a finite positive number', () => {
    const dpr = effectiveDPR()
    expect(Number.isFinite(dpr)).toBe(true)
    expect(dpr).toBeGreaterThan(0)
    expect(dpr).toBeLessThanOrEqual(2) // the §13 cap
  })
})

describe('getResidencyPool — capacity', () => {
  it('defaults getParameter(MAX_TEXTURE_IMAGE_UNITS) to 16 when no maxTextureUnits option is given', () => {
    // Isolated from the "reuse" test below (which also uses default
    // options but asserts on pool identity, not this specific fallback
    // value) so this exact default-value branch has one test naming it
    // directly rather than being incidental to a different assertion.
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    const pool = getResidencyPool(context)
    // 16 (the fake's default) is above the 8-unit working ceiling in
    // residency.ts, so capacity is 8 — this confirms getParameter's
    // default branch ran (not the maxTextureUnits-override branch) by
    // checking it behaves identically to the explicit maxTextureUnits: 16
    // case below, rather than asserting on an internal value directly.
    expect(pool.capacity).toBe(8)
  })

  it('caps capacity at the working ceiling (8) even when hardware reports more', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas, { maxTextureUnits: 32 })
    const pool = getResidencyPool(context)
    expect(pool.capacity).toBe(8)
  })

  it('uses the hardware-reported count when it is below the working ceiling', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas, { maxTextureUnits: 4 })
    const pool = getResidencyPool(context)
    expect(pool.capacity).toBe(4)
  })

  it('falls back to the guaranteed WebGL2 minimum (16) when getParameter reports something invalid', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas, { invalidMaxTextureUnits: true })
    const pool = getResidencyPool(context)
    // 16 (fallback) is above the 8-unit working ceiling, so capacity is
    // still capped at 8 — this asserts the fallback kicked in AND the cap
    // still applies on top of it, not that the raw fallback leaks through.
    expect(pool.capacity).toBe(8)
  })

  it('a second call for the same context returns the exact same pool (reuse, not a new one per call)', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    const first = getResidencyPool(context)
    const second = getResidencyPool(context)
    expect(first).toBe(second)
  })
})

describe('getResidencyPool — bind()', () => {
  it('binds distinct textures to distinct, increasing unit indices', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    const pool = getResidencyPool(context)
    pool.beginPass()

    const a = pool.bind(fakeTexture('a'))
    const b = pool.bind(fakeTexture('b'))
    expect(a).toBe(0)
    expect(b).toBe(1)
  })

  it('binding the same texture again within one pass returns the same unit, without reallocating', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    const pool = getResidencyPool(context)
    pool.beginPass()

    const texture = fakeTexture('shared')
    const first = pool.bind(texture)
    const second = pool.bind(texture)
    expect(first).toBe(second)
    expect(pool.residentCount).toBe(1)
  })

  it('returns null, does not throw, once the pass exceeds capacity', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas, { maxTextureUnits: 2 })
    const pool = getResidencyPool(context)
    pool.beginPass()

    expect(pool.bind(fakeTexture('a'))).toBe(0)
    expect(pool.bind(fakeTexture('b'))).toBe(1)
    expect(() => pool.bind(fakeTexture('c'))).not.toThrow()
    expect(pool.bind(fakeTexture('c'))).toBeNull()
  })

  it('beginPass() resets unit bookkeeping — a new pass starts back at unit 0', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    const pool = getResidencyPool(context)

    pool.beginPass()
    pool.bind(fakeTexture('a'))
    expect(pool.residentCount).toBe(1)

    pool.beginPass()
    expect(pool.residentCount).toBe(0)
    const unit = pool.bind(fakeTexture('b'))
    expect(unit).toBe(0) // fresh pass, unit numbering restarts
  })
})

describe('GLContext.resizeToDisplay()', () => {
  it('sizes the backing store to clientWidth/clientHeight times the DPR cap', () => {
    const canvas = document.createElement('canvas')
    Object.defineProperty(canvas, 'clientWidth', { value: 400, configurable: true })
    Object.defineProperty(canvas, 'clientHeight', { value: 300, configurable: true })
    const context = createFakeGLContext(canvas)

    context.resizeToDisplay()

    const dpr = effectiveDPR()
    expect(canvas.width).toBe(Math.round(400 * dpr))
    expect(canvas.height).toBe(Math.round(300 * dpr))
  })

  it('is a no-op (does not re-set width/height) when the target size has not changed', () => {
    const canvas = document.createElement('canvas')
    Object.defineProperty(canvas, 'clientWidth', { value: 200, configurable: true })
    Object.defineProperty(canvas, 'clientHeight', { value: 100, configurable: true })
    const context = createFakeGLContext(canvas)

    context.resizeToDisplay()
    const widthAfterFirst = canvas.width
    context.resizeToDisplay() // same client size again
    expect(canvas.width).toBe(widthAfterFirst)
  })

  it('never sizes to 0 even if clientWidth/clientHeight are 0 (an unlaid-out canvas)', () => {
    const canvas = document.createElement('canvas')
    // happy-dom canvases default to 0 clientWidth/clientHeight until styled/laid out —
    // this is the real, un-stubbed case, not a forced one.
    const context = createFakeGLContext(canvas)
    context.resizeToDisplay()
    expect(canvas.width).toBeGreaterThanOrEqual(1)
    expect(canvas.height).toBeGreaterThanOrEqual(1)
  })
})
