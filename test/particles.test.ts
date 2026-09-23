/**
 * test/particles.test — packages/particles/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom plus test/fake-webgl2.ts (WebGL2 instanced-draw
 * fakes) and installFake2DContext() (sampler.ts's rasterization). Imports
 * core by package name, matching every GL plugin package's test file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { particles } from '../packages/particles/src/index.js'
import { createFakeGL2, installFake2DContext } from './fake-webgl2.js'

function readyImage(): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true })
  return img
}

afterEach(() => {
  getSharedScheduler().stop()
})

describe('particles — construction contract', () => {
  it('throws when `from` is missing', () => {
    expect(() => particles({} as any)).toThrow()
  })

  it('does not throw with a valid `from`', () => {
    expect(() => particles({ from: readyImage() })).not.toThrow()
  })

  it('accepts a { text } SourceSpec for `from`', () => {
    expect(() => particles({ from: { text: 'HELLO' } })).not.toThrow()
  })

  it('accepts a { text } SourceSpec for `to`', () => {
    expect(() => particles({ from: readyImage(), to: { text: 'COMICE' } })).not.toThrow()
  })
})

describe('particles — target contract', () => {
  it('accepts a plain container target without throwing', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(particles({ from: readyImage() }))).not.toThrow()
    div.remove()
  })
})

describe('particles — no WebGL2 available', () => {
  it('does not append a canvas, setup()/teardown() do not throw', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(particles({ from: readyImage() }))).not.toThrow()
    expect(document.querySelectorAll('canvas').length).toBe(0)
    expect(() => handle.destroy()).not.toThrow()
    div.remove()
  })
})

describe('particles — with a real WebGL2 + 2D context (both faked)', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let uninstall2D: () => void
  let container: HTMLDivElement
  let handle: ComiceHandle | null = null

  beforeEach(() => {
    ;({ uninstall: uninstall2D } = installFake2DContext({ imageDataAlpha: 255 }))
    const original2DAwareGetContext = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return original2DAwareGetContext.call(this, type)
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    handle = null
  })

  afterEach(() => {
    handle?.destroy()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    uninstall2D()
    container.remove()
    document.querySelectorAll('canvas').forEach((c) => c.remove())
  })

  it('inserts a canvas after the target', () => {
    handle = comice(container) as ComiceHandle
    handle.use(particles({ from: readyImage() }))
    expect(container.nextElementSibling?.tagName).toBe('CANVAS')
  })

  it('sets the parent to position: relative if it was static', () => {
    const parent = container.parentElement!
    parent.style.position = 'static'
    handle = comice(container) as ComiceHandle
    handle.use(particles({ from: readyImage() }))
    expect(parent.style.position).toBe('relative')
  })

  it.each(['cloud', 'shatter'] as const)('accepts mode "%s" without throwing', (mode) => {
    handle = comice(container) as ComiceHandle
    expect(() => handle!.use(particles({ mode, from: readyImage() }))).not.toThrow()
  })

  it('accepts a `to` source (morphing) without throwing', () => {
    handle = comice(container) as ComiceHandle
    expect(() => handle!.use(particles({ from: readyImage(), to: readyImage() }))).not.toThrow()
  })

  it('accepts motion.fluid without throwing', () => {
    handle = comice(container) as ComiceHandle
    expect(() => handle!.use(particles({ from: readyImage(), motion: { fluid: true, noise: 0.05 } }))).not.toThrow()
  })

  it('accepts a custom count and size without throwing', () => {
    handle = comice(container) as ComiceHandle
    expect(() => handle!.use(particles({ from: readyImage(), count: 500, size: 5 }))).not.toThrow()
  })

  it('teardown removes the canvas', () => {
    handle = comice(container) as ComiceHandle
    handle.use(particles({ from: readyImage() }))
    expect(document.querySelectorAll('canvas').length).toBe(1)
    handle.destroy()
    handle = null
    expect(document.querySelectorAll('canvas').length).toBe(0)
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
      handle = comice(container) as ComiceHandle
      handle.use(particles({ from: readyImage() }))
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
      handle = comice(container) as ComiceHandle
      handle.use(particles({ from: readyImage() }))
      container.remove()
      expect(() => pending?.(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('.setProgress() on the handle drives the plugin without throwing', () => {
    handle = comice(container) as ComiceHandle
    handle.use(particles({ from: readyImage(), to: readyImage() }))
    expect(() => handle!.setProgress(0.6)).not.toThrow()
  })

  it('degrades (no throw) when 2D canvas is unavailable at sample time', () => {
    uninstall2D()
    handle = comice(container) as ComiceHandle
    expect(() => handle!.use(particles({ from: readyImage() }))).not.toThrow()
    ;({ uninstall: uninstall2D } = installFake2DContext())
  })

  it('a ResizeObserver signal does not throw', () => {
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
      handle = comice(container) as ComiceHandle
      handle.use(particles({ from: readyImage() }))
      expect(capturedCallback).not.toBeNull()
      expect(() => capturedCallback!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)).not.toThrow()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})

describe('particles — params (MappableTarget)', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let uninstall2D: () => void
  let container: HTMLDivElement
  let handle: ComiceHandle | null = null

  beforeEach(() => {
    ;({ uninstall: uninstall2D } = installFake2DContext({ imageDataAlpha: 255 }))
    const original2DAwareGetContext = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return original2DAwareGetContext.call(this, type)
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    handle = null
  })

  afterEach(() => {
    handle?.destroy()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    uninstall2D()
    container.remove()
    document.querySelectorAll('canvas').forEach((c) => c.remove())
  })

  it('get/setParam round-trips progress, clamped to [0, 1]', () => {
    handle = comice(container) as ComiceHandle
    const plugin = particles({ from: readyImage(), to: readyImage() })
    handle.use(plugin)
    plugin.params!.setParam('progress', 0.42)
    expect(plugin.params!.getParam('progress')).toBeCloseTo(0.42)
    plugin.params!.setParam('progress', 5)
    expect(plugin.params!.getParam('progress')).toBe(1)
    plugin.params!.setParam('progress', -5)
    expect(plugin.params!.getParam('progress')).toBe(0)
  })

  it('getParam for an unknown name returns 0', () => {
    handle = comice(container) as ComiceHandle
    const plugin = particles({ from: readyImage() })
    handle.use(plugin)
    expect(plugin.params!.getParam('bogus')).toBe(0)
  })

  it('setParam for an unknown name is a no-op', () => {
    handle = comice(container) as ComiceHandle
    const plugin = particles({ from: readyImage() })
    handle.use(plugin)
    expect(() => plugin.params!.setParam('bogus', 1)).not.toThrow()
  })
})
