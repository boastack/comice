/**
 * test/dissolve.test — packages/dissolve/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts
 * for the "real WebGL2" branches — same split test/morph.test.ts uses: the
 * no-WebGL2 degrade path exercised for real (happy-dom's own
 * canvas.getContext('webgl2') is unconditionally null), the success path
 * exercised by patching HTMLCanvasElement.prototype.getContext.
 *
 * IMPORTANT: this file imports `comice`/`comice/scheduler` from the PACKAGE
 * NAME, exactly like test/morph.test.ts, and for the identical reason —
 * packages/dissolve/src/index.ts itself imports comice/gl and
 * comice/scheduler by package name (that's what a real published
 * @comice/dissolve does), so importing core from source here would resolve
 * to a SECOND, different scheduler singleton and cause confusing
 * test-isolation failures. See test/morph.test.ts's own header for the
 * full story; packages/core must be built (`pnpm build`) before this file
 * can pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { dissolve } from '../packages/dissolve/src/index.js'
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

describe('dissolve — construction contract', () => {
  it('throws when `from` is missing', () => {
    const to = readyImage()
    expect(() => dissolve({ to } as any)).toThrow()
  })

  it('throws when `to` is missing', () => {
    const from = readyImage()
    expect(() => dissolve({ from } as any)).toThrow()
  })

  it('does not throw when both `from` and `to` are supplied', () => {
    expect(() => dissolve({ from: readyImage(), to: readyImage() })).not.toThrow()
  })
})

describe('dissolve — target contract', () => {
  it('accepts a plain container element as the target (not media itself)', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(dissolve({ from: readyImage(), to: readyImage() }))).not.toThrow()
    div.remove()
  })
})

describe('dissolve — no WebGL2 available (happy-dom\'s real, unpatched getContext)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('never hides the target — unlike morph, the target is not media', () => {
    container.style.visibility = ''
    const handle = comice(container) as ComiceHandle
    handle.use(dissolve({ from: readyImage(), to: readyImage() }))
    expect(container.style.visibility).toBe('')
  })

  it('does not append a canvas when WebGL2 is unavailable', () => {
    const handle = comice(container) as ComiceHandle
    handle.use(dissolve({ from: readyImage(), to: readyImage() }))
    expect(document.querySelectorAll('canvas').length).toBe(0)
  })

  it('setup()/teardown() do not throw even with no GL context at all', () => {
    const handle = comice(container) as ComiceHandle
    expect(() => handle.use(dissolve({ from: readyImage(), to: readyImage() }))).not.toThrow()
    expect(() => handle.destroy()).not.toThrow()
  })

  it('.setProgress() does not throw with no GL context', () => {
    const handle = comice(container) as ComiceHandle
    handle.use(dissolve({ from: readyImage(), to: readyImage() }))
    expect(() => handle.setProgress(0.5)).not.toThrow()
  })
})

describe('dissolve — with a real WebGL2 context (faked)', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let container: HTMLDivElement
  let handle: ComiceHandle | null = null

  beforeEach(() => {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return originalGetContext.call(this, type)
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    handle = null
  })

  afterEach(() => {
    handle?.destroy()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    container.remove()
    document.querySelectorAll('canvas').forEach((canvas) => canvas.remove())
  })

  it('inserts a canvas after the target without hiding the target', () => {
    handle = comice(container) as ComiceHandle
    handle.use(dissolve({ from: readyImage(), to: readyImage() }))

    expect(container.style.visibility).toBe('')
    expect(container.nextElementSibling?.tagName).toBe('CANVAS')
  })

  it('sets the parent to position: relative if it was static', () => {
    const parent = container.parentElement!
    parent.style.position = 'static'
    handle = comice(container) as ComiceHandle
    handle.use(dissolve({ from: readyImage(), to: readyImage() }))
    expect(parent.style.position).toBe('relative')
  })

  it.each(['crossfade', 'noise', 'liquid'] as const)('accepts transition "%s" without throwing', (transition) => {
    handle = comice(container) as ComiceHandle
    expect(() => handle!.use(dissolve({ from: readyImage(), to: readyImage(), transition }))).not.toThrow()
  })

  it('progress starts at instance.progress (0 for an idle handle)', () => {
    handle = comice(container) as ComiceHandle
    const plugin = dissolve({ from: readyImage(), to: readyImage() })
    handle.use(plugin)
    expect(plugin.params!.getParam('progress')).toBe(0)
  })

  it('setParam("progress", n) updates the readable param, clamped to [0, 1]', () => {
    handle = comice(container) as ComiceHandle
    const plugin = dissolve({ from: readyImage(), to: readyImage() })
    handle.use(plugin)

    plugin.params!.setParam('progress', 0.42)
    expect(plugin.params!.getParam('progress')).toBeCloseTo(0.42)

    plugin.params!.setParam('progress', 5)
    expect(plugin.params!.getParam('progress')).toBe(1)

    plugin.params!.setParam('progress', -5)
    expect(plugin.params!.getParam('progress')).toBe(0)
  })

  it('getParam for an unknown name returns 0 rather than throwing', () => {
    handle = comice(container) as ComiceHandle
    const plugin = dissolve({ from: readyImage(), to: readyImage() })
    handle.use(plugin)
    expect(plugin.params!.getParam('bogus')).toBe(0)
  })

  it('setParam for an unknown name is a no-op, not a throw', () => {
    handle = comice(container) as ComiceHandle
    const plugin = dissolve({ from: readyImage(), to: readyImage() })
    handle.use(plugin)
    expect(() => plugin.params!.setParam('bogus', 1)).not.toThrow()
    expect(plugin.params!.getParam('progress')).toBe(0)
  })

  it('.setProgress() on the handle drives the plugin without throwing', () => {
    handle = comice(container) as ComiceHandle
    handle.use(dissolve({ from: readyImage(), to: readyImage() }))
    expect(() => handle!.setProgress(0.75)).not.toThrow()
  })

  it('teardown removes the canvas and unregisters from the scheduler', () => {
    handle = comice(container) as ComiceHandle
    handle.use(dissolve({ from: readyImage(), to: readyImage() }))
    expect(document.querySelectorAll('canvas').length).toBe(1)

    handle.destroy()
    handle = null
    expect(document.querySelectorAll('canvas').length).toBe(0)
  })

  it('accepts custom noise options for the noise/liquid transitions without throwing', () => {
    handle = comice(container) as ComiceHandle
    expect(() =>
      handle!.use(
        dissolve({
          from: readyImage(),
          to: readyImage(),
          transition: 'liquid',
          noise: { scale: 4, intensity: 1.5, softness: 0.08 },
        }),
      ),
    ).not.toThrow()
  })

  it('registers against the shared scheduler and renders on a driven frame', () => {
    getSharedScheduler().stop() // ensure a clean scheduler state for this frame-driving test
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      handle = comice(container) as ComiceHandle
      handle.use(dissolve({ from: readyImage(), to: readyImage() }))
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
      handle = comice(container) as ComiceHandle
      handle.use(dissolve({ from: readyImage(), to: readyImage() }))
      container.remove()
      expect(() => pending?.(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
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
      handle = comice(container) as ComiceHandle
      handle.use(dissolve({ from: readyImage(), to: readyImage() }))
      expect(capturedCallback).not.toBeNull()
      expect(() => capturedCallback!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)).not.toThrow()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
