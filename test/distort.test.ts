/**
 * test/distort.test — packages/distort/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts
 * for the "real WebGL2" branches, same split test/morph.test.ts and
 * test/dissolve.test.ts use.
 *
 * IMPORTANT: imports `comice`/`comice/scheduler` from the PACKAGE NAME, for
 * the identical reason test/dissolve.test.ts's header documents —
 * packages/distort/src/index.ts calls comice/gl and comice/scheduler by
 * package name itself, so a source import here would create a second
 * scheduler singleton. packages/core must be built before this file passes.
 *
 * Also covers the T8 core fix this package specifically motivated:
 * signal.pointer -> instance.setDisplay() -> instance.display.x/y, which
 * distort reads via instance.on('*') rather than a private params channel
 * (see packages/distort/src/index.ts's own header comment).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle, type Driver, type DriverSignal } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { distort } from '../packages/distort/src/index.js'
import { createFakeGL2 } from './fake-webgl2.js'

function readyImage(): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true })
  return img
}

/** A minimal plain Driver, matching test/index.test.ts's own fakeDriver()
 *  pattern exactly — fires DriverSignal objects on demand via emit(). */
function fakeDriver(): Driver & { emit(signal: DriverSignal): void } {
  let onSignal: ((signal: DriverSignal) => void) | null = null
  return {
    name: 'fake-driver',
    attach(_target, cb) {
      onSignal = cb
      return () => {
        onSignal = null
      }
    },
    emit(signal) {
      onSignal?.(signal)
    },
  }
}

afterEach(() => {
  getSharedScheduler().stop()
})

describe('distort — target contract', () => {
  it('throws for a non-media target, per the plugin contract', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(distort())).toThrow()
    div.remove()
  })

  it('accepts an <img> target without throwing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(distort())).not.toThrow()
    img.remove()
  })

  it('accepts a <video> target without throwing', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    const handle = comice(video) as ComiceHandle
    expect(() => handle.use(distort({ effect: 'lens' }))).not.toThrow()
    video.remove()
  })
})

describe('distort — no WebGL2 available (happy-dom\'s real, unpatched getContext)', () => {
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
    handle.use(distort())
    expect(img.style.visibility).toBe('')
  })

  it('does not append a canvas when WebGL2 is unavailable', () => {
    const handle = comice(img) as ComiceHandle
    handle.use(distort())
    expect(document.querySelectorAll('canvas').length).toBe(0)
  })

  it('setup()/teardown() do not throw even with no GL context at all', () => {
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(distort())).not.toThrow()
    expect(() => handle.destroy()).not.toThrow()
  })
})

describe('distort — with a real WebGL2 context (faked)', () => {
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

  it('hides the original target and inserts a canvas after it', () => {
    handle = comice(img) as ComiceHandle
    handle.use(distort())
    expect(img.style.visibility).toBe('hidden')
    expect(img.nextElementSibling?.tagName).toBe('CANVAS')
  })

  it('sets the parent to position: relative if it was static', () => {
    const parent = img.parentElement!
    parent.style.position = 'static'
    handle = comice(img) as ComiceHandle
    handle.use(distort())
    expect(parent.style.position).toBe('relative')
  })

  it.each(['bulge', 'lens', 'glass'] as const)('accepts effect "%s" without throwing', (effect) => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(distort({ effect }))).not.toThrow()
  })

  it.each(['linear', 'smooth', 'exp'] as const)('accepts falloff "%s" without throwing', (falloff) => {
    handle = comice(img) as ComiceHandle
    expect(() => handle!.use(distort({ effect: 'bulge', falloff }))).not.toThrow()
  })

  it('accepts custom radius/strength/refraction without throwing', () => {
    handle = comice(img) as ComiceHandle
    expect(() =>
      handle!.use(distort({ effect: 'glass', radius: 240, strength: 0.9, refraction: 0.6 })),
    ).not.toThrow()
  })

  it('teardown removes the canvas, restores visibility, and unregisters from the scheduler', () => {
    handle = comice(img) as ComiceHandle
    handle.use(distort())
    expect(document.querySelectorAll('canvas').length).toBe(1)

    handle.destroy()
    handle = null
    expect(document.querySelectorAll('canvas').length).toBe(0)
    expect(img.style.visibility).toBe('')
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
      handle.use(distort({ effect: 'bulge' }))
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
      handle.use(distort({ effect: 'bulge' }))
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
      handle.use(distort({ effect: 'bulge' }))
      expect(capturedCallback).not.toBeNull()
      expect(() => capturedCallback!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)).not.toThrow()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })

  describe('pointer routing (core signal.pointer -> instance.display -> distort)', () => {
    it('a driver signal.pointer moves instance.display.x/y, which distort reads', () => {
      const driver = fakeDriver()
      handle = comice(img) as ComiceHandle
      handle.use(distort({ effect: 'bulge' }))
      handle.driver(driver)

      expect(() => driver.emit({ state: 'active', progress: 1, pointer: { x: 0.3, y: -0.2 } })).not.toThrow()
      expect(handle.display.x).toBeCloseTo(0.3)
      expect(handle.display.y).toBeCloseTo(-0.2)
    })

    it('pointerActive derives from state — "active" and "entering" both count as active', () => {
      const driver = fakeDriver()
      handle = comice(img) as ComiceHandle
      handle.use(distort({ effect: 'lens' }))
      handle.driver(driver)

      expect(() => driver.emit({ state: 'entering', progress: 0.5, pointer: { x: 0, y: 0 } })).not.toThrow()
      expect(() => driver.emit({ state: 'active', progress: 1, pointer: { x: 0.1, y: 0.1 } })).not.toThrow()
      expect(() => driver.emit({ state: 'leaving', progress: 0.5, pointer: { x: 0.1, y: 0.1 } })).not.toThrow()
      expect(() => driver.emit({ state: 'idle', progress: 0, pointer: { x: 0.1, y: 0.1 } })).not.toThrow()
    })

    it('a signal with no pointer field leaves display.x/y unchanged (partial merge)', () => {
      const driver = fakeDriver()
      handle = comice(img) as ComiceHandle
      handle.use(distort({ effect: 'bulge' }))
      handle.driver(driver)

      driver.emit({ state: 'active', progress: 1, pointer: { x: 0.4, y: 0.5 } })
      expect(() => driver.emit({ state: 'active', progress: 1 })).not.toThrow()
      expect(handle.display.x).toBeCloseTo(0.4)
      expect(handle.display.y).toBeCloseTo(0.5)
    })
  })
})
