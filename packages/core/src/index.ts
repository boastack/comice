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
import type {
  ComiceInstance,
  Driver,
  DriverSignal,
  MappableTarget,
  MappingOptions,
  NamedSignalDriver,
  SignalValues,
  Transform,
} from './types.js'

export { createInstance } from './machine.js'
export { createMapping } from './mapping.js'
export { createScheduler, createVisibilityGate, getSharedScheduler } from './scheduler.js'
export { prefersReducedMotion, snapForReducedMotion } from './motion.js'
export { qualityLevel, resetQuality, setAdaptiveQuality, type QualityLevel } from './budget.js'
export * from './types.js'
export * from './drivers/index.js'

declare const process: { env: { NODE_ENV?: string } } | undefined
const __DEV__ = typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

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
  /** A fresh, identically configured copy of this plugin. A plugin holds
   *  state for ONE element, so when `comice('.card')` matches several, core
   *  calls this to give each element its own. Every official plugin has
   *  one; a plugin without it works on a single element only. */
  create?(): ComicePlugin
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
   * Throws if no driver has been attached yet — a mapping
   * with nothing to read from is a configuration error, not a silent
   * no-op.
   */
  map(sourceKey: string): MappingBuilder
  /**
   * Applies values immediately, no transition — spec §04, "matches
   * gsap.set()". Each key is a plugin parameter (the same values `.map()`
   * writes into), written to every attached plugin; a plugin without that
   * parameter ignores it. `progress` sets the instance's progress directly,
   * without moving its state. Pass a plugin first to write to that plugin
   * only, when two plugins share a parameter name — scoped, `progress` is
   * that plugin's own `progress` parameter (dissolve, morph, particles).
   *
   *   comice('.hero').use(distort()).set({ strength: 0.8 })
   *   handle.set(distortPlugin, { strength: 0.8 })
   */
  set(props: SetProps): ComiceHandle
  set(plugin: ComicePlugin, props: SetProps): ComiceHandle
  /** One handle per matched element — `[this]` for a single element. A
   *  handle for several elements applies everything to all of them, and
   *  reads state/progress from the first; this reaches each one. */
  readonly handles: readonly ComiceHandle[]
}

/** Values for `.set()`: plugin parameters by name, plus `progress`. */
export type SetProps = { progress?: number } & Record<string, number>

function isNamedSignalDriver(driver: Driver | NamedSignalDriver): driver is NamedSignalDriver {
  return typeof (driver as NamedSignalDriver).attachSignals === 'function'
}

const pluginOwners = new WeakMap<ComicePlugin, ComiceHandle>()
const detachPlugin = new WeakMap<ComiceHandle, (plugin: ComicePlugin) => void>()

function wrap(target: Element): ComiceHandle {
  const instance = createInstance()
  const plugins: ComicePlugin[] = []
  const driverTeardowns: Array<() => void> = []
  let destroyed = false

  type SignalChannel = { active: boolean; values: Readonly<SignalValues>; mappings: Array<{ apply(signals: Readonly<SignalValues>): void }> }
  const channels: SignalChannel[] = []
  let latestChannel: SignalChannel | null = null
  const publish = (channel: SignalChannel, values: Readonly<SignalValues>) => {
    if (destroyed || !channel.active) return
    channel.values = values
    for (const mapping of channel.mappings) {
      try {
        mapping.apply(values)
      } catch (err) {
        if (__DEV__) console.warn('[comice] A mapping threw and was skipped this update.', err)
      }
    }
  }

  const handle = instance as ComiceInstance as ComiceHandle
  ;(handle as { handles: readonly ComiceHandle[] }).handles = [handle]

  handle.use = (plugin: ComicePlugin): ComiceHandle => {
    if (destroyed) throw new Error('[comice] Cannot attach a plugin to a destroyed handle.')
    if (pluginOwners.has(plugin)) throw new Error('[comice] This plugin is already attached; use create() for another element.')
    try { plugin.setup(target, instance) }
    catch (error) {
      try { plugin.teardown?.() } catch { /* Preserve the setup error. */ }
      throw error
    }
    plugins.push(plugin)
    pluginOwners.set(plugin, handle)
    return handle
  }

  detachPlugin.set(handle, (plugin) => {
    const index = plugins.indexOf(plugin)
    if (index < 0) return
    plugins.splice(index, 1)
    pluginOwners.delete(plugin)
    try { plugin.teardown?.() } catch (err) { if (__DEV__) console.warn('[comice] Plugin rollback teardown failed.', err) }
  })

  handle.driver = (driver: Driver | NamedSignalDriver): ComiceHandle => {
    if (destroyed) throw new Error('[comice] Cannot attach a driver to a destroyed handle.')
    const previousChannel = latestChannel
    const previousDriven = instance.driven
    const teardownStart = driverTeardowns.length
    const channel: SignalChannel = { active: true, values: {}, mappings: [] }
    latestChannel = channel
    ;(instance as { driven: boolean }).driven = true
    try {
      if (typeof driver.attach === 'function') {
        const teardown = driver.attach(target, (signal: DriverSignal) => {
          if (destroyed || !channel.active || !Number.isFinite(signal.progress)) return
          const progress = Math.max(0, Math.min(1, signal.progress))
          const previous = instance.progress
          // Continuous inputs can reverse between endpoints. Endpoint-only inputs
          // (native scroll, custom drivers) must settle without a duplicate sample.
          if (progress > 0 && (instance.state === 'idle' || (instance.state === 'leaving' && progress > previous))) {
            instance.transition('entering')
          } else if (progress < previous && (instance.state === 'active' || instance.state === 'entering')) {
            instance.transition('leaving')
          }
          if (progress >= 1 && instance.state === 'entering') instance.transition('active')
          if (progress <= 0) {
            if (instance.state === 'active' || instance.state === 'entering') instance.transition('leaving')
            if (instance.state === 'leaving') instance.transition('idle')
          }
          instance.setProgress(progress)

          if (signal.pointer) instance.setDisplay({ x: signal.pointer.x, y: signal.pointer.y })
          publish(channel, {
            progress: signal.progress,
            ...(signal.pointer ? { pointerX: signal.pointer.x, pointerY: signal.pointer.y } : {}),
            ...(signal.velocity !== undefined ? { velocity: signal.velocity } : {}),
          })
        })
        driverTeardowns.push(teardown)
      }

      if (isNamedSignalDriver(driver) && driver.attachSignals) {
        const teardown = driver.attachSignals(target, (signals) => {
          publish(channel, signals)
        })
        driverTeardowns.push(teardown)
      }

    } catch (error) {
      channel.active = false
      for (const teardown of driverTeardowns.splice(teardownStart)) {
        try { teardown() } catch { /* Preserve the attach error. */ }
      }
      latestChannel = previousChannel
      ;(instance as { driven: boolean }).driven = previousDriven
      throw error
    }
    channels.push(channel)
    return handle
  }

  handle.map = (sourceKey: string) => {
    if (destroyed) throw new Error('[comice] Cannot attach a mapping to a destroyed handle.')
    const channel = latestChannel
    return {
      to(pluginTarget: ComicePlugin, paramName: string, options?: MappingOptions) {
        if (destroyed) throw new Error('[comice] Cannot attach a mapping to a destroyed handle.')
        if (!pluginTarget.params) {
          throw new Error(
            `[comice] .map('${sourceKey}').to(plugin, '${paramName}') failed: the plugin passed to ` +
              `.to() has no params — only a plugin with a \`params\` MappableTarget can be mapped to.`,
          )
        }
        if (!channel) throw new Error('[comice] Attach a driver before creating a mapping.')
        const mapping = createMapping(sourceKey, pluginTarget.params, paramName, options)
        channel.mappings.push(mapping)
        mapping.apply(channel.values)
        return handle
      },
    }
  }

  handle.set = (first: SetProps | ComicePlugin, scoped?: SetProps): ComiceHandle => {
    if (destroyed) return handle
    const only = scoped ? (first as ComicePlugin) : null
    const props = scoped ?? (first as SetProps)
    for (const [name, value] of Object.entries(props)) {
      if (name === 'progress' && !only) {
        // Progress within the current state, applied as-is: no transition,
        // which is the point of set() as opposed to transition().
        instance.setProgress(value)
        continue
      }
      for (const plugin of only ? [only] : plugins) plugin.params?.setParam(name, value)
    }
    return handle
  }

  const originalDestroy = instance.destroy
  handle.destroy = (): void => {
    if (destroyed) return
    destroyed = true
    // Every teardown runs in isolation. destroy() is a cleanup path —
    // one driver's or plugin's teardown throwing must not stop the
    // REST of the teardowns from running, or every plugin/driver after
    // the offending one in the array leaks (GPU textures, event
    // listeners, timers never released).
    driverTeardowns.forEach((teardown) => {
      try {
        teardown()
      } catch (err) {
        if (__DEV__) console.warn('[comice] A driver teardown threw during destroy().', err)
      }
    })
    plugins.forEach((plugin) => {
      pluginOwners.delete(plugin)
      try {
        plugin.teardown?.()
      } catch (err) {
        if (__DEV__) console.warn(`[comice] Plugin "${plugin.name}" teardown threw during destroy().`, err)
      }
    })
    driverTeardowns.length = 0
    plugins.length = 0
    for (const channel of channels) {
      channel.active = false
      channel.mappings.length = 0
      channel.values = {}
    }
    channels.length = 0
    latestChannel = null
    originalDestroy()
  }

  return handle
}

/**
 * Wraps one or more elements. Accepts a CSS selector, a single Element, or
 * a NodeList — matching section 04's contract exactly.
 */
/**
 * One chainable handle for several elements — spec §04: comice(target)
 * "returns a chainable instance. Same shape whether target is a CSS
 * selector, an element, or a NodeList." It used to return an ARRAY for more
 * than one match (and an empty one for none), so `comice('.card').use(…)`
 * threw on any page with two cards — almost every example in the spec.
 *
 * Each element keeps its own instance and its own copy of every plugin
 * (ComicePlugin.create), so each still animates independently. Everything
 * applies to all of them; state/progress read from the first; `.on()`
 * listens to all; `.map().to(plugin)` feeds every copy of that plugin.
 */
function group(handles: ComiceHandle[]): ComiceHandle {
  const copies = new Map<ComicePlugin, ComicePlugin[]>()
  const copyFor = (plugin: ComicePlugin, index: number): ComicePlugin => copies.get(plugin)?.[index] ?? plugin
  const first = handles[0]
  const identity: Transform = { x: 0, y: 0, scale: 1, rotate: 0 }

  const g: ComiceHandle = {
    get state() {
      return first?.state ?? 'idle'
    },
    get progress() {
      return first?.progress ?? 0
    },
    get driven() {
      return first?.driven ?? false
    },
    get rest() {
      return first?.rest ?? { ...identity }
    },
    get display() {
      return first?.display ?? { ...identity }
    },
    handles,
    use(plugin) {
      // Every copy is made BEFORE any is attached, so a plugin that can't
      // be copied fails cleanly instead of leaving half the elements set up.
      const perElement = handles.map((_handle, index) => {
        if (index === 0) return plugin
        if (!plugin.create) {
          throw new Error(
            `[comice] ${plugin.name}() can't be used on ${handles.length} elements at once: it has no create() to make one per element. ` +
              'Call comice() once per element, or give the plugin a create().',
          )
        }
        return plugin.create()
      })
      const attached: number[] = []
      try {
        handles.forEach((handle, index) => { handle.use(perElement[index]!); attached.push(index) })
      } catch (error) {
        attached.reverse().forEach((index) => detachPlugin.get(handles[index]!)?.(perElement[index]!))
        throw error
      }
      copies.set(plugin, perElement)
      return g
    },
    driver(driver) {
      handles.forEach((handle) => handle.driver(driver))
      return g
    },
    map(sourceKey) {
      const builders = handles.map((handle) => handle.map(sourceKey))
      return {
        to(plugin, paramName, options) {
          builders.forEach((builder, index) => builder.to(copyFor(plugin, index), paramName, options))
          return g
        },
      }
    },
    set(firstArg: SetProps | ComicePlugin, scoped?: SetProps) {
      handles.forEach((handle, index) => (scoped ? handle.set(copyFor(firstArg as ComicePlugin, index), scoped) : handle.set(firstArg as SetProps)))
      return g
    },
    transition(next) {
      handles.forEach((handle) => handle.transition(next))
      return first?.state ?? 'idle'
    },
    setProgress: (value) => handles.forEach((handle) => handle.setProgress(value)),
    setRest: (next) => handles.forEach((handle) => handle.setRest(next)),
    setDisplay: (next) => handles.forEach((handle) => handle.setDisplay(next)),
    ready: (plugin) => handles.forEach((handle) => handle.ready(plugin)),
    fail: (plugin, error) => handles.forEach((handle) => handle.fail(plugin, error)),
    on(type, listener) {
      const offs = handles.map((handle) => handle.on(type, listener))
      return () => offs.forEach((off) => off())
    },
    off: (type, listener) => handles.forEach((handle) => handle.off(type, listener)),
    destroy() {
      handles.forEach((handle) => handle.destroy())
      copies.clear()
    },
  }
  return g
}

export function comice(target: string | Element | NodeListOf<Element>): ComiceHandle {
  const elements = typeof target === 'string' ? Array.from(document.querySelectorAll(target)) : target instanceof Element ? [target] : Array.from(target)
  if (elements.length === 1) return wrap(elements[0]!)
  if (elements.length === 0 && __DEV__) {
    console.warn(`[comice] comice(${typeof target === 'string' ? `'${target}'` : 'target'}) matched no elements; the handle does nothing.`)
  }
  return group(elements.map(wrap))
}
