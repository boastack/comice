/**
 * comice/core/drivers/time
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 04: { duration, loop }. "The one driver that behaves like a
 * classic tween, for plugins that genuinely want a duration."
 *
 * Every other native driver deliberately avoids a fixed-duration timeline —
 * section 03's whole argument is that real interaction (scroll, hover,
 * drag) should never be modeled as "play for 400ms." time() is the one
 * acknowledged exception: some effects (an ambient background loop, a
 * demo/showcase autoplay) genuinely have no external signal to key off and
 * legitimately want "just run for N seconds." Reaching for time() when a
 * real driver would do — using time() to fake what scroll() or hover()
 * should be reporting — is a misuse of this driver, not a limitation.
 *
 * Rides getSharedScheduler() rather than a private rAF loop, same as
 * drag.ts and every T1-T5 file — one shared loop for the whole page holds
 * for time-based progress the same as it holds for GPU state.
 */

import { getSharedScheduler } from '../scheduler.js'
import type { Driver } from '../types.js'

export type TimeOptions = {
  /** Duration of one full 0..1 sweep, in ms. Default 1000. */
  duration?: number
  /** When true, progress wraps back to 0 and repeats indefinitely instead
   *  of reporting 1 once and stopping. Default false. */
  loop?: boolean
}

export function time(options: TimeOptions = {}): Driver {
  const { duration = 1000, loop = false } = options

  return {
    name: 'time',
    attach(_target, onSignal) {
      let elapsed = 0
      let finished = false

      const unregister = getSharedScheduler().add(
        (deltaMs) => {
          if (finished) return
          elapsed += deltaMs
          const raw = duration > 0 ? elapsed / duration : 1

          if (raw >= 1) {
            if (loop) {
              // Wrap rather than clamp-and-stall at exactly 1 — modulo
              // keeps the sweep continuous even if a frame overshoots the
              // duration boundary by more than one cycle (a long tab
              // background pause resuming, say), rather than skipping to
              // 0 and losing that overshoot's phase.
              elapsed = duration > 0 ? elapsed % duration : 0
              onSignal({ progress: duration > 0 ? elapsed / duration : 0 })
              return
            }
            finished = true
            onSignal({ progress: 1 })
            return
          }

          onSignal({ progress: raw })
        },
        () => !finished,
      )

      return () => {
        unregister()
      }
    },
  }
}
