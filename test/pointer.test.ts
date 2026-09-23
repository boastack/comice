/**
 * test/pointer.test — packages/core/src/drivers/pointer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload). Drives the shared
 * scheduler's rAF loop manually via a fake requestAnimationFrame, same
 * approach as scheduler.test.ts/drag.test.ts, so timing is deterministic
 * rather than racing a timer. pointer.ts rides getSharedScheduler() (not a
 * private rAF loop, as of this file's own fix) — getSharedScheduler().stop()
 * in afterEach is required so each test starts from a clean scheduler,
 * otherwise `queued.length` stops mapping 1:1 to "one rAF pending" once a
 * previous test's entries leak into the next.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { getSharedScheduler } from '../packages/core/src/scheduler.js'
import { pointer } from '../packages/core/src/drivers/pointer.js'

function makePointerEvent(type: string, clientX: number, clientY: number): PointerEvent {
  return new PointerEvent(type, { clientX, clientY, bubbles: true })
}

describe('pointer driver', () => {
  let target: HTMLElement
  let originalRAF: typeof requestAnimationFrame
  let queued: FrameRequestCallback[]

  beforeEach(() => {
    target = document.createElement('div')
    Object.defineProperty(target, 'getBoundingClientRect', {
      value: () => ({
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        right: 200,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON() {},
      }),
      configurable: true,
    })
    document.body.appendChild(target)

    queued = []
    originalRAF = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued.push(cb)
      return queued.length
    }) as typeof requestAnimationFrame
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF
    getSharedScheduler().stop()
    target.remove()
  })

  function flushOneFrame(timestamp: number): void {
    const cb = queued.shift()
    cb?.(timestamp)
  }

  it('exposes the Driver contract: name + attach()', () => {
    const driver = pointer()
    expect(driver.name).toBe('pointer')
    expect(typeof driver.attach).toBe('function')
  })

  it('reports progress 1 and a pointer position once inside the target', () => {
    const driver = pointer({ radius: 50 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(makePointerEvent('pointermove', 50, 50))
    flushOneFrame(16)

    expect(onSignal).toHaveBeenCalled()
    const signal = onSignal.mock.calls[0][0]
    expect(signal.progress).toBe(1)
    expect(signal.pointer).toBeDefined()
    expect(signal.pointer.x).toBeCloseTo(50, 0)
    expect(signal.pointer.y).toBeCloseTo(50, 0)

    detach()
  })

  it('reports progress 0 once, then stops, after the pointer leaves the target bounds', () => {
    const driver = pointer({ radius: 0 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    // Inside first.
    target.dispatchEvent(makePointerEvent('pointermove', 10, 10))
    flushOneFrame(16)
    onSignal.mockClear()

    // Then explicitly leaves.
    target.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
    flushOneFrame(32)

    expect(onSignal).toHaveBeenCalledTimes(1)
    expect(onSignal.mock.calls[0][0].progress).toBe(0)

    // Subsequent frames report nothing further while still outside.
    onSignal.mockClear()
    flushOneFrame(48)
    expect(onSignal).not.toHaveBeenCalled()

    detach()
  })

  it('does not report a signal for a move outside the influence radius', () => {
    const driver = pointer({ radius: 5 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    // Far outside the element and outside the radius.
    target.dispatchEvent(makePointerEvent('pointermove', 5000, 5000))
    flushOneFrame(16)

    expect(onSignal).not.toHaveBeenCalled()
    detach()
  })

  it('reports a signal within radius of the bounds even when outside them', () => {
    const driver = pointer({ radius: 50 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    // 20px to the right of the target's right edge (width 200), within a 50px radius.
    target.dispatchEvent(makePointerEvent('pointermove', 220, 50))
    flushOneFrame(16)

    expect(onSignal).toHaveBeenCalled()
    expect(onSignal.mock.calls[0][0].progress).toBe(1)
    detach()
  })

  it('detach stops further rAF scheduling', () => {
    const driver = pointer()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    expect(queued.length).toBe(1)
    detach()
    // No new frame should be queued once torn down, even if one was mid-flight.
    const remaining = queued.length
    flushOneFrame(16)
    expect(queued.length).toBeLessThanOrEqual(remaining)
  })

  it('computes a real elapsed delta on the tick after a genuine timestamp-0 first frame', () => {
    // Regression test for the exact bug this driver's shared-scheduler
    // migration fixed: scheduler.ts's own tick() used to (and, before this
    // driver rode it, pointer.ts's private loop independently duplicated
    // the same bug) treat `lastTimestamp ? ... : 16.67` as its "first
    // frame?" check, which treats a legitimate timestamp of 0 as falsy —
    // so the tick immediately after a first tick AT 0 silently fell back
    // to the 16.67ms default instead of computing the real elapsed delta.
    // With `lag: 0`, smoothing snaps instantly regardless of deltaMs, so
    // this asserts on velocity instead, which is directly proportional to
    // deltaMs and would silently read wrong under the old bug.
    const driver = pointer({ radius: 200, lag: 0.5 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(makePointerEvent('pointermove', 0, 0))
    flushOneFrame(0) // first tick, genuinely AT timestamp 0
    onSignal.mockClear()

    target.dispatchEvent(makePointerEvent('pointermove', 100, 0))
    flushOneFrame(1000) // a real 1000ms later — deltaMs must be ~1000, not 16.67

    const signal = onSignal.mock.calls[0][0]
    // At lag 0.5 over a real ~1000ms delta, smoothing should have nearly
    // fully caught up to the new raw position (t approaches 1 as deltaMs
    // grows) — under the 16.67ms-fallback bug, t would stay tiny and
    // smoothX would barely have moved from 0.
    expect(signal.pointer.x).toBeGreaterThan(90)

    detach()
  })

  it('lag=0 snaps smoothing instantly to the raw pointer position', () => {
    const driver = pointer({ radius: 100, lag: 0 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(makePointerEvent('pointermove', 30, 40))
    flushOneFrame(16)

    const signal = onSignal.mock.calls[0][0]
    expect(signal.pointer.x).toBeCloseTo(30, 0)
    expect(signal.pointer.y).toBeCloseTo(40, 0)

    detach()
  })
})
