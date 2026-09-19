/**
 * test/machine.test — packages/core/src/machine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure state machine tests — no DOM, matches machine.ts's own "zero DOM,
 * zero WebGL, zero side effects" contract. Pins down the legal-transition
 * table and the rest/display split before plugins start depending on them.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createInstance } from '../packages/core/src/machine.js'

describe('createInstance — initial state', () => {
  it('starts idle with zero progress and identity transforms', () => {
    const instance = createInstance()
    expect(instance.state).toBe('idle')
    expect(instance.progress).toBe(0)
    expect(instance.rest).toEqual({ x: 0, y: 0, scale: 1, rotate: 0 })
    expect(instance.display).toEqual({ x: 0, y: 0, scale: 1, rotate: 0 })
  })
})

describe('createInstance — legal transitions', () => {
  it('walks the full idle -> entering -> active -> leaving -> idle cycle', () => {
    const instance = createInstance()
    expect(instance.transition('entering')).toBe('entering')
    expect(instance.transition('active')).toBe('active')
    expect(instance.transition('leaving')).toBe('leaving')
    expect(instance.transition('idle')).toBe('idle')
  })

  it('allows an interrupted enter to go straight to leaving', () => {
    const instance = createInstance()
    instance.transition('entering')
    expect(instance.transition('leaving')).toBe('leaving')
  })

  it('allows an interrupted leave to re-enter without passing through idle', () => {
    const instance = createInstance()
    instance.transition('entering')
    instance.transition('active')
    instance.transition('leaving')
    expect(instance.transition('entering')).toBe('entering')
  })

  it('refuses an illegal jump and stays in the current state', () => {
    const instance = createInstance()
    // idle -> active skips entering; not in LEGAL_TRANSITIONS['idle'].
    expect(instance.transition('active')).toBe('idle')
    expect(instance.state).toBe('idle')
  })

  it('refuses idle -> leaving', () => {
    const instance = createInstance()
    expect(instance.transition('leaving')).toBe('idle')
  })

  it('refuses active -> entering (must leave first)', () => {
    const instance = createInstance()
    instance.transition('entering')
    instance.transition('active')
    expect(instance.transition('entering')).toBe('active')
  })

  it('transitioning to the current state is a no-op that does not emit', () => {
    const instance = createInstance()
    const listener = mock()
    instance.on('*', listener)
    expect(instance.transition('idle')).toBe('idle')
    expect(listener).not.toHaveBeenCalled()
  })

  it('resets progress to 0 on every state transition', () => {
    const instance = createInstance()
    instance.transition('entering')
    instance.setProgress(0.75)
    expect(instance.progress).toBe(0.75)
    instance.transition('active')
    expect(instance.progress).toBe(0)
  })
})

describe('createInstance — setProgress', () => {
  it('clamps to the 0..1 range', () => {
    const instance = createInstance()
    instance.setProgress(-0.5)
    expect(instance.progress).toBe(0)
    instance.setProgress(1.5)
    expect(instance.progress).toBe(1)
  })

  it('does not emit when the clamped value is unchanged', () => {
    const instance = createInstance()
    const listener = mock()
    instance.on('progress', listener)
    instance.setProgress(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('emits a progress event with the new value', () => {
    const instance = createInstance()
    const listener = mock()
    instance.on('progress', listener)
    instance.setProgress(0.5)
    expect(listener).toHaveBeenCalledTimes(1)
    const [snapshot, event] = listener.mock.calls[0]
    expect(event).toEqual({ type: 'progress', value: 0.5 })
    expect(snapshot.progress).toBe(0.5)
  })
})

describe('createInstance — rest vs display', () => {
  it('setRest does not affect display', () => {
    const instance = createInstance()
    instance.setRest({ x: 10 })
    expect(instance.rest).toEqual({ x: 10, y: 0, scale: 1, rotate: 0 })
    expect(instance.display).toEqual({ x: 0, y: 0, scale: 1, rotate: 0 })
  })

  it('setDisplay does not affect rest', () => {
    const instance = createInstance()
    instance.setDisplay({ scale: 1.2 })
    expect(instance.display).toEqual({ x: 0, y: 0, scale: 1.2, rotate: 0 })
    expect(instance.rest).toEqual({ x: 0, y: 0, scale: 1, rotate: 0 })
  })

  it('partial patches merge rather than replace the whole transform', () => {
    const instance = createInstance()
    instance.setRest({ x: 5 })
    instance.setRest({ y: 8 })
    expect(instance.rest).toEqual({ x: 5, y: 8, scale: 1, rotate: 0 })
  })

  it('getters return clones, not live references', () => {
    const instance = createInstance()
    const rest = instance.rest
    rest.x = 999
    expect(instance.rest.x).toBe(0)
  })
})

describe('createInstance — event subscriptions', () => {
  it('a wildcard listener receives every event type', () => {
    const instance = createInstance()
    const listener = mock()
    instance.on('*', listener)
    instance.transition('entering')
    instance.setProgress(0.3)
    instance.setRest({ x: 1 })
    instance.setDisplay({ y: 1 })
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('a typed listener only receives its own event type', () => {
    const instance = createInstance()
    const activeListener = mock()
    instance.on('active', activeListener)
    instance.transition('entering')
    instance.transition('active')
    expect(activeListener).toHaveBeenCalledTimes(1)
  })

  it('off() unsubscribes a typed listener', () => {
    const instance = createInstance()
    const listener = mock()
    instance.on('entering', listener)
    instance.off('entering', listener)
    instance.transition('entering')
    expect(listener).not.toHaveBeenCalled()
  })

  it('off() unsubscribes a wildcard listener', () => {
    const instance = createInstance()
    const listener = mock()
    instance.on('*', listener)
    instance.off('*', listener)
    instance.transition('entering')
    expect(listener).not.toHaveBeenCalled()
  })

  it('the unsubscribe function returned by on() works', () => {
    const instance = createInstance()
    const listener = mock()
    const unsub = instance.on('entering', listener)
    unsub()
    instance.transition('entering')
    expect(listener).not.toHaveBeenCalled()
  })

  it('an illegal transition does not emit any event', () => {
    const instance = createInstance()
    const listener = mock()
    instance.on('*', listener)
    instance.transition('active') // illegal from idle
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('createInstance — destroy', () => {
  it('clears all subscribers', () => {
    const instance = createInstance()
    const listener = mock()
    instance.on('*', listener)
    instance.destroy()
    instance.transition('entering')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('createInstance — multiple instances are independent', () => {
  it('transitioning one instance does not affect another', () => {
    const a = createInstance()
    const b = createInstance()
    a.transition('entering')
    expect(a.state).toBe('entering')
    expect(b.state).toBe('idle')
  })
})
