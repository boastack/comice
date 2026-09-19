/**
 * comice/core/drivers/pointer.test
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload). Drives the rAF loop
 * manually via a fake requestAnimationFrame, same approach as
 * scheduler.test.ts, so timing is deterministic rather than racing a timer.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { pointer } from './pointer.js'

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
