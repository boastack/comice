/**
 * comice/core/mapping
 * ─────────────────────────────────────────────────────────────────────────────
 * The Signal -> Mapping -> Plugin Parameter layer. Pure, zero-DOM — same
 * discipline as machine.ts. A Mapping reads one named number out of a
 * driver's signal bag every frame and writes a transformed version of it
 * into a named parameter on a plugin, so that neither side has to know
 * about the other:
 *
 *   audio().map('bass').to(distort, 'amount', { output: [0, 0.8] })
 *
 * distort() never mentions audio. audio() never mentions distort. The
 * mapping in between is the only thing that knows both names exist.
 */

import type { MappableTarget, MappingOptions, SignalValues } from './types.js'

const DEFAULT_RANGE: [number, number] = [0, 1]

function clampTo(value: number, [min, max]: [number, number]): number {
  return Math.min(max, Math.max(min, value))
}

function normalize(value: number, [min, max]: [number, number]): number {
  if (max === min) return 0
  return (value - min) / (max - min)
}

function denormalize(t: number, [min, max]: [number, number]): number {
  return min + t * (max - min)
}

/**
 * Named easing curves applied to the normalised (0..1) value, before it is
 * denormalised into `output`. Kept to four well-known curves rather than a
 * general cubic-bezier parser — anything fancier belongs in a plugin, not
 * the mapping layer, per the "the mapping layer stays generic" brief.
 */
function applyEasing(t: number, easing: MappingOptions['easing']): number {
  switch (easing) {
    case 'easeIn':
      return t * t
    case 'easeOut':
      return t * (2 - t)
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    case 'linear':
    default:
      return t
  }
}

export type Mapping = {
  /** Reads `signals[sourceKey]`, applies the pipeline, writes to the target. Skips silently if the source key is absent this frame (driver not warmed up yet) or is an array (spectrum-shaped signals are not mappable to a single parameter). */
  apply(signals: Readonly<SignalValues>): void
  /** Resets internal smoothing state, so the next `apply()` snaps to the raw value instead of easing in from the previous mapping's target. */
  reset(): void
}

/**
 * Builds a single source -> target mapping. `source` is a plain signal key
 * (e.g. 'bass') — resolving 'audio.bass' down to 'bass' against a specific
 * driver's signal bag is the caller's job (see index.ts's `.map()`), so
 * this module stays driver-agnostic.
 */
export function createMapping(
  sourceKey: string,
  target: MappableTarget,
  paramName: string,
  options: MappingOptions = {},
): Mapping {
  const {
    range = DEFAULT_RANGE,
    output = range,
    clamp = true,
    invert = false,
    multiplier = 1,
    offset = 0,
    easing = 'linear',
    smoothing = 0,
  } = options

  let smoothed: number | null = null

  function apply(signals: Readonly<SignalValues>): void {
    const raw = signals[sourceKey]
    if (typeof raw !== 'number') return

    const bounded = clamp ? clampTo(raw, range) : raw
    let t = normalize(bounded, range)
    t = applyEasing(t, easing)
    if (invert) t = 1 - t

    let mapped = denormalize(t, output) * multiplier + offset

    if (smoothing > 0) {
      smoothed = smoothed === null ? mapped : smoothed + (mapped - smoothed) * (1 - smoothing)
      mapped = smoothed
    } else {
      smoothed = null
    }

    target.setParam(paramName, mapped)
  }

  function reset(): void {
    smoothed = null
  }

  return { apply, reset }
}
