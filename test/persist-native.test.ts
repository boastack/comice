/**
 * test/persist-native.test — packages/persist/src/native.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * happy-dom has no real View Transitions API at all (document.startViewTransition
 * is undefined) — same class of environment gap as WebGL2/2D canvas. This
 * file covers the honest, real behavior available under this repo's own
 * test environment (the no-support fallback path) plus a faked-support
 * path (a stand-in startViewTransition, since real behavior can't be
 * exercised here — the same "verified for shape, not for real browser
 * behavior" limitation every GL primitive in this repo already carries,
 * see harness/README.md).
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { runViewTransition, supportsNativeViewTransitions } from '../packages/persist/src/native.js'

describe('supportsNativeViewTransitions', () => {
  it('is false under happy-dom (no real View Transitions implementation)', () => {
    expect(supportsNativeViewTransitions()).toBe(false)
  })

  it('is true when document.startViewTransition is a function (faked)', () => {
    const original = (document as any).startViewTransition
    ;(document as any).startViewTransition = () => {}
    try {
      expect(supportsNativeViewTransitions()).toBe(true)
    } finally {
      ;(document as any).startViewTransition = original
    }
  })

  it('is false when startViewTransition exists but is not a function', () => {
    const original = (document as any).startViewTransition
    ;(document as any).startViewTransition = 'not-a-function'
    try {
      expect(supportsNativeViewTransitions()).toBe(false)
    } finally {
      ;(document as any).startViewTransition = original
    }
  })
})

describe('runViewTransition', () => {
  afterEach(() => {
    delete (document as any).startViewTransition
  })

  it('calls updateCallback directly when no native support exists', () => {
    const cb = mock()
    runViewTransition(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('does not throw when updateCallback itself throws on the no-native path', () => {
    expect(() =>
      runViewTransition(() => {
        throw new Error('boom')
      }),
    ).not.toThrow()
  })

  it('calls document.startViewTransition(updateCallback) when native support exists', () => {
    const startViewTransition = mock()
    ;(document as any).startViewTransition = startViewTransition
    const cb = () => {}
    runViewTransition(cb)
    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(startViewTransition).toHaveBeenCalledWith(cb)
  })

  it('does not call the fallback path when native support exists', () => {
    const startViewTransition = mock()
    ;(document as any).startViewTransition = startViewTransition
    const cb = mock()
    runViewTransition(cb)
    // cb is passed TO startViewTransition, never invoked directly by
    // runViewTransition itself on the native path — the real API owns
    // calling it.
    expect(cb).not.toHaveBeenCalled()
  })
})
