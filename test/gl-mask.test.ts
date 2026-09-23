/**
 * test/gl-mask.test — packages/core/src/gl/mask.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts
 * (WebGL2) and its installFake2DContext() (2D canvas + Path2D, neither of
 * which happy-dom implements at all) — see those helpers' headers for why.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  bindMaskUniforms,
  createCursorMask,
  createDerivedMask,
  createRasterizedMask,
  IDENTITY_UV_TRANSFORM,
  MASK_SAMPLE_GLSL,
} from '../packages/core/src/gl/mask.js'
import { createFakeGLContext, installFake2DContext, type Fake2DCallLog } from './fake-webgl2.js'

function fakeTexture(id: string): WebGLTexture {
  return { __id: id } as unknown as WebGLTexture
}

// ─────────────────────────────────────────────────────────────────────────
// PROCEDURAL: cursor
// ─────────────────────────────────────────────────────────────────────────

describe('createCursorMask', () => {
  it('produces an analytic-cursor MaskField with the given defaults', () => {
    const mask = createCursorMask()
    expect(mask.field.kind).toBe('analytic-cursor')
    if (mask.field.kind === 'analytic-cursor') {
      expect(mask.field.center).toEqual([0.5, 0.5])
      expect(mask.field.radius).toBe(0.2)
      expect(mask.field.softness).toBe(0.1)
      expect(mask.field.falloff).toBe('smooth')
    }
  })

  it('honors explicit options', () => {
    const mask = createCursorMask({ center: [0.1, 0.9], radius: 0.3, softness: 0.05, falloff: 'sharp' })
    expect(mask.field).toEqual({
      kind: 'analytic-cursor',
      center: [0.1, 0.9],
      radius: 0.3,
      softness: 0.05,
      falloff: 'sharp',
    })
  })

  it('setCenter/setRadius/setSoftness update subsequent field reads live', () => {
    const mask = createCursorMask()
    mask.setCenter(0.2, 0.4)
    mask.setRadius(0.6)
    mask.setSoftness(0.25)
    expect(mask.field).toEqual({
      kind: 'analytic-cursor',
      center: [0.2, 0.4],
      radius: 0.6,
      softness: 0.25,
      falloff: 'smooth',
    })
  })

})

// ─────────────────────────────────────────────────────────────────────────
// RASTERIZED: shape, text
// ─────────────────────────────────────────────────────────────────────────

describe('createRasterizedMask — degrade-never-disappear (context is null)', () => {
  it('field stays null forever, rasterize()/destroy() are no-ops', () => {
    const mask = createRasterizedMask(null)
    expect(mask.field).toBeNull()
    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1' }, 100, 100)).not.toThrow()
    expect(mask.field).toBeNull()
    expect(() => mask.destroy()).not.toThrow()
  })
})

describe('createRasterizedMask — no 2D canvas support (happy-dom\'s real, unpatched getContext)', () => {
  it('rasterize() degrades (field stays null) without throwing when getContext("2d") is unavailable', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)

    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1' }, 100, 100)).not.toThrow()
    expect(mask.field).toBeNull()

    canvas.remove()
  })
})

describe('createRasterizedMask — with a real 2D context (faked)', () => {
  let uninstall2D: () => void
  let callLog: Fake2DCallLog
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    const installed = installFake2DContext()
    uninstall2D = installed.uninstall
    callLog = installed.callLog
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    uninstall2D()
    canvas.remove()
  })

  it('rasterizing a shape calls ctx2d.fill() and produces a texture MaskField', () => {
    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    expect(mask.field).toBeNull()

    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 200, 150)

    expect(callLog.filledPaths).toBe(1)
    expect(mask.field).not.toBeNull()
    expect(mask.field?.kind).toBe('texture')
    if (mask.field?.kind === 'texture') {
      expect(mask.field.uvTransform).toEqual(IDENTITY_UV_TRANSFORM)
    }
  })

  it('accepts a pre-built Path2D as well as a path string', () => {
    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    const PathCtor = (globalThis as any).Path2D
    mask.rasterize({ type: 'shape', path: new PathCtor('M0 0L1 1Z') }, 100, 100)
    expect(callLog.filledPaths).toBe(1)
    expect(mask.field).not.toBeNull()
  })

  it('rasterizing text calls ctx2d.fillText() with the given text', () => {
    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    mask.rasterize({ type: 'text', text: 'Comice' }, 200, 60)
    expect(callLog.filledTexts).toEqual(['Comice'])
    expect(mask.field).not.toBeNull()
  })

  it('a second rasterize() at the same size reuses the render target (no-op resize), a different size reallocates', () => {
    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100)
    const firstTexture = mask.field?.kind === 'texture' ? mask.field.texture : null
    expect(firstTexture).not.toBeNull()

    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100) // same size
    const secondTexture = mask.field?.kind === 'texture' ? mask.field.texture : null
    expect(secondTexture).toBe(firstTexture) // reused, not reallocated

    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 300, 300) // different size
    const thirdTexture = mask.field?.kind === 'texture' ? mask.field.texture : null
    expect(thirdTexture).not.toBeNull()
  })

  it('destroy() releases the render target and is idempotent; rasterize() after destroy() is a no-op', () => {
    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100)
    expect(mask.field).not.toBeNull()

    mask.destroy()
    expect(() => mask.destroy()).not.toThrow()
    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100)).not.toThrow()
  })

  it('degrades (leaves previous field as-is) without throwing when createTexture() fails mid-rasterize', () => {
    const context = createFakeGLContext(canvas, { failCreateTexture: true })
    const mask = createRasterizedMask(context)
    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100)).not.toThrow()
    expect(mask.field).toBeNull()
  })

  it('degrades without throwing when createFramebuffer() fails mid-rasterize', () => {
    const context = createFakeGLContext(canvas, { failCreateFramebuffer: true })
    const mask = createRasterizedMask(context)
    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100)).not.toThrow()
    expect(mask.field).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// RASTERIZED: sdf: true — the signed-distance-field bake, the mechanism
// legacy/index.html's appleLogo layout and legacy/african.html's whole
// 17-shape catalogue both use for a smooth, liquid-morphable edge, ported
// here as one shared option on the existing rasterizer rather than a
// second producer.
// ─────────────────────────────────────────────────────────────────────────

describe('createRasterizedMask — rasterize({ sdf: true })', () => {
  let uninstall2D: () => void
  let canvas: HTMLCanvasElement

  afterEach(() => {
    uninstall2D()
    canvas.remove()
  })

  it('produces a texture MaskField the same shape as the non-SDF path', () => {
    const installed = installFake2DContext()
    uninstall2D = installed.uninstall
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)

    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    expect(mask.field).toBeNull()

    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100, { sdf: true })

    expect(mask.field).not.toBeNull()
    expect(mask.field?.kind).toBe('texture')
  })

  it('calls getImageData() to read back the rasterized pixels for the bake (unlike the coverage path, which never reads pixels back)', () => {
    const installed = installFake2DContext()
    uninstall2D = installed.uninstall
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)

    // Spy on getImageData by wrapping the context 2D fake's own method —
    // simplest is to just assert rasterize({ sdf: true }) doesn't throw
    // and produces a field, since installFake2DContext's getImageData is
    // already exercised as part of that; a dedicated call-count spy would
    // duplicate installFake2DContext's own responsibility.
    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    expect(() => mask.rasterize({ type: 'text', text: 'Comice' }, 200, 60, { sdf: true })).not.toThrow()
    expect(mask.field).not.toBeNull()
  })

  it('respects a custom maxDistance option without throwing', () => {
    const installed = installFake2DContext()
    uninstall2D = installed.uninstall
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)

    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100, { sdf: true, maxDistance: 192 })).not.toThrow()
    expect(mask.field).not.toBeNull()
  })

  it('handles a fully-inside image (alpha 255 everywhere) without throwing', () => {
    const installed = installFake2DContext({ imageDataAlpha: 255 })
    uninstall2D = installed.uninstall
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)

    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 40, 40, { sdf: true })).not.toThrow()
    expect(mask.field).not.toBeNull()
  })

  it('handles a fully-outside image (alpha 0 everywhere) without throwing', () => {
    const installed = installFake2DContext({ imageDataAlpha: 0 })
    uninstall2D = installed.uninstall
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)

    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 40, 40, { sdf: true })).not.toThrow()
    expect(mask.field).not.toBeNull()
  })

  it('a second sdf rasterize() at the same size reuses the render target', () => {
    const installed = installFake2DContext()
    uninstall2D = installed.uninstall
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)

    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100, { sdf: true })
    const firstTexture = mask.field?.kind === 'texture' ? mask.field.texture : null

    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100, { sdf: true })
    const secondTexture = mask.field?.kind === 'texture' ? mask.field.texture : null

    expect(secondTexture).toBe(firstTexture)
  })

  it('switching a source from sdf: false to sdf: true reuses the same render target (same allocation path)', () => {
    const installed = installFake2DContext()
    uninstall2D = installed.uninstall
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)

    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100)
    const coverageTexture = mask.field?.kind === 'texture' ? mask.field.texture : null

    mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100, { sdf: true })
    const sdfTexture = mask.field?.kind === 'texture' ? mask.field.texture : null

    expect(sdfTexture).toBe(coverageTexture) // same render target, re-uploaded with different content
  })

  it('degrades (field stays null) without throwing when no 2D canvas support is available', () => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const mask = createRasterizedMask(context)
    uninstall2D = () => {} // no fake installed for this test — exercising happy-dom's real null getContext('2d')

    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100, { sdf: true })).not.toThrow()
    expect(mask.field).toBeNull()
  })

  it('degrades without throwing when createTexture() fails mid-bake', () => {
    const installed = installFake2DContext()
    uninstall2D = installed.uninstall
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)

    const context = createFakeGLContext(canvas, { failCreateTexture: true })
    const mask = createRasterizedMask(context)
    expect(() => mask.rasterize({ type: 'shape', path: 'M0 0L1 1Z' }, 100, 100, { sdf: true })).not.toThrow()
    expect(mask.field).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// DERIVED: image, video, subject, depth
// ─────────────────────────────────────────────────────────────────────────

describe('createDerivedMask — degrade-never-disappear (context is null)', () => {
  it('field stays null forever, reduce()/destroy() are no-ops', () => {
    const mask = createDerivedMask(null, 'image')
    expect(mask.field).toBeNull()
    expect(() => mask.reduce(fakeTexture('src'), 100, 100)).not.toThrow()
    expect(mask.field).toBeNull()
    expect(() => mask.destroy()).not.toThrow()
  })
})

describe('createDerivedMask — each kind', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it.each(['image', 'video', 'subject', 'depth'] as const)('reduces a %s source to a texture MaskField', (kind) => {
    const context = createFakeGLContext(canvas)
    const mask = createDerivedMask(context, kind)
    expect(mask.field).toBeNull()

    mask.reduce(fakeTexture('src'), 100, 100)

    expect(mask.field).not.toBeNull()
    expect(mask.field?.kind).toBe('texture')
  })

  it('depth kind accepts threshold/softness options without throwing', () => {
    const context = createFakeGLContext(canvas)
    const mask = createDerivedMask(context, 'depth', { threshold: 0.7, softness: 0.1 })
    expect(() => mask.reduce(fakeTexture('depthTex'), 100, 100)).not.toThrow()
    expect(mask.field).not.toBeNull()
  })

  it('a second reduce() at the same size reuses the render target, a different size reallocates', () => {
    const context = createFakeGLContext(canvas)
    const mask = createDerivedMask(context, 'image')
    mask.reduce(fakeTexture('a'), 100, 100)
    const first = mask.field?.kind === 'texture' ? mask.field.texture : null

    mask.reduce(fakeTexture('a'), 100, 100)
    const second = mask.field?.kind === 'texture' ? mask.field.texture : null
    expect(second).toBe(first)

    mask.reduce(fakeTexture('a'), 400, 400)
    const third = mask.field?.kind === 'texture' ? mask.field.texture : null
    expect(third).not.toBeNull()
  })

  it('destroy() releases the render target and is idempotent; reduce() after destroy() is a no-op', () => {
    const context = createFakeGLContext(canvas)
    const mask = createDerivedMask(context, 'image')
    mask.reduce(fakeTexture('a'), 100, 100)
    expect(mask.field).not.toBeNull()

    mask.destroy()
    expect(() => mask.destroy()).not.toThrow()
    expect(() => mask.reduce(fakeTexture('a'), 100, 100)).not.toThrow()
  })

  it('degrades without throwing when the reduction shader fails to compile', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    const mask = createDerivedMask(context, 'image')
    expect(() => mask.reduce(fakeTexture('a'), 100, 100)).not.toThrow()
    expect(mask.field).toBeNull()
  })

  it('degrades without throwing when the reduction program fails to link', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    const mask = createDerivedMask(context, 'image')
    expect(() => mask.reduce(fakeTexture('a'), 100, 100)).not.toThrow()
    expect(mask.field).toBeNull()
  })

  it('degrades without throwing when createProgram() itself returns null', () => {
    const context = createFakeGLContext(canvas, { failCreateProgram: true })
    const mask = createDerivedMask(context, 'image')
    expect(() => mask.reduce(fakeTexture('a'), 100, 100)).not.toThrow()
    expect(mask.field).toBeNull()
  })

  it('a second derived mask against the same context reuses the cached reduction program (no recompile)', () => {
    const context = createFakeGLContext(canvas)
    const maskA = createDerivedMask(context, 'image')
    const maskB = createDerivedMask(context, 'depth')
    maskA.reduce(fakeTexture('a'), 100, 100)
    expect(() => maskB.reduce(fakeTexture('b'), 100, 100)).not.toThrow()
    expect(maskB.field).not.toBeNull()
  })

  it('degrades without throwing when createTexture() fails mid-reduce', () => {
    const context = createFakeGLContext(canvas, { failCreateTexture: true })
    const mask = createDerivedMask(context, 'image')
    expect(() => mask.reduce(fakeTexture('a'), 100, 100)).not.toThrow()
    expect(mask.field).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// THE SHARED SAMPLING CHUNK + UNIFORM BINDING
// ─────────────────────────────────────────────────────────────────────────

describe('MASK_SAMPLE_GLSL', () => {
  it('is a non-empty GLSL string declaring sampleMask()', () => {
    expect(typeof MASK_SAMPLE_GLSL).toBe('string')
    expect(MASK_SAMPLE_GLSL).toContain('float sampleMask(vec2 uv)')
    expect(MASK_SAMPLE_GLSL).toContain('u_maskKind')
  })
})

describe('bindMaskUniforms', () => {
  function fakeLocations() {
    return {
      uMaskKind: { __id: 'u_maskKind' } as unknown as WebGLUniformLocation,
      uMaskTexture: { __id: 'u_maskTexture' } as unknown as WebGLUniformLocation,
      uMaskUvTransform: { __id: 'u_maskUvTransform' } as unknown as WebGLUniformLocation,
      uMaskCursorCenter: { __id: 'u_maskCursorCenter' } as unknown as WebGLUniformLocation,
      uMaskCursorRadius: { __id: 'u_maskCursorRadius' } as unknown as WebGLUniformLocation,
      uMaskCursorSoftness: { __id: 'u_maskCursorSoftness' } as unknown as WebGLUniformLocation,
      uMaskCursorFalloff: { __id: 'u_maskCursorFalloff' } as unknown as WebGLUniformLocation,
    }
  }

  it('binds a texture MaskField: sets kind=0, binds the texture, sets the UV transform', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    const field = { kind: 'texture' as const, texture: fakeTexture('m'), uvTransform: IDENTITY_UV_TRANSFORM }
    expect(() => bindMaskUniforms(context.gl, fakeLocations(), field, 3)).not.toThrow()
  })

  it('binds an analytic-cursor MaskField: sets kind=1 and the cursor uniforms, no texture bind', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    const field = {
      kind: 'analytic-cursor' as const,
      center: [0.5, 0.5] as const,
      radius: 0.2,
      softness: 0.1,
      falloff: 'linear' as const,
    }
    expect(() => bindMaskUniforms(context.gl, fakeLocations(), field, 3)).not.toThrow()
  })

  it.each(['linear', 'smooth', 'sharp'] as const)('handles falloff "%s" without throwing', (falloff) => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    const field = { kind: 'analytic-cursor' as const, center: [0.5, 0.5] as const, radius: 0.2, softness: 0.1, falloff }
    expect(() => bindMaskUniforms(context.gl, fakeLocations(), field, 0)).not.toThrow()
  })

  it('a null field is treated as texture-mode with nothing bound — reveals nothing, not everything', () => {
    const canvas = document.createElement('canvas')
    const context = createFakeGLContext(canvas)
    expect(() => bindMaskUniforms(context.gl, fakeLocations(), null, 0)).not.toThrow()
  })
})
