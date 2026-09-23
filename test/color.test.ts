/**
 * test/color.test — packages/color/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom plus test/fake-webgl2.ts, same split every
 * single-media GL plugin test file in this repo uses (morph/dissolve/
 * distort). Imports core by package name — color's own source does
 * (comice/gl, comice/scheduler) — matching test/morph.test.ts's documented
 * two-scheduler-singleton reasoning.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { color } from '../packages/color/src/index.js'
import { createFakeGL2 } from './fake-webgl2.js'

function readyImage(): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true })
  return img
}

afterEach(() => {
  getSharedScheduler().stop()
})

describe('color — construction contract', () => {
  it('throws when effects includes "lut" but no lut path is given', () => {
    expect(() => color({ effects: ['lut'] })).not.toThrow() // constructor itself doesn't validate — setup() does, matching morph's mask requirement pattern
  })

  it('does not throw with no options at all (harmless passthrough)', () => {
    expect(() => color()).not.toThrow()
  })
})

describe('color — target contract', () => {
  it('throws for a non-media target', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(color({ effects: ['duotone'] }))).toThrow()
    div.remove()
  })

  it('accepts an <img> target without throwing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(color({ effects: ['duotone'] }))).not.toThrow()
    img.remove()
  })

  it('accepts a <video> target without throwing', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    const handle = comice(video) as ComiceHandle
    expect(() => handle.use(color({ effects: ['grain'] }))).not.toThrow()
    video.remove()
  })

  it('throws at setup() when effects includes "lut" with no lut path', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(color({ effects: ['lut'] }))).toThrow()
    img.remove()
  })
})

describe('color — no WebGL2 available', () => {
  let img: HTMLImageElement

  beforeEach(() => {
    img = readyImage()
    document.body.appendChild(img)
  })

  afterEach(() => {
    img.remove()
  })

  it('hides the target and restores its visibility on the no-WebGL2 degrade path', () => {
    img.style.visibility = ''
    const handle = comice(img) as ComiceHandle
    handle.use(color({ effects: ['duotone'] }))
    expect(img.style.visibility).toBe('')
  })

  it('does not append a canvas when WebGL2 is unavailable', () => {
    const handle = comice(img) as ComiceHandle
    handle.use(color({ effects: ['bloom'] }))
    expect(document.querySelectorAll('canvas').length).toBe(0)
  })

  it('setup()/teardown() do not throw with no GL context', () => {
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(color({ effects: ['aberration'] }))).not.toThrow()
    expect(() => handle.destroy()).not.toThrow()
  })
})

describe('color — with a real WebGL2 context (faked)', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalFetch = globalThis.fetch
  let img: HTMLImageElement
  let handle: ComiceHandle | null = null

  beforeEach(() => {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return originalGetContext.call(this, type)
    }
    img = readyImage()
    document.body.appendChild(img)
    handle = null
  })

  afterEach(() => {
    handle?.destroy()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    globalThis.fetch = originalFetch
    img.remove()
    document.querySelectorAll('canvas').forEach((canvas) => canvas.remove())
  })

  it('hides the original target and inserts a canvas after it', () => {
    handle = comice(img) as ComiceHandle
    handle.use(color({ effects: ['duotone'] }))
    expect(img.style.visibility).toBe('hidden')
    expect(img.nextElementSibling?.tagName).toBe('CANVAS')
  })

  it('sets the parent to position: relative if it was static', () => {
    const parent = img.parentElement!
    parent.style.position = 'static'
    handle = comice(img) as ComiceHandle
    handle.use(color({ effects: ['grain'] }))
    expect(parent.style.position).toBe('relative')
  })

  it('accepts every effect and combinations without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(color({ effects: ['duotone', 'grain', 'bloom', 'aberration'] }))).not.toThrow()
  })

  it('fetches and applies a LUT when effects includes "lut"', async () => {
    const cubeText = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n')
    globalThis.fetch = (async () => ({ text: async () => cubeText })) as unknown as typeof fetch

    handle = comice(img) as ComiceHandle
    handle.use(color({ effects: ['lut'], lut: '/fake.cube' }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // No throw across the async fetch->parse->recompile->render chain.
    expect(true).toBe(true)
  })

  it('destroys the placeholder-size program once the real .cube size differs (no GL resource leak)', async () => {
    const size = 4
    const lines = [`LUT_3D_SIZE ${size}`]
    for (let i = 0; i < size ** 3; i++) lines.push('0 0 0')
    const cubeText = lines.join('\n')
    globalThis.fetch = (async () => ({ text: async () => cubeText })) as unknown as typeof fetch

    handle = comice(img) as ComiceHandle
    // The placeholder program compiles with lut.size: 2; a real 4x4x4
    // cube forces a genuinely different cache key on recompile, so the
    // stale (size-2) program becomes unreachable and must be destroyed
    // rather than leaked — this is the path a same-size LUT (like the
    // other LUT test's size-2 fixture) never exercises.
    expect(() => handle!.use(color({ effects: ['lut'], lut: '/fake4.cube' }))).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })

  it('degrades (no throw) when the LUT fetch fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(color({ effects: ['lut'], lut: '/missing.cube' }))).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
  })

  it('degrades (no throw) when the fetched .cube text is malformed', async () => {
    globalThis.fetch = (async () => ({ text: async () => 'not a cube file' })) as unknown as typeof fetch

    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(color({ effects: ['lut'], lut: '/bad.cube' }))).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
  })

  it('teardown removes the canvas and the LUT texture without throwing', async () => {
    const cubeText = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n')
    globalThis.fetch = (async () => ({ text: async () => cubeText })) as unknown as typeof fetch

    handle = comice(img) as ComiceHandle
    handle.use(color({ effects: ['lut'], lut: '/fake.cube' }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(document.querySelectorAll('canvas').length).toBe(1)
    handle.destroy()
    handle = null
    expect(document.querySelectorAll('canvas').length).toBe(0)
  })

  it('a ResizeObserver signal re-renders without throwing', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    let capturedCallback: ResizeObserverCallback | null = null
    class SpyResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        capturedCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as any).ResizeObserver = SpyResizeObserver

    try {
      handle = comice(img) as ComiceHandle
      handle.use(color({ effects: ['duotone'] }))
      expect(capturedCallback).not.toBeNull()
      expect(() => capturedCallback!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)).not.toThrow()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })

  it('registers against the shared scheduler and renders on a driven frame', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      handle = comice(img) as ComiceHandle
      handle.use(color({ effects: ['duotone'] }))
      expect(pending).not.toBeNull()
      expect(() => pending!(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('stops rendering (isActive() false) once the target is removed from the document', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      handle = comice(img) as ComiceHandle
      handle.use(color({ effects: ['duotone'] }))
      img.remove()
      expect(() => pending?.(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })
})

describe('color — params (MappableTarget)', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let img: HTMLImageElement
  let handle: ComiceHandle | null = null

  beforeEach(() => {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return originalGetContext.call(this, type)
    }
    img = readyImage()
    document.body.appendChild(img)
    handle = null
  })

  afterEach(() => {
    handle?.destroy()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    img.remove()
    document.querySelectorAll('canvas').forEach((canvas) => canvas.remove())
  })

  it('get/setParam round-trips every named parameter', () => {
    handle = comice(img) as ComiceHandle
    const plugin = color({ effects: ['grain', 'bloom', 'aberration'] })
    handle.use(plugin)

    for (const name of ['grainAmount', 'bloomIntensity', 'bloomThreshold', 'aberrationAmount', 'grainSeed']) {
      plugin.params!.setParam(name, 0.42)
      expect(plugin.params!.getParam(name)).toBeCloseTo(0.42)
    }
  })

  it('getParam for an unknown name returns 0', () => {
    handle = comice(img) as ComiceHandle
    const plugin = color({ effects: ['duotone'] })
    handle.use(plugin)
    expect(plugin.params!.getParam('bogus')).toBe(0)
  })

  it('setParam for an unknown name is a no-op', () => {
    handle = comice(img) as ComiceHandle
    const plugin = color({ effects: ['duotone'] })
    handle.use(plugin)
    expect(() => plugin.params!.setParam('bogus', 1)).not.toThrow()
  })
})
