/**
 * @comice/morph/sdf
 * ─────────────────────────────────────────────────────────────────────────────
 * The shared signed-distance-field GLSL library `morph` is built on. Ported,
 * not re-derived — ROADMAP.md's T7 entry and CLAUDE.md-equivalent guidance
 * are explicit that the original prototype’s SDF/liquid-blend math is a
 * working, proven implementation validated against real footage, and the
 * job here is generalizing it into the five spec operations, not
 * re-deriving distance-field math from a blank page.
 *
 * Every function below is taken directly from the original prototype’s
 * `fragmentShader` template (search that file for `float smin`,
 * `float sdRoundedBox`, `mat2 rotate2d`, `float sdEllipseApprox`,
 * `float sdArch`) with no changes to the math itself — only reformatting
 * to live as a standalone GLSL-source-string module, the same pattern
 * gl/noise.ts (T5) established for GLSL that isn't tied to any one
 * WebGL2RenderingContext.
 *
 * Same reasoning as gl/noise.ts for why this is source text, not TS logic
 * touching a GL context: there is no GPU resource to allocate for a pure
 * math library, so there is nothing to leak and no fake-GL context needed
 * to exercise it. Testing here is string-shape only (right signatures,
 * balanced braces) for the same honest reason gl/noise.ts's tests are —
 * this environment has no GLSL compiler.
 */

/**
 * Smooth minimum — legacy's liquid union. `smin(a, b, k)` blends two
 * distance fields with a rounded, "liquid" transition when k > 0; k -> 0
 * degrades toward a hard min(). This is THE primitive that makes shapes
 * merging together look like they're made of a single material rather than
 * two shapes overlapping — every operation below that combines multiple
 * shapes into one (merge, distribute's multi-target union) goes through
 * this, never a plain `min()`, when liquid blending is wanted.
 */
export const SMIN_GLSL = `
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
`

/** A rounded-rectangle SDF, `p` in the box's local (centered) space, `b`
 *  the box's half-extents, `r` the corner radius. legacy's most-used shape
 *  primitive — cardDeck, gameSymbols' square/cross, radialFan, filmStrip,
 *  audioSpectrum and waveTiles all reduce to one or more of these. */
export const SD_ROUNDED_BOX_GLSL = `
float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
`

/** A 2D rotation matrix. Used to orient a distributed target's shape
 *  (radialFan's fanned cards, cardDeck's stagger, waveTiles/filmStrip's
 *  gentle tilt) without needing a separate rotated-SDF variant per shape. */
export const ROTATE2D_GLSL = `
mat2 rotate2d(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}
`

/** An approximate ellipse SDF (exact only at the major/minor axes, close
 *  enough everywhere else for this library's purposes — legacy's own
 *  comment-free use in the `petals` layout accepts the same approximation).
 *  `radius` is (rx, ry) in `p`'s local space. */
export const SD_ELLIPSE_APPROX_GLSL = `
float sdEllipseApprox(vec2 p, vec2 radius) {
  return (length(p / radius) - 1.0) * min(radius.x, radius.y);
}
`

/** A rounded-arch SDF: a rounded box body topped with a half-circle dome,
 *  composed from sdRoundedBox + a circle rather than its own closed-form
 *  distance function — exactly how legacy's `arches` layout built it.
 *  Depends on sdRoundedBox, so a consumer splicing this in must also
 *  splice in SD_ROUNDED_BOX_GLSL first (composeSdfGLSL() below handles the
 *  ordering, same pattern as gl/noise.ts's composeNoiseGLSL()). */
export const SD_ARCH_GLSL = `
float sdArch(vec2 p, vec2 size) {
  float body = sdRoundedBox(p - vec2(0.0, -size.y * 0.22), vec2(size.x, size.y * 0.72), 0.025);
  float dome = length(p - vec2(0.0, size.y * 0.48)) - size.x;
  return min(body, dome);
}
`

export type SdfLibraryOptions = {
  /** Skip sdArch (and its sdRoundedBox dependency stays optional too, see
   *  below) if a caller's layouts never use arches. Default true. */
  arch?: boolean
  /** Skip rotate2d if no layout in use needs rotated shapes. Default true. */
  rotate?: boolean
  /** Skip sdEllipseApprox if no layout in use needs ellipses. Default true. */
  ellipse?: boolean
}

/**
 * Concatenates the SDF library in dependency order (smin and
 * sdRoundedBox always first, since sdArch depends on sdRoundedBox) and
 * returns one GLSL source block. Mirrors gl/noise.ts's composeNoiseGLSL()
 * exactly — same reasoning: "which order do these go in" is answered once,
 * here, not by every shader-writing consumer independently.
 *
 * sdRoundedBox is always included (nearly every layout needs it); smin is
 * always included (the liquid union is morph's whole identity per §07/§08).
 * arch/rotate/ellipse are individually toggleable since a shape shader that
 * never uses arches, say, gains nothing from compiling sdArch.
 */
export function composeSdfGLSL(options: SdfLibraryOptions = {}): string {
  const { arch = true, rotate = true, ellipse = true } = options
  let source = SMIN_GLSL + SD_ROUNDED_BOX_GLSL
  if (rotate) source += ROTATE2D_GLSL
  if (ellipse) source += SD_ELLIPSE_APPROX_GLSL
  if (arch) source += SD_ARCH_GLSL
  return source
}
