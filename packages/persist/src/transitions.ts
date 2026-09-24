/**
 * @comice/persist/transitions
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions computing the CSS a handoff element needs at a given
 * point in its transition — the same "progress -> CSS" shape reveal's own
 * effects.ts uses, applied here to a from-box/to-box animation instead of
 * a from-progress/to-progress one, since a handoff always has a real
 * start rect and end rect (registry.ts's own fromRect, and the new
 * target's live getBoundingClientRect()) rather than a fixed 0..1 range
 * over one element's own geometry.
 *
 * All four spec transitions (shared, blend, curtain, iris) are genuinely
 * the SAME underlying mechanism — the surviving element repositioned from
 * fromRect to toRect — differing only in what happens VISUALLY during
 * that repositioning, exactly the same "one mechanism, several presets"
 * shape morph's five operations or dissolve's three transitions already
 * use. None of these needs its own separate handoff logic in index.ts.
 */

export type Rect = { x: number; y: number; width: number; height: number }

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpRect(from: Rect, to: Rect, t: number): Rect {
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
  }
}

export type TransitionStyle = {
  /** Absolute-position CSS the handoff element needs at this point. */
  rect: Rect
  opacity: number
  clipPath?: string
  filter?: string
}

/**
 * shared: the View Transitions API's own cross-fade/morph handles the
 * VISUAL interpolation natively where `native` support exists (see
 * index.ts) — this fallback path, used when it doesn't, is a direct
 * geometric interpolation from fromRect to toRect with no extra visual
 * treatment. This is the transition spec's own worked example describes
 * ("watching the same video keep playing... as it grows into the hero").
 */
export function sharedTransition(from: Rect, to: Rect, progress: number): TransitionStyle {
  const t = clamp01(progress)
  return { rect: lerpRect(from, to, t), opacity: 1 }
}

/**
 * blend: the same geometric interpolation as `shared`, with the element
 * itself cross-fading through a dip in opacity at the midpoint rather
 * than staying fully opaque throughout — reads as "this dissolved and
 * reformed" instead of "this physically moved."
 */
export function blendTransition(from: Rect, to: Rect, progress: number): TransitionStyle {
  const t = clamp01(progress)
  const opacity = 1 - Math.sin(t * Math.PI) * 0.5
  return { rect: lerpRect(from, to, t), opacity }
}

/**
 * curtain: two panels (implemented here as a single animated clip-path
 * inset, matching reveal's own curtain() effect exactly — same visual
 * language, different domain) part from the center as the element
 * reaches toRect, revealing the destination rather than a plain move.
 */
export function curtainTransition(from: Rect, to: Rect, progress: number): TransitionStyle {
  const t = clamp01(progress)
  const insetPct = (1 - Math.abs(t * 2 - 1)) * 50
  return {
    rect: lerpRect(from, to, t),
    opacity: 1,
    clipPath: `inset(0 ${insetPct}% 0 ${insetPct}%)`,
  }
}

/**
 * iris: a circular wipe centered on the handoff element's own midpoint,
 * closing to nothing at the transition's midpoint and reopening around
 * the destination — the classic "iris out, iris in" cut, applied to a
 * moving element rather than a static one.
 */
export function irisTransition(from: Rect, to: Rect, progress: number): TransitionStyle {
  const t = clamp01(progress)
  const openness = Math.abs(t * 2 - 1) // 1 (fully open) at t=0/1, 0 (fully closed) at t=0.5
  const radiusPct = 75 * openness + 1 // never fully 0, avoids a zero-radius circle() edge case
  return {
    rect: lerpRect(from, to, t),
    opacity: 1,
    clipPath: `circle(${radiusPct.toFixed(2)}% at 50% 50%)`,
  }
}

const TRANSITIONS = {
  shared: sharedTransition,
  blend: blendTransition,
  curtain: curtainTransition,
  iris: irisTransition,
}

export function computeTransitionStyle(name: keyof typeof TRANSITIONS, from: Rect, to: Rect, progress: number): TransitionStyle {
  return TRANSITIONS[name](from, to, progress)
}
