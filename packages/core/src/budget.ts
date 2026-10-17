/**
 * comice/core/budget
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec §13, "Watch the frame clock: step down resolution, then chain length,
 * then a static poster if frames keep missing budget." Not built until now.
 *
 * The scheduler reports every frame's delta here. When two seconds of frames
 * in a row miss their budget (averaging under ~40fps), quality steps down
 * one level. The window is a second of TIME, not a count of
 * frames: 60 frames is one second on a healthy page but twelve on a page
 * running at 5fps, exactly when a decision is most needed:
 *
 *   0  full resolution
 *   1  75% resolution  ─┐ every GPU allocation reads effectiveDPR(), which
 *   2  50% resolution  ─┘ multiplies by renderScale(); canvases resize next frame
 *   3  poster          — effects stop drawing; each canvas keeps showing its
 *                        last frame, a still image instead of a blank
 *
 * "Then chain length" has no step here: core allows one GL effect per
 * element (gl/context.ts's mountCanvas), so there is no chain to shorten.
 *
 * Resolution levels step back up when frames run comfortably fast again.
 * The poster is STICKY for the page: with nothing drawing, frames look fast
 * again by construction, and recovering from that would flip straight back.
 *
 * A developer who would rather manage quality themselves calls
 * setAdaptiveQuality(false), which pins full quality.
 */

export type QualityLevel = 0 | 1 | 2 | 3

const POSTER: QualityLevel = 3
const SCALES = [1, 0.75, 0.5, 0.5] as const
const WINDOW_MS = 1000 // one decision per second of frames
const SLOW_MS = 1000 / 40 // averaging slower than this misses budget
const FAST_MS = 1000 / 55 // averaging faster than this has headroom
const IGNORE_OVER_MS = 1000 // a tab switch or a debugger pause, not rendering cost — a 3fps page's 333ms frames still count

let level: QualityLevel = 0
let quietUntil = 0
let adaptive = true
let sum = 0
let count = 0
let fastWindows = 0
let slowWindows = 0

/** Records one frame's duration. Called by the scheduler every tick. */
export function recordFrame(deltaMs: number): void {
  if (!adaptive || level === POSTER || deltaMs <= 0 || deltaMs > IGNORE_OVER_MS) return
  if (performance.now() < quietUntil) return
  sum += deltaMs
  count++
  if (sum < WINDOW_MS) return

  const average = sum / count
  sum = 0
  count = 0
  if (average > SLOW_MS) {
    fastWindows = 0
    // Two slow seconds in a row, not one: page load (decoding, shader
    // compiles, first uploads) is one slow second on almost every page, and
    // stepping down for it cost a healthy page resolution for the whole
    // visit (seen on harness/site/: level 1 before anything was slow).
    if (++slowWindows >= 2) {
      level = (level + 1) as QualityLevel
      slowWindows = 0
    }
  } else if (average < FAST_MS && level > 0) {
    slowWindows = 0
    // Two fast windows in a row before stepping back up, so one quiet
    // second does not undo a step that a busy one needed.
    if (++fastWindows >= 2) {
      level = (level - 1) as QualityLevel
      fastWindows = 0
    }
  } else {
    fastWindows = 0
    slowWindows = 0
  }
}

/**
 * Stops counting frames for `ms` (default two seconds). Mounting an effect is
 * one-off work (compiling a shader, baking a mask, the first uploads) that
 * stalls a few frames; that is setup, not sustained rendering cost. Without
 * this, an app that remounts an effect repeatedly, such as a settings panel
 * that rebuilds it on every slider move, read as "too slow", stepped down to
 * the poster, and froze every effect on the page until reload. Frames already
 * counted stay counted; only the frames inside the window are skipped.
 */
export function quietFor(ms = 2000): void {
  quietUntil = performance.now() + ms
  sum = 0
  count = 0
  slowWindows = 0
}

/** The current quality level, 0 (full) to 3 (poster). */
export function qualityLevel(): QualityLevel {
  return level
}

/** Multiplier on the device pixel ratio for every GPU allocation. */
export function renderScale(): number {
  return SCALES[level]
}

/** Whether effects should stop drawing and hold their last frame. */
export function isPoster(): boolean {
  return level === POSTER
}

/** Turns automatic quality stepping on (default) or off. Off pins full
 *  quality and clears any step already taken. */
export function setAdaptiveQuality(enabled: boolean): void {
  adaptive = enabled
  if (!enabled) resetQuality()
}

/** Back to full quality with a fresh measurement window. */
export function resetQuality(): void {
  level = 0
  quietUntil = 0
  sum = 0
  count = 0
  fastWindows = 0
  slowWindows = 0
}
