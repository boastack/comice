/**
 * @comice/type/gooey
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions computing the CSS gooey (blur + contrast) filter chain
 * `melt` uses to morph word to word — spec's own words: "word to word
 * morphing via CSS filters... the text side twin of smin." This is the
 * well-known "gooey" CSS technique: blur two overlapping elements enough
 * that their edges bleed into each other, then apply a steep contrast
 * curve that snaps every blurred edge back to fully opaque or fully
 * transparent — which is exactly what smin's smooth-minimum blend does
 * for two SDF shapes, just expressed in CSS filter space instead of GLSL.
 *
 * Zero DOM here — index.ts applies these to real elements.
 */

export type MeltOptions = {
  /** Peak blur radius at the midpoint of the transition, px. Default 14,
   *  matching spec's own example. */
  blur?: number
  /** [start, end] contrast curve — spec's own `[0.5, 18]` example: a
   *  gentle contrast value blended toward a very steep one, snapping the
   *  blurred blob back into crisp text by the end of the transition. */
  threshold?: readonly [number, number]
  /** Keeps a word that DIDN'T change between two consecutive states
   *  perfectly still (no blur/contrast applied at all) rather than
   *  visibly "thickening" through the gooey filter for no reason — spec's
   *  own explicit example. Default true. */
  hold?: boolean
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/**
 * The blur radius at a given point in the transition — a triangle wave
 * peaking at progress 0.5 (maximum gooeyness exactly between the two
 * words) and returning to 0 at both ends (crisp text at rest, on both
 * sides of the transition).
 */
export function meltBlur(progress: number, options: MeltOptions = {}): number {
  const peak = options.blur ?? 14
  const p = clamp01(progress)
  const triangle = 1 - Math.abs(p * 2 - 1)
  return peak * triangle
}

/**
 * The contrast() filter value at a given point — interpolates from
 * `threshold[0]` (gentle, at rest) toward `threshold[1]` (steep, at the
 * midpoint) and back, the same triangle shape as meltBlur() but over the
 * CONTRAST curve rather than the blur radius, so peak blur and peak
 * contrast-snap happen at the same instant.
 */
export function meltContrast(progress: number, options: MeltOptions = {}): number {
  const [gentle, steep] = options.threshold ?? [0.5, 18]
  const p = clamp01(progress)
  const triangle = 1 - Math.abs(p * 2 - 1)
  return gentle + (steep - gentle) * triangle
}

/** The full CSS filter string for one melt frame — the standard gooey
 *  recipe (blur then contrast, in that order) as a single `filter`
 *  property value. */
export function meltFilter(progress: number, options: MeltOptions = {}): string {
  const blur = meltBlur(progress, options)
  const contrast = meltContrast(progress, options)
  if (blur <= 0.001) return 'none'
  return `blur(${blur.toFixed(2)}px) contrast(${contrast.toFixed(2)})`
}
