/**
 * test/ascii-shader.test — packages/ascii/src/shader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom plus test/fake-webgl2.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildFragmentShader, compileAsciiProgram, destroyAsciiProgram, drawAscii } from '../packages/ascii/src/shader.js'
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

describe('compileAsciiProgram', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('compiles successfully for the default charset length (10)', () => {
    const context = createFakeGLContext(canvas)
    expect(compileAsciiProgram(context.gl, { glyphCount: 10 })).not.toBeNull()
  })

  it('compiles successfully for a single-glyph charset', () => {
    const context = createFakeGLContext(canvas)
    expect(compileAsciiProgram(context.gl, { glyphCount: 1 })).not.toBeNull()
  })

  it('clamps a zero/negative glyphCount to at least 1', () => {
    const context = createFakeGLContext(canvas)
    expect(compileAsciiProgram(context.gl, { glyphCount: 0 })).not.toBeNull()
  })

  it('caches by glyphCount — same count returns the same program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileAsciiProgram(context.gl, { glyphCount: 5 })
    const b = compileAsciiProgram(context.gl, { glyphCount: 5 })
    expect(a).toBe(b)
  })

  it('a different glyphCount produces a different cached program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileAsciiProgram(context.gl, { glyphCount: 5 })
    const b = compileAsciiProgram(context.gl, { glyphCount: 8 })
    expect(a).not.toBe(b)
  })

  it('exposes every uniform location', () => {
    const context = createFakeGLContext(canvas)
    const program = compileAsciiProgram(context.gl, { glyphCount: 10 })!
    expect(program.uMedia).not.toBeNull()
    expect(program.uAtlas).not.toBeNull()
    expect(program.uResolution).not.toBeNull()
    expect(program.uCell).not.toBeNull()
  })

  it('returns null, never throws, when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(compileAsciiProgram(context.gl, { glyphCount: 10 })).toBeNull()
  })

  it('returns null, never throws, when program linking fails', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    expect(compileAsciiProgram(context.gl, { glyphCount: 10 })).toBeNull()
  })

  it('returns null, never throws, when createProgram() itself returns null', () => {
    const context = createFakeGLContext(canvas, { failCreateProgram: true })
    expect(compileAsciiProgram(context.gl, { glyphCount: 10 })).toBeNull()
  })

  it('a failed compile is also cached', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    const a = compileAsciiProgram(context.gl, { glyphCount: 10 })
    const b = compileAsciiProgram(context.gl, { glyphCount: 10 })
    expect(a).toBeNull()
    expect(b).toBeNull()
  })
})

describe('glyph order — real bug: highlights vanished, a white image rendered black', () => {
  // Spec: charset is "ordered dark to light. Default ' .:-=+*#%@'". Glyphs
  // draw in the media's own colour on black, so the space is the darkest
  // glyph and '@' the lightest. The shader inverted the index, putting the
  // space on bright pixels. The fake GL can't rasterize, so this pins the
  // mapping in the generated GLSL.
  it('a bright pixel picks a high (inky) glyph index: brightness maps to the index directly', () => {
    const source = buildFragmentShader({ glyphCount: 10 })
    expect(source).toContain('int glyphIndex = bucket;')
    expect(source).not.toContain('glyphCount - 1 - bucket')
  })

  it('samples glyphs right way up (atlas rows are top-first, gl_FragCoord counts from the bottom)', () => {
    expect(buildFragmentShader({ glyphCount: 10 })).toContain('1.0 - cellLocalUv.y')
  })
})

describe('destroyAsciiProgram', () => {
  it('does not throw', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileAsciiProgram(context.gl, { glyphCount: 10 })!
    expect(() => destroyAsciiProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })

  it('a program shared by two instances survives the FIRST destroy — real bug found running many ascii() instances on one page', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileAsciiProgram(context.gl, { glyphCount: 12 })!
    const instanceB = compileAsciiProgram(context.gl, { glyphCount: 12 })!
    expect(instanceA).toBe(instanceB) // same cached object, the whole point of the cache

    destroyAsciiProgram(context.gl, instanceA) // instance A tears down first

    // instanceB's own reference must still be usable — recompiling the
    // SAME glyphCount while B is still alive must return B's own object
    // unchanged (not a new one), proving the cache entry was never
    // evicted out from under the still-live reference.
    const stillCached = compileAsciiProgram(context.gl, { glyphCount: 12 })
    expect(stillCached).toBe(instanceB)

    canvas.remove()
  })

  it('the underlying cache entry IS evicted once every reference has been released — a later compile genuinely recompiles', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileAsciiProgram(context.gl, { glyphCount: 8 })!
    const instanceB = compileAsciiProgram(context.gl, { glyphCount: 8 })!

    destroyAsciiProgram(context.gl, instanceA)
    destroyAsciiProgram(context.gl, instanceB) // last reference released

    const recompiled = compileAsciiProgram(context.gl, { glyphCount: 8 })!
    // A genuinely NEW object — proves the stale entry was actually
    // evicted from the cache, not left dangling for a future compile to
    // incorrectly reuse.
    expect(recompiled).not.toBe(instanceA)
    expect(recompiled).not.toBe(instanceB)

    canvas.remove()
  })

  it('destroying more times than compiled for a glyphCount does not throw (defensive floor at 0)', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileAsciiProgram(context.gl, { glyphCount: 16 })!
    destroyAsciiProgram(context.gl, program)
    expect(() => destroyAsciiProgram(context.gl, program)).not.toThrow()
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
      uAtlas: null,
      uResolution: null,
      uCell: null,
    }
    expect(() => destroyAsciiProgram(context.gl, foreignProgram)).not.toThrow()
    canvas.remove()
  })
})

describe('drawAscii', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  const baseState = { resolutionWidth: 400, resolutionHeight: 300, cell: 10 }

  it('draws without throwing when both media and atlas textures are present', () => {
    const context = createFakeGLContext(canvas)
    const program = compileAsciiProgram(context.gl, { glyphCount: 10 })!
    const plane = fakePlane(fakeTexture('media'))
    getResidencyPool(context).beginPass()
    expect(() => drawAscii(context, program, plane, fakeTexture('atlas'), baseState)).not.toThrow()
  })

  it('does nothing (no throw) when the media plane has no texture yet', () => {
    const context = createFakeGLContext(canvas)
    const program = compileAsciiProgram(context.gl, { glyphCount: 10 })!
    const plane = fakePlane(null)
    expect(() => drawAscii(context, program, plane, fakeTexture('atlas'), baseState)).not.toThrow()
  })

  it('does nothing (no throw) when the atlas texture is null (not yet rasterized)', () => {
    const context = createFakeGLContext(canvas)
    const program = compileAsciiProgram(context.gl, { glyphCount: 10 })!
    const plane = fakePlane(fakeTexture('media'))
    expect(() => drawAscii(context, program, plane, null, baseState)).not.toThrow()
  })

  it('does nothing (no throw) when the residency pool is exhausted', () => {
    const context = createFakeGLContext(canvas, { maxTextureUnits: 1 })
    const program = compileAsciiProgram(context.gl, { glyphCount: 10 })!
    const plane = fakePlane(fakeTexture('media'))
    getResidencyPool(context).beginPass()
    expect(() => drawAscii(context, program, plane, fakeTexture('atlas'), baseState)).not.toThrow()
  })
})
