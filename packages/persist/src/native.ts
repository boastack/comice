/**
 * @comice/persist/native
 * ─────────────────────────────────────────────────────────────────────────────
 * The View Transitions API detection + invocation, isolated into its own
 * tiny module — same "one thing this file does, testable in isolation"
 * discipline every other plugin's own small helper modules hold to.
 *
 * WHY THIS EXISTS SEPARATELY FROM index.ts: happy-dom (this repo's test
 * environment) has no `document.startViewTransition` at all — same class
 * of gap as WebGL2/2D canvas (see harness/README.md's own note on this).
 * Isolating the real API call here means index.ts's own logic (the DOM
 * handoff, the registry) stays testable even though this one function
 * cannot be exercised for real outside an actual browser — mirrors how
 * every GL-touching package in this repo isolates its shader.ts from its
 * DOM-facing index.ts for the identical testability reason.
 */

/** True if this browser exposes a real, callable
 *  document.startViewTransition — the actual feature-detection spec's own
 *  `native: 'auto'` option needs ("Use the View Transitions API where it
 *  suffices"). Never throws. */
declare const process: { env: { NODE_ENV?: string } } | undefined

export function supportsNativeViewTransitions(): boolean {
  return typeof document !== 'undefined' && typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === 'function'
}

/**
 * Runs `updateCallback` inside a real View Transition when supported,
 * falling back to calling it directly (synchronously, no native
 * transition) otherwise — the same "degrade to the thing a browser
 * without the feature would already do" discipline every primitive in
 * this codebase holds to. Never throws: a callback error surfaces through
 * the native API's own promise machinery (which starts the transition
 * regardless and lets the callback's own rejection be observed by
 * whoever awaits `ready`/`finished`), or, on the no-support path, the
 * callback's own throw is caught and logged rather than crashing an SPA
 * route transition over a persist configuration mistake — the actual
 * navigation must never fail because a visual transition plugin errored.
 */
export function runViewTransition(updateCallback: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  if (typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(updateCallback)
    return
  }
  try {
    updateCallback()
  } catch (err) {
    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
      console.warn('[comice] persist(): updateCallback threw on the no-native-View-Transitions fallback path.', err)
    }
  }
}
