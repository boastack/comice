/**
 * test/reveal-stagger.test — packages/reveal/src/stagger.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) since stagger delay
 * computation walks the real DOM to find a target's sibling group.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { computeStaggerDelay } from '../packages/reveal/src/stagger.js'

describe('computeStaggerDelay — auto grid (DOM siblings)', () => {
  let container: HTMLElement
  let items: HTMLElement[]

  beforeEach(() => {
    container = document.createElement('div')
    items = Array.from({ length: 4 }, () => document.createElement('figure'))
    items.forEach((item) => container.appendChild(item))
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('returns 0 for a target with no siblings of its own tag', () => {
    const lonely = document.createElement('span')
    document.body.appendChild(lonely)
    expect(computeStaggerDelay(lonely, {})).toBe(0)
    lonely.remove()
  })

  it('the first item in the group gets delay 0 (from: start, the default)', () => {
    expect(computeStaggerDelay(items[0], { each: 60 })).toBe(0)
  })

  it('each subsequent item is delayed by one more step of `each`', () => {
    expect(computeStaggerDelay(items[1], { each: 60 })).toBe(60)
    expect(computeStaggerDelay(items[2], { each: 60 })).toBe(120)
    expect(computeStaggerDelay(items[3], { each: 60 })).toBe(180)
  })

  it('defaults each to 60ms', () => {
    expect(computeStaggerDelay(items[1], {})).toBe(60)
  })

  it('from: "end" reverses the order', () => {
    expect(computeStaggerDelay(items[3], { each: 60, from: 'end' })).toBe(0)
    expect(computeStaggerDelay(items[0], { each: 60, from: 'end' })).toBe(180)
  })

  it('from: "center" radiates outward from the middle', () => {
    // 4 items, center = 1.5. Distances: |0-1.5|=1.5, |1-1.5|=0.5, |2-1.5|=0.5, |3-1.5|=1.5
    expect(computeStaggerDelay(items[1], { each: 60, from: 'center' })).toBe(30)
    expect(computeStaggerDelay(items[2], { each: 60, from: 'center' })).toBe(30)
    expect(computeStaggerDelay(items[0], { each: 60, from: 'center' })).toBe(90)
    expect(computeStaggerDelay(items[3], { each: 60, from: 'center' })).toBe(90)
  })

  it('only counts siblings matching the target\'s own tag', () => {
    const div = document.createElement('div')
    container.insertBefore(div, items[1])
    // div is a different tag, so figure indices are unaffected.
    expect(computeStaggerDelay(items[1], { each: 60 })).toBe(60)
  })

  it('adds random jitter within [0, random) on top of the base delay', () => {
    const base = computeStaggerDelay(items[2], { each: 60, random: 0 })
    const withJitter = computeStaggerDelay(items[2], { each: 60, random: 50 })
    expect(withJitter).toBeGreaterThanOrEqual(base)
    expect(withJitter).toBeLessThan(base + 50)
  })

  it('a group of exactly one item returns 0', () => {
    // A fresh parent, not document.body directly — beforeEach's own
    // `container` is itself a <div> appended to document.body, so
    // reusing document.body here would make `solo` and `container`
    // false siblings under resolveGroup's tag-name filter.
    const soloParent = document.createElement('section')
    const solo = document.createElement('div')
    soloParent.appendChild(solo)
    document.body.appendChild(soloParent)
    expect(computeStaggerDelay(solo, { each: 60 })).toBe(0)
    soloParent.remove()
  })
})

describe('computeStaggerDelay — explicit grid selector', () => {
  it('queries the whole document instead of DOM siblings when grid is a selector', () => {
    const a = document.createElement('div')
    a.className = 'tile'
    const b = document.createElement('div')
    b.className = 'tile'
    // Deliberately not DOM siblings of each other's natural parent chain.
    const wrapperA = document.createElement('section')
    const wrapperB = document.createElement('section')
    wrapperA.appendChild(a)
    wrapperB.appendChild(b)
    document.body.appendChild(wrapperA)
    document.body.appendChild(wrapperB)

    expect(computeStaggerDelay(a, { each: 60, grid: '.tile' })).toBe(0)
    expect(computeStaggerDelay(b, { each: 60, grid: '.tile' })).toBe(60)

    wrapperA.remove()
    wrapperB.remove()
  })
})
