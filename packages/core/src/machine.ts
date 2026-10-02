/**
 * comice/core/machine
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure interaction state machine — zero DOM, zero WebGL, zero side effects.
 *
 * ARCHITECTURE
 * ────────────
 * A pure state machine: accepts a driver's normalised signal, mutates state
 * through a single pipeline, and notifies subscribers. No GPU calls, no
 * texture uploads, no rendering. All side effects belong in plugins.
 *
 * This is the mechanism section 03 of the plan describes: idle, entering,
 * active, leaving, driven by real events rather than a fixed-duration
 * timeline, so an interrupted transition reverses from wherever it actually
 * is instead of snapping back to a hardcoded start.
 *
 * MUTATION PIPELINE
 * ─────────────────
 * Every state change flows through one path:
 *
 *   transition(next) → applyState(patch, event) → state updated → emit(event) → subscribers
 *
 * No caller mutates state directly. No event fires without a state update.
 * No state update happens without an event. The pipeline is the only door.
 *
 * EVENT SYSTEM
 * ────────────
 * Every mutation emits a typed event as the second argument to subscribers:
 *
 *   instance.on('active', (state, event) => { ... })
 *   instance.on('leaving', (state, event) => { ... })
 *
 * REST VS DISPLAY
 * ────────────────
 * Two transforms are tracked, not one. `rest` is where an element would be
 * with no interaction applied. `display` is what is actually rendered this
 * frame. Plugins read `rest` when computing relationships between elements
 * (distance, adjacency, field strength) so that one element's hover does not
 * feed back into another element's geometry. This is the fix the Viscose
 * audit surfaced: hover moves what you see, never what a field is computed
 * from.
 */

import type {
  ComiceState,
  ComiceEvent,
  ComiceEventType,
  ComiceOptions,
  ComiceInstance,
  StateListener,
  StateListenerSnapshot,
  Transform,
} from './types.js'

// Build-time constant injected by tsup/esbuild via `define`. Declared here
// for TypeScript only — the real string literal is substituted before the
// code ever executes, so `process` is never accessed at runtime. This
// avoids depending on @types/node for a browser-only package.
declare const process: { env: { NODE_ENV?: string } } | undefined

// ─────────────────────────────────────────────────────────────────────────────
// MODULE-LEVEL COUNTER
// ─────────────────────────────────────────────────────────────────────────────

let _instanceCounter = 0

const __DEV__ =
  typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

// ─────────────────────────────────────────────────────────────────────────────
// STATE GRAPH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legal transitions out of each state. `transition()` refuses anything not
 * listed here rather than silently allowing an invalid jump — the same
 * "eliminate invalid states by design" discipline a formal state machine
 * gives you, kept intentionally small rather than reaching for a full
 * statechart library.
 */
const LEGAL_TRANSITIONS: Record<ComiceState, readonly ComiceState[]> = {
  idle: ['entering'],
  entering: ['active', 'leaving'], // interrupted mid-enter goes straight to leaving
  active: ['leaving'],
  leaving: ['idle', 'entering'], // interrupted mid-leave can re-enter
}

function isLegalTransition(from: ComiceState, to: ComiceState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to)
}

type MutableComiceState = {
  state: ComiceState
  progress: number // 0..1 within the current state, driver-supplied
  rest: Transform
  display: Transform
}

const IDENTITY_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scale: 1,
  rotate: 0,
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a pure Comice state machine instance.
 *
 * Safe to instantiate anywhere the plane/driver layer above it runs.
 * Every mutation goes through `applyState`, which updates state then fires
 * `emit`. Subscribers always receive a cloned snapshot.
 */
export function createInstance(options: ComiceOptions = {}): ComiceInstance {
  const instanceId = `comice-${++_instanceCounter}`

  let state: MutableComiceState = {
    state: 'idle',
    progress: 0,
    rest: { ...IDENTITY_TRANSFORM },
    display: { ...IDENTITY_TRANSFORM },
  }

  const listenersByType = new Map<ComiceEventType, Set<StateListener>>()
  const listenersAll = new Set<StateListener>()

  // ── MUTATION PIPELINE ────────────────────────────────────────────────────

  function notify(fn: StateListener, snapshot: StateListenerSnapshot, event: ComiceEvent): void {
    try {
      fn(snapshot, event)
    } catch (err) {
      if (__DEV__) {
        console.warn(`[comice] A listener for "${event.type}" threw on instance ${instanceId}.`, err)
      }
    }
  }

  /**
   * Every subscriber is notified in isolation. One listener throwing must
   * not stop the REST of the listeners for this same event from being
   * notified — the state has already mutated by the time emit() runs (see
   * applyState below), so a listener failing here is purely a "did this
   * one subscriber hear about it" problem, never a state-corruption one.
   */
  function emit(event: ComiceEvent): void {
    const snapshot = getSnapshot()
    listenersAll.forEach((fn) => notify(fn, snapshot, event))
    listenersByType.get(event.type)?.forEach((fn) => notify(fn, snapshot, event))
  }

  /**
   * Apply a partial state patch then emit the triggering event.
   * This is the only place `state` itself is replaced.
   */
  function applyState(
    patch: Partial<MutableComiceState>,
    event: ComiceEvent,
  ): ComiceState {
    state = { ...state, ...patch }
    emit(event)
    return state.state
  }

  // ── ACTIONS ───────────────────────────────────────────────────────────────

  /**
   * Request a transition to `next`. Refuses illegal jumps in dev with a
   * warning rather than silently corrupting state. Returns the state that
   * is actually active after the call, which may be unchanged if the
   * transition was refused.
   */
  function transition(next: ComiceState): ComiceState {
    const from = state.state

    if (from === next) return from

    if (!isLegalTransition(from, next)) {
      /* istanbul ignore else */
      if (__DEV__) {
        console.warn(
          `[comice] Illegal transition "${from}" -> "${next}" on instance ` +
            `${instanceId}. Allowed from "${from}": ${LEGAL_TRANSITIONS[from].join(', ') || '(none)'}.`,
        )
      }
      return from
    }

    return applyState(
      { state: next, progress: 0 },
      { type: next, from, to: next },
    )
  }

  /**
   * Update the driver-supplied progress within the current state, without
   * changing state itself. Called every frame by whatever driver is
   * attached (scroll, pointer, drag, time).
   */
  function setProgress(value: number): void {
    const clamped = Math.max(0, Math.min(1, value))
    if (clamped === state.progress) return
    applyState({ progress: clamped }, { type: 'progress', value: clamped })
  }

  /**
   * Update the rest transform — where this element would be with no
   * interaction applied. Plugins compute field relationships (distance,
   * adjacency) from this, never from `display`, so hovering one element
   * cannot feed back into the geometry another element reads.
   */
  function setRest(next: Partial<Transform>): void {
    applyState(
      { rest: { ...state.rest, ...next } },
      { type: 'rest', value: { ...state.rest, ...next } },
    )
  }

  /**
   * Update the display transform — what is actually rendered this frame.
   * May diverge from `rest` while a hover, drag, or other interaction is
   * live.
   */
  function setDisplay(next: Partial<Transform>): void {
    applyState(
      { display: { ...state.display, ...next } },
      { type: 'display', value: { ...state.display, ...next } },
    )
  }

  // Lifecycle events change no state, and fire on the next microtask: a
  // plugin reports during setup(), which runs inside `.use()` — before a
  // `.on('error')` chained after it is attached. Firing synchronously would
  // make a setup-time failure impossible to hear.
  let destroyed = false
  function lifecycle(event: ComiceEvent): void {
    queueMicrotask(() => {
      if (!destroyed) emit(event)
    })
  }

  function ready(plugin: string): void {
    lifecycle({ type: 'ready', plugin })
  }

  function fail(plugin: string, error: Error): void {
    lifecycle({ type: 'error', plugin, error })
  }

  function destroy(): void {
    destroyed = true
    listenersAll.clear()
    listenersByType.clear()
  }

  // ── DATA ACCESS ──────────────────────────────────────────────────────────

  /**
   * Returns a safe snapshot for listeners: the current machine state plus
   * progress and both transforms, cloned so a listener cannot mutate live
   * state through the object it receives.
   */
  function getSnapshot(): StateListenerSnapshot {
    return {
      state: state.state,
      progress: state.progress,
      rest: { ...state.rest },
      display: { ...state.display },
    }
  }

  /**
   * Subscribe to a specific event type, or every event when `type` is
   * omitted. Returns an unsubscribe function.
   */
  function on(type: ComiceEventType | '*', listener: StateListener): () => void {
    if (type === '*') {
      listenersAll.add(listener)
      return () => listenersAll.delete(listener)
    }
    if (!listenersByType.has(type)) listenersByType.set(type, new Set())
    listenersByType.get(type)!.add(listener)
    return () => listenersByType.get(type)?.delete(listener)
  }

  function off(type: ComiceEventType | '*', listener: StateListener): void {
    if (type === '*') {
      listenersAll.delete(listener)
      return
    }
    listenersByType.get(type)?.delete(listener)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC SURFACE
  // ─────────────────────────────────────────────────────────────────────────

  return {
    get state(): ComiceState {
      return state.state
    },
    get progress(): number {
      return state.progress
    },
    get rest(): Transform {
      return { ...state.rest }
    },
    get display(): Transform {
      return { ...state.display }
    },

    transition,
    setProgress,
    setRest,
    setDisplay,
    ready,
    fail,
    destroy,

    on,
    off,
  }
}
