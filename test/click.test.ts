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
    const teardown = click().attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))

    expect(signals).toEqual([1, 1, 1])
    teardown()
  })

  it('toggle: true alternates progress 1/0 on successive clicks', () => {
    const signals: number[] = []
    const teardown = click({ toggle: true }).attach(target, (signal) => signals.push(signal.progress))

    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    target.dispatchEvent(new Event('click', { bubbles: true }))

    expect(signals).toEqual([1, 0, 1, 0])
    teardown()
  })

  it('toggle state starts fresh for each attach() — two instances do not share state', () => {
    const signalsA: number[] = []
    const signalsB: number[] = []
    const driver = click({ toggle: true })
    const teardownA = driver.attach(target, (signal) => signalsA.push(signal.progress))
    const targetB = document.createElement('div')
    document.body.appendChild(targetB)
    const teardownB = driver.attach(targetB, (signal) => signalsB.push(signal.progress))

    target.dispatchEvent(new Event('click', { bubbles: true }))
    targetB.dispatchEvent(new Event('click', { bubbles: true }))

    // Both start at "off", so both first clicks report 1 — independent
    // toggle state per attach(), not shared across the two targets.
    expect(signalsA).toEqual([1])
    expect(signalsB).toEqual([1])

    teardownA()
    teardownB()
    targetB.remove()
  })

  it('teardown() removes the listener — a click after teardown reports nothing further', () => {
    const signals: number[] = []
    const teardown = click().attach(target, (signal) => signals.push(signal.progress))
    target.dispatchEvent(new Event('click', { bubbles: true }))
    expect(signals).toEqual([1])

    teardown()
    target.dispatchEvent(new Event('click', { bubbles: true }))
    expect(signals).toEqual([1]) // unchanged — no new signal after teardown
  })
})
