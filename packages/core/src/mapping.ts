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
 * Validates the constructor-time shape of MappingOptions and throws with a
 * specific, actionable message on the first problem found. This runs once,
 * at `.map().to(...)` call time, not per frame — a programmer error (a
 * malformed config object) throws, fails loud, and is easy to fix, while
 * bad runtime input degrades instead (see apply() below, which stays
 * silent on purpose for a signal value that's merely out of range this
 * frame). A malformed `range`/`output` or an out-of-bounds `smoothing`
 * would otherwise silently misbehave every single frame forever (e.g.
 * smoothing >= 1 means the mapped value never updates past its first
 * frame) rather than fail once, immediately, at the call site where it's
 * actually easy to fix.
 */
function validateOptions(options: MappingOptions): void {
  const { range, output, multiplier, offset, smoothing } = options

  function assertFiniteRange(value: [number, number] | undefined, label: string): void {
    if (!value) return
    const [min, max] = value
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new RangeError(`[comice] mapping ${label} must be finite numbers, got [${min}, ${max}].`)
    }
    if (min >= max) {
      throw new RangeError(
        `[comice] mapping ${label} must have min < max, got [${min}, ${max}]. ` +
          `A degenerate or reversed range clamps every value to the same output forever — ` +
          `use \`invert: true\` instead of reversing the range to flip direction.`,
      )
    }
  }

  assertFiniteRange(range, 'range')
  assertFiniteRange(output, 'output')

  if (multiplier !== undefined && !Number.isFinite(multiplier)) {
    throw new RangeError(`[comice] mapping multiplier must be a finite number, got ${multiplier}.`)
  }
  if (offset !== undefined && !Number.isFinite(offset)) {
    throw new RangeError(`[comice] mapping offset must be a finite number, got ${offset}.`)
  }
  if (smoothing !== undefined && (!Number.isFinite(smoothing) || smoothing < 0 || smoothing >= 1)) {
    throw new RangeError(
      `[comice] mapping smoothing must be a finite number in [0, 1), got ${smoothing}. ` +
        `smoothing >= 1 means the mapped value would never update past its first frame.`,
    )
  }
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
  validateOptions(options)

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
    // Absent (driver not warmed up yet), array-shaped (spectrum data, not
    // mappable to a single parameter), or non-finite (a NaN/Infinity from
    // a buggy or degenerate driver signal) all degrade the same way: skip
    // this frame silently and try again next frame. This is a runtime
    // input problem, not a configuration problem — see validateOptions()
    // above for the config-time throw path — so per-frame bad data never
    // takes the mapping down, it just misses a frame.
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return

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
