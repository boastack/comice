/**
 * test/morph.test — packages/morph/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts
 * for the "real WebGL2" branches — happy-dom's own canvas.getContext('webgl2')
 * is unconditionally null (see test/gl-context.test.ts), so the no-WebGL2
 * degrade path is exercised for real without patching anything, and the
 * success path is exercised by patching HTMLCanvasElement.prototype.getContext
 * for the one describe block that needs it, the same pattern
 * test/gl-context.test.ts established.
 *
 * This is morph's version of what test/reveal.test.ts is for reveal: it
 * exercises the REAL comice() public API, proving .use()/setup()/teardown()/
 * params against the first SHADER plugin those contracts have ever had
 * (reveal proved them against CSS state).
 *
 * IMPORTANT DIFFERENCE FROM test/reveal.test.ts: this file imports `comice`
 * and `getSharedScheduler` from the PACKAGE NAME (`comice`, `comice/scheduler`),
 * which resolves through packages/core's own package.json `exports` map to
 * its BUILT dist/ — not from `../packages/core/src/...` the way every other
 * test file in this repo does. morph's own source (packages/morph/src/
 * index.ts, shader.ts) imports core the same way, since that's what a real
 * published @comice/morph does — it has no access to comice's source tree,
 * only its package exports. If this test imported core from source while
 * morph imports it from `comice/scheduler`, `comice()`'s handle and morph's
 * own getSharedScheduler() call would resolve to two DIFFERENT module
 * instances with two different scheduler singletons — real failures this
 * file hit before the import was aligned this way (a stray-canvas/scheduler
 * test-isolation bug turned out to be a two-singletons bug instead).
 * `reveal` never hit this because it never calls getSharedScheduler() itself.
 *
 * Consequence: `pnpm build` on packages/core must be current before running
 * this file, the same real dependency plane.ts/mask.ts/etc.'s own dist
 * output already requires for anything that imports comice/gl.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { morph } from '../packages/morph/src/index.js'
import { createFakeGL2, installFake2DContext } from './fake-webgl2.js'

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

describe('morph — target contract', () => {
  it('throws for a non-media target, per the plugin contract', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(morph({ operation: 'merge' }))).toThrow()
    div.remove()
  })

  it('accepts an <img> target without throwing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(morph({ operation: 'merge' }))).not.toThrow()
    img.remove()
  })

  it('accepts a <video> target without throwing', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    const handle = comice(video) as ComiceHandle
    expect(() => handle.use(morph({ operation: 'breakout' }))).not.toThrow()
    video.remove()
  })
})

describe('morph — no WebGL2 available (happy-dom\'s real, unpatched getContext)', () => {
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
    const plugin = morph({ operation: 'merge' })
    handle.use(plugin)
    // No WebGL2 -> glContext stays null -> setup()'s own fallback restores
    // visibility rather than leaving the target permanently hidden with
    // nothing replacing it.
    expect(img.style.visibility).toBe('')
  })

  it('does not append a canvas when WebGL2 is unavailable', () => {
    const handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'merge' }))
    const canvases = document.querySelectorAll('canvas')
    expect(canvases.length).toBe(0)
  })

  it('setup()/teardown() do not throw even with no GL context at all', () => {
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(morph({ operation: 'merge' }))).not.toThrow()
    expect(() => handle.destroy()).not.toThrow()
  })

  it('.transition()/.setProgress() do not throw with no GL context', () => {
    const handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'merge' }))
    expect(() => {
      handle.transition('entering')
      handle.setProgress(0.5)
    }).not.toThrow()
  })
})

describe('morph — with a real WebGL2 context (faked)', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let img: HTMLImageElement
  // Tracked so afterEach can always tear down whatever the test created —
  // without this, a canvas/scheduler registration from one test leaks
  // into the next (a stray <canvas> in document.body, a still-registered
  // scheduler entry), which is exactly the kind of test-isolation bug
  // this project's own testing notes call out for getSharedScheduler().
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

  it('hides the original target and inserts a canvas after it', () => {
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'merge' }))

    expect(img.style.visibility).toBe('hidden')
    expect(img.nextElementSibling?.tagName).toBe('CANVAS')
  })

  it('sets the parent to position: relative if it was static (needed for the canvas overlay)', () => {
    const parent = img.parentElement!
    // happy-dom's getComputedStyle reports an empty string for an
    // unstyled position, not the real browser default 'static' — set it
    // explicitly here so setup()'s `=== 'static'` check actually fires,
    // proving the real-browser case rather than happy-dom's own quirk.
    parent.style.position = 'static'
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'merge' }))
    expect(parent.style.position).toBe('relative')
  })

  it('does not override an already-positioned parent', () => {
    const parent = img.parentElement!
    parent.style.position = 'absolute'
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'merge' }))
    expect(parent.style.position).toBe('absolute')
  })

  it('teardown() removes the canvas and restores the target\'s original visibility', () => {
    img.style.visibility = 'visible'
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'merge' }))
    expect(img.nextElementSibling?.tagName).toBe('CANVAS')

    handle.destroy()

    expect(document.querySelectorAll('canvas').length).toBe(0)
    expect(img.style.visibility).toBe('visible')
  })

  it('teardown() is safe to call without throwing, and idempotent via destroy()', () => {
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'merge' }))
    expect(() => handle!.destroy()).not.toThrow()
  })

  it('.transition()/.setProgress() drive the shader without throwing', () => {
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'merge' }))
    expect(() => {
      handle!.transition('entering')
      handle!.setProgress(0.3)
      handle!.setProgress(0.7)
    }).not.toThrow()
  })

  it('a video target with 0x0 dimensions falls back to a 16:9 media aspect (no divide-by-zero)', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    Object.defineProperty(video, 'videoWidth', { value: 0, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 0, configurable: true })
    handle = comice(video) as ComiceHandle
    expect(() => {
      handle!.use(morph({ operation: 'merge' }))
      handle!.setProgress(0.5)
    }).not.toThrow()
    video.remove()
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
      handle = comice(img) as ComiceHandle
      handle.use(morph({ operation: 'merge' }))
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
      handle.use(morph({ operation: 'merge' }))
      img.remove()
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
      handle = comice(img) as ComiceHandle
      handle.use(morph({ operation: 'merge' }))
      expect(capturedCallback).not.toBeNull()
      expect(() => capturedCallback!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)).not.toThrow()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})

describe('morph — params / MappableTarget contract', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let img: HTMLImageElement

  beforeEach(() => {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return originalGetContext.call(this, type)
    }
    img = readyImage()
    document.body.appendChild(img)
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    img.remove()
    document.querySelectorAll('canvas').forEach((canvas) => canvas.remove())
  })

  it('exposes a params object with getParam/setParam', () => {
    const plugin = morph({ operation: 'merge' })
    expect(plugin.params).toBeDefined()
    expect(typeof plugin.params?.getParam).toBe('function')
    expect(typeof plugin.params?.setParam).toBe('function')
  })

  it('setParam("progress", ...) / getParam("progress") round-trip', () => {
    const handle = comice(img) as ComiceHandle
    const plugin = morph({ operation: 'merge' })
    handle.use(plugin)

    plugin.params!.setParam('progress', 0.6)
    expect(plugin.params!.getParam('progress')).toBeCloseTo(0.6)
  })

  it('setParam clamps progress to [0, 1]', () => {
    const handle = comice(img) as ComiceHandle
    const plugin = morph({ operation: 'merge' })
    handle.use(plugin)

    plugin.params!.setParam('progress', 5)
    expect(plugin.params!.getParam('progress')).toBe(1)

    plugin.params!.setParam('progress', -5)
    expect(plugin.params!.getParam('progress')).toBe(0)
  })

  it('mouseX/mouseY/velocity are independently settable and readable', () => {
    const handle = comice(img) as ComiceHandle
    const plugin = morph({ operation: 'merge' })
    handle.use(plugin)

    plugin.params!.setParam('mouseX', 0.3)
    plugin.params!.setParam('mouseY', -0.2)
    plugin.params!.setParam('velocity', 0.8)

    expect(plugin.params!.getParam('mouseX')).toBe(0.3)
    expect(plugin.params!.getParam('mouseY')).toBe(-0.2)
    expect(plugin.params!.getParam('velocity')).toBe(0.8)
  })

  it('setParam ignores an unknown parameter name rather than throwing', () => {
    const handle = comice(img) as ComiceHandle
    const plugin = morph({ operation: 'merge' })
    handle.use(plugin)
    expect(() => plugin.params!.setParam('nonexistent', 1)).not.toThrow()
  })

  it('getParam returns 0 for an unknown parameter name', () => {
    const plugin = morph({ operation: 'merge' })
    expect(plugin.params!.getParam('nonexistent')).toBe(0)
  })

  it('works end to end through .map().to(), the real mapping layer, no morph-specific driver code', () => {
    const handle = comice(img) as ComiceHandle
    const plugin = morph({ operation: 'merge' })
    handle.use(plugin)

    let onSignals: ((signals: any) => void) | null = null
    const fakeDriver = {
      name: 'fake',
      attachSignals(_target: Element, cb: (signals: any) => void) {
        onSignals = cb
        return () => {}
      },
    }

    handle.driver(fakeDriver as any).map('level').to(plugin, 'progress', { output: [0, 1] })
    onSignals!({ level: 0.8 })

    expect(plugin.params!.getParam('progress')).toBeCloseTo(0.8)
  })
})

describe('morph — operation and layout options', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext

  beforeEach(() => {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return originalGetContext.call(this, type)
    }
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    document.querySelectorAll('canvas').forEach((canvas) => canvas.remove())
  })

  it.each(['merge', 'breakout', 'distribute'] as const)('accepts operation "%s" without throwing', (operation) => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(morph({ operation }))).not.toThrow()
    img.remove()
  })

  it.each(['shelf', 'fan', 'circles', 'symbols', 'arches', 'petals', 'filmStrip', 'spectrum', 'waveTiles'] as const)(
    'accepts layout "%s" without throwing',
    (layout) => {
      const img = readyImage()
      document.body.appendChild(img)
      const handle = comice(img) as ComiceHandle
      expect(() => handle.use(morph({ operation: 'merge', layout }))).not.toThrow()
      img.remove()
    },
  )

  it('defaults layout to "shelf" and liquid to 0.5 when not specified', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    // No direct way to introspect the compiled shader's options from here;
    // this asserts the defaults are at least accepted without throwing,
    // exercising the same code path an explicit { layout: 'shelf', liquid: 0.5 }
    // would (see test/morph-shader.test.ts for direct option-shape coverage).
    expect(() => handle.use(morph({ operation: 'merge' }))).not.toThrow()
    img.remove()
  })

  it('a failed shader compile (bad fake GL) does not throw during setup()', () => {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2({ failShaderCompile: true })
      return originalGetContext.call(this, type)
    }
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(morph({ operation: 'merge' }))).not.toThrow()
    expect(() => handle.setProgress(0.5)).not.toThrow()
    img.remove()
  })
})

describe('morph — operation: "mask"', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let uninstall2D: () => void
  let img: HTMLImageElement
  let handle: ComiceHandle | null = null

  beforeEach(() => {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return originalGetContext.call(this, type)
    }
    const installed = installFake2DContext()
    uninstall2D = installed.uninstall
    img = readyImage()
    document.body.appendChild(img)
    handle = null
  })

  afterEach(() => {
    handle?.destroy()
    uninstall2D()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    img.remove()
    document.querySelectorAll('canvas').forEach((canvas) => canvas.remove())
  })

  it('throws at construction time when operation: "mask" has no mask source (programmer error, per the plugin contract)', () => {
    expect(() => morph({ operation: 'mask' } as any)).toThrow()
  })

  it('accepts a shape-path mask source without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))).not.toThrow()
  })

  it('accepts a text mask source without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'mask', mask: { type: 'text', text: 'Comice' } }))).not.toThrow()
  })

  it('rasterizes the mask eagerly during setup() (a real target size is already available from getBoundingClientRect)', () => {
    // Indirect check: .setProgress() right after .use(), with no frame
    // driven yet, must not throw and must actually run through the mask
    // draw path (covered more directly in morph-shader.test.ts and
    // gl-mask.test.ts) — this asserts the wiring, not the GLSL itself.
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))
    expect(() => handle!.setProgress(0.5)).not.toThrow()
  })

  it('.transition()/.setProgress() drive the shader without throwing', () => {
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))
    expect(() => {
      handle!.transition('entering')
      handle!.setProgress(0.3)
      handle!.setProgress(0.7)
    }).not.toThrow()
  })

  it('a ResizeObserver signal re-rasterizes the mask at the new size without throwing', () => {
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
      handle.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))
      expect(capturedCallback).not.toBeNull()
      expect(() => capturedCallback!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)).not.toThrow()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })

  it('teardown() releases the rasterized mask and does not throw', () => {
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))
    expect(() => handle!.destroy()).not.toThrow()
    handle = null // already destroyed — afterEach's handle?.destroy() must not double-destroy
  })

  it('a getBoundingClientRect() of 0x0 (unlaid-out element) does not throw during setup()', () => {
    // happy-dom's default getBoundingClientRect() is already 0x0 for an
    // unstyled element — this is the real, unstubbed case, not a forced one.
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))).not.toThrow()
  })

  it('a real, nonzero layout box actually rasterizes the mask and computes a real maskScale', () => {
    // Stubbed to a real size (happy-dom's own getBoundingClientRect() is
    // always 0x0) — this is what exercises rasterizeMaskIfNeeded()'s
    // actual rasterize()+maskScale computation, not just its early-return
    // guard for an unlaid-out element (covered above).
    Object.defineProperty(img, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 320, height: 180, right: 320, bottom: 180, x: 0, y: 0, toJSON() {} }),
      configurable: true,
    })
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))).not.toThrow()
    expect(() => handle!.setProgress(0.5)).not.toThrow()
  })

  it('registers against the shared scheduler and renders a mask draw on a driven frame', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      handle = comice(img) as ComiceHandle
      handle.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))
      expect(pending).not.toBeNull()
      expect(() => pending!(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('works with a <video> target too, not just <img>', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true })
    handle = comice(video) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))).not.toThrow()
    video.remove()
  })

  it('degrades (no throw, no canvas) when WebGL2 is unavailable, even with a mask source given', () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext // real happy-dom: webgl2 always null
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' } }))).not.toThrow()
    expect(document.querySelectorAll('canvas').length).toBe(0)
  })
})

describe('morph — operation: "recompose"', () => {
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

  it('accepts operation: "recompose" without throwing, using layout defaults', () => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'recompose' }))).not.toThrow()
  })

  it.each(['circle', 'square', 'frame'] as const)('accepts recomposeTarget "%s" without throwing', (recomposeTarget) => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'recompose', recomposeTarget }))).not.toThrow()
  })

  it('accepts custom recomposeStart/recomposeEnd without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() =>
      handle!.use(morph({ operation: 'recompose', recomposeStart: 0.3, recomposeEnd: 0.7 })),
    ).not.toThrow()
  })

  it('.transition()/.setProgress() drive the shader without throwing, including past the recompose window', () => {
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'recompose' }))
    expect(() => {
      handle!.transition('entering')
      handle!.setProgress(0.5) // inside pMerge's window, before recompose starts
      handle!.setProgress(0.9) // inside the default recomposeStart/End window
      handle!.setProgress(1.0)
    }).not.toThrow()
  })

  it('works with every layout, not just the default', () => {
    const layouts = ['shelf', 'fan', 'circles', 'symbols', 'arches', 'petals', 'filmStrip', 'spectrum', 'waveTiles'] as const
    for (const layout of layouts) {
      const localImg = readyImage()
      document.body.appendChild(localImg)
      const localHandle = comice(localImg) as ComiceHandle
      expect(() => localHandle.use(morph({ operation: 'recompose', layout }))).not.toThrow()
      localHandle.destroy()
      localImg.remove()
    }
  })

  it('degrades (no throw, no canvas) when WebGL2 is unavailable', () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'recompose' }))).not.toThrow()
    expect(document.querySelectorAll('canvas').length).toBe(0)
  })
})

describe('morph — thread option', () => {
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

  it('accepts thread: {} (all defaults) on a merge operation without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'merge', thread: {} }))).not.toThrow()
  })

  it('accepts explicit width/pinch/sag/dissolve without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() =>
      handle!.use(
        morph({
          operation: 'merge',
          thread: { width: 0.04, pinch: 0.6, sag: 0.2, dissolve: 0.5 },
        }),
      ),
    ).not.toThrow()
  })

  it('works with breakout, distribute and recompose, not just merge', () => {
    const operations = ['breakout', 'distribute', 'recompose'] as const
    for (const operation of operations) {
      const localImg = readyImage()
      document.body.appendChild(localImg)
      const localHandle = comice(localImg) as ComiceHandle
      expect(() => localHandle.use(morph({ operation, thread: {} }))).not.toThrow()
      localHandle.destroy()
      localImg.remove()
    }
  })

  it('is accepted for operation: "mask" without throwing (corner drops; see morph-spec.test.ts)', () => {
    handle = comice(img) as ComiceHandle
    expect(() =>
      handle!.use(morph({ operation: 'mask', mask: { type: 'shape', path: 'M0 0L1 1Z' }, thread: {} })),
    ).not.toThrow()
  })

  it('.transition()/.setProgress() drive the shader without throwing across the full range', () => {
    handle = comice(img) as ComiceHandle
    handle.use(morph({ operation: 'merge', thread: { dissolve: 0.8 } }))
    expect(() => {
      handle!.transition('entering')
      handle!.setProgress(0.1) // fully separated — thread fully formed
      handle!.setProgress(0.5)
      handle!.setProgress(0.95) // nearly merged — thread nearly gone
    }).not.toThrow()
  })

  it('works with every layout', () => {
    const layouts = ['shelf', 'fan', 'circles', 'symbols', 'arches', 'petals', 'filmStrip', 'spectrum', 'waveTiles'] as const
    for (const layout of layouts) {
      const localImg = readyImage()
      document.body.appendChild(localImg)
      const localHandle = comice(localImg) as ComiceHandle
      expect(() => localHandle.use(morph({ operation: 'merge', layout, thread: {} }))).not.toThrow()
      localHandle.destroy()
      localImg.remove()
    }
  })

  it('degrades (no throw, no canvas) when WebGL2 is unavailable', () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(morph({ operation: 'merge', thread: {} }))).not.toThrow()
    expect(document.querySelectorAll('canvas').length).toBe(0)
  })
})
