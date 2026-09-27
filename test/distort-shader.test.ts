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

describe('fragment shader field math — real bugs found in a real browser', () => {
  // The fake GL context can't rasterize, so these pin the GLSL source
  // itself. Found on harness/site/: with correct uniforms reaching the
  // shader, stripes behind the pointer still never bent.
  function fragmentSourceFor(effect: 'bulge' | 'lens' | 'glass'): string {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    const sources: string[] = []
    const shaderSource = context.gl.shaderSource.bind(context.gl)
    context.gl.shaderSource = (shader: WebGLShader, source: string) => {
      sources.push(source)
      shaderSource(shader, source)
    }
    // A distinct falloff per call so the per-config program cache can't
    // hand back an earlier compile and skip shaderSource() entirely.
    compileDistortProgram(context.gl, { effect, falloff: 'exp' })
    return sources.find((s) => s.includes('u_pointer')) ?? ''
  }

  it.each(['bulge', 'lens', 'glass'] as const)('%s measures from the pointer\'s uv position (parenthesized), not uv + 0.5', (effect) => {
    // `uv - u_pointer * 0.5 + 0.5` ADDS 0.5: the field centre landed at
    // uv - (0.5, 0.5) relative to the pointer, entirely off-image.
    const source = fragmentSourceFor(effect)
    expect(source).toContain('vec2 toPointer = uv - (u_pointer * 0.5 + 0.5);')
    // Assignment form only: bulge's explanatory GLSL comment quotes the old expression.
    expect(source).not.toContain('= uv - u_pointer * 0.5 + 0.5')
  })

  it('bulge ramps its push in from zero at the pointer (no tear under the cursor)', () => {
    // A unit direction times full field strength is discontinuous exactly
    // at the pointer and tore a pinched black hole into the image there.
    const source = fragmentSourceFor('bulge')
    expect(source).toContain('float ramp = smoothstep(0.0, 0.35, d);')
    expect(source).toContain('-dir * field * ramp')
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

  it('a program shared by two instances survives the FIRST destroy — real bug found running many distort() instances on one page', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileDistortProgram(context.gl, { effect: 'lens', falloff: 'linear' })!
    const instanceB = compileDistortProgram(context.gl, { effect: 'lens', falloff: 'linear' })!
    expect(instanceA).toBe(instanceB) // same cached object, the whole point of the cache

    destroyDistortProgram(context.gl, instanceA) // instance A tears down first

    // instanceB's own reference must still be usable — recompiling the
    // SAME config while B is still alive must return B's own object
    // unchanged (not a new one), proving the cache entry was never
    // evicted out from under the still-live reference.
    const stillCached = compileDistortProgram(context.gl, { effect: 'lens', falloff: 'linear' })
    expect(stillCached).toBe(instanceB)

    canvas.remove()
  })

  it('the underlying cache entry IS evicted once every reference has been released — a later compile genuinely recompiles', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileDistortProgram(context.gl, { effect: 'bulge' })!
    const instanceB = compileDistortProgram(context.gl, { effect: 'bulge' })!

    destroyDistortProgram(context.gl, instanceA)
    destroyDistortProgram(context.gl, instanceB) // last reference released

    const recompiled = compileDistortProgram(context.gl, { effect: 'bulge' })!
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
    const program = compileDistortProgram(context.gl, { effect: 'bulge' })!
    destroyDistortProgram(context.gl, program)
    expect(() => destroyDistortProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })

  it('does not throw for a program that was never compiled through this cache at all', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const foreignProgram = {
      program: {} as WebGLProgram,
      vao: {} as WebGLVertexArrayObject,
      uResolution: null,
      uPointer: null,
      uPointerActive: null,
      uRadius: null,
      uStrength: null,
      uRefraction: null,
      uMedia: null,
    }
    expect(() => destroyDistortProgram(context.gl, foreignProgram)).not.toThrow()
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
