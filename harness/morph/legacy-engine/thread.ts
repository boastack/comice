/**
 * @comice/morph/thread
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec §08's `thread` option on `morph`: `{ width, pinch, sag, dissolve }`,
 * "models the bridge between separating shapes so they break rather than
 * simply stop touching." The example usage in the spec artifact: media
 * collapsing into a logo, "the connecting tissue stretches and visibly
 * snaps rather than fading, matching how honey or wax actually breaks
 * apart."
 *
 * UNLIKE EVERY OTHER FILE IN THIS PACKAGE, this one has NO legacy
 * reference to port — `thread` does not exist anywhere in
 * the original prototype pages. This is real, new GLSL,
 * designed from the spec's own description rather than transcribed from a
 * working implementation. Kept in its own module (mirroring sdf.ts's
 * pattern: a small, self-contained, independently testable GLSL library)
 * specifically so that distinction is visible in the source layout, not
 * buried inside shader.ts alongside the ported math.
 *
 * THE MODEL: a thread is a capsule-like connector between two points —
 * `from` (a distribute target's current, still-separated position) and
 * `to` (where it is merging toward, the origin in every layouts.ts
 * layout) — that exists only while the two points are meaningfully apart,
 * and thins, sags and breaks up as they approach:
 *
 *   - `width`: the strand's base half-thickness at its thickest (the
 *     `from` end), CSS px.
 *   - `pinch`: 0..1, how much the strand narrows toward its `to` end
 *     relative to `width` — a thread that's about to detach reads as
 *     "thinning toward where it's pulling free," not a uniform-width bar.
 *   - `sag`: droop under simulated gravity, CSS px at the strand's
 *     midpoint when fully stretched, scaled by how far apart `from` and
 *     `to` currently are (a fully-collapsed thread has nothing to sag).
 *   - `dissolve`: how deeply the strand's edge tears as it stretches, CSS
 *     px — 0 is a clean strand that simply thins; more reads as torn and
 *     dotted, the "snap" spec's own description asks for rather than a
 *     fade.
 *
 * UNITS: px, because that's how the spec's own example reads (`thread: {
 * sag: 6, dissolve: 4 }`). They used to be unitless factors with dissolve
 * clamped to 0..1: that example drooped by 1.5x the strand's length and
 * clamped its tear. shader.ts converts px to st (1 / u_resolution.y).
 *
 * `sdThread()` returns a signed distance exactly like every function in
 * sdf.ts, so a consumer unions it into an existing shape union
 * (`smin`/`min`) the same way every layout already combines its own
 * per-target shapes — a thread is one more operand in that union, not a
 * separate render pass.
 */

/**
 * Declares `float sdThread(vec2 p, vec2 from, vec2 to, float width, float
 * pinch, float sag, float dissolve, float separation)`.
 *
 * `separation` is 0..1, how far apart `from`/`to` currently are relative
 * to their maximum possible separation for this instance (a caller passes
 * something like `pMerge`-derived progress, NOT a raw pixel distance) —
 * it gates both `sag` (no droop when the two points are already
 * touching) and `dissolve` (no tearing on a fully-formed, unstretched
 * strand) so the thread reads as "appearing and thinning as things pull
 * apart," not a permanently-torn bar sitting between two touching shapes.
 *
 * Depends on nothing from sdf.ts — the capsule/line-segment distance
 * function here is self-contained, not built from sdRoundedBox or any
 * other existing primitive, since a tapered, sagging capsule is a
 * genuinely different shape family from the box/circle/ellipse/arch
 * primitives sdf.ts already has.
 */
export const SD_THREAD_GLSL = `
float sdThread(vec2 p, vec2 from, vec2 to, float width, float pinch, float sag, float dissolve, float separation) {
  vec2 span = to - from;
  float spanLength = max(length(span), 0.00001);
  vec2 spanDir = span / spanLength;

  float along = clamp(dot(p - from, spanDir), 0.0, spanLength);
  float t = along / spanLength; // 0 at 'from', 1 at 'to'

  // sag: a parabolic droop peaking at the strand's midpoint, scaled by
  // how far apart the two ends currently are — perpendicular to the
  // strand's own direction, so it reads as "hanging," not a shape
  // distortion along the strand's length.
  vec2 perp = vec2(-spanDir.y, spanDir.x);
  float sagAmount = sag * separation * 4.0 * t * (1.0 - t);

  vec2 centerLine = from + spanDir * along + perp * sagAmount;
  float distToLine = length(p - centerLine);

  // pinch: the strand's radius narrows linearly from 'width' at 'from'
  // toward 'width * (1.0 - pinch)' at 'to'.
  float radius = width * mix(1.0, 1.0 - pinch, t);

  float d = distToLine - radius;

  // dissolve: breaks the strand's edge into a torn/dotted pattern rather
  // than a smooth taper, increasing with 'separation' (a thread that has
  // barely started stretching stays clean; one that's nearly pulled apart
  // reads as tearing). A cheap, deterministic "noise" from a sine lattice
  // along the strand — not gl/noise.ts's simplex noise, since a thread
  // tear pattern wants a directional, elongated break, not an isotropic
  // field; a dedicated cheap function here avoids pulling gl/noise.ts's
  // whole library into every distribute layout that never uses threads.
  float tearNoise = sin(t * 47.0 + p.x * 23.0) * sin(t * 31.0 - p.y * 19.0);
  float tearAmount = dissolve * separation;
  d += tearNoise * tearAmount;

  return d;
}
`
