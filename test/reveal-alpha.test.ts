/**
 * test/reveal-alpha — reveal's image mask, "sampled by luminance or alpha"
 * (spec §08). Only luminance existed: a black logo on transparency has no
 * luminance, so it revealed nothing. An image with any transparency is now
 * read by alpha; opaque images and video by luminance; `{ source, channel }`
 * chooses. Verified in Chromium (a black diamond PNG reveals a diamond).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { reveal } from '../packages/reveal/src/index.js'
import { hasTransparency, type RevealMaskSource } from '../packages/reveal/src/mask.js'
import { createFakeGL2, installFake2DContext } from './fake-webgl2.js'
import { installFakeIntersectionObserver, type FakeIntersection } from './fake-intersection.js'

function image(ready = true): HTMLImageElement {
  const el = document.createElement('img')
  Object.defineProperty(el, 'complete', { value: ready, configurable: true })
  Object.defineProperty(el, 'naturalWidth', { value: ready ? 300 : 0, configurable: true })
  Object.defineProperty(el, 'clientWidth', { value: 300, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true })
  return el
}

describe('hasTransparency', () => {
  let uninstall: () => void
  afterEach(() => uninstall())

  it('true when the sample has any alpha below opaque; false for an opaque image', () => {
    ;({ uninstall } = installFake2DContext({ imageDataAlpha: 0 }))
    expect(hasTransparency(image())).toBe(true)
    uninstall()
    ;({ uninstall } = installFake2DContext({ imageDataAlpha: 255 }))
    expect(hasTransparency(image())).toBe(false)
  })

  it('a video, an undecoded image, no 2D context or an unreadable image count as opaque', () => {
    ;({ uninstall } = installFake2DContext({ imageDataAlpha: 0 }))
    expect(hasTransparency(document.createElement('video'))).toBe(false)
    expect(hasTransparency(image(false))).toBe(false)
    const getContext = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      const ctx = getContext.call(this, type) as any
      ctx.getImageData = () => {
        throw new Error('tainted')
      }
      return ctx
    }
    expect(hasTransparency(image())).toBe(false)
    HTMLCanvasElement.prototype.getContext = getContext
    uninstall()
    ;({ uninstall } = installFake2DContext())
    uninstall()
    expect(hasTransparency(image())).toBe(false) // happy-dom: no 2D context
    ;({ uninstall } = installFake2DContext())
  })
})

describe('the channel reaches the reduction shader', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalRAF = globalThis.requestAnimationFrame
  let uninstall2D: () => void
  let intersection: FakeIntersection
  let queued: FrameRequestCallback[]
  let kinds: number[]
  let handle: ComiceHandle | null

  function setup(alpha: number): void {
    ;({ uninstall: uninstall2D } = installFake2DContext({ imageDataAlpha: alpha }))
    const twoD = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type !== 'webgl2') return twoD.call(this, type)
      const gl = createFakeGL2()
      const uniform1i = gl.uniform1i.bind(gl)
      gl.uniform1i = (loc: WebGLUniformLocation | null, v: number) => {
        if ((loc as unknown as { __id?: string } | null)?.__id === 'u_kind') kinds.push(v)
        uniform1i(loc, v)
      }
      return gl
    }
  }

  beforeEach(() => {
    intersection = installFakeIntersectionObserver()
    getSharedScheduler().stop()
    queued = []
    kinds = []
    handle = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => queued.push(cb)) as typeof requestAnimationFrame
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

  async function kindFor(mask: RevealMaskSource, alpha: number): Promise<number | undefined> {
    setup(alpha)
    const target = image()
    document.body.appendChild(target)
    handle = comice(target).use(reveal({ effect: 'mask', mask }))
    handle.set({ progress: 0.5 })
    queued.splice(0).forEach((cb) => cb(16))
    return kinds[0]
  }

  it('a transparent image: alpha (3); an opaque one: luminance (0)', async () => {
    expect(await kindFor(image(), 0)).toBe(3)
    handle!.destroy()
    kinds = []
    HTMLCanvasElement.prototype.getContext = originalGetContext
    uninstall2D()
    expect(await kindFor(image(), 255)).toBe(0)
  })

  it('{ source, channel } overrides the automatic choice', async () => {
    expect(await kindFor({ source: image(), channel: 'luminance' }, 0)).toBe(0)
    handle!.destroy()
    kinds = []
    HTMLCanvasElement.prototype.getContext = originalGetContext
    uninstall2D()
    expect(await kindFor({ source: image(), channel: 'alpha' }, 255)).toBe(3)
  })
})
