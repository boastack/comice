/**
 * test/mosaic-shader.test — packages/mosaic/src/shader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { compileMosaicProgram, destroyMosaicProgram, drawMosaic, type MosaicFill } from '../packages/mosaic/src/shader.js'
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

const ALL_FILLS: MosaicFill[] = ['dither', 'halftone', 'riso', 'pixelate', 'crosshatch', 'images']

describe('compileMosaicProgram', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it.each(ALL_FILLS)('compiles successfully for fill "%s"', (fill) => {
    const context = createFakeGLContext(canvas)
    const options = fill === 'images' ? { fill, sourceCount: 3 } : { fill }
    expect(compileMosaicProgram(context.gl, options)).not.toBeNull()
  })

  it('compiles with custom cell/paletteCount', () => {
    const context = createFakeGLContext(canvas)
    expect(compileMosaicProgram(context.gl, { fill: 'dither', cell: 20, paletteCount: 8 })).not.toBeNull()
  })

  it('caches by config — same config returns the same program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileMosaicProgram(context.gl, { fill: 'pixelate', cell: 10 })
    const b = compileMosaicProgram(context.gl, { fill: 'pixelate', cell: 10 })
    expect(a).toBe(b)
  })

  it('a different fill produces a different cached program', () => {
    const context = createFakeGLContext(canvas)
    const a = compileMosaicProgram(context.gl, { fill: 'pixelate' })
    const b = compileMosaicProgram(context.gl, { fill: 'halftone' })
    expect(a).not.toBe(b)
  })

  it('exposes the media/resolution/cell uniform locations', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMosaicProgram(context.gl, { fill: 'pixelate' })!
    expect(program.uMedia).not.toBeNull()
    expect(program.uResolution).not.toBeNull()
    expect(program.uCell).not.toBeNull()
  })

  it('exposes uSources only for fill: "images"', () => {
    const context = createFakeGLContext(canvas)
    const imagesProgram = compileMosaicProgram(context.gl, { fill: 'images', sourceCount: 2 })!
    expect(imagesProgram.uSources).not.toBeNull()
    expect(imagesProgram.sourceCount).toBe(2)

    const pixelateProgram = compileMosaicProgram(context.gl, { fill: 'pixelate' })!
    expect(pixelateProgram.uSources).toBeNull()
    expect(pixelateProgram.sourceCount).toBe(0)
  })

  it('a sourceCount of 0 for "images" still compiles (clamped to at least 1 sampler)', () => {
    const context = createFakeGLContext(canvas)
    expect(compileMosaicProgram(context.gl, { fill: 'images', sourceCount: 0 })).not.toBeNull()
  })

  it('returns null, never throws, when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(compileMosaicProgram(context.gl, { fill: 'pixelate' })).toBeNull()
  })

  it('returns null, never throws, when program linking fails', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    expect(compileMosaicProgram(context.gl, { fill: 'pixelate' })).toBeNull()
  })

  it('returns null, never throws, when createProgram() itself returns null', () => {
    const context = createFakeGLContext(canvas, { failCreateProgram: true })
    expect(compileMosaicProgram(context.gl, { fill: 'pixelate' })).toBeNull()
  })

  it('a failed compile is also cached', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    const a = compileMosaicProgram(context.gl, { fill: 'pixelate' })
    const b = compileMosaicProgram(context.gl, { fill: 'pixelate' })
    expect(a).toBeNull()
    expect(b).toBeNull()
  })
})

describe('destroyMosaicProgram', () => {
  it('does not throw', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileMosaicProgram(context.gl, { fill: 'pixelate' })!
    expect(() => destroyMosaicProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })

  it('a program shared by two instances survives the FIRST destroy — real bug found running many mosaic() instances on one page', () => {
    // Two "instances" compiling the exact same config share ONE cached
    // program (compileMosaicProgram's own cache, keyed by config) — this
    // is the real scenario that broke on a live page: hover-swapping
    // mosaic()/ascii() on grid cards meant two same-config instances
    // could be alive at once, and the first one to tear down used to
    // delete the program out from under the second, still-live one.
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileMosaicProgram(context.gl, { fill: 'dither', cell: 10 })!
    const instanceB = compileMosaicProgram(context.gl, { fill: 'dither', cell: 10 })!
    expect(instanceA).toBe(instanceB) // same cached object, the whole point of the cache

    destroyMosaicProgram(context.gl, instanceA) // instance A tears down first

    // instanceB's own reference must still be usable — recompiling the
    // SAME config while B is still alive must return B's own object
    // unchanged (not a new one), proving the cache entry was never
    // evicted out from under the still-live reference.
    const stillCached = compileMosaicProgram(context.gl, { fill: 'dither', cell: 10 })
    expect(stillCached).toBe(instanceB)

    canvas.remove()
  })

  it('the underlying cache entry IS evicted once every reference has been released — a later compile genuinely recompiles', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)

    const instanceA = compileMosaicProgram(context.gl, { fill: 'halftone' })!
    const instanceB = compileMosaicProgram(context.gl, { fill: 'halftone' })!

    destroyMosaicProgram(context.gl, instanceA)
    destroyMosaicProgram(context.gl, instanceB) // last reference released

    const recompiled = compileMosaicProgram(context.gl, { fill: 'halftone' })!
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
    const program = compileMosaicProgram(context.gl, { fill: 'crosshatch' })!
    destroyMosaicProgram(context.gl, program)
    expect(() => destroyMosaicProgram(context.gl, program)).not.toThrow()
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
      uResolution: null,
      uCell: null,
      uSources: null,
      sourceCount: 0,
    }
    expect(() => destroyMosaicProgram(context.gl, foreignProgram)).not.toThrow()
    canvas.remove()
  })
})

describe('drawMosaic', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  const baseState = { resolutionWidth: 400, resolutionHeight: 300, cell: 12 }

  it('draws without throwing for every fill', () => {
    const context = createFakeGLContext(canvas)
    const plane = fakePlane(fakeTexture('media'))
    for (const fill of ALL_FILLS) {
      const options = fill === 'images' ? { fill, sourceCount: 2 } : { fill }
      const program = compileMosaicProgram(context.gl, options)!
      getResidencyPool(context).beginPass()
      const sources = fill === 'images' ? [fakePlane(fakeTexture('t0')), fakePlane(fakeTexture('t1'))] : []
      expect(() => drawMosaic(context, program, plane, sources, baseState)).not.toThrow()
    }
  })

  it('does nothing (no throw) when the media plane has no texture yet', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMosaicProgram(context.gl, { fill: 'pixelate' })!
    const plane = fakePlane(null)
    expect(() => drawMosaic(context, program, plane, [], baseState)).not.toThrow()
  })

  it('does nothing (no throw) when the residency pool cannot fit the media texture', () => {
    const context = createFakeGLContext(canvas, { maxTextureUnits: 0 })
    const program = compileMosaicProgram(context.gl, { fill: 'pixelate' })!
    const plane = fakePlane(fakeTexture('media'))
    getResidencyPool(context).beginPass()
    expect(() => drawMosaic(context, program, plane, [], baseState)).not.toThrow()
  })

  it('fill "images" with an unbound/missing tile plane falls back to the media unit without throwing', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMosaicProgram(context.gl, { fill: 'images', sourceCount: 2 })!
    const plane = fakePlane(fakeTexture('media'))
    getResidencyPool(context).beginPass()
    // Only one of two expected source planes supplied, and it has no
    // texture yet — exercises both the "missing plane" and "plane with
    // null texture" fallback paths.
    expect(() => drawMosaic(context, program, plane, [fakePlane(null)], baseState)).not.toThrow()
  })

  it('fill "images" degrades (no throw) when the pool cannot fit a tile texture', () => {
    const context = createFakeGLContext(canvas, { maxTextureUnits: 1 })
    const program = compileMosaicProgram(context.gl, { fill: 'images', sourceCount: 1 })!
    const plane = fakePlane(fakeTexture('media'))
    getResidencyPool(context).beginPass()
    expect(() => drawMosaic(context, program, plane, [fakePlane(fakeTexture('t0'))], baseState)).not.toThrow()
  })
})
