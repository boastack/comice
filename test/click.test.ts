/**
 * test/click.test — packages/core/src/drivers/click.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload). No scheduler, no
 * timers — click is purely event-driven, so no fake-rAF machinery is
 * needed here, unlike drag.test.ts/time.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { click } from '../packages/core/src/drivers/click.js'

describe('click driver', () => {
  let target: HTMLElement

  beforeEach(() => {
    target = document.createElement('div')
    document.body.appendChild(target)
  })

  afterEach(() => {
    target.remove()
  })

  it('exposes the Driver contract: name + attach()', () => {
    const driver = click()
    expect(driver.name).toBe('click')
    expect(typeof driver.attach).toBe('function')
  })

  it('reports progress 1 on every click by default (toggle: false)', () => {
    const signals: number[] = []
    const teardown = click({ duration: 0 }).attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))

    expect(signals).toEqual([1, 1, 1, 1, 1, 1]) // each arrival is sent twice to settle the state machine (tween.ts)
    teardown()
  })

  it('toggle: true alternates progress 1/0 on successive clicks', () => {
    const signals: number[] = []
    const teardown = click({ toggle: true, duration: 0 }).attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))

    expect(signals).toEqual([1, 1, 0, 0, 1, 1, 0, 0])
    teardown()
  })

  it('toggle state starts fresh for each attach() — two instances do not share state', () => {
    const signalsA: number[] = []
    const signalsB: number[] = []
    const driver = click({ toggle: true, duration: 0 })
    const teardownA = driver.attach(target, (signal) => signalsA.push(signal.progress))
    const targetB = document.createElement('div')
    document.body.appendChild(targetB)
    const teardownB = driver.attach(targetB, (signal) => signalsB.push(signal.progress))

    target.dispatchEvent(new Event('click', { bubbles: true }))
    targetB.dispatchEvent(new Event('click', { bubbles: true }))

    // Both start at "off", so both first clicks report 1 — independent
    // toggle state per attach(), not shared across the two targets.
    expect(signalsA).toEqual([1, 1])
    expect(signalsB).toEqual([1, 1])

    teardownA()
    teardownB()
    targetB.remove()
  })

  describe('hidden targets and overlays — real bug found on a real page', () => {
    // A GL plugin hides its target (visibility: hidden), so a real click
    // hit-tests straight through it and lands on its parent. The old
    // listener on the target itself never fired at all.
    function fixture() {
      const parent = document.createElement('div')
      const img = document.createElement('img')
      const caption = document.createElement('p')
      img.style.visibility = 'hidden'
      parent.appendChild(img)
      parent.appendChild(caption)
      document.body.appendChild(parent)
      Object.defineProperty(img, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200, x: 0, y: 0, toJSON() {} }),
        configurable: true,
      })
      return { parent, img, caption }
    }
    const clickAt = (el: Element, clientX: number, clientY: number) =>
      el.dispatchEvent(new MouseEvent('click', { clientX, clientY, bubbles: true }))

    it('a click landing on the parent inside the hidden target\'s box counts', () => {
      const { parent, img } = fixture()
      const signals: number[] = []
      const teardown = click({ duration: 0 }).attach(img, (signal) => signals.push(signal.progress))

      clickAt(parent, 150, 100)

      expect(signals).toEqual([1, 1])
      teardown()
      parent.remove()
    })

    it('a click on the parent OUTSIDE the target\'s box does not count', () => {
      const { parent, img } = fixture()
      const signals: number[] = []
      const teardown = click({ duration: 0 }).attach(img, (signal) => signals.push(signal.progress))

      clickAt(parent, 400, 100)

      expect(signals).toEqual([])
      teardown()
      parent.remove()
    })

    it('a click on an overlay drawn over the target (a caption) does not count', () => {
      const { parent, img, caption } = fixture()
      const signals: number[] = []
      const teardown = click({ duration: 0 }).attach(img, (signal) => signals.push(signal.progress))

      clickAt(caption, 150, 100) // inside the image's box, but on the caption

      expect(signals).toEqual([])
      teardown()
      parent.remove()
    })
  })

  it('teardown() removes the listener — a click after teardown reports nothing further', () => {
    const signals: number[] = []
    const teardown = click({ duration: 0 }).attach(target, (signal) => signals.push(signal.progress))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    expect(signals).toEqual([1, 1])

    teardown()
    target.dispatchEvent(new Event('click', { bubbles: true }))
    expect(signals).toEqual([1, 1]) // unchanged — no new signal after teardown
  })
})
