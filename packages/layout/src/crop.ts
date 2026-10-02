/**
 * @comice/layout/crop
 * ─────────────────────────────────────────────────────────────────────────────
 * layout's `crop` mode: the media crops itself to its box, keeping a focal
 * point in frame as the box resizes — responsive art direction. (The spec
 * names `crop` among layout's modes without defining it; this is the
 * agreed reading, and `focal: 'subject'` takes over once vision exists.)
 *
 * CSS `object-position: 60% 30%` only guarantees the focal point is
 * somewhere in frame. This centres it when the image is large enough to,
 * and clamps at the image's edges so no empty band ever shows.
 */

export type FocalPoint = readonly [number, number]

/**
 * The `object-position` (in px) that puts `focal` (0..1 of the image) at
 * the centre of a `boxWidth` x `boxHeight` box under `object-fit: cover`,
 * clamped so the image always covers the box.
 */
export function focalCropPosition(naturalWidth: number, naturalHeight: number, boxWidth: number, boxHeight: number, focal: FocalPoint): { x: number; y: number } {
  const scale = Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  const clamp = (value: number, min: number) => Math.min(0, Math.max(min, value))
  return {
    x: clamp(boxWidth / 2 - focal[0] * width, boxWidth - width),
    y: clamp(boxHeight / 2 - focal[1] * height, boxHeight - height),
  }
}

/** `'4/5'`, `'16 / 9'` or a number -> the CSS aspect-ratio value, or null
 *  for something that isn't one. */
export function parseAspect(aspect: string | number): string | null {
  if (typeof aspect === 'number') return aspect > 0 && Number.isFinite(aspect) ? String(aspect) : null
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?)\s*)?$/.exec(aspect)
  if (!match) return null
  const ratio = Number(match[1]) / Number(match[2] ?? 1)
  return ratio > 0 && Number.isFinite(ratio) ? `${match[1]} / ${match[2] ?? 1}` : null
}
