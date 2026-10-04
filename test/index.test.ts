/**
 * test/index.test — packages/core/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) since comice() queries
 * the real DOM. Covers the public surface: comice()/.use()/.driver()/
 * .map().to()/.destroy() — the contract every plugin and driver is written
 * against.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { comice, type ComiceHandle, type ComicePlugin } from '../packages/core/src/index.js'
import type { Driver, DriverSignal, MappableTarget, NamedSignalDriver, SignalValues } from '../packages/core/src/types.js'

function fakePlugin(): ComicePlugin & { setupCalls: number; teardownCalls: number } {
  return {
    name: 'fake',
    setupCalls: 0,
    teardownCalls: 0,
    setup() {
      this.setupCalls++
    },
    teardown() {
      this.teardownCalls++
    },
  }
}

function mappablePlugin(): ComicePlugin & { params: MappableTarget; values: Record<string, number> } {
  const values: Record<string, number> = {}
  return {
    name: 'mappable',
    setup() {},
    values,
    params: {
      getParam: (name) => values[name] ?? 0,
      setParam: (name, value) => {
        values[name] = value
      },
    },
  }
}

/** A plain Driver: reports only `progress`, drives the state machine. */
function fakeDriver(): Driver & { fire(signal: DriverSignal): void; teardownCalls: number } {
  let onSignal: ((signal: DriverSignal) => void) | null = null
  return {
    name: 'fake-driver',
    teardownCalls: 0,
    attach(_target, cb) {
      onSignal = cb
      return () => {
        this.teardownCalls++
      }
    },
    fire(signal) {
      onSignal?.(signal)
    },
  }
}

/** A NamedSignalDriver: reports a signal bag, no state-machine progress. */
function fakeSignalDriver(): NamedSignalDriver & { fire(signals: SignalValues): void } {
  let onSignals: ((signals: Readonly<SignalValues>) => void) | null = null
  return {
    name: 'fake-signal-driver',
    attachSignals(_target, cb) {
      onSignals = cb
      return () => {}
    },
    fire(signals) {
      onSignals?.(signals)
    },
  }
}

describe('comice() — target resolution', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    el.className = 'target'
    document.body.appendChild(el)
  })

  afterEach(() => {
    el.remove()
    document.querySelectorAll('.target').forEach((node) => node.remove())
  })

  it('wraps a single Element directly', () => {
    const handle = comice(el) as ComiceHandle
    expect(handle.state).toBe('idle')
  })

  it('wraps a single-match selector as one handle, not an array', () => {
    const handle = comice('.target')
    expect(Array.isArray(handle)).toBe(false)
    expect((handle as ComiceHandle).state).toBe('idle')
  })

  it('a NodeList of one element is one handle too', () => {
    const handle = comice(document.querySelectorAll('.target'))
    expect(handle.handles).toHaveLength(1)
    expect(handle.state).toBe('idle')
  })
})

describe('comice() — .use()', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
  })

  it('calls the plugin setup hook with the target and the instance', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = fakePlugin()
    handle.use(plugin)
    expect(plugin.setupCalls).toBe(1)
  })

  it('is chainable', () => {
    const handle = comice(el) as ComiceHandle
    const result = handle.use(fakePlugin())
    expect(result).toBe(handle)
  })

  it('calls every used plugin teardown on destroy()', () => {
    const handle = comice(el) as ComiceHandle
    const a = fakePlugin()
    const b = fakePlugin()
    handle.use(a).use(b)
    handle.destroy()
    expect(a.teardownCalls).toBe(1)
    expect(b.teardownCalls).toBe(1)
  })
})

describe('comice() — .driver() with a plain Driver', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
  })

  it('drives instance.progress from the driver signal while state does not change', () => {
    const handle = comice(el) as ComiceHandle
    const driver = fakeDriver()
    handle.driver(driver)
    // First fire from idle triggers idle -> entering, which (correctly,
    // per machine.ts) resets progress to 0. Fire a second signal, still
    // within 'entering' (progress < 1 does not trigger entering -> active),
    // to observe setProgress without a transition resetting it.
    driver.fire({ progress: 0.3 })
    driver.fire({ progress: 0.5 })
    expect(handle.state).toBe('entering')
    expect(handle.progress).toBeCloseTo(0.5)
  })

  it('transitions idle -> entering -> active -> leaving -> idle, one transition per signal', () => {
    const handle = comice(el) as ComiceHandle
    const driver = fakeDriver()
    handle.driver(driver)

    driver.fire({ progress: 0.3 })
    expect(handle.state).toBe('entering')

    driver.fire({ progress: 1 })
    expect(handle.state).toBe('active')

    // A single progress <= 0 signal advances exactly one transition
    // (active -> leaving), not two (active -> leaving -> idle) in one
    // call — see index.ts's `else if` chain.
    driver.fire({ progress: 0 })
    expect(handle.state).toBe('leaving')

    driver.fire({ progress: 0 })
    expect(handle.state).toBe('idle')
  })

  it('tears down the driver on destroy()', () => {
    const handle = comice(el) as ComiceHandle
    const driver = fakeDriver()
    handle.driver(driver)
    handle.destroy()
    expect(driver.teardownCalls).toBe(1)
  })

  it('routes signal.pointer into instance.display.x/y — previously had no path to a plugin at all', () => {
    const handle = comice(el) as ComiceHandle
    const driver = fakeDriver()
    handle.driver(driver)

    driver.fire({ progress: 1, pointer: { x: 42, y: 17 } })

    expect(handle.display.x).toBe(42)
    expect(handle.display.y).toBe(17)
  })

  it('does not touch display.x/y when a signal carries no pointer field', () => {
    const handle = comice(el) as ComiceHandle
    const driver = fakeDriver()
    handle.driver(driver)

    driver.fire({ progress: 1, pointer: { x: 5, y: 9 } })
    driver.fire({ progress: 1 }) // no pointer this time

    // display.x/y stay at their last-set value rather than resetting —
    // setDisplay() merges a partial Transform, it does not replace it.
    expect(handle.display.x).toBe(5)
    expect(handle.display.y).toBe(9)
  })

  it('display.scale/rotate stay at their Transform defaults — pointer routing only ever touches x/y', () => {
    const handle = comice(el) as ComiceHandle
    const driver = fakeDriver()
    handle.driver(driver)

    driver.fire({ progress: 1, pointer: { x: 5, y: 9 } })

    expect(handle.display.scale).toBe(1)
    expect(handle.display.rotate).toBe(0)
  })

  it('a plugin subscribed via instance.on(\'*\') observes the routed pointer position', () => {
    const handle = comice(el) as ComiceHandle
    const driver = fakeDriver()
    handle.driver(driver)

    let observedX: number | null = null
    let observedY: number | null = null
    handle.on('*', (snapshot) => {
      observedX = snapshot.display.x
      observedY = snapshot.display.y
    })

    driver.fire({ progress: 1, pointer: { x: 33, y: 8 } })

    expect(observedX).toBe(33)
    expect(observedY).toBe(8)
  })
})

describe('comice() — .driver() with a NamedSignalDriver', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
  })

  it('does not touch instance.progress or state (no attach implemented)', () => {
    const handle = comice(el) as ComiceHandle
    const driver = fakeSignalDriver()
    handle.driver(driver)
    driver.fire({ bass: 0.9 })
    expect(handle.progress).toBe(0)
    expect(handle.state).toBe('idle')
  })
})

describe('comice() — many elements, one chainable handle (spec §04)', () => {
  // It used to return an ARRAY for several matches (and [] for none), so
  // comice('.card').use(...) threw on any page with two cards.
  let els: HTMLElement[]

  beforeEach(() => {
    els = [0, 1, 2].map(() => {
      const el = document.createElement('div')
      el.className = 'card'
      document.body.appendChild(el)
      return el
    })
  })
  afterEach(() => els.forEach((el) => el.remove()))

  /** A plugin whose create() makes copies, recording which element each set up on. */
  function copyablePlugin(log: Element[] = []): ComicePlugin & { params: MappableTarget; values: Record<string, number>; log: Element[] } {
    const values: Record<string, number> = {}
    return {
      name: 'copyable',
      log,
      values,
      setup(target) {
        log.push(target)
      },
      params: {
        getParam: (name) => values[name] ?? 0,
        setParam: (name, value) => {
          values[name] = value
        },
      },
      create: () => copyablePlugin(log),
    }
  }

  it('is one handle that chains, with one handle per element underneath', () => {
    const handle = comice('.card')
    expect(Array.isArray(handle)).toBe(false)
    expect(handle.handles).toHaveLength(3)
    expect(handle.driver(fakeDriver())).toBe(handle)
  })

  it('.use() gives every element its own copy of the plugin', () => {
    const log: Element[] = []
    comice('.card').use(copyablePlugin(log))
    expect(log).toEqual(els) // set up once per element, each on its own
  })

  it('a plugin with no create() fails clearly, before touching any element', () => {
    const plugin = fakePlugin()
    expect(() => comice('.card').use(plugin)).toThrow(/can't be used on 3 elements at once: it has no create\(\)/)
    expect(plugin.setupCalls).toBe(0)
  })

  it('.set() applies to every element; scoped to a plugin, it reaches each element\'s copy', () => {
    const plugin = copyablePlugin()
    const handle = comice('.card').use(plugin)
    handle.set({ progress: 0.4 })
    expect(handle.handles.map((h) => h.progress)).toEqual([0.4, 0.4, 0.4])
    handle.set(plugin, { amount: 0.7 })
    expect(plugin.values.amount).toBe(0.7) // the original (first element); copies get it too, checked via .map below
  })

  it('.map().to(plugin) feeds every copy of that plugin', () => {
    const plugin = copyablePlugin()
    const copies: Array<Record<string, number>> = []
    const original = plugin.create!
    plugin.create = () => {
      const copy = original() as ReturnType<typeof copyablePlugin>
      copies.push(copy.values)
      return copy
    }
    const listeners: Array<(signals: Readonly<SignalValues>) => void> = []
    const driver: NamedSignalDriver = {
      name: 'every-attach',
      attachSignals(_target, cb) {
        listeners.push(cb)
        return () => {}
      },
    }
    comice('.card').use(plugin).driver(driver).map('bass').to(plugin, 'amount')
    listeners.forEach((cb) => cb({ bass: 0.6 }))
    expect([plugin.values.amount, ...copies.map((v) => v.amount)]).toEqual([0.6, 0.6, 0.6])
  })

  it('.on() listens to every element, and its unsubscribe removes all of them', () => {
    const handle = comice('.card')
    let heard = 0
    const off = handle.on('entering', () => heard++)
    handle.transition('entering')
    expect(heard).toBe(3)
    off()
    handle.transition('leaving')
    handle.transition('entering')
    expect(heard).toBe(3)
    const listener = () => heard++
    handle.on('idle', listener)
    handle.off('idle', listener)
    handle.transition('leaving')
    handle.transition('idle')
    expect(heard).toBe(3)
  })

  it('driven: false until .driver(); true for every element after', () => {
    const handle = comice('.card')
    expect(handle.driven).toBe(false)
    handle.driver(fakeDriver())
    expect([handle.driven, ...handle.handles.map((h) => h.driven)]).toEqual([true, true, true, true])
    expect(comice('.none-at-all-here').driven).toBe(false)
  })

  it('state, progress and transforms read from the first element; setters reach all', () => {
    const handle = comice('.card')
    expect(handle.transition('entering')).toBe('entering')
    handle.setProgress(0.5)
    handle.setRest({ x: 4 })
    handle.setDisplay({ y: 2 })
    expect(handle.state).toBe('entering')
    expect(handle.progress).toBe(0.5)
    expect(handle.rest.x).toBe(4)
    expect(handle.display.y).toBe(2)
    expect(handle.handles.every((h) => h.progress === 0.5 && h.rest.x === 4)).toBe(true)
  })

  it('ready/fail and destroy reach every element', async () => {
    const handle = comice('.card')
    const seen: string[] = []
    handle.on('*', (_s, e) => seen.push(e.type))
    handle.ready('x')
    handle.fail('x', new Error('no'))
    await new Promise<void>((r) => queueMicrotask(r))
    expect(seen.filter((t) => t === 'ready')).toHaveLength(3)
    expect(seen.filter((t) => t === 'error')).toHaveLength(3)

    const plugin = copyablePlugin()
    let torn = 0
    const counting = { ...plugin, teardown: () => torn++, create: () => ({ ...copyablePlugin(), teardown: () => torn++ }) }
    comice('.card').use(counting).destroy()
    expect(torn).toBe(3)
  })

  it('no matches: a handle that does nothing (and a dev warning), not a crash', () => {
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (message: string) => void warnings.push(message)
    try {
      const handle = comice('.nothing-here')
      expect(() => handle.use(copyablePlugin()).driver(fakeDriver()).set({ progress: 1 }).map('x').to(copyablePlugin(), 'y')).not.toThrow()
      expect(handle.handles).toHaveLength(0)
      expect([handle.state, handle.progress, handle.rest.scale, handle.display.scale]).toEqual(['idle', 0, 1, 1])
      expect(handle.transition('entering')).toBe('idle')
      expect(warnings[0]).toMatch(/comice\('\.nothing-here'\) matched no elements/)
      expect(() => comice(document.querySelectorAll('.nothing-here'))).not.toThrow() // NodeList: same, no selector to name
    } finally {
      console.warn = warn
    }
  })
})

describe('comice() — .map().to()', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
  })

  it('routes a named signal into a plugin parameter', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = mappablePlugin()
    handle.use(plugin)

    const driver = fakeSignalDriver()
    handle.driver(driver).map('bass').to(plugin, 'amount')

    driver.fire({ bass: 0.72 })
    expect(plugin.values.amount).toBeCloseTo(0.72)
  })

  it('applies mapping options (output range)', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = mappablePlugin()
    handle.use(plugin)

    const driver = fakeSignalDriver()
    handle.driver(driver).map('bass').to(plugin, 'amount', { output: [0, 0.8] })

    driver.fire({ bass: 1 })
    expect(plugin.values.amount).toBeCloseTo(0.8)
  })

  it('supports multiple mappings from one driver to different plugins', () => {
    const handle = comice(el) as ComiceHandle
    const distortLike = mappablePlugin()
    const auraLike = mappablePlugin()
    handle.use(distortLike).use(auraLike)

    const driver = fakeSignalDriver()
    handle
      .driver(driver)
      .map('bass')
      .to(distortLike, 'amount')
      .map('energy')
      .to(auraLike, 'intensity')

    driver.fire({ bass: 0.4, energy: 0.9 })
    expect(distortLike.values.amount).toBeCloseTo(0.4)
    expect(auraLike.values.intensity).toBeCloseTo(0.9)
  })

  it('is chainable back to the handle', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = mappablePlugin()
    handle.use(plugin)
    const driver = fakeSignalDriver()
    const result = handle.driver(driver).map('bass').to(plugin, 'amount')
    expect(result).toBe(handle)
  })

  it('throws when the target plugin has no params', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = fakePlugin() // no `params`
    handle.use(plugin)
    const driver = fakeSignalDriver()
    handle.driver(driver)
    expect(() => handle.map('bass').to(plugin, 'amount')).toThrow()
  })

  it('ignores an absent signal key rather than throwing', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = mappablePlugin()
    handle.use(plugin)
    const driver = fakeSignalDriver()
    handle.driver(driver).map('nonexistent').to(plugin, 'amount')
    expect(() => driver.fire({ bass: 0.5 })).not.toThrow()
    expect(plugin.values.amount).toBeUndefined()
  })

  it('one mapping throwing (e.g. a plugin validating its own param) does not block other mappings on the same signal', () => {
    const handle = comice(el) as ComiceHandle
    const throwingPlugin: ComicePlugin = {
      name: 'throwing',
      setup() {},
      params: {
        getParam: () => 0,
        setParam: () => {
          throw new Error('rejected')
        },
      },
    }
    const healthyPlugin = mappablePlugin()
    handle.use(throwingPlugin).use(healthyPlugin)

    const driver = fakeSignalDriver()
    handle
      .driver(driver)
      .map('bass')
      .to(throwingPlugin, 'amount')
      .map('bass')
      .to(healthyPlugin, 'amount')

    expect(() => driver.fire({ bass: 0.5 })).not.toThrow()
    expect(healthyPlugin.values.amount).toBeCloseTo(0.5)
  })
})

describe('comice() — .set() (spec §04: applies immediately, no transition)', () => {
  function el(): HTMLElement {
    const div = document.createElement('div')
    document.body.appendChild(div)
    return div
  }

  it('writes each value into every attached plugin, and returns the handle for chaining', () => {
    const a = mappablePlugin()
    const b = mappablePlugin()
    const handle = comice(el()) as ComiceHandle
    expect(handle.use(a).use(b).set({ strength: 0.8, radius: 120 })).toBe(handle)
    expect(a.values).toEqual({ strength: 0.8, radius: 120 })
    expect(b.values).toEqual({ strength: 0.8, radius: 120 })
  })

  it('progress sets the instance directly — no state transition', () => {
    const handle = comice(el()) as ComiceHandle
    const states: string[] = []
    handle.on('*', (s) => states.push(s.state))
    handle.set({ progress: 0.6 })
    expect(handle.progress).toBe(0.6)
    expect(handle.state).toBe('idle') // a driver signal would have entered; set() does not
    expect(states).toEqual(['idle'])
  })

  it('progress is not passed to plugins as a parameter when unscoped', () => {
    const p = mappablePlugin()
    const handle = comice(el()) as ComiceHandle
    handle.use(p).set({ progress: 0.3 })
    expect(p.values).toEqual({})
  })

  it('scoped to one plugin: only that plugin receives the values, including its own `progress`', () => {
    const a = mappablePlugin()
    const b = mappablePlugin()
    const handle = comice(el()) as ComiceHandle
    handle.use(a).use(b).set(b, { strength: 0.5, progress: 0.4 })
    expect(a.values).toEqual({})
    expect(b.values).toEqual({ strength: 0.5, progress: 0.4 })
    expect(handle.progress).toBe(0) // the instance's progress is untouched
  })

  it('plugins without params are skipped, not an error', () => {
    const handle = comice(el()) as ComiceHandle
    handle.use(fakePlugin())
    expect(() => handle.set({ strength: 1 })).not.toThrow()
  })
})

describe('comice() — .destroy() crash isolation', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
  })

  it('a throwing plugin teardown does not stop later plugins from being torn down', () => {
    const handle = comice(el) as ComiceHandle
    const throwing: ComicePlugin = {
      name: 'throwing',
      setup() {},
      teardown() {
        throw new Error('boom')
      },
    }
    const healthy = fakePlugin()
    handle.use(throwing).use(healthy)

    expect(() => handle.destroy()).not.toThrow()
    expect(healthy.teardownCalls).toBe(1)
  })

  it('a throwing driver teardown does not stop later driver teardowns from running', () => {
    const handle = comice(el) as ComiceHandle
    const throwingDriver: Driver = {
      name: 'throwing-driver',
      attach() {
        return () => {
          throw new Error('boom')
        }
      },
    }
    const healthyDriver = fakeDriver()
    handle.driver(throwingDriver).driver(healthyDriver)

    expect(() => handle.destroy()).not.toThrow()
    expect(healthyDriver.teardownCalls).toBe(1)
  })
})
