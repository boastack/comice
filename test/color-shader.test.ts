/**
 * test/color-shader.test — packages/color/src/shader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { compileColorProgram, destroyColorProgram, drawColor, type ColorEffect } from '../packages/color/src/shader.js'
import { getResidencyPool } from '../packages/core/src/gl/residency.js'
import { createFakeGLContext } from './fake-webgl2.js'
import type { Plane } from '../packages/core/src/gl/plane.js'

function fakeTexture(id: string): WebGLTexture {
  return { __id: id } as unknown as WebGLTexture
}

function fakePlane(texture: WebGLTexture | null): Plane {
  return {
    texture,
    upload() {},
    syncLayout() {},
    box: { x: 0, y: 0, width: 100, height: 100 },
    destroy() {},
  }
}

const ALL_EFFECTS: ColorEffect[] = ['duotone', 'lut', 'grain', 'bloom', 'aberration']

describe('compileColorProgram', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('compiles successfully with no effects (passthrough)', () => {
    const context = createFakeGLContext(canvas)
    expect(compileColorProgram(context.gl, { effects: [] })).not.toBeNull()
  })

  it.each(ALL_EFFECTS)('compiles successfully with only "%s" enabled', (effect) => {
    const context = createFakeGLContext(canvas)
    const options = effect === 'lut' ? { effects: [effect], lut: { size: 4 } } : { effects: [effect] }
    expect(compileColorProgram(context.gl, options)).not.toBeNull()
  })

  it('compiles successfully with every effect enabled at once (the composable pipeline)', () => {
    const context = createFakeGLContext(canvas)
    expect(compileColorProgram(context.gl, { effects: ALL_EFFECTS, lut: { size: 8 } })).not.toBeNull()
  })

  it('compiles for both interpolate modes', () => {
    const context = createFakeGLContext(canvas)
    expect(compileColorProgram(context.gl, { effects: ['duotone'], interpolate: 'oklch' })).not.toBeNull()
    expect(compileColorProgram(context.gl, { effects: ['duotone'], interpolate: 'rgb' })).not.toBeNull()
  })

  it('respects custom duotone/grain/bloom/aberration options without throwing', () => {
    const context = createFakeGLContext(canvas)
    expect(() =>
      compileColorProgram(context.gl, {
        effects: ALL_EFFECTS,
        lut: { size: 4 },
        duotone: { shadow: [0, 0, 0], highlight: [1, 1, 1] },
        grain: { amount: 0.3 },
        bloom: { threshold: 0.5, intensity: 1 },
        aberration: { amount: 0.01 },
      }),
    ).not.toThrow()
  })

  it('caches by config — same effects/interpolate/lut size returns the same program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileColorProgram(context.gl, { effects: ['duotone'] })
    const b = compileColorProgram(context.gl, { effects: ['duotone'] })
    expect(a).toBe(b)
  })

  it('a different effect set produces a different cached program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileColorProgram(context.gl, { effects: ['duotone'] })
    const b = compileColorProgram(context.gl, { effects: ['grain'] })
    expect(a).not.toBe(b)
  })

  it('effect order in the array does not affect the cache key', () => {
    const context = createFakeGLContext(canvas)
    const a = compileColorProgram(context.gl, { effects: ['duotone', 'grain'] })
    const b = compileColorProgram(context.gl, { effects: ['grain', 'duotone'] })
    expect(a).toBe(b)
  })

  it('exposes every uniform location', () => {
    const context = createFakeGLContext(canvas)
    const program = compileColorProgram(context.gl, { effects: ALL_EFFECTS, lut: { size: 4 } })!
    expect(program.uMedia).not.toBeNull()
    expect(program.uLut).not.toBeNull()
    expect(program.uResolution).not.toBeNull()
    expect(program.uBloomThreshold).not.toBeNull()
    expect(program.uBloomIntensity).not.toBeNull()
    expect(program.uAberrationAmount).not.toBeNull()
    expect(program.uGrainAmount).not.toBeNull()
    expect(program.uGrainSeed).not.toBeNull()
  })

  it('returns null, never throws, when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(compileColorProgram(context.gl, { effects: [] })).toBeNull()
  })

  it('returns null, never throws, when program linking fails', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    expect(compileColorProgram(context.gl, { effects: [] })).toBeNull()
  })

  it('returns null, never throws, when createProgram() itself returns null', () => {
    const context = createFakeGLContext(canvas, { failCreateProgram: true })
    expect(compileColorProgram(context.gl, { effects: [] })).toBeNull()
  })

  it('a failed compile is also cached', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    const a = compileColorProgram(context.gl, { effects: [] })
    const b = compileColorProgram(context.gl, { effects: [] })
    expect(a).toBeNull()
    expect(b).toBeNull()
  })
})

describe('destroyColorProgram', () => {
  it('does not throw', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileColorProgram(context.gl, { effects: [] })!
    expect(() => destroyColorProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })

  it('a program shared by two instances survives the FIRST destroy — real bug found running many color() instances on one page', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileColorProgram(context.gl, { effects: ['duotone', 'grain'] })!
    const instanceB = compileColorProgram(context.gl, { effects: ['duotone', 'grain'] })!
    expect(instanceA).toBe(instanceB) // same cached object, the whole point of the cache

    destroyColorProgram(context.gl, instanceA) // instance A tears down first

    // instanceB's own reference must still be usable — recompiling the
    // SAME config while B is still alive must return B's own object
    // unchanged (not a new one), proving the cache entry was never
    // evicted out from under the still-live reference.
    const stillCached = compileColorProgram(context.gl, { effects: ['duotone', 'grain'] })
    expect(stillCached).toBe(instanceB)

    canvas.remove()
  })

  it('the underlying cache entry IS evicted once every reference has been released — a later compile genuinely recompiles', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileColorProgram(context.gl, { effects: ['bloom'] })!
    const instanceB = compileColorProgram(context.gl, { effects: ['bloom'] })!

    destroyColorProgram(context.gl, instanceA)
    destroyColorProgram(context.gl, instanceB) // last reference released

    const recompiled = compileColorProgram(context.gl, { effects: ['bloom'] })!
    // A genuinely NEW object — proves the stale entry was actually
    // evicted from the cache, not left dangling for a future compile to
    // incorrectly reuse.
    expect(recompiled).not.toBe(instanceA)
    expect(recompiled).not.toBe(instanceB)

    canvas.remove()
  })

  it('destroying more times than compiled for a config does not throw (defensive floor at 0)', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileColorProgram(context.gl, { effects: [] })!
    destroyColorProgram(context.gl, program)
    expect(() => destroyColorProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })

  it('does not throw for a program that was never compiled through this cache at all', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const foreignProgram = {
      program: {} as WebGLProgram,
      vao: {} as WebGLVertexArrayObject,
      uMedia: null,
      uLut: null,
      uResolution: null,
      uBloomThreshold: null,
      uBloomIntensity: null,
      uAberrationAmount: null,
      uGrainAmount: null,
      uGrainSeed: null,
    }
    expect(() => destroyColorProgram(context.gl, foreignProgram)).not.toThrow()
    canvas.remove()
  })
})

describe('drawColor', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  const baseState = {
    resolutionWidth: 400,
    resolutionHeight: 300,
    bloomThreshold: 0.7,
    bloomIntensity: 0.6,
    aberrationAmount: 0.004,
    grainAmount: 0.08,
    grainSeed: 0,
  }

  it('draws without throwing when the plane has a texture', () => {
    const context = createFakeGLContext(canvas)
    const program = compileColorProgram(context.gl, { effects: ALL_EFFECTS, lut: { size: 4 } })!
    const plane = fakePlane(fakeTexture('media'))
    const lutTexture = fakeTexture('lut')

    getResidencyPool(context).beginPass()
    expect(() => drawColor(context, program, plane, lutTexture, baseState)).not.toThrow()
  })

  it('draws without throwing when lutTexture is null (lut effect off, or not yet uploaded)', () => {
    const context = createFakeGLContext(canvas)
    const program = compileColorProgram(context.gl, { effects: [] })!
    const plane = fakePlane(fakeTexture('media'))

    getResidencyPool(context).beginPass()
    expect(() => drawColor(context, program, plane, null, baseState)).not.toThrow()
  })

  it('does nothing (no throw) when the plane has no texture yet', () => {
    const context = createFakeGLContext(canvas)
    const program = compileColorProgram(context.gl, { effects: [] })!
    const plane = fakePlane(null)

    expect(() => drawColor(context, program, plane, null, baseState)).not.toThrow()
  })

  it('does nothing (no throw) when the residency pool is exhausted for the media texture', () => {
    const context = createFakeGLContext(canvas, { maxTextureUnits: 0 })
    const program = compileColorProgram(context.gl, { effects: [] })!
    const plane = fakePlane(fakeTexture('media'))

    getResidencyPool(context).beginPass()
    expect(() => drawColor(context, program, plane, null, baseState)).not.toThrow()
  })

  it('falls back to unit 0 (does not throw) when the pool cannot fit the LUT texture', () => {
    const context = createFakeGLContext(canvas, { maxTextureUnits: 1 })
    const program = compileColorProgram(context.gl, { effects: ['lut'], lut: { size: 4 } })!
    const plane = fakePlane(fakeTexture('media'))
    const lutTexture = fakeTexture('lut')

    getResidencyPool(context).beginPass()
    expect(() => drawColor(context, program, plane, lutTexture, baseState)).not.toThrow()
  })
})
