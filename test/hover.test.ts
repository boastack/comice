/**
 * test/hover.test — packages/core/src/drivers/hover.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { hover } from '../packages/core/src/drivers/hover.js'

describe('hover driver', () => {
  let target: HTMLElement

  beforeEach(() => {
    target = document.createElement('div')
    document.body.appendChild(target)
  })

  afterEach(() => {
    target.remove()
  })

  it('exposes the Driver contract: name + attach()', () => {
    const driver = hover()
    expect(driver.name).toBe('hover')
    expect(typeof driver.attach).toBe('function')
  })

  it('reports progress 1 after the intent delay once the pointer enters', () => {
    const driver = hover({ intent: 50 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(new PointerEvent('pointerenter'))
    expect(onSignal).not.toHaveBeenCalled() // not yet — still inside the intent delay

    detach()
  })

  it('fires progress 1 via a real timer once the intent delay elapses', async () => {
    const driver = hover({ intent: 10 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(new PointerEvent('pointerenter'))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(onSignal).toHaveBeenCalledWith({ progress: 1 })
    detach()
  })

  it('reports progress 0 immediately on pointerleave, with no delay', () => {
    const driver = hover({ intent: 1000 }) // long delay — leave must not wait for it
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(new PointerEvent('pointerenter'))
    target.dispatchEvent(new PointerEvent('pointerleave'))

    expect(onSignal).toHaveBeenCalledWith({ progress: 0 })
    detach()
  })

  it('a leave before the intent delay elapses cancels the pending enter entirely', async () => {
    const driver = hover({ intent: 20 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(new PointerEvent('pointerenter'))
    target.dispatchEvent(new PointerEvent('pointerleave'))
    await new Promise((resolve) => setTimeout(resolve, 40))

    // Only the immediate leave signal fired — the enter never did, even
    // after its delay would have elapsed, because leave canceled the timer.
    expect(onSignal).toHaveBeenCalledTimes(1)
    expect(onSignal).toHaveBeenCalledWith({ progress: 0 })
    detach()
  })

  it('a fast re-enter after a leave restarts the intent timer rather than stacking', async () => {
    const driver = hover({ intent: 20 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(new PointerEvent('pointerenter'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    target.dispatchEvent(new PointerEvent('pointerenter')) // re-enter before the first timer fires
    await new Promise((resolve) => setTimeout(resolve, 30))

    // Exactly one enter signal, not two, despite two pointerenter events.
    const enterCalls = onSignal.mock.calls.filter(([signal]) => signal.progress === 1)
    expect(enterCalls.length).toBe(1)
    detach()
  })

  it('defaults intent to 80ms', async () => {
    const driver = hover()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(new PointerEvent('pointerenter'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(onSignal).not.toHaveBeenCalled() // default 80ms hasn't elapsed yet

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(onSignal).toHaveBeenCalledWith({ progress: 1 })
    detach()
  })

  it('detach removes both listeners and clears any pending enter timer', async () => {
    const driver = hover({ intent: 10 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    target.dispatchEvent(new PointerEvent('pointerenter'))
    detach()
    await new Promise((resolve) => setTimeout(resolve, 25))

    // The pending enter timer was cleared by detach() — no late signal.
    expect(onSignal).not.toHaveBeenCalled()

    // And the listeners are gone — further events do nothing.
    target.dispatchEvent(new PointerEvent('pointerleave'))
    expect(onSignal).not.toHaveBeenCalled()
  })
})
