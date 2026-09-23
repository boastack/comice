/**
 * test/time.test — packages/core/src/drivers/time.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload). time() rides
 * getSharedScheduler() rather than a private rAF loop, so frames are driven
 * deterministically the same way test/scheduler.test.ts drives them:
 * patching globalThis.requestAnimationFrame and calling the queued
 * callback directly with a controlled timestamp.
 *
 * getSharedScheduler() is a true module-level singleton (see scheduler.ts),
 * so every test here calls getSharedScheduler().stop() in afterEach per
 * the project-wide rule in ROADMAP.md — otherwise a stale rafId from one
 * test's fake requestAnimationFrame can survive into the next test's real
 * one and silently never get scheduled against.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getSharedScheduler } from '../packages/core/src/scheduler.js'
import { time } from '../packages/core/src/drivers/time.js'

describe('time driver', () => {
  let target: HTMLElement
  let originalRAF: typeof requestAnimationFrame
  let queued: FrameRequestCallback[]

  beforeEach(() => {
    target = document.createElement('div')
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
    const driver = time()
    expect(driver.name).toBe('time')
    expect(typeof driver.attach).toBe('function')
  })

  it('reports progress advancing toward 1 across frames, over `duration` ms', () => {
    const signals: number[] = []
    const teardown = time({ duration: 1000 }).attach(target, (signal) => signals.push(signal.progress))

    flushOneFrame(0) // first tick: deltaMs falls back to 16.67 per scheduler.ts's tick()
    flushOneFrame(500)
    flushOneFrame(1000)

    expect(signals[0]).toBeGreaterThan(0)
    expect(signals[0]).toBeLessThan(1)
    expect(signals[signals.length - 1]).toBeLessThanOrEqual(1)
    // Monotonically increasing while not yet finished.
    expect(signals[1]).toBeGreaterThan(signals[0])

    teardown()
  })

  it('reports exactly 1 once and then stops (no loop) when loop is false (default)', () => {
    const signals: number[] = []
    const teardown = time({ duration: 100 }).attach(target, (signal) => signals.push(signal.progress))

    flushOneFrame(0)
    flushOneFrame(50)
    flushOneFrame(200) // overshoots duration — should land on exactly 1, not >1
    flushOneFrame(400) // finished — isActive() now false, no further signal

    expect(signals[signals.length - 1]).toBe(1)
    const countOfOnes = signals.filter((p) => p === 1).length
    expect(countOfOnes).toBe(1) // reported once, not once per frame after finishing

    teardown()
  })

  it('loop: true wraps progress back toward 0 instead of stopping at 1', () => {
    const signals: number[] = []
    const teardown = time({ duration: 100, loop: true }).attach(target, (signal) => signals.push(signal.progress))

    flushOneFrame(0)
    flushOneFrame(50)
    flushOneFrame(120) // past one full duration — should have wrapped, not clamped at 1
    flushOneFrame(150)

    // At least one signal after the wrap point is less than 1 again,
    // proving the sweep restarted rather than sitting at 1 forever.
    const afterWrap = signals.slice(2)
    expect(afterWrap.some((p) => p < 1)).toBe(true)

    teardown()
  })

  it('duration: 0 reports progress 1 immediately (no division by zero, no NaN)', () => {
    const signals: number[] = []
    const teardown = time({ duration: 0 }).attach(target, (signal) => signals.push(signal.progress))

    flushOneFrame(0)

    expect(signals[0]).toBe(1)
    expect(Number.isNaN(signals[0])).toBe(false)

    teardown()
  })

  it('loop: true with duration: 0 does not throw and does not NaN', () => {
    const signals: number[] = []
    const teardown = time({ duration: 0, loop: true }).attach(target, (signal) => signals.push(signal.progress))

    expect(() => {
      flushOneFrame(0)
      flushOneFrame(16)
    }).not.toThrow()
    expect(signals.every((p) => !Number.isNaN(p))).toBe(true)

    teardown()
  })

  it('teardown() unregisters from the shared scheduler — no further signals after', () => {
    const signals: number[] = []
    const teardown = time({ duration: 1000 }).attach(target, (signal) => signals.push(signal.progress))
    flushOneFrame(0) // tick() re-queues its own next frame before teardown() runs below
    const countAfterFirstFrame = signals.length

    teardown()
    // The entry is removed from the scheduler's Set by teardown(), but the
    // frame tick() already scheduled (at the end of the flushOneFrame(0)
    // call above, before teardown ran) is still sitting in the fake rAF
    // queue — teardown() cannot retroactively cancel a callback the fake
    // requestAnimationFrame has already captured. Flushing that pending
    // frame is the actual proof: this driver's callback must not fire
    // again even though the scheduler's own loop tick still runs once
    // more for whatever else (if anything) remains registered.
    flushOneFrame(16)
    expect(signals.length).toBe(countAfterFirstFrame)
  })

  it('defaults duration to 1000ms and loop to false when no options given', () => {
    const signals: number[] = []
    const teardown = time().attach(target, (signal) => signals.push(signal.progress))
    flushOneFrame(0)
    flushOneFrame(2000) // well past the 1000ms default — should be clamped at 1, not looping
    expect(signals[signals.length - 1]).toBe(1)
    teardown()
  })
})
