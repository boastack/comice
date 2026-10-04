/**
 * test/reveal-plays-on-view — reveal with no driver plays itself when the
 * element comes into view (spec §08: reveal "owns media entering"; its own
 * example `comice('.grid figure').use(reveal({ effect: 'blinds', stagger }))`
 * has no driver). It used to stay hidden forever. With a driver, the driver
 * keeps the timing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { reveal } from '../packages/reveal/src/index.js'
import { installFakeIntersectionObserver, type FakeIntersection } from './fake-intersection.js'

let intersection: FakeIntersection | null
let queued: FrameRequestCallback[]
let now: number
const originalRAF = globalThis.requestAnimationFrame
let handle: ComiceHandle | null

beforeEach(() => {
  getSharedScheduler().stop()
  intersection = null
  queued = []
  now = 0
  handle = null
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => queued.push(cb)) as typeof requestAnimationFrame
})

afterEach(() => {
  handle?.destroy()
  getSharedScheduler().stop()
  globalThis.requestAnimationFrame = originalRAF
  intersection?.uninstall()
  document.body.innerHTML = ''
})

function frames(n: number, ms = 100): void {
  for (let i = 0; i < n; i++) {
    now += ms
    queued.splice(0).forEach((cb) => cb(now))
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function box(): HTMLDivElement {
  return document.body.appendChild(document.createElement('div'))
}

describe('no driver: reveal plays itself on entering view', () => {
  it('waits for the element to be seen, then runs entering -> active', async () => {
    intersection = installFakeIntersectionObserver({ visible: false })
    const el = box()
    handle = comice(el).use(reveal({ effect: 'blinds', waitForDecode: false }))
    await tick()
    expect(handle.state).toBe('idle')
    intersection.setVisible(true)
    expect(handle.state).toBe('entering')
    frames(4) // 400ms of 800
    expect(handle.progress).toBeGreaterThan(0.5)
    expect(handle.progress).toBeLessThan(1)
    frames(5)
    expect(handle.state).toBe('active')
    expect(handle.progress).toBe(1)
  })

  it('a stagger delay counts from being seen, so a grid plays as it scrolls in', async () => {
    intersection = installFakeIntersectionObserver({ visible: false })
    const grid = box()
    const figures = [0, 1].map(() => grid.appendChild(document.createElement('figure')))
    handle = comice(figures as unknown as NodeListOf<Element>).use(reveal({ effect: 'blinds', stagger: { each: 0.05 }, waitForDecode: false }))
    await tick()
    intersection.setVisible(true)
    const [first, second] = handle.handles
    expect(first!.state).toBe('entering')
    expect(second!.state).toBe('idle') // 50ms to go
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(second!.state).toBe('entering')
  })

  it('under reduced motion it goes straight to active', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    try {
      intersection = installFakeIntersectionObserver()
      handle = comice(box()).use(reveal({ waitForDecode: false }))
      await tick()
      expect(handle.state).toBe('active')
    } finally {
      window.matchMedia = original
    }
  })

  it('without IntersectionObserver it plays at once', async () => {
    const IO = globalThis.IntersectionObserver
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    try {
      handle = comice(box()).use(reveal({ waitForDecode: false }))
      await tick()
      expect(handle.state).toBe('entering')
    } finally {
      globalThis.IntersectionObserver = IO
    }
  })

  it('destroyed mid-play, or before being seen, it stops cleanly', async () => {
    intersection = installFakeIntersectionObserver()
    handle = comice(box()).use(reveal({ waitForDecode: false }))
    await tick()
    frames(2)
    handle.destroy()
    expect(() => frames(10)).not.toThrow()
    handle = comice(box()).use(reveal({ waitForDecode: false }))
    handle.destroy() // before the microtask that decides
    handle = null
    await tick()
  })
})

describe('with a driver, the driver keeps the timing', () => {
  it('nothing plays on view; `driven` says why', async () => {
    intersection = installFakeIntersectionObserver()
    const el = box()
    handle = comice(el).use(reveal({ waitForDecode: false })).driver({ name: 'manual', attach: () => () => {} })
    expect(handle.driven).toBe(true)
    await tick()
    frames(10)
    expect(handle.state).toBe('idle')
  })

  it('a stagger delay still applies to a driven reveal', async () => {
    intersection = installFakeIntersectionObserver()
    const grid = box()
    const items = [0, 1].map(() => grid.appendChild(document.createElement('figure')))
    const plugin = reveal({ waitForDecode: false, stagger: { each: 0.03 } })
    handle = comice(items as unknown as NodeListOf<Element>).use(plugin).driver({ name: 'manual', attach: () => () => {} })
    const second = handle.handles[1]!
    await tick()
    second.setProgress(0.5) // before its 30ms: buffered, not painted
    expect(items[1]!.style.transform).toBe(items[0]!.style.transform)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(items[1]!.style.transform).not.toBe(items[0]!.style.transform)
    expect(handle.state).toBe('idle') // and nothing played on its own
  })

  it('driven is false until .driver(), on a single handle and a group', () => {
    const a = comice(box())
    expect(a.driven).toBe(false)
    const g = comice([box(), box()] as unknown as NodeListOf<Element>)
    expect(g.driven).toBe(false)
    g.driver({ name: 'manual', attach: () => () => {} })
    expect(g.driven).toBe(true)
    expect(comice('.nothing').driven).toBe(false)
  })
})
