/**
 * test/reveal-stagger.test — packages/reveal/src/stagger.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) since stagger delay
 * computation walks the real DOM to find a target's sibling group.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { computeStaggerDelay } from '../packages/reveal/src/stagger.js'

describe('computeStaggerDelay — siblings, one by one (no grid)', () => {
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
    expect(computeStaggerDelay(items[0], { each: 0.06 })).toBe(0)
  })

  it('each subsequent item is delayed by one more step of `each`', () => {
    expect(computeStaggerDelay(items[1], { each: 0.06 })).toBe(60)
    expect(computeStaggerDelay(items[2], { each: 0.06 })).toBe(120)
    expect(computeStaggerDelay(items[3], { each: 0.06 })).toBe(180)
  })

  it('defaults each to 60ms', () => {
    expect(computeStaggerDelay(items[1], {})).toBe(60)
  })

  it('from: "end" reverses the order', () => {
    expect(computeStaggerDelay(items[3], { each: 0.06, from: 'end' })).toBe(0)
    expect(computeStaggerDelay(items[0], { each: 0.06, from: 'end' })).toBe(180)
  })

  it('from: "center" radiates outward from the middle', () => {
    // 4 items, center = 1.5. Distances: |0-1.5|=1.5, |1-1.5|=0.5, |2-1.5|=0.5, |3-1.5|=1.5
    expect(computeStaggerDelay(items[1], { each: 0.06, from: 'center' })).toBe(30)
    expect(computeStaggerDelay(items[2], { each: 0.06, from: 'center' })).toBe(30)
    expect(computeStaggerDelay(items[0], { each: 0.06, from: 'center' })).toBe(90)
    expect(computeStaggerDelay(items[3], { each: 0.06, from: 'center' })).toBe(90)
  })

  it('only counts siblings matching the target\'s own tag', () => {
    const div = document.createElement('div')
    container.insertBefore(div, items[1])
    // div is a different tag, so figure indices are unaffected.
    expect(computeStaggerDelay(items[1], { each: 0.06 })).toBe(60)
  })

  it('adds random jitter within [0, random) on top of the base delay', () => {
    const base = computeStaggerDelay(items[2], { each: 0.06, random: 0 })
    const withJitter = computeStaggerDelay(items[2], { each: 0.06, random: 0.05 })
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
    expect(computeStaggerDelay(solo, { each: 0.06 })).toBe(0)
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

    expect(computeStaggerDelay(a, { each: 0.06, grid: '.tile' })).toBe(0)
    expect(computeStaggerDelay(b, { each: 0.06, grid: '.tile' })).toBe(60)

    wrapperA.remove()
    wrapperB.remove()
  })
})

describe("computeStaggerDelay — the spec's units and grids", () => {
  it("`each` is seconds, as the spec writes it ({ each: 0.06 } is 60ms; it was 0.06ms)", () => {
    const parent = document.body.appendChild(document.createElement('section'))
    const [a, b] = [0, 1].map(() => parent.appendChild(document.createElement('figure')))
    expect(computeStaggerDelay(b!, { each: 0.06 })).toBeCloseTo(60)
    expect(computeStaggerDelay(a!, {})).toBe(0)
    parent.remove()
  })

  function grid(rows: number, columns: number): HTMLElement[] {
    const parent = document.body.appendChild(document.createElement('section'))
    const cells: HTMLElement[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const cell = parent.appendChild(document.createElement('figure'))
        Object.defineProperty(cell, 'getBoundingClientRect', { value: () => ({ top: r * 100, left: c * 100 }) as DOMRect })
        cells.push(cell)
      }
    }
    return cells
  }

  it("grid: 'auto' reads rows from layout and staggers by distance from the top-left", () => {
    const cells = grid(2, 3) // [0 1 2 / 3 4 5]
    const delays = cells.map((cell) => computeStaggerDelay(cell, { each: 0.1, grid: 'auto' }))
    expect(delays[0]).toBe(0)
    expect(delays[1]).toBeCloseTo(100)
    expect(delays[3]).toBeCloseTo(100) // one row down: as near as one column across
    expect(delays[4]).toBeCloseTo(Math.SQRT2 * 100)
    expect(delays[5]).toBeCloseTo(Math.hypot(1, 2) * 100)
    cells[0]!.parentElement!.remove()
  })

  it("from: 'center' and 'end' move the origin; [rows, columns] gives the grid", () => {
    const cells = grid(3, 3)
    expect(computeStaggerDelay(cells[4]!, { each: 0.1, grid: 'auto', from: 'center' })).toBe(0)
    expect(computeStaggerDelay(cells[8]!, { each: 0.1, grid: 'auto', from: 'end' })).toBe(0)
    expect(computeStaggerDelay(cells[0]!, { each: 0.1, grid: 'auto', from: 'end' })).toBeCloseTo(Math.hypot(2, 2) * 100)
    // Given as [rows, columns], layout isn't read: 9 items as 1 x 9 is a line.
    expect(computeStaggerDelay(cells[8]!, { each: 0.1, grid: [1, 9] })).toBeCloseTo(800)
    expect(computeStaggerDelay(cells[8]!, { each: 0.1, grid: [3, 0] })).toBeCloseTo(Math.hypot(8, 0) * 100) // columns floor at 1
    cells[0]!.parentElement!.remove()
  })
})
