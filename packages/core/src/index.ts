/**
 * comice
 * ─────────────────────────────────────────────────────────────────────────────
 * Entry point. Section 04's public surface:
 *
 *   comice('.card').use(spotlight()).driver(hover())
 *
 * This file wires a DOM target to a state machine instance and a driver.
 * It does not render anything itself — that is a plugin's job, attached via
 * `.use()`. Core's job stops at: find the element, run the state machine,
 * feed it driver signals, expose the instance.
 */

import { createInstance } from './machine.js'
import { createMapping } from './mapping.js'
import { createVisibilityGate, getSharedScheduler } from './scheduler.js'
import type {
  ComiceInstance,
  Driver,
  DriverSignal,
  MappableTarget,
  MappingOptions,
  NamedSignalDriver,
  SignalValues,
} from './types.js'

export { createInstance } from './machine.js'
export { createMapping } from './mapping.js'
export { createScheduler, createVisibilityGate, getSharedScheduler } from './scheduler.js'
export * from './types.js'
export * from './drivers/index.js'

/**
 * A plugin is anything with a `setup` hook. Plugins receive the raw element
 * and the state machine instance, and are responsible for their own
 * rendering (WebGL, CSS, or otherwise). Core never assumes a rendering
 * technology.
 *
 * `params`, when present, makes this plugin instance a MappableTarget: a
 * mapping can then read/write its named parameters without either side
 * knowing about the other (the Driver -> Signal -> Mapping -> Plugin
 * Parameter architecture). A plugin with no params is still a fully valid
 * ComicePlugin — nothing here is required.
 */
export type ComicePlugin = {
  name: string
  setup(target: Element, instance: ComiceInstance): void
  teardown?(): void
  params?: MappableTarget
}

/**
 * The chainable object returned by `.map(sourceKey)` — the second half of
 * `.map('bass').to(plugin, 'amount', options)`. A bare object rather than
 * a class since nothing here needs prototype methods beyond `to`.
 */
export type MappingBuilder = {
  to(target: ComicePlugin, paramName: string, options?: MappingOptions): ComiceHandle
}

export type ComiceHandle = ComiceInstance & {
  use(plugin: ComicePlugin): ComiceHandle
  driver(driver: Driver | NamedSignalDriver): ComiceHandle
  /**
   * Starts a mapping from a named signal on the most recently attached
   * named-signal driver to a plugin parameter. `.driver(audio()).map('bass').to(distort, 'amount')`.
   * Throws if no named-signal driver has been attached yet — a mapping
   * with nothing to read from is a configuration error, not a silent
   * no-op.
   */
  map(sourceKey: string): MappingBuilder
}

const sharedScheduler = getSharedScheduler()

function isNamedSignalDriver(driver: Driver | NamedSignalDriver): driver is NamedSignalDriver {
  return typeof (driver as NamedSignalDriver).attachSignals === 'function'
}

function wrap(target: Element): ComiceHandle {
  const instance = createInstance()
  const plugins: ComicePlugin[] = []
  const driverTeardowns: Array<() => void> = []
  const visibility = createVisibilityGate(target)

  // The most recently attached named-signal driver's live signal bag.
  // `.map()` reads from this — "the most recently attached driver" matches
  // the brief's `.driver(audio()).map('bass').to(...)` chaining, and
  // multiple `.driver()` calls each get their own mappings registry so two
  // drivers on one instance (e.g. pointer() and audio()) don't collide.
  let latestSignals: Readonly<SignalValues> = {}
  const mappings: Array<{ apply(signals: Readonly<SignalValues>): void }> = []

  const handle = instance as ComiceInstance as ComiceHandle

  handle.use = (plugin: ComicePlugin): ComiceHandle => {
    plugins.push(plugin)
    plugin.setup(target, instance)
    return handle
  }

  handle.driver = (driver: Driver | NamedSignalDriver): ComiceHandle => {
    if (typeof driver.attach === 'function') {
      const teardown = driver.attach(target, (signal: DriverSignal) => {
        instance.setProgress(signal.progress)

        // A driver reporting progress > 0 for the first time enters; falling
        // back to 0 leaves. Plugins that need finer control call
        // instance.transition() directly instead of relying on this default.
        //
        // `else if` deliberately, not four independent `if`s: each branch
        // below both reads AND mutates instance.state, so with plain `if`s
        // a single signal.progress <= 0 signal could cascade through two
        // transitions in one call (active -> leaving -> idle) instead of
        // the intended one driver signal, at most one transition. A
        // caller wanting the second half of that cascade sees it on the
        // *next* signal, same as every other progress <= 0 report.
        if (signal.progress > 0 && instance.state === 'idle') {
          instance.transition('entering')
        } else if (signal.progress >= 1 && instance.state === 'entering') {
          instance.transition('active')
        } else if (signal.progress <= 0 && (instance.state === 'active' || instance.state === 'entering')) {
          instance.transition('leaving')
        } else if (signal.progress <= 0 && instance.state === 'leaving') {
          instance.transition('idle')
        }
      })
      driverTeardowns.push(teardown)
    }

    if (isNamedSignalDriver(driver) && driver.attachSignals) {
      const teardown = driver.attachSignals(target, (signals) => {
        latestSignals = signals
        // Mappings are applied here, synchronously, as signals arrive —
        // not from a separate scheduler entry — so a mapping never reads
        // a signal bag older than the frame that produced it, and there
        // is exactly one write to each plugin param per driver update.
        mappings.forEach((mapping) => mapping.apply(latestSignals))
      })
      driverTeardowns.push(teardown)
    }

    return handle
  }

  handle.map = (sourceKey: string) => ({
    to(pluginTarget: ComicePlugin, paramName: string, options?: MappingOptions) {
      if (!pluginTarget.params) {
        throw new Error(
          `[comice] .map('${sourceKey}').to(plugin, '${paramName}') failed: the plugin passed to ` +
            `.to() has no params — only a plugin with a \`params\` MappableTarget can be mapped to.`,
        )
      }
      mappings.push(createMapping(sourceKey, pluginTarget.params, paramName, options))
      return handle
    },
  })

  const originalDestroy = instance.destroy
  handle.destroy = (): void => {
    driverTeardowns.forEach((teardown) => teardown())
    plugins.forEach((plugin) => plugin.teardown?.())
    visibility.destroy()
    originalDestroy()
  }

  return handle
}

/**
 * Wraps one or more elements. Accepts a CSS selector, a single Element, or
 * a NodeList — matching section 04's contract exactly.
 */
export function comice(target: string | Element | NodeListOf<Element>): ComiceHandle | ComiceHandle[] {
  if (typeof target === 'string') {
    const elements = Array.from(document.querySelectorAll(target))
    if (elements.length === 1) return wrap(elements[0])
    return elements.map(wrap)
  }
  if (target instanceof Element) return wrap(target)
  return Array.from(target).map(wrap)
}
