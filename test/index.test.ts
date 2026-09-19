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

  it('wraps a multi-match selector as an array of handles', () => {
    const second = document.createElement('div')
    second.className = 'target'
    document.body.appendChild(second)

    const handles = comice('.target')
    expect(Array.isArray(handles)).toBe(true)
    expect((handles as ComiceHandle[]).length).toBe(2)

    second.remove()
  })

  it('wraps a NodeList as an array of handles', () => {
    const nodeList = document.querySelectorAll('.target')
    const handles = comice(nodeList)
    expect(Array.isArray(handles)).toBe(true)
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
