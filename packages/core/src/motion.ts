/**
 * comice/core/motion
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec rule 04, "Degrade, never disappear: no GPU, reduced motion, weak
 * phone, failed load, the media still shows." Nothing in Comice checked
 * `prefers-reduced-motion` at all.
 *
 * The decision: plugins decide, motion off. Under reduced motion every
 * plugin that MOVES jumps straight to its end state with no animation in
 * between (snapForReducedMotion), and anything that moves on its own clock
 * stops (particles' noise drift, rail/drag inertia, click/hover/persist
 * animations). Plugins that change how media LOOKS without moving it —
 * a colour grade, seed's placeholders, layout's text wrap, aura's colour —
 * keep working; they are not motion.
 *
 * Read live, never cached as a boolean: a visitor can flip the OS setting
 * with the page open, and the next frame follows it.
 */

// The MediaQueryList is itself live (`.matches` follows the OS setting), so
// it is created once and only re-created if `matchMedia` itself is swapped
// out — which a test environment does, and a real page never does.
let queriedWith: typeof matchMedia | null | undefined
let query: MediaQueryList | null = null

/** Whether the visitor has asked the OS for reduced motion, right now. */
export function prefersReducedMotion(): boolean {
  const current = typeof matchMedia === 'function' ? matchMedia : null
  if (current !== queriedWith) {
    queriedWith = current
    query = current ? current('(prefers-reduced-motion: reduce)') : null
  }
  return query?.matches ?? false
}

/** A plugin's progress, as it should be drawn: unchanged normally; under
 *  reduced motion, snapped to whichever end state it is closer to, so the
 *  effect jumps instead of animating through the middle. */
export function snapForReducedMotion(progress: number): number {
  if (!prefersReducedMotion()) return progress
  return progress >= 0.5 ? 1 : 0
}
