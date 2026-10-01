/**
 * test/ascii.test — packages/ascii/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom plus test/fake-webgl2.ts (WebGL2) and its
 * installFake2DContext() (atlas rasterization). Imports core by package
 * name, matching every GL plugin package's test file in this repo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { ascii } from '../packages/ascii/src/index.js'
import { createFakeGL2, installFake2DContext } from './fake-webgl2.js'
import { installFakeIntersectionObserver, type FakeIntersection } from './fake-intersection.js'

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

describe('ascii — construction contract', () => {
  it('throws for an empty charset', () => {
    expect(() => ascii({ charset: '' })).toThrow()
  })

  it('does not throw with no options at all', () => {
    expect(() => ascii()).not.toThrow()
  })
})

describe('ascii — target contract', () => {
  it('throws for a non-media target', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(ascii())).toThrow()
    div.remove()
  })

  it('accepts an <img> target without throwing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(ascii())).not.toThrow()
    img.remove()
  })
})

describe('ascii — no WebGL2 available', () => {
  it('hides then restores the target, appends no canvas', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(ascii())
    expect(img.style.visibility).toBe('')
    expect(document.querySelectorAll('canvas').length).toBe(0)
    img.remove()
  })

  it('setup()/teardown() do not throw with no GL context', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(ascii())).not.toThrow()
    expect(() => handle.destroy()).not.toThrow()
    img.remove()
  })
})

describe('ascii — with a real WebGL2 context and 2D canvas (both faked)', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let uninstall2D: () => void
  let intersection: FakeIntersection
  let img: HTMLImageElement
  let handle: ComiceHandle | null = null

  beforeEach(() => {
    ;({ uninstall: uninstall2D } = installFake2DContext({ imageDataAlpha: 255 }))
    // The render loop only runs while the target is on screen (spec §13);
    // happy-dom never reports anything as on screen.
    intersection = installFakeIntersectionObserver()
    const original2DAwareGetContext = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return original2DAwareGetContext.call(this, type)
    }
    img = readyImage()
    document.body.appendChild(img)
    handle = null
  })

  afterEach(() => {
    handle?.destroy()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    uninstall2D()
    intersection.uninstall()
    img.remove()
    document.querySelectorAll('canvas').forEach((c) => c.remove())
  })

  it('hides the original target and inserts a canvas after it', () => {
    handle = comice(img) as ComiceHandle
    handle.use(ascii())
    expect(img.style.visibility).toBe('hidden')
    expect(img.nextElementSibling?.tagName).toBe('CANVAS')
  })

  it('sets the parent to position: relative if it was static', () => {
    const parent = img.parentElement!
    parent.style.position = 'static'
    handle = comice(img) as ComiceHandle
    handle.use(ascii())
    expect(parent.style.position).toBe('relative')
  })

  it('accepts a custom charset and cell size without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(ascii({ charset: '01', cell: 20 }))).not.toThrow()
  })

  it('teardown removes the canvas', () => {
    handle = comice(img) as ComiceHandle
    handle.use(ascii())
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
      handle.use(ascii())
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
      handle.use(ascii())
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
      handle.use(ascii())
      img.remove()
      expect(() => pending?.(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('degrades (no throw, no atlas texture) when 2D canvas is unavailable', () => {
    uninstall2D()
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(ascii())).not.toThrow()
    ;({ uninstall: uninstall2D } = installFake2DContext())
  })
})

describe('ascii — params (MappableTarget)', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let uninstall2D: () => void
  let img: HTMLImageElement
  let handle: ComiceHandle | null = null

  beforeEach(() => {
    ;({ uninstall: uninstall2D } = installFake2DContext({ imageDataAlpha: 255 }))
    const original2DAwareGetContext = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return original2DAwareGetContext.call(this, type)
    }
    img = readyImage()
    document.body.appendChild(img)
    handle = null
  })

  afterEach(() => {
    handle?.destroy()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    uninstall2D()
    img.remove()
    document.querySelectorAll('canvas').forEach((c) => c.remove())
  })

  it('get/setParam round-trips "cell"', () => {
    handle = comice(img) as ComiceHandle
    const plugin = ascii()
    handle.use(plugin)
    plugin.params!.setParam('cell', 16)
    expect(plugin.params!.getParam('cell')).toBe(16)
  })

  it('setParam clamps cell to a minimum of 1', () => {
    handle = comice(img) as ComiceHandle
    const plugin = ascii()
    handle.use(plugin)
    plugin.params!.setParam('cell', -3)
    expect(plugin.params!.getParam('cell')).toBe(1)
  })

  it('getParam for an unknown name returns 0', () => {
    handle = comice(img) as ComiceHandle
    const plugin = ascii()
    handle.use(plugin)
    expect(plugin.params!.getParam('bogus')).toBe(0)
  })

  it('setParam for an unknown name is a no-op', () => {
    handle = comice(img) as ComiceHandle
    const plugin = ascii()
    handle.use(plugin)
    expect(() => plugin.params!.setParam('bogus', 1)).not.toThrow()
  })
})
