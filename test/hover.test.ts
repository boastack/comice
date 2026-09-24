/**
 * test/hover.test — packages/core/src/drivers/hover.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload).
 *
 * hover tracks enter/leave from document-level pointermove (see hit.ts), not
 * the target's own pointerenter/pointerleave — so these tests move the
 * pointer the way a real browser reports it: a pointermove landing on the
 * target (enter), or on something else (leave).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { hover } from '../packages/core/src/drivers/hover.js'

function setRect(el: Element, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }),
    configurable: true,
  })
}

function moveOn(el: Element, clientX = 0, clientY = 0): void {
  el.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, bubbles: true }))
}

describe('hover driver', () => {
  let target: HTMLElement
  let elsewhere: HTMLElement

  beforeEach(() => {
    target = document.createElement('div')
    elsewhere = document.createElement('div')
    document.body.appendChild(target)
    document.body.appendChild(elsewhere)
  })

  afterEach(() => {
    target.remove()
    elsewhere.remove()
  })

  const enter = () => moveOn(target)
  const leave = () => moveOn(elsewhere)

  it('exposes the Driver contract: name + attach()', () => {
    const driver = hover()
    expect(driver.name).toBe('hover')
    expect(typeof driver.attach).toBe('function')
  })

  it('reports progress 1 after the intent delay once the pointer enters', () => {
    const driver = hover({ intent: 50 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    enter()
    expect(onSignal).not.toHaveBeenCalled() // not yet — still inside the intent delay

    detach()
  })

  it('fires progress 1 via a real timer once the intent delay elapses', async () => {
    const driver = hover({ intent: 10 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    enter()
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(onSignal).toHaveBeenCalledWith({ progress: 1 })
    detach()
  })

  it('further moves while already over the target do not restart the intent timer', async () => {
    const driver = hover({ intent: 20 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    enter()
    await new Promise((resolve) => setTimeout(resolve, 12))
    enter() // still over — must not push the enter back another 20ms
    await new Promise((resolve) => setTimeout(resolve, 12))

    expect(onSignal).toHaveBeenCalledWith({ progress: 1 })
    detach()
  })

  it('reports progress 0 immediately when the pointer moves off, with no delay', () => {
    const driver = hover({ intent: 1000 }) // long delay — leave must not wait for it
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    enter()
    leave()

    expect(onSignal).toHaveBeenCalledWith({ progress: 0 })
    detach()
  })

  it('a move elsewhere without ever having entered reports nothing', () => {
    const driver = hover()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    leave()

    expect(onSignal).not.toHaveBeenCalled()
    detach()
  })

  it('a leave before the intent delay elapses cancels the pending enter entirely', async () => {
    const driver = hover({ intent: 20 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    enter()
    leave()
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

    enter()
    await new Promise((resolve) => setTimeout(resolve, 5))
    leave()
    enter() // re-enter before the first timer would have fired
    await new Promise((resolve) => setTimeout(resolve, 30))

    const enterCalls = onSignal.mock.calls.filter(([signal]) => signal.progress === 1)
    expect(enterCalls.length).toBe(1)
    detach()
  })

  it('defaults intent to 80ms', async () => {
    const driver = hover()
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    enter()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(onSignal).not.toHaveBeenCalled() // default 80ms hasn't elapsed yet

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(onSignal).toHaveBeenCalledWith({ progress: 1 })
    detach()
  })

  it('a HIDDEN target still enters when the pointer is over its box (event lands on its parent) — real bug found on a real page', () => {
    // A GL plugin hides its target (visibility: hidden), so the browser
    // hit-tests straight through it: the pointermove lands on the parent,
    // never on the target. The old pointerenter-on-target listener got
    // nothing at all.
    const parent = document.createElement('div')
    const hidden = document.createElement('img')
    hidden.style.visibility = 'hidden'
    parent.appendChild(hidden)
    document.body.appendChild(parent)
    setRect(hidden, 100, 100, 200, 100)

    const driver = hover({ intent: 0 })
    const onSignal = mock()
    const detach = driver.attach(hidden, onSignal)

    moveOn(parent, 150, 150) // inside the hidden target's box
    moveOn(parent, 10, 10) // outside it

    expect(onSignal).toHaveBeenCalledWith({ progress: 0 })
    detach()
    parent.remove()
  })

  it('an overlay drawn on top of the target counts as leaving, like native hover', () => {
    const parent = document.createElement('div')
    const img = document.createElement('img')
    const caption = document.createElement('p')
    parent.appendChild(img)
    parent.appendChild(caption)
    document.body.appendChild(parent)
    setRect(img, 0, 0, 300, 200)

    const driver = hover({ intent: 1000 })
    const onSignal = mock()
    const detach = driver.attach(img, onSignal)

    moveOn(img, 50, 50)
    moveOn(caption, 50, 50) // same point, but on the caption — not the image

    expect(onSignal).toHaveBeenCalledWith({ progress: 0 })
    detach()
    parent.remove()
  })

  it('the pointer leaving the window counts as leaving', () => {
    const driver = hover({ intent: 1000 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    enter()
    target.dispatchEvent(new PointerEvent('pointerleave')) // leaving the target alone is not a window leave
    expect(onSignal).not.toHaveBeenCalled()

    document.documentElement.dispatchEvent(new PointerEvent('pointerleave'))
    expect(onSignal).toHaveBeenCalledWith({ progress: 0 })
    detach()
  })

  it('detach removes both listeners and clears any pending enter timer', async () => {
    const driver = hover({ intent: 10 })
    const onSignal = mock()
    const detach = driver.attach(target, onSignal)

    enter()
    detach()
    await new Promise((resolve) => setTimeout(resolve, 25))

    // The pending enter timer was cleared by detach() — no late signal.
    expect(onSignal).not.toHaveBeenCalled()

    // And the listeners are gone — further events do nothing.
    leave()
    document.documentElement.dispatchEvent(new PointerEvent('pointerleave'))
    expect(onSignal).not.toHaveBeenCalled()
  })
})
