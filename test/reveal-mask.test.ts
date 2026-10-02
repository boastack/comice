/**
 * test/reveal-mask — reveal's `mask` effect (packages/reveal/src/mask.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec §08: reveal's `mask` effect, "a shape, text, the cursor, an image, a
 * video, a subject or depth". It didn't exist; core's mask field had no
 * consumer. Rendering is verified in Chromium (shape, text, image, cursor);
 * these cover the wiring, the failure paths, and that the media never stays
 * hidden behind a mask that can't draw.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle, type ComiceEvent } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { reveal } from '../packages/reveal/src/index.js'
import { validateMaskSource } from '../packages/reveal/src/mask.js'
import { createFakeGL2, installFake2DContext, type FakeGLOptions } from './fake-webgl2.js'
import { installFakeIntersectionObserver, type FakeIntersection } from './fake-intersection.js'

function media<T extends HTMLImageElement | HTMLVideoElement>(el: T, ready = true): T {
  if (el instanceof HTMLImageElement) {
    Object.defineProperty(el, 'complete', { value: ready, configurable: true })
    Object.defineProperty(el, 'naturalWidth', { value: ready ? 300 : 0, configurable: true })
  } else {
    Object.defineProperty(el, 'readyState', { value: ready ? 2 : 0, configurable: true })
  }
  return el
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('validateMaskSource', () => {
  it("effect 'mask' with no mask throws, naming what a mask can be", () => {
    expect(() => validateMaskSource(undefined)).toThrow(/needs a `mask`/)
    expect(() => reveal({ effect: 'mask' })).toThrow(/needs a `mask`/)
  })

  it("'subject' and 'depth' need @comice/vision, which isn't built — they throw instead of revealing nothing", () => {
    expect(() => reveal({ mask: 'subject' })).toThrow(/needs @comice\/vision/)
    expect(() => reveal({ mask: 'depth' })).toThrow(/needs @comice\/vision/)
  })
})

describe("reveal({ mask }) — wiring", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalRAF = globalThis.requestAnimationFrame
  let uninstall2D: () => void
  let intersection: FakeIntersection
  let queued: FrameRequestCallback[]
  let draws: number
  let uniforms: Array<[string, number[]]>
  let handle: ComiceHandle | null

  function useFakeGL(options: FakeGLOptions | null): void {
    const twoD = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type !== 'webgl2') return twoD.call(this, type)
      if (!options) return null
      const gl = createFakeGL2(options)
      const drawArrays = gl.drawArrays.bind(gl)
      gl.drawArrays = (...args: Parameters<WebGL2RenderingContext['drawArrays']>) => {
        draws++
        drawArrays(...args)
      }
      const uniform2f = gl.uniform2f.bind(gl)
      gl.uniform2f = (loc: WebGLUniformLocation | null, x: number, y: number) => {
        uniforms.push([(loc as unknown as { __id: string } | null)?.__id ?? '', [x, y]])
        uniform2f(loc, x, y)
      }
      return gl
    }
  }

  function frame(): void {
    const pending = queued
    queued = []
    pending.forEach((cb) => cb(16))
  }

  function img(): HTMLImageElement {
    const el = media(document.createElement('img'))
    Object.defineProperty(el, 'clientWidth', { value: 300, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true })
    document.body.appendChild(el)
    return el
  }

  async function lifecycle(h: ComiceHandle): Promise<ComiceEvent[]> {
    const seen: ComiceEvent[] = []
    h.on('ready', (_s, e) => seen.push(e))
    h.on('error', (_s, e) => seen.push(e))
    await tick()
    return seen
  }

  beforeEach(() => {
    ;({ uninstall: uninstall2D } = installFake2DContext())
    intersection = installFakeIntersectionObserver()
    queued = []
    draws = 0
    uniforms = []
    handle = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued.push(cb)
      return queued.length
    }) as typeof requestAnimationFrame
    getSharedScheduler().stop()
  })

  afterEach(() => {
    handle?.destroy()
    getSharedScheduler().stop()
    globalThis.requestAnimationFrame = originalRAF
    HTMLCanvasElement.prototype.getContext = originalGetContext
    uninstall2D()
    intersection.uninstall()
    document.body.innerHTML = ''
  })

  it("a `mask` makes 'mask' the default effect (spec's default); without one, reveal stays CSS", () => {
    useFakeGL({})
    const a = img()
    handle = (comice(a) as ComiceHandle).use(reveal({ mask: { type: 'shape', path: 'M0 0L10 10Z' }, waitForDecode: false }))
    expect(a.style.visibility).toBe('hidden') // drawn by the GPU through the mask
    expect(document.querySelectorAll('canvas').length).toBe(1)

    const b = img()
    const h2 = (comice(b) as ComiceHandle).use(reveal({ waitForDecode: false }))
    expect(b.style.transform).not.toBe('') // the CSS 'scale' effect
    h2.destroy()
  })

  it("needs an <img> or <video>: the GPU draws media, not arbitrary DOM", () => {
    useFakeGL({})
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(() => (comice(div) as ComiceHandle).use(reveal({ mask: { type: 'cursor' } }))).toThrow(/needs an <img> or <video> target/)
  })

  it.each([
    ['shape', { type: 'shape', path: 'M0 0L10 10Z' }],
    ['text', { type: 'text', text: 'COMICE' }],
    ['cursor', { type: 'cursor', radius: 80, softness: 0.5 }],
  ] as const)('a %s mask draws the media through it and reports ready', async (_label, mask) => {
    useFakeGL({})
    handle = (comice(img()) as ComiceHandle).use(reveal({ mask, waitForDecode: false }))
    handle.set({ progress: 0.5 })
    frame()
    expect(draws).toBeGreaterThan(0)
    expect(await lifecycle(handle)).toEqual([{ type: 'ready', plugin: 'reveal' }]) // once, not twice
  })

  it('an image mask is reduced from its own plane; a video mask too', async () => {
    useFakeGL({})
    handle = (comice(img()) as ComiceHandle).use(reveal({ mask: media(document.createElement('img')), waitForDecode: false }))
    handle.set({ progress: 0.4 })
    frame()
    expect(draws).toBeGreaterThan(0)
    expect((await lifecycle(handle)).map((e) => e.type)).toEqual(['ready'])

    handle.destroy()
    draws = 0
    handle = (comice(img()) as ComiceHandle).use(reveal({ mask: media(document.createElement('video')), waitForDecode: false }))
    handle.set({ progress: 0.4 })
    expect(draws).toBeGreaterThan(0)
  })

  it("the cursor follows the pointer: px (y down) become aspect-corrected uv (y up)", () => {
    useFakeGL({})
    handle = (comice(img()) as ComiceHandle).use(reveal({ mask: { type: 'cursor', radius: 50 }, waitForDecode: false }))
    // The fake canvas lays out at 0x0, which the mask treats as 1x1.
    handle.setDisplay({ x: 0.25, y: 0.25 })
    handle.set({ progress: 1 })
    const centre = uniforms.filter(([name]) => name === 'u_maskCursorCenter').at(-1)![1]
    expect(centre[0]).toBeCloseTo(0.25)
    expect(centre[1]).toBeCloseTo(0.75)
  })

  it('with no WebGL2: error, and the media is left showing (no canvas)', async () => {
    useFakeGL(null)
    const a = img()
    handle = (comice(a) as ComiceHandle).use(reveal({ mask: { type: 'cursor' }, waitForDecode: false }))
    expect((await lifecycle(handle)).map((e) => e.type)).toEqual(['error'])
    expect(a.style.visibility).toBe('')
    expect(document.querySelector('canvas')).toBeNull()
  })

  it.each([
    ['compile', { failShaderCompile: true }],
    ['link', { failProgramLink: true }],
  ] as const)('a shader that will not %s: error, and the media is left showing', async (_stage, options) => {
    useFakeGL(options)
    const a = img()
    handle = (comice(a) as ComiceHandle).use(reveal({ mask: { type: 'cursor' }, waitForDecode: false }))
    expect((await lifecycle(handle)).map((e) => e.type)).toEqual(['error'])
    expect(a.style.visibility).toBe('')
  })

  it('cross-origin media: error, and the element is handed back', async () => {
    useFakeGL({ failTexImage: true })
    const a = img()
    handle = (comice(a) as ComiceHandle).use(reveal({ mask: { type: 'cursor' }, waitForDecode: false }))
    handle.set({ progress: 0.5 })
    expect((await lifecycle(handle)).map((e) => e.type)).toEqual(['error'])
    expect(a.style.visibility).toBe('')
  })

  it('media not decoded yet: nothing drawn until it is', () => {
    useFakeGL({})
    const a = media(document.createElement('img'), false)
    document.body.appendChild(a)
    handle = (comice(a) as ComiceHandle).use(reveal({ mask: { type: 'cursor' }, waitForDecode: false }))
    handle.set({ progress: 0.5 })
    expect(draws).toBe(0)
  })

  it('with only one texture unit, a texture mask falls back to the media unit rather than failing', () => {
    useFakeGL({ maxTextureUnits: 1 })
    handle = (comice(img()) as ComiceHandle).use(reveal({ mask: { type: 'shape', path: 'M0 0L10 10Z' }, waitForDecode: false }))
    handle.set({ progress: 0.5 })
    expect(draws).toBeGreaterThan(0)
  })

  it('a shape mask re-rasterizes when the media is resized', () => {
    useFakeGL({})
    const OriginalRO = globalThis.ResizeObserver
    let callback: ResizeObserverCallback | null = null
    ;(globalThis as any).ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        callback = cb
      }
      observe() {}
      disconnect() {}
    }
    try {
      handle = (comice(img()) as ComiceHandle).use(reveal({ mask: { type: 'shape', path: 'M0 0L10 10Z' }, waitForDecode: false }))
      expect(() => callback!([], {} as ResizeObserver)).not.toThrow()
    } finally {
      globalThis.ResizeObserver = OriginalRO
    }
  })

  it('teardown hands the media back and removes the canvas', () => {
    useFakeGL({})
    const a = img()
    handle = (comice(a) as ComiceHandle).use(reveal({ mask: { type: 'text', text: 'X' }, waitForDecode: false }))
    handle.destroy()
    handle = null
    expect(a.style.visibility).toBe('')
    expect(document.querySelector('canvas')).toBeNull()
  })
})
