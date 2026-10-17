/**
 * test/scroll-smooth — scroll({ smooth }): the progress glides behind the scroll.
 *
 * The scrub of a ScrollTrigger, in core: `smooth` seconds to catch up (about 95% of the
 * way), easing out, idle once it arrives, skipped under reduced motion. Driven through the
 * fallback path with a fake frame clock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { scroll } from '../packages/core/src/drivers/scroll.js'
import { getSharedScheduler } from '../packages/core/src/scheduler.js'
import type { DriverSignal } from '../packages/core/src/types.js'

let top = 400
const originalRaf = globalThis.requestAnimationFrame
const originalMatchMedia = globalThis.matchMedia
let queue: FrameRequestCallback[] = []
let clock = 0
let target: HTMLElement

beforeEach(() => {
  getSharedScheduler().stop()
  queue = []
  clock = 0
  top = 400
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { queue.push(cb); return queue.length }) as typeof requestAnimationFrame
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, height: 200, left: 0, right: 0, bottom: top + 200, width: 0, x: 0, y: 0, toJSON() {} }),
  })
  target = document.createElement('div')
  document.body.append(target)
})
afterEach(() => {
  getSharedScheduler().stop()
  globalThis.requestAnimationFrame = originalRaf
  globalThis.matchMedia = originalMatchMedia
  target.remove()
})

/** One frame of `ms`: every callback queued so far runs at the new time. */
function frame(ms = 16.67): void {
  clock += ms
  const pending = queue
  queue = []
  pending.forEach((cb) => cb(clock))
}
/** Moves the element (so the scroll position) and tells the driver, as a scroll event does. */
function scrollTo(nextTop: number): void {
  top = nextTop
  window.dispatchEvent(new Event('scroll'))
}
const record = (driver: ReturnType<typeof scroll>) => {
  const seen: DriverSignal[] = []
  const detach = driver.attach(target, (signal) => seen.push(signal))
  return { seen, detach }
}
// An element 200 high in an 800 high viewport: at top 400 the progress is .4, at top -200 it is 1.

describe('scroll({ smooth })', () => {
  it('without it, progress follows the scroll at once', () => {
    const { seen, detach } = record(scroll())
    seen.length = 0
    scrollTo(-200); frame()
    expect(seen.at(-1)!.progress).toBe(1)
    detach()
  })

  it('the first signal lands at once: there is nothing to glide from', () => {
    const { seen, detach } = record(scroll({ smooth: .3 }))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.progress).toBeCloseTo(.4, 5)
    detach()
  })

  it('later progress glides toward the scroll, easing out, and settles exactly on it', () => {
    const { seen, detach } = record(scroll({ smooth: .3 }))
    seen.length = 0
    scrollTo(-200) // the target is now 1
    const values: number[] = []
    for (let i = 0; i < 60; i++) { frame(); const last = seen.at(-1); if (last) values.push(last.progress) }
    expect(values[0]!).toBeGreaterThan(.4)
    expect(values[0]!).toBeLessThan(1)
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!)
    // Easing out: each step is smaller than the one before, until it lands.
    const first = values[1]! - values[0]!, later = values[10]! - values[9]!
    expect(later).toBeLessThan(first)
    expect(values.at(-1)).toBe(1)
    detach()
  })

  it('reaches about 95% of the way in `smooth` seconds', () => {
    const { seen, detach } = record(scroll({ smooth: .3 }))
    scrollTo(-200)
    const start = .4
    let elapsed = 0
    while (elapsed < 300) { frame(); elapsed += 16.67 }
    const covered = (seen.at(-1)!.progress - start) / (1 - start)
    expect(covered).toBeGreaterThan(.9)
    expect(covered).toBeLessThan(1)
    detach()
  })

  it('goes quiet once it has arrived, and wakes for the next scroll', () => {
    const { seen, detach } = record(scroll({ smooth: .2 }))
    scrollTo(-200)
    for (let i = 0; i < 80; i++) frame()
    expect(seen.at(-1)!.progress).toBe(1)
    const settled = seen.length
    for (let i = 0; i < 10; i++) frame()
    expect(seen).toHaveLength(settled) // nothing more is sent while at rest
    scrollTo(400)
    for (let i = 0; i < 80; i++) frame()
    expect(seen.length).toBeGreaterThan(settled)
    expect(seen.at(-1)!.progress).toBeCloseTo(.4, 5)
    detach()
  })

  it('a stalled frame does not leap the distance', () => {
    const { seen, detach } = record(scroll({ smooth: .3 }))
    frame() // the shared loop's first tick has no previous frame to measure from
    seen.length = 0
    scrollTo(-200)
    frame() // the driver measures the new position
    frame(1000) // then a frame that took a second
    expect(seen.at(-1)!.progress).toBeGreaterThan(.4)
    expect(seen.at(-1)!.progress).toBeLessThan(.95)
    detach()
  })

  it('is skipped under reduced motion', () => {
    globalThis.matchMedia = ((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as unknown as typeof matchMedia
    const { seen, detach } = record(scroll({ smooth: .3 }))
    seen.length = 0
    scrollTo(-200); frame()
    expect(seen.at(-1)!.progress).toBe(1)
    detach()
  })

  it('detaching stops the glide', () => {
    const { seen, detach } = record(scroll({ smooth: .3 }))
    seen.length = 0
    scrollTo(-200); frame()
    const before = seen.length
    detach()
    for (let i = 0; i < 20; i++) frame()
    expect(seen).toHaveLength(before)
  })

  it('rejects a smooth that is not a number of seconds', () => {
    for (const smooth of [-1, NaN, Infinity]) expect(() => scroll({ smooth }).attach(target, () => {})).toThrow(RangeError)
    expect(() => scroll({ smooth: 0 }).attach(target, () => {})()).not.toThrow()
  })
})
