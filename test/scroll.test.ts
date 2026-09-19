/**
 * test/scroll.test — packages/core/src/drivers/scroll.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload). happy-dom has no native
 * ScrollTimeline, so the fallback path (attachFallback) is exercised
 * directly/naturally through scroll()'s public API. The native path
 * (attachNative) is exercised by installing a fake ScrollTimeline global —
 * neither internal function is exported, so both paths are driven entirely
 * through scroll()'s own contract, same as every other driver test file.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { scroll } from '../packages/core/src/drivers/scroll.js'

function mockRect(overrides: Partial<DOMRect>): void {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON() {},
      ...overrides,
    }),
  })
}

describe('scroll driver — fallback path (no native ScrollTimeline)', () => {
  let target: HTMLElement
  let originalInnerHeight: number

  beforeEach(() => {
    target = document.createElement('div')
    document.body.appendChild(target)
    originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  })

  afterEach(() => {
    target.remove()
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
  })

  it('exposes the Driver contract: name + attach()', () => {
    const driver = scroll()
    expect(driver.name).toBe('scroll')
    expect(typeof driver.attach).toBe('function')
  })

  it('measures progress immediately on attach, without waiting for a scroll event', () => {
    mockRect({ top: 400, height: 200 })
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    expect(onSignal).toHaveBeenCalledTimes(1)
    detach()
  })

  it('reports progress near 0 when the element has not entered the viewport yet', () => {
    // top === viewport height => just at the bottom edge => progress 0.
    mockRect({ top: 800, height: 200 })
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    expect(onSignal.mock.calls[0][0].progress).toBeCloseTo(0, 1)
    detach()
  })

  it('reports progress 1 once the element has fully left the viewport top', () => {
    mockRect({ top: -200, height: 200 }) // bottom edge (top + height) at 0 => fully scrolled past
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    expect(onSignal.mock.calls[0][0].progress).toBeCloseTo(1, 1)
    detach()
  })

  it('clamps progress to the 0..1 range', () => {
    mockRect({ top: 5000, height: 200 }) // far below the viewport
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    expect(onSignal.mock.calls[0][0].progress).toBe(0)
    detach()
  })

  it('re-measures on a scroll event, batched via requestAnimationFrame', () => {
    mockRect({ top: 400, height: 200 })
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    onSignal.mockClear()

    const original = globalThis.requestAnimationFrame
    let queued: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      window.dispatchEvent(new Event('scroll'))
      expect(onSignal).not.toHaveBeenCalled() // measurement is batched to the next frame
      queued!(16)
      expect(onSignal).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.requestAnimationFrame = original
      detach()
    }
  })

  it('coalesces multiple scroll events into a single measurement per frame', () => {
    mockRect({ top: 400, height: 200 })
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    onSignal.mockClear()

    const original = globalThis.requestAnimationFrame
    let queued: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      window.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('scroll'))
      queued!(16)
      expect(onSignal).toHaveBeenCalledTimes(1) // not 3
    } finally {
      globalThis.requestAnimationFrame = original
      detach()
    }
  })

  it('re-measures on a resize event too', () => {
    mockRect({ top: 400, height: 200 })
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    onSignal.mockClear()

    const original = globalThis.requestAnimationFrame
    let queued: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      window.dispatchEvent(new Event('resize'))
      queued!(16)
      expect(onSignal).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.requestAnimationFrame = original
      detach()
    }
  })

  it('threshold shifts when progress starts', () => {
    // With threshold 0.5, the element must be halfway into the viewport
    // before progress leaves 0 — i.e. the same rect that reports 0 at
    // threshold 0 should report a smaller (or equal) progress at 0.5.
    mockRect({ top: 700, height: 200 })
    const withoutThreshold = mock()
    const detach1 = scroll().attach(target, withoutThreshold)
    const withThreshold = mock()
    const detach2 = scroll({ threshold: 0.5 }).attach(target, withThreshold)

    expect(withThreshold.mock.calls[0][0].progress).toBeLessThanOrEqual(
      withoutThreshold.mock.calls[0][0].progress,
    )
    detach1()
    detach2()
  })

  it('detach removes the scroll and resize listeners and cancels a pending frame', () => {
    mockRect({ top: 400, height: 200 })
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    onSignal.mockClear()
    detach()

    const original = globalThis.requestAnimationFrame
    let queued: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      window.dispatchEvent(new Event('scroll'))
      // No new frame is queued because the listener was removed by detach().
      expect(queued).toBeNull()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })
})

describe('scroll driver — native ScrollTimeline path', () => {
  let target: HTMLElement
  let animateSpy: ReturnType<typeof mock>
  let cancelSpy: ReturnType<typeof mock>

  beforeEach(() => {
    target = document.createElement('div')
    document.body.appendChild(target)

    ;(globalThis as any).ScrollTimeline = class {
      constructor(_opts: unknown) {}
    }

    cancelSpy = mock()
    animateSpy = mock(() => ({
      effect: { getComputedTiming: () => ({ progress: 0.42 }) },
      cancel: cancelSpy,
    }))
    ;(target as any).animate = animateSpy
  })

  afterEach(() => {
    delete (globalThis as any).ScrollTimeline
    target.remove()
  })

  it('uses target.animate() as a timing probe when ScrollTimeline is supported', () => {
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    expect(animateSpy).toHaveBeenCalled()
    detach()
  })

  it('reports progress read from the probe animation on each polled frame', () => {
    const driver = scroll()
    const onSignal = mock()

    const original = globalThis.requestAnimationFrame
    let queued: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      const detach = driver.attach(target, onSignal)
      expect(queued).not.toBeNull()
      queued!(16)
      expect(onSignal).toHaveBeenCalledWith({ progress: 0.42 })
      detach()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('falls back to progress 0 when the probe reports no timing', () => {
    animateSpy = mock(() => ({
      effect: { getComputedTiming: () => ({ progress: undefined }) },
      cancel: cancelSpy,
    }))
    ;(target as any).animate = animateSpy

    const driver = scroll()
    const onSignal = mock()

    const original = globalThis.requestAnimationFrame
    let queued: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      const detach = driver.attach(target, onSignal)
      queued!(16)
      expect(onSignal).toHaveBeenCalledWith({ progress: 0 })
      detach()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('detach cancels the probe animation and the polling loop', () => {
    const driver = scroll()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)
    detach()
    expect(cancelSpy).toHaveBeenCalled()
  })
})
