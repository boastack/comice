/**
 * test/lifecycle — the `ready` and `error` events (spec §04)
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec §04 lists `.on()`'s lifecycle events as "active, leaving, ready,
 * error"; ready and error did not exist. Worse, every GPU failure (no
 * WebGL2, a shader that won't compile, cross-origin media) degraded
 * silently — the media showed, the effect didn't, and nothing said why.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle, type ComiceEvent } from 'comice'
import { createInstance } from '../packages/core/src/machine.js'
import { createGLReporter } from '../packages/core/src/gl/report.js'
import type { Plane } from '../packages/core/src/gl/plane.js'
import { distort } from '../packages/distort/src/index.js'
import { ascii } from '../packages/ascii/src/index.js'
import { color } from '../packages/color/src/index.js'
import { dissolve } from '../packages/dissolve/src/index.js'
import { morph } from '../packages/morph/src/index.js'
import { mosaic } from '../packages/mosaic/src/index.js'
import { rail } from '../packages/rail/src/index.js'
import { aura } from '../packages/aura/src/index.js'
import { getSharedScheduler } from 'comice/scheduler'
import { installFakeIntersectionObserver } from './fake-intersection.js'
import { createFakeGL2, type FakeGLOptions } from './fake-webgl2.js'

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('instance.ready() / instance.fail()', () => {
  it('emit on the next microtask, so a listener chained after .use() still hears them', async () => {
    const instance = createInstance()
    const events: ComiceEvent[] = []
    instance.ready('distort') // reported during setup, before anyone listens
    instance.on('ready', (_s, e) => events.push(e))
    await tick()
    expect(events).toEqual([{ type: 'ready', plugin: 'distort' }])
  })

  it('error carries the plugin and the Error', async () => {
    const instance = createInstance()
    const seen: ComiceEvent[] = []
    const error = new Error('no WebGL2')
    instance.fail('color', error)
    instance.on('error', (_s, e) => seen.push(e))
    await tick()
    expect(seen).toEqual([{ type: 'error', plugin: 'color', error }])
  })

  it('change no state', async () => {
    const instance = createInstance()
    instance.ready('x')
    await tick()
    expect(instance.state).toBe('idle')
    expect(instance.progress).toBe(0)
  })

  it('are dropped once the instance is destroyed', async () => {
    const instance = createInstance()
    let heard = 0
    instance.on('*', () => heard++)
    instance.ready('x')
    instance.destroy()
    await tick()
    expect(heard).toBe(0)
  })
})

describe('createGLReporter', () => {
  const plane = (texture: unknown, error: Error | null = null) => ({ texture, error }) as unknown as Plane

  function setup() {
    const instance = createInstance()
    const events: ComiceEvent[] = []
    instance.on('*', (_s, e) => events.push(e))
    return { reporter: createGLReporter(instance, 'distort'), events }
  }

  it('noContext / noProgram report a plain-language error naming the plugin — once', async () => {
    const { reporter, events } = setup()
    reporter.noContext()
    reporter.noProgram()
    await tick()
    expect(events).toHaveLength(1)
    const e = events[0] as Extract<ComiceEvent, { type: 'error' }>
    expect(e.plugin).toBe('distort')
    expect(e.error.message).toMatch(/distort\(\): WebGL2 is unavailable.*original media is shown unchanged/)
  })

  it('noProgram explains a failed shader compile', async () => {
    const { reporter, events } = setup()
    reporter.noProgram()
    await tick()
    expect((events[0] as Extract<ComiceEvent, { type: 'error' }>).error.message).toMatch(/shader failed to compile/)
  })

  it('afterDraw reports ready once, and only when every plane has a texture', async () => {
    const { reporter, events } = setup()
    reporter.afterDraw(plane({}), plane(null)) // a second source still loading
    reporter.afterDraw(plane({}), plane({}))
    reporter.afterDraw(plane({}), plane({}))
    await tick()
    expect(events).toEqual([{ type: 'ready', plugin: 'distort' }])
  })

  it('afterDraw hands the element back (onUnusable) on an upload error — once', async () => {
    const instance = createInstance()
    let released = 0
    const reporter = createGLReporter(instance, 'distort', () => released++)
    reporter.afterDraw(plane(null, new Error('cross-origin')))
    reporter.afterDraw(plane(null, new Error('cross-origin')))
    expect(released).toBe(1)
  })

  it("afterDraw reports a plane's upload error instead of ready", async () => {
    const { reporter, events } = setup()
    reporter.afterDraw(plane(null, new Error('cross-origin')))
    reporter.afterDraw(plane(null, new Error('cross-origin')))
    await tick()
    expect(events).toHaveLength(1)
    expect((events[0] as Extract<ComiceEvent, { type: 'error' }>).error.message).toBe('[comice] distort(): cross-origin')
  })
})

describe('real plugins report through .on()', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let handle: ComiceHandle | null = null

  afterEach(() => {
    handle?.destroy()
    handle = null
    HTMLCanvasElement.prototype.getContext = originalGetContext
    document.body.innerHTML = ''
  })

  function useFakeGL(options: FakeGLOptions | null): void {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return options ? createFakeGL2(options) : null
      return originalGetContext.call(this, type)
    }
  }

  function readyImage(): HTMLImageElement {
    const img = document.createElement('img')
    Object.defineProperty(img, 'complete', { value: true })
    Object.defineProperty(img, 'naturalWidth', { value: 800 })
    Object.defineProperty(img, 'naturalHeight', { value: 600 })
    document.body.appendChild(img)
    return img
  }

  async function events(build: () => ComiceHandle): Promise<ComiceEvent[]> {
    const seen: ComiceEvent[] = []
    handle = build()
    handle.on('ready', (_s, e) => seen.push(e))
    handle.on('error', (_s, e) => seen.push(e))
    await tick()
    return seen
  }

  it('distort with no WebGL2: error, and the media is left showing', async () => {
    useFakeGL(null)
    const img = readyImage()
    const seen = await events(() => (comice(img) as ComiceHandle).use(distort()))
    expect(seen.map((e) => e.type)).toEqual(['error'])
    expect(img.style.visibility).toBe('')
  })

  it('distort whose shader will not compile: error', async () => {
    useFakeGL({ failShaderCompile: true })
    const seen = await events(() => (comice(readyImage()) as ComiceHandle).use(distort()))
    expect(seen.map((e) => e.type)).toEqual(['error'])
  })

  it('distort with cross-origin media: error with the CORS hint — and the media is shown again', async () => {
    useFakeGL({ failTexImage: true })
    const img = readyImage()
    const seen = await events(() => (comice(img) as ComiceHandle).use(distort()))
    const e = seen[0] as Extract<ComiceEvent, { type: 'error' }>
    expect(e.type).toBe('error')
    expect(e.error.message).toMatch(/CORS/)
    // It used to stay hidden behind a canvas with nothing to draw: the
    // media disappeared (seen in Chromium with a real cross-origin image).
    expect(img.style.visibility).toBe('')
    expect(document.querySelector('canvas')).toBeNull()
  })

  it.each([
    ['ascii', () => ascii()],
    ['color', () => color({ effects: ['grain'] })],
    ['mosaic', () => mosaic({ fill: 'pixelate' })],
    ['morph', () => morph({ operation: 'merge' })],
  ] as const)('%s with cross-origin media: error, and the media is shown again', async (_name, make) => {
    useFakeGL({ failTexImage: true })
    const img = readyImage()
    const seen = await events(() => (comice(img) as ComiceHandle).use(make()))
    expect(seen.map((e) => e.type)).toEqual(['error'])
    expect(img.style.visibility).toBe('')
    expect(document.querySelector('canvas')).toBeNull()
  })

  it('dissolve with cross-origin media: error, and its canvas is removed from the stage', async () => {
    useFakeGL({ failTexImage: true })
    const stage = document.createElement('div')
    document.body.appendChild(stage)
    const seen = await events(() => (comice(stage) as ComiceHandle).use(dissolve({ from: readyImage(), to: readyImage() })))
    expect(seen.map((e) => e.type)).toEqual(['error'])
    expect(document.querySelector('canvas')).toBeNull()
  })

  it('distort that draws: ready', async () => {
    useFakeGL({})
    const seen = await events(() => (comice(readyImage()) as ComiceHandle).use(distort()))
    expect(seen).toEqual([{ type: 'ready', plugin: 'distort' }])
  })

  it('aura with cross-origin media: error (it reports before bailing on the missing texture)', async () => {
    // aura allocates its own small texture at setup (texImage2D with 9
    // arguments), so failTexImage would throw there. Only MEDIA uploads (the
    // 6-argument DOM-source form) fail — from the very first, as a
    // cross-origin image's do, so the plane never gets a texture.
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type !== 'webgl2') return originalGetContext.call(this, type)
      const gl = createFakeGL2()
      const texImage2D = gl.texImage2D.bind(gl) as (...args: unknown[]) => void
      ;(gl as unknown as { texImage2D: (...args: unknown[]) => void }).texImage2D = (...args) => {
        if (args.length === 6) throw new Error('tainted canvas (fake)')
        texImage2D(...args)
      }
      return gl
    }
    const intersection = installFakeIntersectionObserver()
    const originalRAF = globalThis.requestAnimationFrame
    let frame: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frame = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      getSharedScheduler().stop()
      const seen: ComiceEvent[] = []
      handle = (comice(readyImage()) as ComiceHandle).use(aura({ glow: false }))
      handle.on('error', (_s, e) => seen.push(e))
      frame!(16) // one sampling frame: still no texture
      await tick()
      expect(seen.map((e) => e.type)).toEqual(['error'])
      expect((seen[0] as Extract<ComiceEvent, { type: 'error' }>).error.message).toMatch(/aura\(\).*CORS/)
    } finally {
      globalThis.requestAnimationFrame = originalRAF
      getSharedScheduler().stop()
      intersection.uninstall()
    }
  })

  it('a DOM-only plugin (rail): ready once set up', async () => {
    const track = document.createElement('div')
    track.append(document.createElement('div'), document.createElement('div'))
    document.body.appendChild(track)
    const seen = await events(() => (comice(track) as ComiceHandle).use(rail({ mode: 'strip' })))
    expect(seen).toEqual([{ type: 'ready', plugin: 'rail' }])
  })
})
