/**
 * @comice/rail/physics
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions: rail's own internal state machine and per-item layout
 * math. Zero DOM here, same discipline reveal/effects.ts and morph/sdf.ts
 * both follow — kept pure and unit-testable in isolation.
 *
 * Spec §08's `rail` card: "Owns: media collections you move through, with
 * physics that feel physical. A state machine, idle, dragging,
 * decelerating, snapping, settled." This state graph does NOT map onto
 * core's fixed idle/entering/active/leaving machine (machine.ts) — that
 * graph is section 03's generic "one thing being emphasised or revealed"
 * shape, and rail's five states are a genuinely different interaction
 * (a scrollable/draggable collection, not a single element's enter/leave).
 * rail therefore owns this state graph itself rather than forcing a
 * five-state interaction through a four-state machine, the same reasoning
 * distort's own field state (pointerX/pointerY/pointerActive) is tracked
 * outside machine.ts rather than shoehorned into Transform.
 */

export type RailState = 'idle' | 'dragging' | 'decelerating' | 'snapping' | 'settled'

export type RailMode = 'canvas' | 'strip' | 'compare' | 'stack' | 'marquee' | 'arc' | 'coverflow'

/** Below this per-frame velocity (progress-units per 16.67ms frame), a
 *  decelerating rail is considered settled — matches drag.ts's own
 *  INERTIA_SETTLE_THRESHOLD reasoning: never run a scheduler entry that
 *  isn't doing meaningful work. */
export const SETTLE_THRESHOLD = 0.0005

/** Decays `velocity` by `inertia` for one frame, returning the next
 *  velocity — 0 once it drops below SETTLE_THRESHOLD. Pure, so the
 *  scheduler-driven decay loop in index.ts is trivial to drive from
 *  outside a real rAF for testing. */
export function decayVelocity(velocity: number, inertia: number): number {
  const next = velocity * inertia
  return Math.abs(next) < SETTLE_THRESHOLD ? 0 : next
}

/** Wraps an arbitrary offset into [0, itemCount) — used by 'marquee' mode,
 *  the one rail mode that scrolls infinitely rather than clamping at its
 *  ends. */
export function wrapIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0
  const wrapped = index % itemCount
  return wrapped < 0 ? wrapped + itemCount : wrapped
}

/** Clamps a continuous "which item am I between" position to the valid
 *  range for a non-wrapping mode — every mode except 'marquee'. */
export function clampPosition(position: number, itemCount: number): number {
  if (itemCount <= 1) return 0
  return Math.max(0, Math.min(itemCount - 1, position))
}

/** Rounds a continuous position to its nearest whole item index — the
 *  target snapping resolves to. */
export function nearestIndex(position: number, itemCount: number): number {
  if (itemCount <= 0) return 0
  return Math.max(0, Math.min(itemCount - 1, Math.round(position)))
}

export type ItemTransform = {
  /** Offset along the rail's primary axis, in the same units `position`
   *  (item-index space) is measured in — index.ts converts this to px
   *  against the rail's own item spacing before writing a CSS transform. */
  offset: number
  scale: number
  rotate: number
  opacity: number
  /** Stacking order — higher renders on top. Plain z-index, not a 3D
   *  translateZ (spec's own "Not a 3D engine" line, section 05). */
  z: number
}

const IDENTITY_ITEM_TRANSFORM: ItemTransform = { offset: 0, scale: 1, rotate: 0, opacity: 1, z: 0 }

/**
 * Per-mode layout math: given `position` (the continuous, possibly
 * fractional "currently between which items" value driven by drag/inertia/
 * snap) and one item's own index, returns that item's ItemTransform.
 *
 * Each mode is a pure function of (delta, position-within-collection) —
 * none of them touch the DOM or know about other items' elements, only
 * their own relative distance from the current position.
 */
function layoutFor(mode: RailMode, delta: number, itemCount: number): ItemTransform {
  switch (mode) {
    case 'strip':
      return { ...IDENTITY_ITEM_TRANSFORM, offset: delta }

    case 'canvas':
      // Items drift apart and shrink slightly as they leave center —
      // distinguishes it from 'strip' without a different interaction model.
      return { ...IDENTITY_ITEM_TRANSFORM, offset: delta * 1.15, scale: 1 - Math.min(0.15, Math.abs(delta) * 0.05) }

    case 'compare':
      // Only ever shows exactly two items — anything beyond index 0/1 is
      // pushed fully transparent rather than laid out along the axis.
      return { ...IDENTITY_ITEM_TRANSFORM, offset: delta, opacity: Math.abs(delta) < 1.5 ? 1 : 0 }

    case 'stack': {
      // The active item on top, others receding behind by distance —
      // spec's own "physics that feel physical" language points here most directly.
      const d = Math.abs(delta)
      return {
        offset: delta * 0.08,
        scale: Math.max(0.85, 1 - d * 0.06),
        rotate: 0,
        opacity: Math.max(0.3, 1 - d * 0.25),
        z: -d,
      }
    }

    case 'marquee':
      // Never fades — index.ts wraps the index before calling this (see wrapIndex()).
      return { ...IDENTITY_ITEM_TRANSFORM, offset: delta }

    case 'arc': {
      // A fan spread, distinct from 'coverflow' by having no perspective depth change.
      const angle = delta * 12 // degrees per step
      return { offset: delta, scale: 1, rotate: angle, opacity: 1, z: -Math.abs(delta) }
    }

    case 'coverflow': {
      // The active item flat and largest, neighbours rotated away in
      // perspective and pushed back/scaled down by distance.
      const d = delta
      const rotate = Math.max(-60, Math.min(60, -d * 45))
      const scale = Math.max(0.6, 1 - Math.abs(d) * 0.18)
      return { offset: d * 0.7, scale, rotate, opacity: Math.max(0.4, 1 - Math.abs(d) * 0.3), z: -Math.abs(d) }
    }
  }
}

/** Computes one item's ItemTransform for the current rail `position`.
 *  `itemCount` distinguishes 'marquee' (wraps `delta` toward whichever
 *  direction is shorter) from every other mode (a plain linear delta). */
export function computeItemTransform(mode: RailMode, itemIndex: number, position: number, itemCount: number): ItemTransform {
  let delta = itemIndex - position
  if (mode === 'marquee' && itemCount > 0) {
    // Take the shorter path around the loop, so an item doesn't visibly
    // travel the long way around when wrapping.
    const wrapped = ((delta % itemCount) + itemCount * 1.5) % itemCount - itemCount / 2
    delta = wrapped
  }
  return layoutFor(mode, delta, itemCount)
}
