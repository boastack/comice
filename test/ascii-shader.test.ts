/**
 * test/ascii-shader.test — packages/ascii/src/shader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom plus test/fake-webgl2.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { compileAsciiProgram, destroyAsciiProgram, drawAscii } from '../packages/ascii/src/shader.js'
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

describe('destroyAsciiProgram', () => {
  it('does not throw', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileAsciiProgram(context.gl, { glyphCount: 10 })!
    expect(() => destroyAsciiProgram(context.gl, program)).not.toThrow()
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
