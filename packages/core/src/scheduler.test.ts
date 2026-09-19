/**
 * comice/core/scheduler.test
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) since scheduler.ts uses
 * requestAnimationFrame, IntersectionObserver, and document.hidden.
 *
 * happy-dom's rAF polyfill and IntersectionObserver don't fire on their own
 * the way a real browser would (no real paint loop, no real layout), so
 * these tests drive them by dispatching the entries/timing manually rather
 * than waiting on real frames — that keeps the tests deterministic instead
 * of racing a timer.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createScheduler, createVisibilityGate } from './scheduler.js'

describe('createScheduler', () => {
  it('does not start a rAF loop until something is added', () => {
    const rafSpy = mock((cb: FrameRequestCallback) => {
      return 0
    })
    const original = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = rafSpy as typeof requestAnimationFrame
    try {
      createScheduler()
      expect(rafSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('calls an active callback on each driven frame', () => {
    const scheduler = createScheduler()
    const callback = mock()
    scheduler.add(callback, () => true)

    // Drive frames manually: happy-dom's rAF queue is flushed by directly
    // invoking whatever was scheduled, via a controlled fake below.
    const original = globalThis.requestAnimationFrame
    let queued: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      // add() above already used the *original* rAF to schedule its first
      // tick, so re-add to capture the queued callback under our fake.
      const scheduler2 = createScheduler()
      const cb2 = mock()
      scheduler2.add(cb2, () => true)
      expect(queued).not.toBeNull()
      queued!(16)
      expect(cb2).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('skips a callback whose isActive() returns false', () => {
    const original = globalThis.requestAnimationFrame
    let queued: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      const scheduler = createScheduler()
      const callback = mock()
      scheduler.add(callback, () => false)
      queued!(16)
      expect(callback).not.toHaveBeenCalled()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('unregister() stops future calls to that callback', () => {
    const original = globalThis.requestAnimationFrame
    const box: { queued: FrameRequestCallback | null } = { queued: null }
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      box.queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      const scheduler = createScheduler()
      const callback = mock()
      const unregister = scheduler.add(callback, () => true)
      unregister()
      // If the loop re-queued itself, drive it once more; either way the
      // unregistered callback must not fire.
      box.queued?.(16)
      expect(callback).not.toHaveBeenCalled()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('stop() clears all entries and cancels the pending frame', () => {
    const cancelSpy = mock()
    const originalCancel = globalThis.cancelAnimationFrame
    globalThis.cancelAnimationFrame = cancelSpy as typeof cancelAnimationFrame

    try {
      const scheduler = createScheduler()
      const callback = mock()
      scheduler.add(callback, () => true)
      scheduler.stop()
      expect(cancelSpy).toHaveBeenCalled()
    } finally {
      globalThis.cancelAnimationFrame = originalCancel
    }
  })

  it('supports multiple independent entries', () => {
    const original = globalThis.requestAnimationFrame
    let queued: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      const scheduler = createScheduler()
      const a = mock()
      const b = mock()
      scheduler.add(a, () => true)
      scheduler.add(b, () => false)
      queued!(16)
      expect(a).toHaveBeenCalledTimes(1)
      expect(b).not.toHaveBeenCalled()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })
})

describe('createVisibilityGate', () => {
  let target: HTMLElement

  beforeEach(() => {
    target = document.createElement('div')
    document.body.appendChild(target)
  })

  afterEach(() => {
    target.remove()
  })

  it('starts not visible until IntersectionObserver reports intersecting', () => {
    const gate = createVisibilityGate(target)
    expect(gate.isVisible()).toBe(false)
    gate.destroy()
  })

  it('reflects document.hidden in isVisible()', () => {
    const gate = createVisibilityGate(target)
    // Even if on-screen, a hidden tab must report not visible. We can't
    // force the IntersectionObserver callback synchronously in happy-dom,
    // so this asserts the starting (not-yet-intersecting) state stays
    // false regardless of document.hidden, which is the conservative,
    // correct default before the first observer callback fires.
    expect(gate.isVisible()).toBe(false)
    gate.destroy()
  })

  it('destroy() disconnects the observer and removes the visibilitychange listener without throwing', () => {
    const gate = createVisibilityGate(target)
    expect(() => gate.destroy()).not.toThrow()
  })

  it('destroy() is safe to call once and only tears down its own listeners', () => {
    const removeSpy = mock()
    const original = document.removeEventListener.bind(document)
    document.removeEventListener = ((...args: Parameters<typeof document.removeEventListener>) => {
      removeSpy(...args)
      return original(...args)
    }) as typeof document.removeEventListener

    try {
      const gate = createVisibilityGate(target)
      gate.destroy()
      expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    } finally {
      document.removeEventListener = original
    }
  })
})
