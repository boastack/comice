/**
 * test/layout.test — packages/layout/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure CSS/DOM, no GL, no scheduler.
 */

import { describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from '../packages/core/src/index.js'
import { layout } from '../packages/layout/src/index.js'

function readyImage(): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true })
  return img
}

describe('layout — construction contract', () => {
  it("throws for mode 'anchor' with no target selector", () => {
    expect(() => layout({ mode: 'anchor' })).toThrow()
  })

  it("does not throw for mode 'wrap'/'avoid' with no target selector", () => {
    expect(() => layout({ mode: 'wrap' })).not.toThrow()
    expect(() => layout({ mode: 'avoid' })).not.toThrow()
  })
})

describe('layout — target contract', () => {
  it('throws for a non-media target', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(layout({ mode: 'wrap' }))).toThrow()
    div.remove()
  })

  it('accepts an <img> media target without throwing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(layout({ mode: 'wrap' }))).not.toThrow()
    img.remove()
  })

  it("throws for mode 'anchor' when the target selector matches nothing", () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(layout({ mode: 'anchor', target: '#does-not-exist' }))).toThrow()
    img.remove()
  })
})

describe('layout — mode: wrap', () => {
  it('sets float and shape-outside on the media element', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(layout({ mode: 'wrap', float: 'left' }))
    expect(img.style.float).toBe('left')
    expect(img.style.shapeOutside).not.toBe('')
    img.remove()
  })

  it("shape: 'rect' uses an inset() shape-outside", () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(layout({ mode: 'wrap', shape: 'rect', margin: 10 }))
    expect(img.style.shapeOutside).toContain('inset(')
    img.remove()
  })

  it("shape: 'ellipse' (default) sets both shape-outside and clip-path", () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(layout({ mode: 'wrap' }))
    // Exact value, not toContain('ellipse('): happy-dom accepts any string
    // here, so a substring check passed while real Chromium rejected the old
    // single-radius `ellipse(closest-side)` outright (CSS.supports -> false)
    // and silently dropped both properties. Two radii is the valid form.
    expect(img.style.shapeOutside).toBe('ellipse(closest-side closest-side)')
    expect(img.style.clipPath).toBe('ellipse(closest-side closest-side)')
    img.remove()
  })

  it('respects a custom margin via shape-margin', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(layout({ mode: 'wrap', margin: 24 }))
    expect(img.style.shapeMargin).toBe('24px')
    img.remove()
  })

  it('restores original styles on teardown', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(layout({ mode: 'wrap' }))
    handle.destroy()
    expect(img.style.float).toBe('')
    expect(img.style.shapeOutside).toBe('')
    img.remove()
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
      const img = readyImage()
      document.body.appendChild(img)
      const handle = comice(img) as ComiceHandle
      handle.use(layout({ mode: 'wrap' }))
      expect(capturedCallback).not.toBeNull()
      expect(() => capturedCallback!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)).not.toThrow()
      img.remove()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})

describe('layout — mode: avoid', () => {
  it("floats to the right side when float: 'right'", () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(layout({ mode: 'avoid', float: 'right' }))
    expect(img.style.float).toBe('right')
    img.remove()
  })
})

describe('layout — mode: anchor', () => {
  it('positions the target element absolutely relative to the media', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const caption = document.createElement('div')
    caption.id = 'caption'
    document.body.appendChild(caption)

    const handle = comice(img) as ComiceHandle
    handle.use(layout({ mode: 'anchor', target: '#caption', edge: 'bottom', offset: 12 }))

    expect(caption.style.position).toBe('absolute')
    img.remove()
    caption.remove()
  })

  it.each(['top', 'bottom', 'left', 'right'] as const)('positions correctly for edge "%s" without throwing', (edge) => {
    const img = readyImage()
    document.body.appendChild(img)
    const caption = document.createElement('div')
    caption.id = 'caption2'
    document.body.appendChild(caption)

    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(layout({ mode: 'anchor', target: '#caption2', edge }))).not.toThrow()

    img.remove()
    caption.remove()
  })

  it('sets parent to position: relative if it was static', () => {
    const wrapper = document.createElement('div')
    wrapper.style.position = 'static'
    document.body.appendChild(wrapper)
    const img = readyImage()
    wrapper.appendChild(img)
    const caption = document.createElement('div')
    caption.id = 'caption3'
    document.body.appendChild(caption)

    const handle = comice(img) as ComiceHandle
    handle.use(layout({ mode: 'anchor', target: '#caption3' }))

    expect(wrapper.style.position).toBe('relative')
    wrapper.remove()
    caption.remove()
  })

  it('restores the anchored element style on teardown', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const caption = document.createElement('div')
    caption.id = 'caption4'
    caption.style.position = 'static'
    document.body.appendChild(caption)

    const handle = comice(img) as ComiceHandle
    handle.use(layout({ mode: 'anchor', target: '#caption4' }))
    handle.destroy()

    expect(caption.style.position).toBe('static')
    img.remove()
    caption.remove()
  })

  it('a ResizeObserver signal recomputes the anchor position without throwing', () => {
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
      const img = readyImage()
      document.body.appendChild(img)
      const caption = document.createElement('div')
      caption.id = 'caption5'
      document.body.appendChild(caption)

      const handle = comice(img) as ComiceHandle
      handle.use(layout({ mode: 'anchor', target: '#caption5' }))
      expect(() => capturedCallback!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)).not.toThrow()

      img.remove()
      caption.remove()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
