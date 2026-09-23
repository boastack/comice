/**
 * test/mosaic.test — packages/mosaic/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom plus test/fake-webgl2.ts, same split every
 * single-media GL plugin test file in this repo uses. Imports core by
 * package name — mosaic's own source does — matching test/morph.test.ts's
 * documented two-scheduler-singleton reasoning.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { mosaic } from '../packages/mosaic/src/index.js'
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

describe('mosaic — construction contract', () => {
  it("throws when fill is 'images' with no sources", () => {
    expect(() => mosaic({ fill: 'images' })).toThrow()
  })

  it("does not throw when fill is 'images' with sources", () => {
    expect(() => mosaic({ fill: 'images', sources: [readyImage()] })).not.toThrow()
  })

  it('does not throw for every non-images fill with no sources', () => {
    for (const fill of ['dither', 'halftone', 'riso', 'pixelate', 'crosshatch'] as const) {
      expect(() => mosaic({ fill })).not.toThrow()
    }
  })
})

describe('mosaic — target contract', () => {
  it('throws for a non-media target', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(mosaic({ fill: 'pixelate' }))).toThrow()
    div.remove()
  })

  it('accepts an <img> target without throwing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(mosaic({ fill: 'pixelate' }))).not.toThrow()
    img.remove()
  })
})

describe('mosaic — no WebGL2 available', () => {
  it('hides then restores the target, appends no canvas', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(mosaic({ fill: 'dither' }))
    expect(img.style.visibility).toBe('')
    expect(document.querySelectorAll('canvas').length).toBe(0)
    img.remove()
  })

  it('setup()/teardown() do not throw with no GL context', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(mosaic({ fill: 'pixelate' }))).not.toThrow()
    expect(() => handle.destroy()).not.toThrow()
    img.remove()
  })
})

describe('mosaic — with a real WebGL2 context (faked)', () => {
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
    document.querySelectorAll('canvas').forEach((c) => c.remove())
  })

  it('hides the original target and inserts a canvas after it', () => {
    handle = comice(img) as ComiceHandle
    handle.use(mosaic({ fill: 'pixelate' }))
    expect(img.style.visibility).toBe('hidden')
    expect(img.nextElementSibling?.tagName).toBe('CANVAS')
  })

  it('sets the parent to position: relative if it was static', () => {
    const parent = img.parentElement!
    parent.style.position = 'static'
    handle = comice(img) as ComiceHandle
    handle.use(mosaic({ fill: 'halftone' }))
    expect(parent.style.position).toBe('relative')
  })

  it.each(['dither', 'halftone', 'riso', 'pixelate', 'crosshatch'] as const)('accepts fill "%s" without throwing', (fill) => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(mosaic({ fill }))).not.toThrow()
  })

  it("accepts fill 'images' with real sources without throwing", () => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(mosaic({ fill: 'images', sources: [readyImage(), readyImage()] }))).not.toThrow()
  })

  it('accepts a numeric palette without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(mosaic({ fill: 'dither', palette: 4 }))).not.toThrow()
  })

  it('accepts a string[] palette without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(mosaic({ fill: 'dither', palette: ['#000', '#fff', '#f00'] }))).not.toThrow()
  })

  it('teardown removes the canvas and all source planes', () => {
    handle = comice(img) as ComiceHandle
    handle.use(mosaic({ fill: 'images', sources: [readyImage()] }))
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
      handle.use(mosaic({ fill: 'pixelate' }))
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
      handle.use(mosaic({ fill: 'pixelate' }))
      expect(pending).not.toBeNull()
      expect(() => pending!(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('stops rendering once the target is removed from the document', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      handle = comice(img) as ComiceHandle
      handle.use(mosaic({ fill: 'pixelate' }))
      img.remove()
      expect(() => pending?.(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })
})

describe('mosaic — params (MappableTarget)', () => {
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
    document.querySelectorAll('canvas').forEach((c) => c.remove())
  })

  it('get/setParam round-trips "cell"', () => {
    handle = comice(img) as ComiceHandle
    const plugin = mosaic({ fill: 'pixelate' })
    handle.use(plugin)
    plugin.params!.setParam('cell', 24)
    expect(plugin.params!.getParam('cell')).toBe(24)
  })

  it('setParam clamps cell to a minimum of 1', () => {
    handle = comice(img) as ComiceHandle
    const plugin = mosaic({ fill: 'pixelate' })
    handle.use(plugin)
    plugin.params!.setParam('cell', -5)
    expect(plugin.params!.getParam('cell')).toBe(1)
  })

  it('getParam for an unknown name returns 0', () => {
    handle = comice(img) as ComiceHandle
    const plugin = mosaic({ fill: 'pixelate' })
    handle.use(plugin)
    expect(plugin.params!.getParam('bogus')).toBe(0)
  })

  it('setParam for an unknown name is a no-op', () => {
    handle = comice(img) as ComiceHandle
    const plugin = mosaic({ fill: 'pixelate' })
    handle.use(plugin)
    expect(() => plugin.params!.setParam('bogus', 1)).not.toThrow()
  })
})
