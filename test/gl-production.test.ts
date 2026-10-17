import { afterEach, describe, expect, it } from 'bun:test'
import { mountCanvas } from '../packages/core/src/gl/context.js'
import { createPlane } from '../packages/core/src/gl/plane.js'
import { bakeMask, createRasterizedMask } from '../packages/core/src/gl/mask.js'
import { createFakeGLContext, installFake2DContext } from './fake-webgl2.js'

afterEach(() => { document.body.innerHTML = '' })
describe('GPU primitive production regressions', () => {
  it('restores a positioned parent only after its last surface releases', () => {
    const parent = document.createElement('div'); parent.style.position = 'static'; document.body.append(parent)
    const a = document.createElement('img'), b = document.createElement('img'); parent.append(a, b)
    const mountA = mountCanvas(createFakeGLContext(document.createElement('canvas')), a, { owner: 'a', hideTarget: true })
    const mountB = mountCanvas(createFakeGLContext(document.createElement('canvas')), b, { owner: 'b', hideTarget: true })
    expect(parent.style.position).toBe('relative')
    mountA.release(); expect(parent.style.position).toBe('relative')
    mountB.release(); expect(parent.style.position).toBe('static')
    mountB.release(); expect(parent.style.position).toBe('static')
  })
  it('preserves a parent position edited by the application while mounted', () => {
    const parent = document.createElement('div'); parent.style.position = 'static'; document.body.append(parent)
    const img = document.createElement('img'); parent.append(img)
    const mount = mountCanvas(createFakeGLContext(document.createElement('canvas')), img, { owner: 'a', hideTarget: true })
    parent.style.position = 'absolute'; mount.release(); expect(parent.style.position).toBe('absolute')
  })
  it('keeps a fixed and transformed source aligned with its GPU surface', () => {
    const img = document.createElement('img'); img.style.position = 'fixed'; img.style.transform = 'scale(1.5)'; img.style.transformOrigin = '25% 75%'; document.body.append(img)
    const context = createFakeGLContext(document.createElement('canvas'))
    const mount = mountCanvas(context, img, { owner: 'fixed', hideTarget: true })
    expect(context.canvas.style.position).toBe('fixed')
    expect(context.canvas.style.transform).toBe('scale(1.5)')
    expect(context.canvas.style.transformOrigin).toBe('25% 75%')
    mount.release()
  })
  it('rasterizes a decoded image mask at its explicit bake resolution', () => {
    const fake2D = installFake2DContext()
    try {
      const context = createFakeGLContext(document.createElement('canvas'))
      const uploads: unknown[][] = []; context.gl.texImage2D = ((...args: unknown[]) => { uploads.push(args) }) as typeof context.gl.texImage2D
      const source = document.createElement('img'); Object.defineProperties(source, { naturalWidth: { value: 200 }, naturalHeight: { value: 100 } })
      const mask = createRasterizedMask(context)
      mask.rasterize({ type: 'image', source }, 400, 300, { sdf: true, resolution: [128, 64], fill: .82, alphaThreshold: 127 })
      expect(mask.field?.kind).toBe('texture')
      expect(uploads.at(-1)?.slice(3, 5)).toEqual([128, 64])
      mask.destroy()
    } finally { fake2D.uninstall() }
  })
  it('rejects invalid mask allocation and distance settings before baking', () => {
    const mask = createRasterizedMask(createFakeGLContext(document.createElement('canvas')))
    const input = { type: 'text' as const, text: 'ACME' }
    expect(() => mask.rasterize(input, 100, 100, { maxDistance: 0 })).toThrow(/maxDistance/)
    expect(() => mask.rasterize(input, 100, 100, { fill: 2 })).toThrow(/fill/)
    expect(() => mask.rasterize(input, 100, 100, { resolution: [Infinity, 64] })).toThrow(/resolution/)
    expect(() => mask.rasterize(input, 100, 100, { precision: 'invalid' as never })).toThrow(/precision/)
    mask.destroy()
  })
  it('uploads signed half-precision fields without a quantizing 0.5 bias', () => {
    const raster = installFake2DContext()
    try {
      const context = createFakeGLContext(document.createElement('canvas')), uploads: unknown[][] = []
      context.gl.texImage2D = ((...args: unknown[]) => { uploads.push(args) }) as typeof context.gl.texImage2D
      const mask = createRasterizedMask(context)
      mask.rasterize({ type: 'text', text: 'Any shape' }, 30, 20, { sdf: true, precision: 'half', maxDistance: 30 })
      expect(uploads.at(-1)?.[2]).toBe(context.gl.R16F)
      expect(uploads.at(-1)?.[7]).toBe(context.gl.FLOAT)
      expect(uploads.at(-1)?.[8]).toBeInstanceOf(Float32Array)
      const values = uploads.at(-1)?.[8] as Float32Array
      expect([...values].every((value) => Number.isFinite(value) && value >= -30 && value <= 30)).toBe(true)
      expect(mask.distanceEncoding).toBe('signed')
      mask.rasterize({ type: 'text', text: 'One island' }, 30, 20, { components: true })
      expect(mask.components).toEqual([[.5, .5]])
      mask.destroy()
      expect(mask.components).toEqual([])
    } finally { raster.uninstall() }
  })
  it('retains fractional vector edge coverage in float distance fields', () => {
    // A real edge: solid shape, one partly covered pixel, then empty space.
    const decode = (h: number) => { const e = (h >> 10) & 31, m = h & 1023, sign = h & 0x8000 ? -1 : 1; return sign * (e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24) }
    for (const alpha of [32, 160]) {
      const data = new Uint8ClampedArray(3 * 4)
      data[3] = 255; data[7] = alpha; data[11] = 0
      const result = bakeMask({ id: 1, width: 3, height: 1, pixels: data.buffer, sdf: true, maxDistance: 32, threshold: 96, half: true, bounded: false, components: false })
      const distance = decode(new Uint16Array(result.field!)[1]!)
      expect(distance).toBeCloseTo((96 - alpha) / 255, 2)
      expect(Math.abs(distance)).toBeLessThan(1)
    }
  })
  it('invalidates a texture on a media load error and recovers after the next load', () => {
    const img = document.createElement('img'); Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } })
    const context = createFakeGLContext(document.createElement('canvas'))
    const plane = createPlane(context, img)
    expect(plane.texture).not.toBeNull()
    img.dispatchEvent(new Event('error')); expect(plane.texture).toBeNull(); expect(plane.error?.message).toMatch(/failed to load/)
    img.dispatchEvent(new Event('load')); expect(plane.texture).not.toBeNull(); expect(plane.error).toBeNull()
    plane.destroy()
  })
  it('rasterizes SVG media at decoded dimensions and reuses its upload canvas', () => {
    const raster = installFake2DContext()
    try {
      const img = document.createElement('img'); img.src = '/icon.svg?version=2'
      Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 150 }, naturalHeight: { value: 150 } })
      const context = createFakeGLContext(document.createElement('canvas'))
      const uploads: unknown[] = []; context.gl.texImage2D = ((...args: unknown[]) => { uploads.push(args.at(-1)) }) as typeof context.gl.texImage2D
      const plane = createPlane(context, img)
      const canvas = uploads[0] as HTMLCanvasElement
      expect(canvas).toBeInstanceOf(HTMLCanvasElement)
      expect([canvas.width, canvas.height]).toEqual([150, 150])
      plane.upload(); expect(uploads.at(-1)).toBe(canvas)
      plane.destroy()
    } finally { raster.uninstall() }
  })
  it('keeps SVG media visible when its raster context is unavailable', () => {
    const img = document.createElement('img'); img.src = 'data:image/svg+xml,<svg/>'
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 150 }, naturalHeight: { value: 150 } })
    const plane = createPlane(createFakeGLContext(document.createElement('canvas')), img)
    expect(plane.texture).toBeNull(); expect(plane.error).toBeInstanceOf(Error)
    plane.destroy()
  })
  describe('the canvas speaks for hidden media (accessibility)', () => {
    const mount = (el: HTMLElement) => { document.body.append(el); const context = createFakeGLContext(document.createElement('canvas')); mountCanvas(context, el, { owner: 'a11y', hideTarget: true }); return context.canvas }
    it('an image gives its alt text', () => {
      const img = document.createElement('img'); img.alt = 'A tailor at work'
      const canvas = mount(img)
      expect(canvas.getAttribute('role')).toBe('img')
      expect(canvas.getAttribute('aria-label')).toBe('A tailor at work')
      expect(canvas.hasAttribute('aria-hidden')).toBe(false)
    })
    it('an aria-label wins over alt, and a video uses its aria-label or title', () => {
      const img = document.createElement('img'); img.alt = 'alt'; img.setAttribute('aria-label', 'Label')
      expect(mount(img).getAttribute('aria-label')).toBe('Label')
      const labelled = document.createElement('video'); labelled.setAttribute('aria-label', 'Hero Merge')
      expect(mount(labelled).getAttribute('aria-label')).toBe('Hero Merge')
      const titled = document.createElement('video'); titled.title = 'Product reel'
      expect(mount(titled).getAttribute('aria-label')).toBe('Product reel')
    })
    it('decorative media (alt="") stays out of the accessibility tree', () => {
      const img = document.createElement('img'); img.alt = ''
      const canvas = mount(img)
      expect(canvas.getAttribute('aria-hidden')).toBe('true')
      expect(canvas.hasAttribute('role')).toBe(false)
    })
    it('media with no name gets none invented', () => {
      const canvas = mount(document.createElement('img'))
      expect(canvas.hasAttribute('role')).toBe(false)
      expect(canvas.hasAttribute('aria-label')).toBe(false)
      expect(mount(document.createElement('video')).hasAttribute('aria-label')).toBe(false)
    })
  })
})
