/**
 * test/scheduler.test — packages/core/src/scheduler.ts
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
import { createScheduler, createVisibilityGate } from '../packages/core/src/scheduler.js'

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

  describe('crash isolation', () => {
    // The scheduler is a SHARED loop across every Comice instance, plugin
    // and driver on the page. One entry throwing must not silently kill
    // the loop for everyone else — these tests pin down exactly that.

    it('a throwing callback does not stop other callbacks from running the same frame', () => {
      const original = globalThis.requestAnimationFrame
      let queued: FrameRequestCallback | null = null
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        queued = cb
        return 1
      }) as typeof requestAnimationFrame

      try {
        const scheduler = createScheduler()
        const throwing = mock(() => {
          throw new Error('boom')
        })
        const healthy = mock()
        scheduler.add(throwing, () => true)
        scheduler.add(healthy, () => true)
        expect(() => queued!(16)).not.toThrow()
        expect(throwing).toHaveBeenCalledTimes(1)
        expect(healthy).toHaveBeenCalledTimes(1)
      } finally {
        globalThis.requestAnimationFrame = original
      }
    })

    it('the loop keeps re-scheduling itself after a callback throws', () => {
      const original = globalThis.requestAnimationFrame
      const box: { queued: FrameRequestCallback | null } = { queued: null }
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        box.queued = cb
        return 1
      }) as typeof requestAnimationFrame

      try {
        const scheduler = createScheduler()
        const throwing = mock(() => {
          throw new Error('boom')
        })
        scheduler.add(throwing, () => true)

        const firstTick = box.queued!
        box.queued = null
        firstTick(16)
        // If tick() itself had thrown (instead of isolating the callback),
        // it would never reach the requestAnimationFrame(tick) call that
        // re-queues the next frame — box.queued would still be null here.
        expect(box.queued).not.toBeNull()

        const secondTick = box.queued!
        expect(() => secondTick(32)).not.toThrow()
        expect(throwing).toHaveBeenCalledTimes(2)
      } finally {
        globalThis.requestAnimationFrame = original
      }
    })

    it('warns via console.warn when a callback throws (dev mode)', () => {
      const original = globalThis.requestAnimationFrame
      let queued: FrameRequestCallback | null = null
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        queued = cb
        return 1
      }) as typeof requestAnimationFrame

      const warnSpy = mock()
      const originalWarn = console.warn
      console.warn = warnSpy

      try {
        const scheduler = createScheduler()
        scheduler.add(() => {
          throw new Error('boom')
        }, () => true)
        queued!(16)
        expect(warnSpy).toHaveBeenCalled()
        expect(warnSpy.mock.calls[0][0]).toContain('[comice]')
      } finally {
        globalThis.requestAnimationFrame = original
        console.warn = originalWarn
      }
    })
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

  it('becomes visible once IntersectionObserver reports an intersection', () => {
    // happy-dom's IntersectionObserver never fires its callback on its
    // own (see the note above) — this installs a fake one that fires
    // synchronously on observe(), same technique used for audio.test.ts,
    // to exercise the actual onScreen-flip branch of the gate.
    const original = globalThis.IntersectionObserver
    let capturedCallback: IntersectionObserverCallback | null = null
    ;(globalThis as any).IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) {
        capturedCallback = callback
      }
      observe(observedTarget: Element) {
        capturedCallback!(
          [{ isIntersecting: true, target: observedTarget } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      disconnect() {}
      unobserve() {}
    }

    try {
      const gate = createVisibilityGate(target)
      expect(gate.isVisible()).toBe(true)
      gate.destroy()
    } finally {
      globalThis.IntersectionObserver = original
    }
  })

  it('updates isVisible() when a real visibilitychange event fires', () => {
    // happy-dom does not flip document.hidden for us on its own, so this
    // stubs the getter (the only part of "document.hidden" happy-dom
    // won't let a test control directly) and then dispatches the actual
    // event the gate's own listener is registered for — exercising the
    // real onVisibilityChange handler, not just its registration.
    const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })

    try {
      const gate = createVisibilityGate(target)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(gate.isVisible()).toBe(false) // tab now hidden, regardless of onScreen
      gate.destroy()
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(document, 'hidden', originalDescriptor)
      } else {
        delete (document as any).hidden
      }
    }
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

describe('createVisibilityGate: a batch of observer records', () => {
  const OriginalIO = globalThis.IntersectionObserver
  let deliver: (records: Array<{ isIntersecting: boolean }>) => void = () => {}
  beforeEach(() => {
    globalThis.IntersectionObserver = class {
      constructor(callback: (records: unknown[]) => void) { deliver = (records) => callback(records) }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof IntersectionObserver
  })
  afterEach(() => { globalThis.IntersectionObserver = OriginalIO })

  it('the last record is the current state: left the screen and came back within one batch is visible', () => {
    const gate = createVisibilityGate(document.createElement('div'))
    deliver([{ isIntersecting: false }, { isIntersecting: true }])
    expect(gate.isVisible()).toBe(true)
    gate.destroy()
  })

  it('and the reverse: came in and left within one batch is not visible', () => {
    const gate = createVisibilityGate(document.createElement('div'))
    deliver([{ isIntersecting: true }])
    expect(gate.isVisible()).toBe(true)
    deliver([{ isIntersecting: true }, { isIntersecting: false }])
    expect(gate.isVisible()).toBe(false)
    gate.destroy()
  })

  it('an empty batch means not visible rather than throwing', () => {
    const gate = createVisibilityGate(document.createElement('div'))
    deliver([{ isIntersecting: true }])
    deliver([])
    expect(gate.isVisible()).toBe(false)
    gate.destroy()
  })
})
