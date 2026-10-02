/**
 * test/tween.test — packages/core/src/drivers/tween.ts (+ click/hover through it)
 * ─────────────────────────────────────────────────────────────────────────────
 * Drives the shared scheduler with a fake requestAnimationFrame, same as
 * pointer.test.ts/drag.test.ts, so every frame is deterministic.
 *
 * The integration block is the real bug: a click()-driven instance used to
 * sit in 'entering' at progress 0 forever (a single { progress: 1 } entered,
 * reset progress to 0, and nothing finished entering -> active). Found on
 * harness/site/ — type's melt never moved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler as getPackageScheduler } from 'comice/scheduler'
import { getSharedScheduler } from '../packages/core/src/scheduler.js'
import { createTween } from '../packages/core/src/drivers/tween.js'
import { click as packageClick } from 'comice/drivers'

let originalRAF: typeof requestAnimationFrame
let queued: FrameRequestCallback[]
let now = 0

beforeEach(() => {
  queued = []
  now = 0
  originalRAF = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queued.push(cb)
    return queued.length
  }) as typeof requestAnimationFrame
})

afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF
  getSharedScheduler().stop()
  getPackageScheduler().stop()
})

/** Runs `n` frames, `ms` apart. */
function frames(n: number, ms = 20): void {
  for (let i = 0; i < n; i++) {
    now += ms
    const pending = queued
    queued = []
    pending.forEach((cb) => cb(now))
  }
}

describe('createTween', () => {
  it('animates linearly to the target, one signal per frame, then sends the arrival twice', () => {
    const values: number[] = []
    const tween = createTween((s) => values.push(+s.progress.toFixed(3)), 100)

    tween.to(1)
    frames(8) // 20ms apart (the scheduler's very first frame counts as 16.67ms)

    const climbing = values.slice(0, -2)
    expect(climbing.length).toBeGreaterThanOrEqual(3) // several in-between values, not a jump
    expect(climbing.every((v, i) => v > 0 && v < 1 && (i === 0 || v > climbing[i - 1]!))).toBe(true)
    expect(values.slice(-2)).toEqual([1, 1])
    expect(values.filter((v) => v === 1).length).toBe(2) // and nothing after arrival
  })

  it('reverses from the CURRENT value, taking proportionally less time', () => {
    const values: number[] = []
    const tween = createTween((s) => values.push(+s.progress.toFixed(3)), 100)

    tween.to(1)
    frames(3)
    const reversedAt = values.at(-1)!
    values.length = 0
    tween.to(0)
    frames(10)

    // Continues down from where it was — never jumps back to 1 or to 0.
    expect(values[0]).toBeLessThan(reversedAt)
    expect(values[0]).toBeGreaterThan(reversedAt - 0.25)
    expect(values.slice(-2)).toEqual([0, 0])
    // Proportional: covering `reversedAt` of the range takes fewer frames
    // than a full 0 -> 1 (5 frames at 20ms for 100ms).
    expect(values.length - 2).toBeLessThan(5)
  })

  it('duration 0 (or no distance to cover) arrives synchronously, still twice', () => {
    const values: number[] = []
    const tween = createTween((s) => values.push(s.progress), 0)
    tween.to(1)
    expect(values).toEqual([1, 1])

    const other = createTween((s) => values.push(s.progress), 100)
    values.length = 0
    other.to(0) // already at 0
    expect(values).toEqual([0, 0])
  })

  it('clamps targets to 0..1', () => {
    const values: number[] = []
    createTween((s) => values.push(s.progress), 0).to(7)
    expect(values).toEqual([1, 1])
  })

  it('stop() halts a running animation', () => {
    const values: number[] = []
    const tween = createTween((s) => values.push(s.progress), 100)
    tween.to(1)
    frames(1)
    frames(2)
    const sent = values.length
    tween.stop()
    frames(10)
    expect(values.length).toBe(sent)
  })
})

describe('click() through a real instance — the stuck-in-entering bug', () => {
  let el: HTMLElement
  let handle: ComiceHandle

  beforeEach(() => {
    el = document.createElement('h2')
    document.body.appendChild(el)
    handle = comice(el) as ComiceHandle
    handle.driver(packageClick({ toggle: true, duration: 100 }))
  })

  afterEach(() => {
    handle.destroy()
    el.remove()
  })

  it('a click goes idle -> entering -> active, passing through mid-progress', () => {
    const seen: Array<[string, number]> = []
    handle.on('*', (s) => seen.push([s.state, +s.progress.toFixed(2)]))

    el.click()
    frames(1)
    frames(8)

    expect(handle.state).toBe('active')
    const states = seen.map(([state]) => state).filter((s, i, all) => s !== all[i - 1])
    expect(states.slice(-2)).toEqual(['entering', 'active'])
    // Something that reads progress (type's melt peaks at 0.5) actually
    // sees the middle of the range, not just the two ends.
    expect(seen.some(([state, p]) => state === 'entering' && p >= 0.4 && p <= 0.6)).toBe(true)
  })

  it('on a slow device (frames 250ms apart) the in-between progress still reaches plugins', () => {
    // The first frame's progress used to be set in 'idle', then wiped to 0
    // by the transition to 'entering' in the same task — never painted. On
    // a 4fps page the whole 400ms animation is two frames, so a progress-
    // reading effect (type's melt) never showed at all.
    const seen: Array<[string, number]> = []
    handle.on('*', (s) => seen.push([s.state, +s.progress.toFixed(2)]))

    el.click()
    for (let i = 0; i < 3; i++) {
      now += 250
      const pending = queued
      queued = []
      pending.forEach((cb) => cb(now))
    }

    // After every event of a frame settles, 'entering' holds the driver's
    // real mid-animation value — not 0.
    expect(seen.some(([state, p]) => state === 'entering' && p > 0 && p < 1)).toBe(true)
    expect(handle.state).toBe('active')
    expect(handle.progress).toBe(1)
  })

  it('a second click goes all the way back to idle (not stuck in leaving)', () => {
    el.click()
    frames(1)
    frames(8)
    expect(handle.state).toBe('active')

    el.click()
    frames(1)
    frames(8)
    expect(handle.state).toBe('idle')
  })
})
