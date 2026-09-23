/**
 * test/particles-shader.test — packages/particles/src/shader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom plus test/fake-webgl2.ts, including its new
 * drawArraysInstanced/vertexAttribDivisor/uniform1iv fakes
 * (added this pass — see fake-webgl2.ts's own comments).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { compileParticlesProgram, destroyParticlesProgram, drawParticles, uploadParticleBuffers, type ParticlesMode } from '../packages/particles/src/shader.js'
import { createFakeGLContext } from './fake-webgl2.js'

const MODES: ParticlesMode[] = ['cloud', 'shatter']

describe('compileParticlesProgram', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it.each(MODES)('compiles successfully for mode "%s"', (mode) => {
    const context = createFakeGLContext(canvas)
    expect(compileParticlesProgram(context.gl, { mode })).not.toBeNull()
  })

  it('mode "cloud" does not throw on attribute setup even though a_baseVertex is unused in its own vertex shader', () => {
    // Regression test for a real bug found against an actual browser's
    // WebGL2 implementation (not this fake — see this exact fix's own
    // commit, and fake-webgl2.ts's getAttribLocation()/
    // enableVertexAttribArray() comments for the full story): a GLSL `in`
    // attribute that's declared but never READ anywhere in a shader's
    // main() may be optimized away entirely by a spec-compliant
    // compiler, making getAttribLocation() return -1.
    // packages/particles/src/shader.ts's shared vertex-shader header
    // declares `a_baseVertex` for both modes, but 'cloud' mode's own
    // main() never references it (only 'shatter' does) — compiling AND
    // fully setting up 'cloud' mode's vertex attributes, all the way
    // through to a non-null program, is what proves the -1 guard around
    // enableVertexAttribArray/vertexAttribPointer actually works, not
    // just that compilation itself succeeded.
    const context = createFakeGLContext(canvas)
    const program = compileParticlesProgram(context.gl, { mode: 'cloud' })
    expect(program).not.toBeNull()
  })

  it.each(MODES)('compiles successfully with fluid motion enabled for mode "%s"', (mode) => {
    const context = createFakeGLContext(canvas)
    expect(compileParticlesProgram(context.gl, { mode, fluid: true })).not.toBeNull()
  })

  it('caches by (mode, fluid) — same config returns the same program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileParticlesProgram(context.gl, { mode: 'cloud', fluid: true })
    const b = compileParticlesProgram(context.gl, { mode: 'cloud', fluid: true })
    expect(a).toBe(b)
  })

  it('a different mode produces a different cached program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileParticlesProgram(context.gl, { mode: 'cloud' })
    const b = compileParticlesProgram(context.gl, { mode: 'shatter' })
    expect(a).not.toBe(b)
  })

  it('cloud uses a single base vertex, shatter uses four (a unit quad)', () => {
    const context = createFakeGLContext(canvas)
    const cloud = compileParticlesProgram(context.gl, { mode: 'cloud' })!
    const shatter = compileParticlesProgram(context.gl, { mode: 'shatter' })!
    expect(cloud.baseVertexCount).toBe(1)
    expect(shatter.baseVertexCount).toBe(4)
  })

  it('exposes every uniform location', () => {
    const context = createFakeGLContext(canvas)
    const program = compileParticlesProgram(context.gl, { mode: 'shatter' })!
    expect(program.uProgress).not.toBeNull()
    expect(program.uPointSize).not.toBeNull()
    expect(program.uNoiseAmount).not.toBeNull()
    expect(program.uTime).not.toBeNull()
  })

  it('returns null, never throws, when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(compileParticlesProgram(context.gl, { mode: 'cloud' })).toBeNull()
  })

  it('returns null, never throws, when program linking fails', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    expect(compileParticlesProgram(context.gl, { mode: 'cloud' })).toBeNull()
  })

  it('returns null, never throws, when createProgram() itself returns null', () => {
    const context = createFakeGLContext(canvas, { failCreateProgram: true })
    expect(compileParticlesProgram(context.gl, { mode: 'cloud' })).toBeNull()
  })

  it('a failed compile is also cached', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    const a = compileParticlesProgram(context.gl, { mode: 'cloud' })
    const b = compileParticlesProgram(context.gl, { mode: 'cloud' })
    expect(a).toBeNull()
    expect(b).toBeNull()
  })
})

describe('destroyParticlesProgram', () => {
  it('does not throw', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileParticlesProgram(context.gl, { mode: 'cloud' })!
    expect(() => destroyParticlesProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })
})

describe('uploadParticleBuffers', () => {
  it('does not throw for a non-trivial buffer set', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileParticlesProgram(context.gl, { mode: 'cloud' })!
    const origins = new Float32Array([0.1, 0.2, 0.3, 0.4])
    const targets = new Float32Array([0.5, 0.6, 0.7, 0.8])
    const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1])
    expect(() => uploadParticleBuffers(context.gl, program, origins, targets, colors)).not.toThrow()
    canvas.remove()
  })
})

describe('drawParticles', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  const baseState = { progress: 0.5, pointSize: 3, noiseAmount: 0.02, time: 1.2, resolutionWidth: 400, resolutionHeight: 300, instanceCount: 100 }

  it.each(MODES)('draws without throwing for mode "%s"', (mode) => {
    const context = createFakeGLContext(canvas)
    const program = compileParticlesProgram(context.gl, { mode })!
    expect(() => drawParticles(context, program, baseState)).not.toThrow()
  })

  it('does nothing (no throw) when instanceCount is 0', () => {
    const context = createFakeGLContext(canvas)
    const program = compileParticlesProgram(context.gl, { mode: 'cloud' })!
    expect(() => drawParticles(context, program, { ...baseState, instanceCount: 0 })).not.toThrow()
  })

  it('does nothing (no throw) when instanceCount is negative', () => {
    const context = createFakeGLContext(canvas)
    const program = compileParticlesProgram(context.gl, { mode: 'cloud' })!
    expect(() => drawParticles(context, program, { ...baseState, instanceCount: -5 })).not.toThrow()
  })

  it('draws without throwing at progress 0 and 1', () => {
    const context = createFakeGLContext(canvas)
    const program = compileParticlesProgram(context.gl, { mode: 'shatter' })!
    expect(() => drawParticles(context, program, { ...baseState, progress: 0 })).not.toThrow()
    expect(() => drawParticles(context, program, { ...baseState, progress: 1 })).not.toThrow()
  })
})
