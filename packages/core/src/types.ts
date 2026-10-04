/**
 * comice/core/types
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared types for the state machine, drivers, and public instance surface.
 */

/** The four states every interactive plugin moves through. Section 03. */
export type ComiceState = 'idle' | 'entering' | 'active' | 'leaving'

/**
 * A 2D transform snapshot. Kept intentionally small and framework-agnostic —
 * plugins read x/y/scale/rotate and translate into their own shader
 * uniforms or CSS as needed.
 */
export type Transform = {
  x: number
  y: number
  scale: number
  rotate: number
}

/** Discriminated union of every event the machine can emit. */
export type ComiceEvent =
  | { type: 'entering'; from: ComiceState; to: ComiceState }
  | { type: 'active'; from: ComiceState; to: ComiceState }
  | { type: 'leaving'; from: ComiceState; to: ComiceState }
  | { type: 'idle'; from: ComiceState; to: ComiceState }
  | { type: 'progress'; value: number }
  | { type: 'rest'; value: Transform }
  | { type: 'display'; value: Transform }
  /** A plugin's effect is on screen for the first time (spec §04 lifecycle). */
  | { type: 'ready'; plugin: string }
  /** A plugin can't show its effect — no WebGL2, a shader that won't
   *  compile, media the GPU can't read. The media still shows (rule 04);
   *  this says why the effect doesn't. */
  | { type: 'error'; plugin: string; error: Error }

export type ComiceEventType = ComiceEvent['type']

/** The snapshot shape passed to every subscriber. */
export type StateListenerSnapshot = {
  state: ComiceState
  progress: number
  rest: Transform
  display: Transform
}

export type StateListener = (
  snapshot: StateListenerSnapshot,
  event: ComiceEvent,
) => void

export type ComiceOptions = {
  /** Initial state. Defaults to 'idle'. */
  initial?: ComiceState
}

/**
 * The public surface returned by createInstance(). This is the shape every
 * plugin instance exposes, matching section 03's `card.state`, `card.on()`,
 * `card.transition()` contract.
 */
export type ComiceInstance = {
  readonly state: ComiceState
  readonly progress: number
  readonly rest: Transform
  readonly display: Transform
  /** True once a driver is attached (`.driver()`). A plugin that would
   *  otherwise play itself — reveal, entering when it comes into view —
   *  leaves the timing to the driver. */
  readonly driven: boolean

  transition(next: ComiceState): ComiceState
  setProgress(value: number): void
  setRest(next: Partial<Transform>): void
  setDisplay(next: Partial<Transform>): void
  /** For plugins: report that `plugin`'s effect is on screen. Emits
   *  `ready` on the next microtask, so `.on('ready')` chained after
   *  `.use()` still hears it. */
  ready(plugin: string): void
  /** For plugins: report why `plugin` can't show its effect. Emits
   *  `error` on the next microtask, like ready(). */
  fail(plugin: string, error: Error): void
  destroy(): void

  on(type: ComiceEventType | '*', listener: StateListener): () => void
  off(type: ComiceEventType | '*', listener: StateListener): void
}

/** A normalised signal any driver produces, regardless of input source. */
export type DriverSignal = {
  /** 0..1, the driver's notion of progress (scroll position, drag distance, elapsed time). */
  progress: number
  /** Raw pointer/touch position in pixels, relative to the element, when applicable. */
  pointer?: { x: number; y: number }
  /** Signed velocity, driver-defined units, used for effects like velocity bend. */
  velocity?: number
}

export type Driver = {
  name: string
  attach(target: Element, onSignal: (signal: DriverSignal) => void): () => void
}

// ─────────────────────────────────────────────────────────────────────────
// SIGNALS + MAPPING
// ─────────────────────────────────────────────────────────────────────────
//
// The original Driver/DriverSignal pair above feeds exactly one number
// (`progress`) into the shared state machine — enough for scroll/hover/
// pointer/drag/click/time, which are each fundamentally "how far along is
// this interaction". A driver like audio produces several independent
// values at once (bass, mid, high, energy, amplitude, a spectrum array)
// that have nothing to do with the state machine's idle/entering/active/
// leaving progress and everything to do with feeding plugin parameters
// directly.
//
// A NamedSignalDriver is the generalisation: instead of one progress
// number, it reports a bag of named values every frame, plus discrete
// events (a beat, an onset). Nothing here replaces the plain Driver above
// — scroll/hover/pointer/drag/click/time keep working exactly as they do
// today. A driver may implement `attach` (the state-machine path) and/or
// `attachSignals` (the named-signal path); audio implements only the
// latter, since "is audio playing" has no honest single progress value —
// which is why NamedSignalDriver does NOT extend Driver: Driver.attach is
// required, and requiring every named-signal driver to also fake a
// progress number would be exactly the kind of dishonest single-value
// summary audio has no good answer for.

/** A bag of named numeric signals a driver reports every frame. Values are
 *  driver-defined — most are normalised 0..1, but a driver may document a
 *  different range where 0..1 does not fit (see each driver's docs). */
export type SignalValues = Record<string, number | number[]>

/** A driver that reports multiple named signals per frame, instead of (or
 *  in addition to) the single progress number a plain Driver feeds the
 *  state machine. `attach` is optional here specifically so a driver like
 *  audio can implement only `attachSignals` — see the note above. */
export type NamedSignalDriver = {
  name: string
  attach?(target: Element, onSignal: (signal: DriverSignal) => void): () => void
  /**
   * Called once per shared scheduler tick with a mutable reference to this
   * driver's own signal bag. The driver writes into `signals` in place —
   * callers must not retain the reference across frames, and the driver
   * must not allocate a new object per frame (see pointer.ts's frame
   * budget discipline, and audio.ts's typed-array reuse).
   */
  attachSignals?(
    target: Element,
    onSignals: (signals: Readonly<SignalValues>) => void,
  ): () => void
  /** Discrete, non-continuous occurrences (a beat, an onset, a drop). */
  on?(event: string, listener: (payload?: unknown) => void): () => void
}

/** A plugin that exposes live-settable parameters is a MappableTarget.
 *  This is deliberately separate from ComicePlugin's `setup`/`teardown` —
 *  a plugin with no params is still a complete, valid plugin. Only
 *  plugins meant to be driven by a mapping need to implement this. */
export type MappableTarget = {
  /** Read the current value of a named parameter. */
  getParam(name: string): number
  /** Write a named parameter. Plugins clamp/validate internally; the
   *  mapping layer's job stops at handing over a number. */
  setParam(name: string, value: number): void
}

/** Options accepted by `.map(source).to(target, options)`. Every field is
 *  optional; the mapping is an identity passthrough (clamped to `range`)
 *  with none of them set. Applied in this fixed order every frame:
 *  clamp to `range` → remap into `output` → invert → multiply → offset →
 *  ease → smooth. */
export type MappingOptions = {
  /** The expected input range of the source signal. Default [0, 1]. */
  range?: [number, number]
  /** The range the value is remapped into before reaching the target.
   *  Default: same as `range` (no remapping). */
  output?: [number, number]
  /** Clamp the input to `range` before remapping. Default true. */
  clamp?: boolean
  /** Flip the value within `output` (output.max becomes output.min and
   *  vice versa). Default false. */
  invert?: boolean
  /** Multiply the mapped value. Applied after remapping, before offset. Default 1. */
  multiplier?: number
  /** Added to the mapped value, after the multiplier. Default 0. */
  offset?: number
  /** A named easing curve applied to the normalised (pre-output-remap)
   *  value. 'linear' is a no-op. Default 'linear'. */
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
  /** Exponential smoothing factor, 0..1, applied last, across frames.
   *  0 disables smoothing (the mapped value is used as-is every frame).
   *  Closer to 1 lags further behind the source. Default 0. */
  smoothing?: number
}
