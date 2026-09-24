/**
 * test/persist-registry.test — packages/persist/src/registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The registry is module-level state (deliberately — see its own file
 * header for why persist can't scope this to one instance), so every test
 * clears it in beforeEach via clearRegistryForTests(), the same escape
 * hatch getSharedScheduler().stop() gives scheduler.test.ts for the
 * identical "module singleton, needs a clean slate per test" reason.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { claim, clearRegistryForTests, hasPending, register, unregister } from '../packages/persist/src/registry.js'

function fakeImage(rect: { x: number; y: number; width: number; height: number }): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'getBoundingClientRect', {
    value: () => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height, right: rect.x + rect.width, bottom: rect.y + rect.height, x: rect.x, y: rect.y, toJSON() {} }),
    configurable: true,
  })
  return img
}

beforeEach(() => {
  clearRegistryForTests()
})

describe('register / claim', () => {
  it('claim() returns null for a match key that was never registered', () => {
    expect(claim('nonexistent')).toBeNull()
  })

  it('register() then claim() round-trips the same element', () => {
    const img = fakeImage({ x: 10, y: 20, width: 100, height: 50 })
    register('hero', img, 'shared')
    const entry = claim('hero')
    expect(entry).not.toBeNull()
    expect(entry!.element).toBe(img)
    expect(entry!.match).toBe('hero')
    expect(entry!.transition).toBe('shared')
  })

  it('captures the element\'s real box at registration time as fromRect', () => {
    const img = fakeImage({ x: 10, y: 20, width: 100, height: 50 })
    register('hero', img, 'shared')
    const entry = claim('hero')!
    expect(entry.fromRect).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  it('claim() removes the entry — a second claim() on the same key returns null', () => {
    const img = fakeImage({ x: 0, y: 0, width: 10, height: 10 })
    register('hero', img, 'shared')
    expect(claim('hero')).not.toBeNull()
    expect(claim('hero')).toBeNull()
  })

  it('registering a new element under the same key overwrites the previous one', () => {
    const first = fakeImage({ x: 0, y: 0, width: 10, height: 10 })
    const second = fakeImage({ x: 5, y: 5, width: 20, height: 20 })
    register('hero', first, 'shared')
    register('hero', second, 'blend')
    const entry = claim('hero')!
    expect(entry.element).toBe(second)
    expect(entry.transition).toBe('blend')
  })

  it('different match keys do not collide', () => {
    const a = fakeImage({ x: 0, y: 0, width: 10, height: 10 })
    const b = fakeImage({ x: 0, y: 0, width: 10, height: 10 })
    register('hero-a', a, 'shared')
    register('hero-b', b, 'iris')
    expect(claim('hero-a')!.element).toBe(a)
    expect(claim('hero-b')!.element).toBe(b)
  })

  it('preserves each of the four transition names exactly', () => {
    for (const transition of ['shared', 'blend', 'curtain', 'iris'] as const) {
      const img = fakeImage({ x: 0, y: 0, width: 10, height: 10 })
      register(`key-${transition}`, img, transition)
      expect(claim(`key-${transition}`)!.transition).toBe(transition)
    }
  })
})

describe('unregister', () => {
  it('removes a pending entry without it ever being claimed', () => {
    const img = fakeImage({ x: 0, y: 0, width: 10, height: 10 })
    register('hero', img, 'shared')
    unregister('hero')
    expect(claim('hero')).toBeNull()
  })

  it('is a no-op (does not throw) for a key with no entry', () => {
    expect(() => unregister('nonexistent')).not.toThrow()
  })
})

describe('hasPending', () => {
  it('is false before any registration', () => {
    expect(hasPending('hero')).toBe(false)
  })

  it('is true after register(), false after claim()', () => {
    const img = fakeImage({ x: 0, y: 0, width: 10, height: 10 })
    register('hero', img, 'shared')
    expect(hasPending('hero')).toBe(true)
    claim('hero')
    expect(hasPending('hero')).toBe(false)
  })

  it('is false after unregister()', () => {
    const img = fakeImage({ x: 0, y: 0, width: 10, height: 10 })
    register('hero', img, 'shared')
    unregister('hero')
    expect(hasPending('hero')).toBe(false)
  })
})
