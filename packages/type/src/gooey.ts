/**
 * @comice/type/gooey
 * ─────────────────────────────────────────────────────────────────────────────
 * The maths of `melt`, spec's "word to word morphing via CSS filters... the
 * text side twin of smin". The well-known gooey text morph: the outgoing
 * word fades while it blurs out, the incoming word fades in while it
 * sharpens, and an alpha threshold over both (an SVG filter, applied with
 * CSS `filter: url(#...)`) snaps the blurred overlap into one solid shape —
 * smin's smooth minimum of two shapes, in filter space.
 *
 * It used to blur and `contrast()` ONE element while the caller swapped
 * its text instantly: the two words never met, and contrast() changes
 * colour, not alpha, so on a transparent background nothing snapped.
 *
 * Zero DOM here — index.ts applies these to real elements.
 */

export type MeltCurve = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | ((t: number) => number)

export type MeltOptions = {
  /** Blur at the midpoint of the melt, px; each word blurs further as it
   *  fades. Default 14, the spec's example. */
  blur?: number
  /** `[cutoff, sharpness]` of the alpha threshold that welds the blurred
   *  words into one shape: alpha below `cutoff` falls away, above it goes
   *  solid, over a ramp `1 / sharpness` wide. Default `[0.5, 18]`, the
   *  spec's example. */
  threshold?: readonly [number, number]
  /** How far the outline is pushed around by liquid turbulence at the middle
   *  of the melt, px: 0 at both ends, most mid-melt. It turns the clean blur
   *  of the words into wavy, organic blobs instead of soft pills. Default 0
   *  (off). */
  wobble?: number
  /** Size of the waves `wobble` makes, px. Larger is slower, rounder swells;
   *  smaller is finer ripples. Default 90. */
  wobbleSize?: number
  /** Blur after the threshold, px. A sharp threshold (a high `sharpness`)
   *  sets a crisp, solid edge; a fraction of a pixel of blur after it stands
   *  in for antialiasing, so the edge is clean instead of stair-stepped.
   *  A value of .35 works with a threshold gain of 400. Default 0. */
  soften?: number
  /** Easing over the melt. Default 'easeInOut'. */
  curve?: MeltCurve
  /** A word that doesn't change stays perfectly still instead of melting
   *  into itself (the spec's "a project name that does not change between
   *  two consecutive slides stays perfectly still instead of visibly
   *  thickening"). Default true. */
  hold?: boolean
  /** How long a melt takes when the text changes, ms. Default 600. */
  duration?: number
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** `curve` applied to 0..1 progress. */
export function ease(curve: MeltCurve | undefined, t: number): number {
  const p = clamp01(t)
  if (typeof curve === 'function') return clamp01(curve(p))
  switch (curve ?? 'easeInOut') {
    case 'linear':
      return p
    case 'easeIn':
      return p * p * p
    case 'easeOut':
      return 1 - (1 - p) ** 3
    default:
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2
  }
}

export type WordFrame = { opacity: number; blur: number }

/** Blur of a word at `presence` (0 gone .. 1 fully there): `blur` at half
 *  presence, 0 when fully there, growing (capped) as it vanishes. */
function wordFrame(presence: number, blur: number): WordFrame {
  if (presence <= 0) return { opacity: 0, blur: 0 }
  return { opacity: presence ** 0.4, blur: Math.min(blur * ((1 - presence) / presence), 100) }
}

/** Both words at one point of the melt (`progress` already eased). */
export function meltFrame(progress: number, options: MeltOptions = {}): { from: WordFrame; to: WordFrame } {
  const p = clamp01(progress)
  const blur = options.blur ?? 14
  return { from: wordFrame(1 - p, blur), to: wordFrame(p, blur) }
}

/** The feColorMatrix `values` for the alpha threshold: colour untouched,
 *  alpha' = sharpness * (alpha - cutoff) + 0.5. */
export function thresholdMatrix(threshold: readonly [number, number] = [0.5, 18]): string {
  const [cutoff, sharpness] = threshold
  return `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${sharpness} ${0.5 - sharpness * cutoff}`
}

/** The displacement, in px, of the outline at `progress` (already eased): none at
 *  either end of the melt, `amount` at its middle. */
export function wobbleAmount(progress: number, amount = 0): number {
  return amount > 0 ? amount * Math.sin(Math.PI * clamp01(progress)) : 0
}

/** The CSS `filter` for one word: its blur, or none. */
export function wordFilter(frame: WordFrame): string {
  return frame.blur > 0.01 ? `blur(${frame.blur.toFixed(2)}px)` : 'none'
}
