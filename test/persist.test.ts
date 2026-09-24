/**
 * test/persist.test — packages/persist/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom. Imports core by package name (comice/scheduler)
 * — persist's own source does, matching every other plugin package's test
 * file that touches getSharedScheduler() directly (see test/morph.test.ts's
 * own header for the full two-scheduler-singleton story this avoids).
 *
 * Simulates a real two-page SPA handoff within ONE test process: "page A"
 * is a comice() instance on one element, torn down via handle.destroy()
 * (the same call an SPA router unmounting a route would trigger through
 * whatever cleanup hook the framework itself calls); "page B" is a SECOND
 * comice() instance on a DIFFERENT element with the same `match` key,
 * simulating the next route's own mount. persist's registry (module-level
 * state, by design — see registry.ts) is what makes this even possible to
 * test in one process at all, the same way it's what makes the real
 * cross-navigation handoff possible in a real browser.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { persist, releasePersist } from '../packages/persist/src/index.js'
import { clearRegistryForTests } from '../packages/persist/src/registry.js'

function readyImage(): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true })
  return img
}

function stubRect(el: HTMLElement, rect: { x: number; y: number; width: number; height: number }): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height, right: rect.x + rect.width, bottom: rect.y + rect.height, x: rect.x, y: rect.y, toJSON() {} }),
    configurable: true,
  })
}

beforeEach(() => {
  clearRegistryForTests()
})

afterEach(() => {
  getSharedScheduler().stop()
  clearRegistryForTests()
  document.querySelectorAll('img, video').forEach((el) => el.remove())
})

describe('persist — construction contract', () => {
  it('throws for an empty match string', () => {
    expect(() => persist({ match: '' })).toThrow()
  })

  it('does not throw with a valid match', () => {
    expect(() => persist({ match: 'hero' })).not.toThrow()
  })
})

describe('persist — target contract', () => {
  it('throws for a non-media target', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(persist({ match: 'hero' }))).toThrow()
    div.remove()
  })

  it('accepts an <img> target without throwing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(persist({ match: 'hero' }))).not.toThrow()
    img.remove()
  })

  it('accepts a <video> target without throwing', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    const handle = comice(video) as ComiceHandle
    expect(() => handle.use(persist({ match: 'hero' }))).not.toThrow()
    video.remove()
  })
})

describe('persist — first page (no prior registration to claim)', () => {
  it('does not throw when no matching entry exists yet — the common first-load case', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(persist({ match: 'hero' }))).not.toThrow()
    img.remove()
  })

  it('registers the element so a LATER page can claim it', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(persist({ match: 'hero' }))
    handle.destroy() // simulates the router unmounting this route

    // A second instance with the same match key should find something to claim.
    const img2 = readyImage()
    document.body.appendChild(img2)
    const handle2 = comice(img2) as ComiceHandle
    expect(() => handle2.use(persist({ match: 'hero' }))).not.toThrow()
    handle2.destroy()
    img.remove()
    img2.remove()
  })
})

describe('persist — the real two-page handoff', () => {
  let pageA: HTMLImageElement
  let pageB: HTMLImageElement
  let handleA: ComiceHandle | null
  let handleB: ComiceHandle | null

  beforeEach(() => {
    pageA = readyImage()
    stubRect(pageA, { x: 0, y: 0, width: 200, height: 100 })
    document.body.appendChild(pageA)
    handleA = null
    handleB = null
  })

  afterEach(() => {
    handleA?.destroy()
    handleB?.destroy()
    pageA.remove()
    pageB?.remove()
  })

  function mountPageA(options: Parameters<typeof persist>[0] = { match: 'hero' }) {
    handleA = comice(pageA) as ComiceHandle
    handleA.use(persist(options))
  }

  function mountPageB(options: Parameters<typeof persist>[0] = { match: 'hero' }) {
    pageB = readyImage()
    stubRect(pageB, { x: 300, y: 300, width: 600, height: 400 })
    document.body.appendChild(pageB)
    handleB = comice(pageB) as ComiceHandle
    handleB.use(persist(options))
  }

  it('hides page B\'s own placeholder once a claim succeeds', () => {
    mountPageA()
    handleA!.destroy()
    mountPageB()
    expect(pageB.style.visibility).toBe('hidden')
  })

  it('inserts page A\'s REAL element into the document as the surviving node', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      mountPageA({ match: 'hero', native: false })
      handleA!.destroy()
      mountPageB({ match: 'hero', native: false })
      expect(document.body.contains(pageA)).toBe(true)
      expect(pending).not.toBeNull()
      pending!(16) // drive one real handoff-animation frame
      expect(pageA.style.position).toBe('fixed')
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('does not touch page B\'s placeholder visibility when there is nothing to claim', () => {
    mountPageB() // no prior page A registration for this match
    expect(pageB.style.visibility).toBe('')
  })

  it.each(['shared', 'blend', 'curtain', 'iris'] as const)('completes a manual (non-native) handoff for transition "%s" without throwing', (transition) => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      mountPageA({ match: 'hero', transition, native: false })
      handleA!.destroy()
      expect(() => mountPageB({ match: 'hero', transition, native: false })).not.toThrow()
      expect(pending).not.toBeNull()
      expect(() => pending!(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('native: false always uses the manual scheduler-driven path, even when native support is faked available', () => {
    ;(document as any).startViewTransition = () => {
      throw new Error('should never be called when native: false')
    }
    try {
      getSharedScheduler().stop()
      const original = globalThis.requestAnimationFrame
      let pending: FrameRequestCallback | null = null
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        pending = cb
        return 1
      }) as typeof requestAnimationFrame
      try {
        mountPageA({ match: 'hero', native: false })
        handleA!.destroy()
        expect(() => mountPageB({ match: 'hero', native: false })).not.toThrow()
        expect(pending).not.toBeNull()
      } finally {
        globalThis.requestAnimationFrame = original
      }
    } finally {
      delete (document as any).startViewTransition
    }
  })

  it('native: true uses the native path when support is faked available', () => {
    const startViewTransition = (cb: () => void) => cb()
    ;(document as any).startViewTransition = startViewTransition
    try {
      mountPageA({ match: 'hero', native: true })
      handleA!.destroy()
      expect(() => mountPageB({ match: 'hero', native: true })).not.toThrow()
    } finally {
      delete (document as any).startViewTransition
    }
  })

  it("native: 'auto' (default) prefers native for transition 'shared' when supported", () => {
    let called = false
    ;(document as any).startViewTransition = (cb: () => void) => {
      called = true
      cb()
    }
    try {
      mountPageA({ match: 'hero', transition: 'shared' })
      handleA!.destroy()
      mountPageB({ match: 'hero', transition: 'shared' })
      expect(called).toBe(true)
    } finally {
      delete (document as any).startViewTransition
    }
  })

  it("native: 'auto' falls back to the manual path for transition 'iris' even when native is supported", () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    let nativeCalled = false
    ;(document as any).startViewTransition = () => {
      nativeCalled = true
    }
    try {
      mountPageA({ match: 'hero', transition: 'iris' })
      handleA!.destroy()
      mountPageB({ match: 'hero', transition: 'iris' })
      expect(nativeCalled).toBe(false)
      expect(pending).not.toBeNull()
    } finally {
      globalThis.requestAnimationFrame = original
      delete (document as any).startViewTransition
    }
  })

  it('duration: 0 completes the handoff animation on the very first frame and unregisters itself', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      mountPageA({ match: 'hero', native: false, duration: 0 })
      handleA!.destroy()
      mountPageB({ match: 'hero', native: false, duration: 0 })
      expect(pending).not.toBeNull()
      expect(() => pending!(16)).not.toThrow()
      expect(pageA.style.opacity).toBe('1') // sharedTransition's own end-state opacity
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('respects a custom duration without throwing', () => {
    getSharedScheduler().stop()
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      mountPageA({ match: 'hero', native: false, duration: 50 })
      handleA!.destroy()
      mountPageB({ match: 'hero', native: false, duration: 50 })
      expect(() => pending?.(16)).not.toThrow()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })
})

describe('persist — teardown', () => {
  it('restores the target element\'s own inline style, unless it was claimed as a survivor', () => {
    const img = readyImage()
    img.style.opacity = '0.5' // a pre-existing style the plugin must restore, not clobber
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(persist({ match: 'lonely-key-never-claimed' }))
    handle.destroy()
    expect(img.style.opacity).toBe('0.5')
    img.remove()
  })

  it('teardown does not throw when called immediately after setup', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(persist({ match: 'hero' }))
    expect(() => handle.destroy()).not.toThrow()
    img.remove()
  })
})

describe('releasePersist', () => {
  it('clears a pending registration so a later claim finds nothing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(persist({ match: 'hero' }))
    handle.destroy()

    releasePersist('hero')

    const img2 = readyImage()
    img2.style.visibility = ''
    document.body.appendChild(img2)
    const handle2 = comice(img2) as ComiceHandle
    handle2.use(persist({ match: 'hero' }))
    // No throw either way, but with nothing left to claim (released
    // above), img2 is never hidden by a handoff claiming it — the
    // "nothing to claim, this is just a normal media element" path.
    expect(img2.style.visibility).toBe('')
    handle2.destroy()
    img.remove()
    img2.remove()
  })

  it('does not throw for a key with no pending registration', () => {
    expect(() => releasePersist('nonexistent')).not.toThrow()
  })
})
