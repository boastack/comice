/**
 * test/distort-shader.test — packages/distort/src/shader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { compileDistortProgram, destroyDistortProgram, drawDistort } from '../packages/distort/src/shader.js'
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

describe('compileDistortProgram', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it.each(['bulge', 'lens', 'glass'] as const)('compiles successfully for effect "%s"', (effect) => {
    const context = createFakeGLContext(canvas)
    const program = compileDistortProgram(context.gl, { effect })
    expect(program).not.toBeNull()
  })

  it.each(['linear', 'smooth', 'exp'] as const)('compiles successfully for falloff "%s"', (falloff) => {
    const context = createFakeGLContext(canvas)
    const program = compileDistortProgram(context.gl, { effect: 'bulge', falloff })
    expect(program).not.toBeNull()
  })

  it('defaults falloff to "smooth" when omitted', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDistortProgram(context.gl, { effect: 'bulge' })
    expect(program).not.toBeNull()
  })

  it('caches by (effect, falloff) — same config returns the same program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileDistortProgram(context.gl, { effect: 'lens', falloff: 'linear' })
    const b = compileDistortProgram(context.gl, { effect: 'lens', falloff: 'linear' })
    expect(a).toBe(b)
  })

  it('a different effect produces a different cached program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileDistortProgram(context.gl, { effect: 'bulge' })
    const b = compileDistortProgram(context.gl, { effect: 'glass' })
    expect(a).not.toBe(b)
  })

  it('exposes all seven uniform locations', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDistortProgram(context.gl, { effect: 'bulge' })!
    expect(program.uResolution).not.toBeNull()
    expect(program.uPointer).not.toBeNull()
    expect(program.uPointerActive).not.toBeNull()
    expect(program.uRadius).not.toBeNull()
    expect(program.uStrength).not.toBeNull()
    expect(program.uRefraction).not.toBeNull()
    expect(program.uMedia).not.toBeNull()
  })

  it('returns null, never throws, when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(compileDistortProgram(context.gl, { effect: 'bulge' })).toBeNull()
  })

  it('returns null, never throws, when program linking fails', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    expect(compileDistortProgram(context.gl, { effect: 'bulge' })).toBeNull()
  })

  it('returns null, never throws, when createProgram() itself returns null', () => {
    const context = createFakeGLContext(canvas, { failCreateProgram: true })
    expect(compileDistortProgram(context.gl, { effect: 'bulge' })).toBeNull()
  })

  it('a failed compile is also cached (does not retry every call)', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    const a = compileDistortProgram(context.gl, { effect: 'bulge' })
    const b = compileDistortProgram(context.gl, { effect: 'bulge' })
    expect(a).toBeNull()
    expect(b).toBeNull()
  })

  it('the "glass" effect (the one using displacementOffset) compiles for every falloff', () => {
    const context = createFakeGLContext(canvas)
    for (const falloff of ['linear', 'smooth', 'exp'] as const) {
      expect(compileDistortProgram(context.gl, { effect: 'glass', falloff })).not.toBeNull()
    }
  })
})

describe('destroyDistortProgram', () => {
  it('does not throw', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileDistortProgram(context.gl, { effect: 'bulge' })!
    expect(() => destroyDistortProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })
})

describe('drawDistort', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  const baseState = {
    pointerX: 0.2,
    pointerY: -0.1,
    pointerActive: true,
    radius: 0.3,
    strength: 0.5,
    refraction: 0,
    resolutionWidth: 400,
    resolutionHeight: 300,
  }

  it('draws without throwing when the plane has a texture', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDistortProgram(context.gl, { effect: 'bulge' })!
    const plane = fakePlane(fakeTexture('media'))

    getResidencyPool(context).beginPass()
    expect(() => drawDistort(context, program, plane, baseState)).not.toThrow()
  })

  it('does nothing (no throw) when the plane has no texture yet', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDistortProgram(context.gl, { effect: 'bulge' })!
    const plane = fakePlane(null)

    expect(() => drawDistort(context, program, plane, baseState)).not.toThrow()
  })

  it('does nothing (no throw) when the residency pool is exhausted', () => {
    const context = createFakeGLContext(canvas, { maxTextureUnits: 0 })
    const program = compileDistortProgram(context.gl, { effect: 'bulge' })!
    const plane = fakePlane(fakeTexture('media'))

    getResidencyPool(context).beginPass()
    expect(() => drawDistort(context, program, plane, baseState)).not.toThrow()
  })

  it('draws successfully for every effect', () => {
    const context = createFakeGLContext(canvas)
    const plane = fakePlane(fakeTexture('media'))
    for (const effect of ['bulge', 'lens', 'glass'] as const) {
      const program = compileDistortProgram(context.gl, { effect })!
      getResidencyPool(context).beginPass()
      expect(() => drawDistort(context, program, plane, baseState)).not.toThrow()
    }
  })

  it('draws without throwing when pointerActive is false', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDistortProgram(context.gl, { effect: 'bulge' })!
    const plane = fakePlane(fakeTexture('media'))

    getResidencyPool(context).beginPass()
    expect(() => drawDistort(context, program, plane, { ...baseState, pointerActive: false })).not.toThrow()
  })

  it('draws without throwing for a nonzero refraction value on glass', () => {
    const context = createFakeGLContext(canvas)
    const program = compileDistortProgram(context.gl, { effect: 'glass' })!
    const plane = fakePlane(fakeTexture('media'))

    getResidencyPool(context).beginPass()
    expect(() => drawDistort(context, program, plane, { ...baseState, refraction: 0.8 })).not.toThrow()
  })
})
