/**
 * test/particles-sources — particles' sources, sampling and motion, end to
 * end through the plugin (fake GL, fake 2D, fake frames).
 *
 * The spec example — `from: { image: '/founder.jpg' }, to: { text:
 * 'COMICE' }, count: 120000, motion: { noise: 0.3 }` — didn't run: a URL
 * source wasn't accepted, an image that hadn't loaded was sampled blank and
 * never retried, and `noise` without `fluid` did nothing. Verified in
 * Chromium with screenshots; these pin the wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { particles, type ParticlesOptions } from '../packages/particles/src/index.js'
import { createFakeGL2, installFake2DContext } from './fake-webgl2.js'
import { installFakeIntersectionObserver, type FakeIntersection } from './fake-intersection.js'

const originalGetContext = HTMLCanvasElement.prototype.getContext
const OriginalImage = globalThis.Image
let uninstall2D: () => void
let intersection: FakeIntersection
let stage: HTMLDivElement
let handle: ComiceHandle | null
let queued: FrameRequestCallback[]
let now: number
let originalRAF: typeof requestAnimationFrame
let gl: {
  instanceUploads: Float32Array[][] // [origins, targets] per build
  textureUploads: number
  uniforms: Record<string, number>
  failTextures: boolean
}

beforeEach(() => {
  ;({ uninstall: uninstall2D } = installFake2DContext({ imageDataAlpha: 255 }))
  intersection = installFakeIntersectionObserver()
  gl = { instanceUploads: [], textureUploads: 0, uniforms: {}, failTextures: false }
  const twoD = HTMLCanvasElement.prototype.getContext
  ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
    if (type !== 'webgl2') return twoD.call(this, type)
    const fake = createFakeGL2()
    let pending: Float32Array[] = []
    const bufferData = fake.bufferData.bind(fake)
    fake.bufferData = (target: number, data: any, usage: number) => {
      if (usage === fake.DYNAMIC_DRAW) {
        pending.push(data)
        if (pending.length === 2) {
          gl.instanceUploads.push(pending)
          pending = []
        }
      }
      bufferData(target, data, usage)
    }
    const texImage2D = fake.texImage2D.bind(fake)
    fake.texImage2D = (...args: any[]) => {
      gl.textureUploads++
      ;(texImage2D as any)(...args)
    }
    const uniform1f = fake.uniform1f.bind(fake)
    fake.uniform1f = (loc: any, value: number) => {
      gl.uniforms[loc?.__id ?? '?'] = value
      uniform1f(loc, value)
    }
    return fake
  }
  getSharedScheduler().stop() // no frame left pending from another file's fake
  queued = []
  now = 0
  originalRAF = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => queued.push(cb)) as typeof requestAnimationFrame
  stage = document.createElement('div')
  Object.defineProperty(stage, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(stage, 'clientHeight', { value: 450, configurable: true })
  document.body.appendChild(stage)
  handle = null
})

afterEach(() => {
  handle?.destroy()
  getSharedScheduler().stop()
  globalThis.requestAnimationFrame = originalRAF
  globalThis.Image = OriginalImage
  HTMLCanvasElement.prototype.getContext = originalGetContext
  uninstall2D()
  intersection.uninstall()
  document.body.innerHTML = ''
})

function frames(n = 1): void {
  for (let i = 0; i < n; i++) {
    now += 16
    const pending = queued
    queued = []
    pending.forEach((cb) => cb(now))
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function image(width = 600, height = 750): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true })
  return img
}

async function mounted(options: ParticlesOptions): Promise<ComiceHandle> {
  handle = comice(stage).use(particles(options))
  await settle()
  frames(1)
  return handle
}

describe('sources', () => {
  it('{ image: url } loads its own image, and builds once it has', async () => {
    let created: HTMLImageElement | null = null
    ;(globalThis as any).Image = function () {
      created = document.createElement('img')
      return created
    }
    await mounted({ from: { image: '/founder.jpg' }, to: { text: 'COMICE' }, count: 120000, motion: { noise: 0.3 } })
    expect(created!.getAttribute('src')).toBe('/founder.jpg')
    expect(created!.crossOrigin).toBe('anonymous')
    expect(gl.instanceUploads).toHaveLength(0) // not loaded: nothing sampled blank

    Object.defineProperty(created!, 'naturalWidth', { value: 600 })
    Object.defineProperty(created!, 'naturalHeight', { value: 750 })
    created!.dispatchEvent(new Event('load'))
    await settle()
    frames(1)
    const [origins] = gl.instanceUploads[0]!
    expect(Math.abs(origins!.length / 2 - 120000) / 120000).toBeLessThan(0.01) // not capped at 16k
    expect(gl.textureUploads).toBe(2)
  })

  it('a source that fails to load says so, through the error event', async () => {
    const element = document.createElement('img')
    const errors: string[] = []
    handle = comice(stage)
    handle.on('error', (_s, e) => errors.push((e as unknown as { error: Error }).error.message))
    handle.use(particles({ from: { image: element } }))
    element.dispatchEvent(new Event('error'))
    await settle()
    expect(errors[0]).toMatch(/couldn't load/)
  })

  it('a URL video plays muted and looping, stays live, and stops with the plugin', async () => {
    const original = document.createElement.bind(document)
    let video: HTMLVideoElement | null = null
    document.createElement = ((tag: string) => {
      const el = original(tag)
      if (tag === 'video') video = el as HTMLVideoElement
      return el
    }) as typeof document.createElement
    try {
      handle = comice(stage).use(particles({ from: { video: '/loop.mp4' } }))
    } finally {
      document.createElement = original
    }
    expect([video!.muted, video!.loop, video!.getAttribute('src')]).toEqual([true, true, '/loop.mp4'])
    Object.defineProperty(video!, 'readyState', { value: 4 })
    Object.defineProperty(video!, 'paused', { value: false })
    Object.defineProperty(video!, 'videoWidth', { value: 640 })
    Object.defineProperty(video!, 'videoHeight', { value: 360 })
    video!.dispatchEvent(new Event('loadeddata'))
    await settle()
    frames(1)
    const afterBuild = gl.textureUploads
    frames(2)
    expect(gl.textureUploads).toBe(afterBuild + 2) // its latest frame, every frame
    handle.destroy()
    handle = null
    expect(video!.hasAttribute('src')).toBe(false)
  })

  it('an element video (not ours) is never stopped; a paused one is not re-uploaded', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { value: 4 })
    Object.defineProperty(video, 'videoWidth', { value: 640 })
    Object.defineProperty(video, 'videoHeight', { value: 360 })
    video.setAttribute('src', '/mine.mp4')
    await mounted({ from: { video }, to: video })
    frames(1)
    const uploads = gl.textureUploads
    frames(2)
    expect(gl.textureUploads).toBe(uploads) // paused
    handle!.destroy()
    handle = null
    expect(video.getAttribute('src')).toBe('/mine.mp4')
  })

  it('text waits for web fonts before it is drawn', async () => {
    let release: () => void = () => {}
    Object.defineProperty(document, 'fonts', { value: { ready: new Promise<void>((resolve) => (release = resolve)) }, configurable: true })
    try {
      await mounted({ from: { text: 'COMICE' } })
      expect(gl.instanceUploads).toHaveLength(0)
      release()
      await settle()
      frames(1)
      expect(gl.instanceUploads).toHaveLength(1)
    } finally {
      delete (document as unknown as { fonts?: unknown }).fonts
    }
  })

  it('an image given as { image: element } is used as is', async () => {
    await mounted({ from: { image: image() } })
    expect(gl.instanceUploads).toHaveLength(1)
  })
})

describe('the round trip', () => {
  it('without `to`, every instance comes back to its own origin', async () => {
    await mounted({ from: image() })
    const [origins, targets] = gl.instanceUploads[0]!
    expect(Array.from(targets!)).toEqual(Array.from(origins!))
  })

  it("into text, instances arrive shuffled (reassemble defaults to false); `reassemble: true` keeps each one's own place", async () => {
    await mounted({ from: image(), to: { text: 'COMICE' }, count: 400 })
    const [, shuffledTargets] = gl.instanceUploads[0]!
    handle!.destroy()
    gl.instanceUploads = []
    await mounted({ from: image(), to: { text: 'COMICE' }, count: 400, reassemble: true })
    const [, ordered] = gl.instanceUploads[0]!
    expect(Array.from(shuffledTargets!)).not.toEqual(Array.from(ordered!))
    const pairs = (a: Float32Array) => Array.from({ length: a.length / 2 }, (_, i) => `${a[i * 2]},${a[i * 2 + 1]}`).sort()
    expect(pairs(shuffledTargets!)).toEqual(pairs(ordered!)) // the same places, in another order
  })

  it('shatter defaults to about a hundred tiles', async () => {
    await mounted({ mode: 'shatter', from: image(), to: image() })
    const [origins] = gl.instanceUploads[0]!
    expect(origins!.length / 2).toBe(104) // 13 x 8 on a 16:9 stage
  })

  it('the stage changing shape resamples; so does a resize signal', async () => {
    const OriginalRO = globalThis.ResizeObserver
    let onResize: ResizeObserverCallback | null = null
    ;(globalThis as any).ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        onResize = cb
      }
      observe() {}
      disconnect() {}
    }
    try {
      await mounted({ from: image() })
      frames(1)
      expect(gl.instanceUploads).toHaveLength(1)
      Object.defineProperty(stage, 'clientWidth', { value: 400, configurable: true })
      frames(1)
      expect(gl.instanceUploads).toHaveLength(2)
      onResize!([], {} as ResizeObserver)
      frames(1)
      expect(gl.instanceUploads).toHaveLength(3)
    } finally {
      globalThis.ResizeObserver = OriginalRO
    }
  })
})

describe('failures draw nothing and say why, once', () => {
  it('a cross-origin source without CORS (a tainted canvas) fails once, not every frame', async () => {
    const errors: string[] = []
    handle = comice(stage)
    handle.on('error', (_s, e) => errors.push((e as unknown as { error: Error }).error.message))
    const twoD = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      const ctx = twoD.call(this, type) as any
      if (type === '2d' && ctx) ctx.getImageData = () => { throw new Error('The canvas has been tainted by cross-origin data.') }
      return ctx
    }
    handle.use(particles({ from: image() }))
    await settle()
    frames(3)
    await settle()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/needs CORS headers/)
  })

  it("media that rasterizes to nothing (no size) is tried once per stage size", async () => {
    await mounted({ from: image(0, 0), to: image() })
    frames(3)
    expect(gl.instanceUploads).toHaveLength(0)
  })

  it('a `to` that fails to rasterize draws nothing', async () => {
    await mounted({ from: image(), to: image(0, 0) })
    expect(gl.instanceUploads).toHaveLength(0)
  })
})

describe('motion', () => {
  const noiseAt = async (options: Partial<ParticlesOptions>) => {
    await mounted({ from: image(), ...options })
    frames(1)
    const value = gl.uniforms.u_noiseAmount
    handle!.destroy()
    handle = null
    return value
  }

  it("noise alone drifts (the spec's `motion: { noise: 0.3 }`); fluid alone is a gentle 0.2; neither is still", async () => {
    expect(await noiseAt({ motion: { noise: 0.3 } })).toBeCloseTo(0.03)
    expect(await noiseAt({ motion: { fluid: true } })).toBeCloseTo(0.02)
    expect(await noiseAt({})).toBe(0)
  })

  it('cloud points default to one grid cell (a solid picture at rest); `size` overrides', async () => {
    await mounted({ from: image(), count: 100 }) // 13 columns over 800px
    frames(1)
    expect(gl.uniforms.u_pointSize).toBeCloseTo((800 / 13) * 1.05)
    handle!.destroy()
    await mounted({ from: image(), size: 5 })
    frames(1)
    expect(gl.uniforms.u_pointSize).toBe(5)
  })
})
