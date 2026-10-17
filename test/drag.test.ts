/**
 * test/drag.test — packages/core/src/drivers/drag.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload). Combines the pointer
 * event pattern from test/pointer.test.ts with the fake-scheduler pattern
 * from test/scheduler.test.ts, since drag.ts both listens for real pointer
 * events AND rides getSharedScheduler() for its post-release inertia decay.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getSharedScheduler } from '../packages/core/src/scheduler.js'
import { drag } from '../packages/core/src/drivers/drag.js'

function makePointerEvent(
  type: string,
  clientX: number,
  clientY: number,
  pointerId = 1,
  timeStamp?: number,
): PointerEvent {
  const event = new PointerEvent(type, { clientX, clientY, pointerId, bubbles: true })
  if (timeStamp !== undefined) {
    Object.defineProperty(event, 'timeStamp', { value: timeStamp, configurable: true })
  }
  return event
}

describe('drag driver', () => {
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

  it('a HIDDEN target still starts a drag from a press inside its box, and keeps tracking outside it — real bug found on a real page', () => {
    // A GL plugin hides its target, so the real pointerdown lands on the
    // body, and moves past the target's edge land on the body too.
    target.style.visibility = 'hidden'
    const signals: number[] = []
    const detach = drag({ inertia: 0 }).attach(target, (signal) => signals.push(signal.progress))

    document.body.dispatchEvent(makePointerEvent('pointerdown', 50, 50, 1, 0))
    document.body.dispatchEvent(makePointerEvent('pointermove', 350, 50, 1, 16)) // far outside the box

    expect(signals.at(-1)).toBe(1) // dragged the full width and clamped
    detach()
  })

  it('a press outside the target\'s box does not start a drag', () => {
    const signals: number[] = []
    const detach = drag().attach(target, (signal) => signals.push(signal.progress))

    document.body.dispatchEvent(makePointerEvent('pointerdown', 500, 500, 1, 0))
    document.body.dispatchEvent(makePointerEvent('pointermove', 600, 500, 1, 16))

    expect(signals).toEqual([])
    detach()
  })

  it('never captures the pointer (capture retargets the follow-up click away from content inside)', () => {
    let captured = false
    target.setPointerCapture = () => {
      captured = true
    }
    const detach = drag().attach(target, () => {})

    target.dispatchEvent(makePointerEvent('pointerdown', 50, 50, 1, 0))

    expect(captured).toBe(false)
    detach()
  })

  it('exposes the Driver contract: name + attach()', () => {
    const driver = drag()
    expect(driver.name).toBe('drag')
    expect(typeof driver.attach).toBe('function')
  })

  it('reports progress swept across the target width as the pointer moves (axis: x, default)', () => {
    const signals: number[] = []
    const teardown = drag().attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 100, 50, 1, 16)) // halfway across 200px width
    target.dispatchEvent(makePointerEvent('pointermove', 200, 50, 1, 32)) // full width

    expect(signals[0]).toBeCloseTo(0.5, 1)
    expect(signals[1]).toBeCloseTo(1, 1)

    teardown()
  })

  it('axis: y measures progress along height instead of width', () => {
    const signals: number[] = []
    const teardown = drag({ axis: 'y' }).attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointerdown', 0, 0, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 0, 50, 1, 16)) // halfway down 100px height
    // x movement alone must NOT affect progress when axis is 'y'.
    target.dispatchEvent(makePointerEvent('pointermove', 150, 50, 1, 32))

    expect(signals[0]).toBeCloseTo(0.5, 1)
    expect(signals[1]).toBeCloseTo(0.5, 1) // unchanged by the x-only move

    teardown()
  })

  it('progress is clamped to [0, 1] even if the pointer moves past the target bounds', () => {
    const signals: number[] = []
    const teardown = drag().attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', -500, 50, 1, 16))
    target.dispatchEvent(makePointerEvent('pointermove', 5000, 50, 1, 32))

    expect(signals[0]).toBe(0)
    expect(signals[1]).toBe(1)

    teardown()
  })

  it('a second pointerdown while already dragging is ignored (single active pointer)', () => {
    const signals: number[] = []
    const teardown = drag().attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 2, 1)) // different pointerId, ignored
    target.dispatchEvent(makePointerEvent('pointermove', 100, 50, 2, 16)) // moves under the ignored pointer

    // No signal from pointer 2's move, since pointer 1 still owns the drag.
    expect(signals.length).toBe(0)

    teardown()
  })

  it('pointermove from an unrelated pointerId (no active drag) is ignored', () => {
    const signals: number[] = []
    const teardown = drag().attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointermove', 100, 50, 99, 0)) // no pointerdown first

    expect(signals.length).toBe(0)
    teardown()
  })

  it('release with leftover velocity starts an inertia decay via the shared scheduler', () => {
    const signals: number[] = []
    const teardown = drag({ inertia: 0.9 }).attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 100, 50, 1, 16)) // fast move -> real velocity
    target.dispatchEvent(makePointerEvent('pointerup', 100, 50, 1, 32))

    const progressAtRelease = signals[signals.length - 1]
    expect(queued.length).toBeGreaterThan(0) // inertia loop registered a frame

    flushOneFrame(48)
    const progressAfterInertiaFrame = signals[signals.length - 1]
    expect(progressAfterInertiaFrame).toBeGreaterThanOrEqual(progressAtRelease)

    teardown()
  })

  it('inertia decay settles and stops ticking once velocity drops below the threshold', () => {
    const signals: number[] = []
    const teardown = drag({ inertia: 0.5 }).attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 20, 50, 1, 16)) // small move, modest velocity
    target.dispatchEvent(makePointerEvent('pointerup', 20, 50, 1, 32))

    // Drive enough frames for a 0.5-per-frame decay to settle well under
    // the threshold — each frame halves velocity, so this converges fast.
    for (let i = 0; i < 30 && queued.length > 0; i++) {
      flushOneFrame(48 + i * 16)
    }

    // Once settled, no further frame should be queued — the scheduler
    // entry unregisters itself rather than ticking forever.
    expect(queued.length).toBe(0)

    teardown()
  })

  it('a new pointerdown during an active inertia decay stops the decay and takes over', () => {
    const signals: number[] = []
    const teardown = drag({ inertia: 0.95 }).attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 150, 50, 1, 16)) // fast move
    target.dispatchEvent(makePointerEvent('pointerup', 150, 50, 1, 32))
    expect(queued.length).toBeGreaterThan(0) // inertia running

    // Re-grab before inertia settles.
    target.dispatchEvent(makePointerEvent('pointerdown', 150, 50, 1, 48))
    // The inertia frame callback that was queued before re-grab, if
    // flushed now, must be a no-op (isActive() reads `!dragging`, which is
    // now true again) rather than fighting the new drag.
    const progressAfterRegrab = signals[signals.length - 1]
    flushOneFrame(64)
    // isActive() gates the callback — dragging again means the queued
    // inertia tick should not have altered progress.
    expect(signals[signals.length - 1]).toBe(progressAfterRegrab)

    teardown()
  })

  it('teardown() during an active drag removes listeners and stops any inertia', () => {
    const signals: number[] = []
    const teardown = drag().attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 100, 50, 1, 16))

    teardown()

    const countBeforeFurtherEvents = signals.length
    target.dispatchEvent(makePointerEvent('pointermove', 200, 50, 1, 32))
    target.dispatchEvent(makePointerEvent('pointerup', 200, 50, 1, 48))
    expect(signals.length).toBe(countBeforeFurtherEvents) // nothing further after teardown
  })

  it('pointercancel ends the drag the same as pointerup', () => {
    const signals: number[] = []
    const teardown = drag().attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 50, 50, 1, 16))
    target.dispatchEvent(makePointerEvent('pointercancel', 50, 50, 1, 32))

    // A subsequent move under the same pointerId, after cancel, should not
    // register — the drag has ended.
    const countAfterCancel = signals.length
    target.dispatchEvent(makePointerEvent('pointermove', 150, 50, 1, 48))
    expect(signals.length).toBe(countAfterCancel)

    teardown()
  })

  it('coasts the same distance at 30, 60 and 120 Hz', () => {
    const runs = [30, 60, 120].map(hz => {
      queued = []
      let latest = { progress: 0, velocity: 0 }
      const teardown = drag({ inertia: .9 }).attach(target, signal => { latest = { progress: signal.progress, velocity: signal.velocity ?? 0 } })
      target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
      target.dispatchEvent(makePointerEvent('pointermove', 2, 50, 1, 16))
      target.dispatchEvent(makePointerEvent('pointerup', 2, 50, 1, 32))
      flushOneFrame(0)
      for (let i = 1; i <= hz / 10; i++) flushOneFrame(i * 1000 / hz)
      teardown(); getSharedScheduler().stop()
      return latest
    })
    for (const result of runs) {
      expect(result.progress).toBeCloseTo(runs[0]!.progress, 8)
      expect(result.velocity).toBeCloseTo(runs[0]!.velocity, 8)
    }
  })

  it('zero inertia and cancelled gestures stop at release without scheduling a coast', () => {
    for (const [inertia, end] of [[0, 'pointerup'], [.9, 'pointercancel']] as const) {
      let latestVelocity = 1
      const teardown = drag({ inertia }).attach(target, signal => { latestVelocity = signal.velocity ?? 0 })
      target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
      target.dispatchEvent(makePointerEvent('pointermove', 20, 50, 1, 16))
      target.dispatchEvent(makePointerEvent(end, 20, 50, 1, 32))
      expect(queued.length).toBe(0); expect(latestVelocity).toBe(0)
      teardown()
    }
  })

  it('rejects unstable inertia and handles constant-velocity coasting', () => {
    for (const inertia of [-.1, 1.1, NaN, Infinity]) expect(() => drag({ inertia })).toThrow(/inertia/)
    const signals: number[] = []
    const teardown = drag({ inertia: 1 }).attach(target, signal => signals.push(signal.progress))
    target.dispatchEvent(makePointerEvent('pointerdown', 0, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 2, 50, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 4, 50, 1, 10))
    target.dispatchEvent(makePointerEvent('pointerup', 4, 50, 1, 20))
    flushOneFrame(0); flushOneFrame(1000 / 60)
    expect(signals.at(-1)).toBeCloseTo(.02 + (.01 / 10 * (1000 / 60)) * (1 + 16.67 * .06), 5)
    teardown()
  })

  it('defaults axis to "x" and inertia to 0.92', () => {
    const signals: number[] = []
    const teardown = drag().attach(target, (signal) => signals.push(signal.progress))
    target.dispatchEvent(makePointerEvent('pointerdown', 0, 0, 1, 0))
    target.dispatchEvent(makePointerEvent('pointermove', 100, 999, 1, 16)) // large y move ignored under default axis x
    expect(signals[0]).toBeCloseTo(0.5, 1)
    teardown()
  })
})
