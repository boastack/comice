/**
 * test/aura.test — packages/aura/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom plus test/fake-webgl2.ts. Imports core by
 * package name, matching every GL plugin package's test file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { aura } from '../packages/aura/src/index.js'
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

describe('aura — target contract', () => {
  it('throws for a non-media target', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(aura())).toThrow()
    div.remove()
  })

  it('accepts an <img> target without throwing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(aura())).not.toThrow()
    img.remove()
  })

  it('accepts a <video> target without throwing', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    const handle = comice(video) as ComiceHandle
    expect(() => handle.use(aura())).not.toThrow()
    video.remove()
  })
})

describe('aura — never hides or replaces the target', () => {
  it('leaves the target visible and inserts no visible canvas over it', () => {
    const img = readyImage()
    img.style.visibility = ''
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(aura())
    expect(img.style.visibility).toBe('')
    img.remove()
  })
})

describe('aura — no WebGL2 available', () => {
  it('setup()/teardown() do not throw with no GL context', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(aura())).not.toThrow()
    expect(() => handle.destroy()).not.toThrow()
    img.remove()
  })
})

describe('aura — with a real WebGL2 context (faked)', () => {
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
    // Sweep any glow <div> left behind by a test whose handle wasn't
    // captured/destroyed cleanly — same defensive cleanup
    // test/color.test.ts's own afterEach applies to stray <canvas>
    // elements for GL plugins that DO insert one.
    document.body.querySelectorAll('div').forEach((el) => el.remove())
  })

  it("sample: 'edges' (default) does not throw across a driven frame", () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura())
      expect(pending).not.toBeNull()
      expect(() => pending!(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it("sample: 'palette' does not throw across a driven frame", () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura({ sample: 'palette', colors: 3 }))
      pending!(16)
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('writes a --aura-color CSS variable for sample: edges', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura({ sample: 'edges' }))
      pending!(16)
      expect(img.style.getPropertyValue('--aura-color')).not.toBe('')
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('cssVariables: false does not write any CSS custom property', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura({ cssVariables: false }))
      pending!(16)
      expect(img.style.getPropertyValue('--aura-color')).toBe('')
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('glow: true inserts a glow element before the target', () => {
    handle = comice(img) as ComiceHandle
    handle.use(aura({ glow: true }))
    expect(img.previousElementSibling).not.toBeNull()
  })

  it('glow: true sets the parent to position: relative if it was static', () => {
    const parent = img.parentElement!
    parent.style.position = 'static'
    handle = comice(img) as ComiceHandle
    handle.use(aura({ glow: true }))
    expect(parent.style.position).toBe('relative')
  })

  it('glow: false inserts no glow element', () => {
    handle = comice(img) as ComiceHandle
    handle.use(aura({ glow: false }))
    expect(img.previousElementSibling).toBeNull()
  })

  it('onSample fires with the current sample data', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    const samples: unknown[] = []
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura({ onSample: (colors) => samples.push(colors) }))
      pending!(16)
      expect(samples.length).toBeGreaterThan(0)
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('clamps against a real ancestor background-color (rgb) set via inline style', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    document.body.style.backgroundColor = 'rgb(255, 255, 255)'
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura())
      expect(() => pending!(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
      document.body.style.backgroundColor = ''
    }
  })

  it('clamps against a real ancestor background-color (rgba) with nonzero alpha', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    document.body.style.backgroundColor = 'rgba(20, 20, 20, 0.8)'
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura())
      expect(() => pending!(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
      document.body.style.backgroundColor = ''
    }
  })

  it('walks past a fully-transparent ancestor background to find one further up', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    img.style.backgroundColor = 'rgba(0, 0, 0, 0)' // fully transparent -> must be skipped, not treated as opaque black
    document.body.style.backgroundColor = 'rgb(240, 240, 240)'
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura())
      expect(() => pending!(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
      document.body.style.backgroundColor = ''
      img.style.backgroundColor = ''
    }
  })

  it('contrast: false skips contrast clamping without throwing', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura({ contrast: false }))
      expect(() => pending!(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('respects a custom sampleIntervalMs, skipping frames faster than the interval', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    const queued: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued.push(cb)
      return queued.length
    }) as typeof requestAnimationFrame
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura({ sampleIntervalMs: 1000 }))
      expect(() => {
        queued.shift()?.(16)
        queued.shift()?.(32) // well under 1000ms since the first sample -> should be a no-op internally, not a throw
      }).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('teardown removes the offscreen canvas, glow element, and CSS variables', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      handle = comice(img) as ComiceHandle
      handle.use(aura())
      pending!(16)
      expect(img.previousElementSibling).not.toBeNull()

      handle.destroy()
      handle = null
      expect(img.previousElementSibling).toBeNull()
      expect(img.style.getPropertyValue('--aura-color')).toBe('')
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
      handle.use(aura())
      img.remove()
      expect(() => pending?.(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })
})
