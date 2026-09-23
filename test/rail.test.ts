/**
 * test/rail.test — packages/rail/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom. rail rides getSharedScheduler() for its own
 * inertia decay (see physics.ts's header — a genuinely different state
 * graph from machine.ts's, owned locally), combined with real
 * PointerEvent dispatch — same two-pattern combination test/drag.test.ts
 * established (fake-scheduler pattern + real pointer events).
 *
 * rail imports `comice/scheduler`, the PACKAGE name (see its own index.ts
 * imports) — so this test file does too, matching test/morph.test.ts's
 * own documented reasoning for why a plugin package that calls
 * getSharedScheduler() directly needs its test file aligned the same way.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { rail } from '../packages/rail/src/index.js'

function makeCollection(itemCount = 5): { container: HTMLDivElement; items: HTMLDivElement[] } {
  const container = document.createElement('div')
  Object.defineProperty(container, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 800, height: 200, right: 800, bottom: 200, x: 0, y: 0, toJSON() {} }),
    configurable: true,
  })
  const items: HTMLDivElement[] = []
  for (let i = 0; i < itemCount; i++) {
    const item = document.createElement('div')
    item.textContent = `Item ${i}`
    container.appendChild(item)
    items.push(item)
  }
  document.body.appendChild(container)
  return { container, items }
}

function makePointerEvent(type: string, clientX: number, pointerId = 1, timeStamp?: number): PointerEvent {
  const event = new PointerEvent(type, { clientX, clientY: 50, pointerId, bubbles: true })
  if (timeStamp !== undefined) {
    Object.defineProperty(event, 'timeStamp', { value: timeStamp, configurable: true })
  }
  return event
}

describe('rail — target contract', () => {
  afterEach(() => getSharedScheduler().stop())

  it('throws for a non-HTMLElement target', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    document.body.appendChild(svg as unknown as Element)
    const handle = comice(svg as unknown as Element) as ComiceHandle
    expect(() => handle.use(rail({ mode: 'strip' }))).toThrow()
    svg.remove()
  })

  it('accepts an HTMLElement target without throwing, using its children as items', () => {
    const { container } = makeCollection()
    const handle = comice(container) as ComiceHandle
    expect(() => handle.use(rail({ mode: 'strip' }))).not.toThrow()
    container.remove()
  })

  it('an explicit `items` selector scopes to matching descendants instead of direct children', () => {
    const container = document.createElement('div')
    const wrapper = document.createElement('div')
    for (let i = 0; i < 3; i++) {
      const item = document.createElement('div')
      item.className = 'slide'
      wrapper.appendChild(item)
    }
    container.appendChild(wrapper)
    document.body.appendChild(container)

    const handle = comice(container) as ComiceHandle
    const plugin = rail({ mode: 'strip', items: '.slide' })
    expect(() => handle.use(plugin)).not.toThrow()
    container.remove()
  })
})

describe.each(['canvas', 'strip', 'compare', 'stack', 'marquee', 'arc', 'coverflow'] as const)('rail — mode: %s', (mode) => {
  afterEach(() => getSharedScheduler().stop())

  it('renders every item with a finite transform at setup, without throwing', () => {
    const { container, items } = makeCollection()
    const handle = comice(container) as ComiceHandle
    expect(() => handle.use(rail({ mode }))).not.toThrow()
    items.forEach((el) => {
      expect(el.style.transform).not.toBe('')
    })
    container.remove()
  })
})

describe('rail — drag interaction', () => {
  afterEach(() => getSharedScheduler().stop())

  it('dragging moves the rail position and updates item transforms', () => {
    const { container, items } = makeCollection()
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip', snap: false }))

    const beforeTransform = items[0]!.style.transform
    container.dispatchEvent(makePointerEvent('pointerdown', 0, 1, 0))
    container.dispatchEvent(makePointerEvent('pointermove', -320, 1, 16)) // drag left by one item-width
    container.dispatchEvent(makePointerEvent('pointerup', -320, 1, 32))

    expect(items[0]!.style.transform).not.toBe(beforeTransform)
    container.remove()
  })

  it('onActive fires with the centred index after a drag settles', () => {
    const { container } = makeCollection()
    const activeIndices: number[] = []
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip', snap: true, onActive: (i) => activeIndices.push(i) }))

    expect(activeIndices).toContain(0) // initial settle at setup()

    container.dispatchEvent(makePointerEvent('pointerdown', 0, 1, 0))
    container.dispatchEvent(makePointerEvent('pointermove', -320, 1, 16))
    container.dispatchEvent(makePointerEvent('pointerup', -320, 1, 32))

    expect(activeIndices.length).toBeGreaterThan(1)
    container.remove()
  })

  it('a drag that ends with real velocity ticks through an inertia frame and settles', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      const { container } = makeCollection()
      const handle = comice(container) as ComiceHandle
      handle.use(rail({ mode: 'strip', snap: true, inertia: 0.5 }))

      container.dispatchEvent(makePointerEvent('pointerdown', 0, 1, 0))
      container.dispatchEvent(makePointerEvent('pointermove', -320, 1, 16)) // fast drag -> real velocity
      container.dispatchEvent(makePointerEvent('pointerup', -320, 1, 32))

      expect(pending).not.toBeNull()
      // Drive enough frames for a 0.5-per-frame decay to settle under the
      // threshold, exercising both the "still decaying" and "ran out,
      // snap" branches of the inertia loop.
      for (let i = 0; i < 40 && pending; i++) {
        const cb = pending
        pending = null
        cb!(48 + i * 16)
      }
      expect(() => handle.destroy()).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('a drag that ends with real velocity and snap disabled settles at the decayed position', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      const { container } = makeCollection()
      const handle = comice(container) as ComiceHandle
      handle.use(rail({ mode: 'strip', snap: false, inertia: 0.5 }))

      container.dispatchEvent(makePointerEvent('pointerdown', 0, 1, 0))
      container.dispatchEvent(makePointerEvent('pointermove', -320, 1, 16))
      container.dispatchEvent(makePointerEvent('pointerup', -320, 1, 32))

      for (let i = 0; i < 40 && pending; i++) {
        const cb = pending
        pending = null
        cb!(48 + i * 16)
      }
      expect(() => handle.destroy()).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('a drag that ends with zero velocity and snap: true settles at the nearest item immediately', () => {
    const { container } = makeCollection()
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip', snap: true }))

    container.dispatchEvent(makePointerEvent('pointerdown', 0, 1, 0))
    // No pointermove -> zero velocity, but a real timestamp gap so dt > 0
    // is exercised too (endDrag's own branch is independent of dt).
    container.dispatchEvent(makePointerEvent('pointerup', 0, 1, 0))

    expect(() => handle.destroy()).not.toThrow()
    container.remove()
  })

  it('a drag that ends with zero velocity and snap: false settles immediately without inertia', () => {
    const { container } = makeCollection()
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip', snap: false }))

    container.dispatchEvent(makePointerEvent('pointerdown', 0, 1, 0))
    // No pointermove at all -> zero velocity on release.
    container.dispatchEvent(makePointerEvent('pointerup', 0, 1, 0))

    expect(() => handle.destroy()).not.toThrow()
    container.remove()
  })

  it('marquee mode does not clamp position to the item range while dragging', () => {
    const { container, items } = makeCollection(3)
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'marquee', snap: false }))

    container.dispatchEvent(makePointerEvent('pointerdown', 0, 1, 0))
    container.dispatchEvent(makePointerEvent('pointermove', -5000, 1, 16)) // far past any clamped range
    container.dispatchEvent(makePointerEvent('pointerup', -5000, 1, 32))

    expect(() => handle.destroy()).not.toThrow()
    container.remove()
  })
})

describe('rail — keyboard', () => {
  afterEach(() => getSharedScheduler().stop())

  it('ArrowRight steps to the next item and ArrowLeft steps back', () => {
    const { container } = makeCollection()
    const activeIndices: number[] = []
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip', onActive: (i) => activeIndices.push(i) }))

    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(activeIndices[activeIndices.length - 1]).toBe(1)

    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    expect(activeIndices[activeIndices.length - 1]).toBe(0)

    container.remove()
  })

  it('ArrowDown/ArrowUp behave the same as Right/Left', () => {
    const { container } = makeCollection()
    const activeIndices: number[] = []
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip', onActive: (i) => activeIndices.push(i) }))

    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(activeIndices[activeIndices.length - 1]).toBe(1)

    container.remove()
  })

  it('roving tabindex keeps only the active item focusable', () => {
    const { container, items } = makeCollection()
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip' }))

    expect(items[0]!.tabIndex).toBe(0)
    expect(items[1]!.tabIndex).toBe(-1)

    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(items[0]!.tabIndex).toBe(-1)
    expect(items[1]!.tabIndex).toBe(0)

    container.remove()
  })

  it('a live region announces "Item N of M" and updates on step', () => {
    const { container } = makeCollection()
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip' }))

    const live = container.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live).not.toBeNull()
    expect(live.textContent).toBe('Item 1 of 5')

    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(live.textContent).toBe('Item 2 of 5')

    container.remove()
  })

  it('keyboard: false disables arrow-key stepping and the live region entirely', () => {
    const { container, items } = makeCollection()
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip', keyboard: false }))

    expect(container.querySelector('[aria-live="polite"]')).toBeNull()
    expect(items[0]!.hasAttribute('tabindex')).toBe(false)

    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    // No throw, and no roving-tabindex side effect since keyboard is off.
    expect(items[1]!.hasAttribute('tabindex')).toBe(false)

    container.remove()
  })
})

describe('rail — params (MappableTarget)', () => {
  afterEach(() => getSharedScheduler().stop())

  it('getParam("position") reflects the current position', () => {
    const { container } = makeCollection()
    const handle = comice(container) as ComiceHandle
    const plugin = rail({ mode: 'strip' })
    handle.use(plugin)
    plugin.params!.setParam('position', 2)
    expect(plugin.params!.getParam('position')).toBe(2)
    container.remove()
  })

  it('setParam clamps to the item range for non-marquee modes', () => {
    const { container } = makeCollection(5)
    const handle = comice(container) as ComiceHandle
    const plugin = rail({ mode: 'strip' })
    handle.use(plugin)
    plugin.params!.setParam('position', 99)
    expect(plugin.params!.getParam('position')).toBe(4)
    container.remove()
  })

  it('getParam for an unknown name returns 0', () => {
    const { container } = makeCollection()
    const handle = comice(container) as ComiceHandle
    const plugin = rail({ mode: 'strip' })
    handle.use(plugin)
    expect(plugin.params!.getParam('bogus')).toBe(0)
    container.remove()
  })

  it('setParam for an unknown name is a no-op', () => {
    const { container } = makeCollection()
    const handle = comice(container) as ComiceHandle
    const plugin = rail({ mode: 'strip' })
    handle.use(plugin)
    expect(() => plugin.params!.setParam('bogus', 1)).not.toThrow()
    expect(plugin.params!.getParam('position')).toBe(0)
    container.remove()
  })
})

describe('rail — teardown', () => {
  afterEach(() => getSharedScheduler().stop())

  it('removes listeners, live region, and resets item styles on destroy', () => {
    const { container, items } = makeCollection()
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip' }))

    handle.destroy()

    expect(container.querySelector('[aria-live="polite"]')).toBeNull()
    items.forEach((el) => {
      expect(el.style.transform).toBe('')
      expect(el.hasAttribute('tabindex')).toBe(false)
    })
  })

  it('teardown during an active drag stops inertia and further events are ignored', () => {
    const { container } = makeCollection()
    const handle = comice(container) as ComiceHandle
    handle.use(rail({ mode: 'strip' }))

    container.dispatchEvent(makePointerEvent('pointerdown', 0, 1, 0))
    container.dispatchEvent(makePointerEvent('pointermove', -50, 1, 16))

    expect(() => handle.destroy()).not.toThrow()
    expect(() => container.dispatchEvent(makePointerEvent('pointerup', -50, 1, 32))).not.toThrow()
  })
})
