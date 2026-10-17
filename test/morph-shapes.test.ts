import { afterEach, describe, expect, it } from 'bun:test'
import { comice, qualityLevel, resetQuality } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { morph } from '../packages/morph/src/index.js'
import { resolveShape } from '../packages/morph/src/shape-input.js'
import { maskComponents } from '../packages/core/src/gl/components.js'
import { createFakeGL2, installFake2DContext } from './fake-webgl2.js'
import { installFakeIntersectionObserver } from './fake-intersection.js'

afterEach(() => { document.body.innerHTML = ''; resetQuality() })
describe('caller-supplied morph shapes', () => {
  it('accepts arbitrary complete SVGs without selecting a layout or operation', () => {
    expect(() => morph({ to: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0L100 20L20 100Z"/></svg>' })).not.toThrow()
    expect(() => morph({ from: '/panels.svg', to: '/brand.svg', join: true, glass: {}, outline: {} })).not.toThrow()
    expect(() => morph({ from: '/panels.svg' })).not.toThrow() // `to` is the media's own frame
    expect(() => morph({ from: '' })).toThrow(/empty/)
    expect(() => morph({ to: '' })).toThrow(/empty/)
    expect(() => morph({ to: {} as never })).toThrow(/SVG/)
  })
  it('validates optional Viscose interaction and thread controls', () => {
    expect(() => morph({ to: 'circle(40%)', interaction: true, join: { style: 'slab', thin: .4, dissolve: 3 }, glass: { rim: .06 } })).not.toThrow()
    for (const interaction of [1, null, [], { radius: 0 }, { decay: 1 }, { wake: -1 }, { radius: NaN }, { bogus: 2 }]) expect(() => morph({ to: 'circle(40%)', interaction: interaction as never })).toThrow(/Interaction|Interaction|interaction/)
    for (const join of [{ thin: 0 }, { thin: -1 }, { dissolve: Infinity }]) expect(() => morph({ to: 'circle(40%)', join })).toThrow(/thin|finite/)
  })
  it('validates joins and independently configurable surface settings', () => {
    expect(() => morph({ to: '/a.svg', join: true })).not.toThrow()
    expect(() => morph({ from: '/a.svg', to: '/b.svg', join: { points: [[0, 0], [2, 1]] } })).toThrow(/normalized/)
    expect(() => morph({ from: '/a.svg', to: '/b.svg', join: { pinch: 2 } })).toThrow(/pinch/)
    expect(() => morph({ from: '/a.svg', to: '/b.svg', join: { width: NaN } })).toThrow(/finite/)
    expect(() => morph({ from: '/a.svg', to: '/b.svg', join: { style: 'other' as never } })).toThrow(/style/)
    expect(() => morph({ from: '/a.svg', to: '/b.svg', join: { style: 'slab' } })).not.toThrow()
    expect(() => morph({ to: '/a.svg', glass: { refraction: -1 } })).toThrow(/nonnegative/)
    expect(() => morph({ to: '/a.svg', outline: { color: 'banana' } })).toThrow(/color/)
    expect(() => morph({ to: '/a.svg', outline: { style: 'other' as never } })).toThrow(/style/)
    expect(() => morph({ to: '/a.svg', outline: { style: 'sheen' } })).not.toThrow()
    expect(() => morph({ to: '/a.svg', outline: { opacity: 2 } })).toThrow(/opacity/)
    expect(() => morph({ to: '/a.svg', outline: false, glass: false })).not.toThrow()
  })
  it('rejects malformed option groups before mounting or replacing a working effect', () => {
    for (const key of ['join', 'cursorFollow', 'bend', 'glass', 'outline']) {
      for (const value of [null, [], 1, 'yes']) expect(() => morph({ [key]: value } as never)).toThrow()
    }
    expect(() => morph({ join: { points: [[.2, .5], null] } } as never)).toThrow(/normalized/)
    expect(() => morph({ join: { widht: 2 } } as never)).toThrow(/Unsupported join/)
    expect(() => morph({ glass: { widht: 2 } } as never)).toThrow(/Unsupported surface/)
    expect(() => morph({ outline: { colour: '#ffffff' } } as never)).toThrow(/Unsupported surface/)
  })
  it('keeps mask objects intact and accepts already decoded images', async () => {
    const abort = new AbortController(), source = { type: 'text' as const, text: 'Any word' }
    const text = await resolveShape(source, abort.signal); expect(text.mask).toBe(source); text.release()
    const image = document.createElement('img'); Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 } })
    const result = await resolveShape(image, abort.signal); expect(result.mask).toEqual({ type: 'image', source: image }); result.release()
    const wrapped = await resolveShape({ type: 'image', source: image }, abort.signal)
    expect(wrapped.mask).toEqual(result.mask); wrapped.release()
  })
  it('releases SVG object URLs and cancels owned requests without changing caller images', async () => {
    const originalImage = globalThis.Image, revoke = URL.revokeObjectURL
    const images: HTMLImageElement[] = [], revoked: string[] = []
    globalThis.Image = function() { const image = document.createElement('img'); Object.defineProperty(image, 'complete', { value: false }); images.push(image); return image } as unknown as typeof Image
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke.call(URL, url) }
    try {
      const controller = new AbortController(), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 10 10')
      const pending = resolveShape(svg, controller.signal), url = images[0]!.src
      images[0]!.dispatchEvent(new Event('load'))
      const resolved = await pending; resolved.release(); resolved.release()
      expect(revoked).toEqual([url])
      const cancelled = resolveShape('<svg viewBox="0 0 10 10"/>', controller.signal)
      controller.abort(); await expect(cancelled).rejects.toThrow(/aborted/)
      expect(images[1]!.hasAttribute('src')).toBe(false); expect(revoked).toHaveLength(2)
      const failed = resolveShape('/missing.svg', new AbortController().signal)
      images[2]!.dispatchEvent(new Event('error')); await expect(failed).rejects.toThrow(/missing.svg/)
    } finally { globalThis.Image = originalImage; URL.revokeObjectURL = revoke }
  })
  it('bakes both endpoints, uploads explicit joins, and releases the paired surfaces', async () => {
    const raster = installFake2DContext(), original = HTMLCanvasElement.prototype.getContext
    const gl = createFakeGL2(), uploads: Array<{name: string; value: unknown}> = []
    gl.uniform2fv = (location, value) => { uploads.push({name: String(location), value}) }
    HTMLCanvasElement.prototype.getContext = function(type: string, ...args: unknown[]) { return type === 'webgl2' ? gl : original.call(this, type as never, ...args as never[]) } as typeof original
    const observer = installFakeIntersectionObserver()
    let handle: ReturnType<typeof comice> | undefined
    try {
      const image = document.createElement('img'); Object.defineProperties(image, { complete: {value:true}, naturalWidth:{value:40}, naturalHeight:{value:20} })
      Object.defineProperty(image, 'getBoundingClientRect', {value: () => ({width:40,height:20,x:0,y:0,top:0,left:0,right:40,bottom:20,toJSON(){}})})
      document.body.append(image)
      const effect = morph({ from:{type:'text',text:'A B'}, to:{type:'text',text:'AB'}, join:{points:[[.25,.5],[.75,.5]]}, glass:{}, outline:{}, direction:'reverse' })
      handle = comice(image).use(effect)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(image.style.visibility).toBe('hidden'); expect(raster.callLog.filledTexts).toEqual(['AB','A B'])
      handle.set(effect,{progress:.5}); expect(uploads.length).toBeGreaterThan(0)
      handle.destroy(); expect(image.style.visibility).toBe(''); expect(document.querySelector('canvas')).toBeNull()
    } finally { handle?.destroy(); observer.uninstall(); getSharedScheduler().stop(); HTMLCanvasElement.prototype.getContext = original; raster.uninstall() }
  })
  it('aborts the other endpoint when an asynchronous shape fails and keeps media visible', async () => {
    const image = document.createElement('img'), pending = document.createElement('img')
    Object.defineProperty(pending,'complete',{value:false}); document.body.append(image)
    const errors: string[] = [], effect = morph({from:pending,to:'<html/>'}), handle = comice(image).use(effect)
    handle.on('error',(_instance,event)=>{if(event.type==='error') errors.push(event.error.message)})
    try {
      await new Promise(resolve=>setTimeout(resolve,0))
      expect(errors).toEqual(['[comice] Invalid SVG document.']); expect(image.style.visibility).toBe(''); expect(document.querySelector('canvas')).toBeNull()
      pending.dispatchEvent(new Event('load')); await Promise.resolve(); expect(document.querySelector('canvas')).toBeNull()
    } finally {handle.destroy()}
  })
  it('fails on malformed SVGs and cancels pending shape loads', async () => {
    const controller = new AbortController()
    await expect(resolveShape('<html/>', controller.signal)).rejects.toThrow(/Invalid SVG/)
    const image = document.createElement('img'); Object.defineProperty(image, 'complete', { value: false })
    const pending = resolveShape(image, controller.signal); controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)
    await expect(resolveShape('/shape.svg', controller.signal)).rejects.toThrow(/aborted/)
  })
  it('leaves media visible during shape loading and aborts mounting on teardown', async () => {
    const image = document.createElement('img'); document.body.append(image)
    const pending = document.createElement('img'); Object.defineProperty(pending, 'complete', { value: false })
    const handle = comice(image).use(morph({ to: pending }))
    expect(image.style.visibility).toBe(''); expect(document.querySelector('canvas')).toBeNull()
    handle.destroy(); pending.dispatchEvent(new Event('load')); await Promise.resolve(); await Promise.resolve()
    expect(document.querySelector('canvas')).toBeNull(); expect(image.style.visibility).toBe('')
  })
  it('retains direct driver progress while asynchronous shapes initialize', async () => {
    const image = document.createElement('img'); document.body.append(image)
    const effect = morph({ to: { type: 'text', text: 'Any shape' } })
    const handle = comice(image).use(effect).driver({ name: 'initial', attach(_target, emit) { emit({ progress: .8 }); return () => {} } })
    try {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      expect(effect.params!.getParam('progress')).toBe(.8)
    } finally { handle.destroy() }
  })
  it('continues to honor user progress after adaptive quality reaches poster mode', async () => {
    const raster = installFake2DContext()
    const oldRAF = requestAnimationFrame, oldContext = HTMLCanvasElement.prototype.getContext
    let tick: FrameRequestCallback = () => {}, drawn = 0
    const gl = createFakeGL2(); gl.drawArrays = () => { drawn++ }
    globalThis.requestAnimationFrame = (cb) => { tick = cb; return 1 }
    HTMLCanvasElement.prototype.getContext = function(type: string, ...args: unknown[]) { return type === 'webgl2' ? gl : oldContext.call(this, type as never, ...args as never[]) } as typeof oldContext
    const observer = installFakeIntersectionObserver()
    let handle: ReturnType<typeof comice> | undefined
    try {
      const image = document.createElement('img'); Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 } }); document.body.append(image)
      Object.defineProperty(image, 'getBoundingClientRect', { value: () => ({ width: 40, height: 20 }) })
      const effect = morph({ to: 'inset(0)' }); handle = comice(image).use(effect)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      // Mounting opens a quiet window (budget.ts); this test drives frames in fake time, so end it.
      resetQuality()
      for (let i = 0; i <= 65; i++) tick(i * 100)
      expect(qualityLevel()).toBe(3)
      const before = drawn; handle.set(effect, { progress: .7 })
      expect(drawn).toBe(before + 1); expect(effect.params!.getParam('progress')).toBe(.7)
      observer.setVisible(false); handle.set(effect, { progress: .2 }); expect(drawn).toBe(before + 1)
    } finally { handle?.destroy(); observer.uninstall(); getSharedScheduler().stop(); globalThis.requestAnimationFrame = oldRAF; HTMLCanvasElement.prototype.getContext = oldContext; raster.uninstall() }
  })
})

describe('automatic SVG connections', () => {
  it('finds normalized centers from opaque islands, with diagonal connectivity and alpha thresholding', () => {
    const width = 10, height = 4, data = new Uint8ClampedArray(width * height * 4)
    for (const [x, y] of [[1, 1], [2, 2], [7, 1], [7, 2]]) data[(y * width + x) * 4 + 3] = 255
    data[3] = 80
    expect(maskComponents({ width, height, data } as ImageData)).toEqual([[.2, .5], [.75, .5]])
  })
  it('ignores isolated noise and bounds automatic links while preserving the source mask', () => {
    const width = 180, height = 4, data = new Uint8ClampedArray(width * height * 4)
    for (let x = 0; x < width; x += 5) for (let y = 1; y <= 2; y++) data[(y * width + x) * 4 + 3] = 255
    data[3] = 255
    expect(maskComponents({ width, height, data } as ImageData)).toHaveLength(32)
    const empty = new Uint8ClampedArray(16); empty[3] = 255
    expect(maskComponents({ width: 2, height: 2, data: empty } as ImageData)).toEqual([])
  })
})
