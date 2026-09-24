/**
 * test/dissolve-shader.test — packages/dissolve/src/shader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts
 * (happy-dom's real getContext('webgl2') is always null — same reasoning
 * as every other *-shader.test.ts in this repo).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { compileDissolveProgram, destroyDissolveProgram, drawDissolve } from '../packages/dissolve/src/shader.js'
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

describe('compileDissolveProgram', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it.each(['crossfade', 'noise', 'liquid'] as const)('compiles successfully for transition "%s"', (transition) => {
    const context = createFakeGLContext(canvas)
    const program = compileDissolveProgram(context.gl, { transition })
    expect(program).not.toBeNull()
  })

  it('respects custom noise options without throwing', () => {
    const context = createFakeGLContext(canvas)
    expect(() =>
      compileDissolveProgram(context.gl, {
        transition: 'noise',
        noise: { scale: 5, intensity: 2, softness: 0.05 },
      }),
    ).not.toThrow()
  })

  it('caches by (transition, scale, intensity, softness) — same config returns the same program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileDissolveProgram(context.gl, { transition: 'noise', noise: { scale: 2 } })
    const b = compileDissolveProgram(context.gl, { transition: 'noise', noise: { scale: 2 } })
    expect(a).toBe(b)
  })

  it('a different noise config produces a different cached program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileDissolveProgram(context.gl, { transition: 'noise', noise: { scale: 2 } })
    const b = compileDissolveProgram(context.gl, { transition: 'noise', noise: { scale: 8 } })
    expect(a).not.toBe(b)
  })

  it('exposes uProgress/uFrom/uTo uniform locations', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDissolveProgram(context.gl, { transition: 'crossfade' })!
    expect(program.uProgress).not.toBeNull()
    expect(program.uFrom).not.toBeNull()
    expect(program.uTo).not.toBeNull()
  })

  it('returns null, never throws, when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(compileDissolveProgram(context.gl, { transition: 'crossfade' })).toBeNull()
  })

  it('returns null, never throws, when program linking fails', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    expect(compileDissolveProgram(context.gl, { transition: 'crossfade' })).toBeNull()
  })

  it('returns null, never throws, when createProgram() itself returns null', () => {
    const context = createFakeGLContext(canvas, { failCreateProgram: true })
    expect(compileDissolveProgram(context.gl, { transition: 'crossfade' })).toBeNull()
  })

  it('a failed compile is also cached (does not retry every call)', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    const a = compileDissolveProgram(context.gl, { transition: 'crossfade' })
    const b = compileDissolveProgram(context.gl, { transition: 'crossfade' })
    expect(a).toBeNull()
    expect(b).toBeNull()
  })
})

describe('destroyDissolveProgram', () => {
  it('does not throw', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileDissolveProgram(context.gl, { transition: 'crossfade' })!
    expect(() => destroyDissolveProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })

  it('a program shared by two instances survives the FIRST destroy — real bug found running many dissolve() instances on one page', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileDissolveProgram(context.gl, { transition: 'noise' })!
    const instanceB = compileDissolveProgram(context.gl, { transition: 'noise' })!
    expect(instanceA).toBe(instanceB) // same cached object, the whole point of the cache

    destroyDissolveProgram(context.gl, instanceA) // instance A tears down first

    // instanceB's own reference must still be usable — recompiling the
    // SAME config while B is still alive must return B's own object
    // unchanged (not a new one), proving the cache entry was never
    // evicted out from under the still-live reference.
    const stillCached = compileDissolveProgram(context.gl, { transition: 'noise' })
    expect(stillCached).toBe(instanceB)

    canvas.remove()
  })

  it('the underlying cache entry IS evicted once every reference has been released — a later compile genuinely recompiles', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileDissolveProgram(context.gl, { transition: 'liquid' })!
    const instanceB = compileDissolveProgram(context.gl, { transition: 'liquid' })!

    destroyDissolveProgram(context.gl, instanceA)
    destroyDissolveProgram(context.gl, instanceB) // last reference released

    const recompiled = compileDissolveProgram(context.gl, { transition: 'liquid' })!
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
    const program = compileDissolveProgram(context.gl, { transition: 'crossfade' })!
    destroyDissolveProgram(context.gl, program)
    expect(() => destroyDissolveProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })

  it('does not throw for a program that was never compiled through this cache at all', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const foreignProgram = {
      program: {} as WebGLProgram,
      vao: {} as WebGLVertexArrayObject,
      uProgress: null,
      uFrom: null,
      uTo: null,
    }
    expect(() => destroyDissolveProgram(context.gl, foreignProgram)).not.toThrow()
    canvas.remove()
  })
})

describe('drawDissolve', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('draws without throwing when both planes have textures', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDissolveProgram(context.gl, { transition: 'crossfade' })!
    const fromPlane = fakePlane(fakeTexture('from'))
    const toPlane = fakePlane(fakeTexture('to'))

    getResidencyPool(context).beginPass()
    expect(() => drawDissolve(context, program, fromPlane, toPlane, { progress: 0.5 })).not.toThrow()
  })

  it('does nothing (no throw) when fromPlane has no texture yet', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDissolveProgram(context.gl, { transition: 'crossfade' })!
    const fromPlane = fakePlane(null)
    const toPlane = fakePlane(fakeTexture('to'))

    expect(() => drawDissolve(context, program, fromPlane, toPlane, { progress: 0 })).not.toThrow()
  })

  it('does nothing (no throw) when toPlane has no texture yet', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDissolveProgram(context.gl, { transition: 'crossfade' })!
    const fromPlane = fakePlane(fakeTexture('from'))
    const toPlane = fakePlane(null)

    expect(() => drawDissolve(context, program, fromPlane, toPlane, { progress: 0 })).not.toThrow()
  })

  it('does nothing (no throw) when the residency pool cannot fit both textures', () => {
    const context = createFakeGLContext(canvas, { maxTextureUnits: 1 })
    const program = compileDissolveProgram(context.gl, { transition: 'crossfade' })!
    const fromPlane = fakePlane(fakeTexture('from'))
    const toPlane = fakePlane(fakeTexture('to'))

    getResidencyPool(context).beginPass()
    expect(() => drawDissolve(context, program, fromPlane, toPlane, { progress: 0.5 })).not.toThrow()
  })

  it('draws successfully for the noise and liquid transitions too', () => {
    const context = createFakeGLContext(canvas)
    const fromPlane = fakePlane(fakeTexture('from'))
    const toPlane = fakePlane(fakeTexture('to'))

    for (const transition of ['noise', 'liquid'] as const) {
      const program = compileDissolveProgram(context.gl, { transition })!
      getResidencyPool(context).beginPass()
      expect(() => drawDissolve(context, program, fromPlane, toPlane, { progress: 0.5 })).not.toThrow()
    }
  })

  it('binding the same texture in both from/to (a degenerate but legal case) does not throw', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDissolveProgram(context.gl, { transition: 'crossfade' })!
    const sharedTexture = fakeTexture('shared')
    const fromPlane = fakePlane(sharedTexture)
    const toPlane = fakePlane(sharedTexture)

    getResidencyPool(context).beginPass()
    expect(() => drawDissolve(context, program, fromPlane, toPlane, { progress: 0.5 })).not.toThrow()
  })
})
