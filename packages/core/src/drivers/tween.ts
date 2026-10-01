/**
 * comice/core/drivers/tween
 * ─────────────────────────────────────────────────────────────────────────────
 * Internal (not exported from drivers/index.ts): turns a discrete driver's
 * jump (click, hover) into a real progress stream.
 *
 * WHY: core routes driver signals into the state machine one transition per
 * signal, and a transition resets progress to 0 (index.ts). A click used to
 * send a single `{ progress: 1 }`: idle -> entering, progress reset to 0 —
 * and nothing ever arrived to finish entering -> active. Every click()- or
 * hover()-driven instance sat in 'entering' at progress 0 forever, so
 * anything reading progress (type's melt, whose blur peaks at 0.5) never
 * moved. Found on harness/site/: 12 samples over 1.2s, all 'entering', 0.
 *
 * So the driver animates progress from wherever it is to the target over
 * `duration`, on the shared scheduler, one signal per frame — the same kind
 * of stream scroll/pointer already produce. Interrupting (a click mid-
 * animation) reverses from the current value, never jumps.
 *
 * SETTLE: on arrival the final value is sent twice. Going up, the first
 * arrival finishes entering -> active; going down, arrival at 0 is
 * active -> leaving, and only the second reaches leaving -> idle. A repeat
 * in an already-settled state is a no-op for the machine.
 */

import { getSharedScheduler } from '../scheduler.js'
import type { DriverSignal } from '../types.js'

export type Tween = {
  /** Animate to `target` (0..1), reversing from the current value. */
  to(target: number): void
  /** Stops any running animation. */
  stop(): void
}

export function createTween(onSignal: (signal: DriverSignal) => void, durationMs: number): Tween {
  let value = 0
  let from = 0
  let target = 0
  let elapsed = 0
  let span = 0 // ms this leg takes: proportional to the distance left
  let unregister: (() => void) | null = null

  function stop(): void {
    unregister?.()
    unregister = null
  }

  function arrive(): void {
    stop()
    value = target
    onSignal({ progress: target })
    onSignal({ progress: target })
  }

  function tick(deltaMs: number): void {
    elapsed += deltaMs
    if (elapsed >= span) {
      arrive()
      return
    }
    value = from + (target - from) * (elapsed / span)
    onSignal({ progress: value })
  }

  return {
    to(next: number): void {
      stop()
      from = value
      target = Math.max(0, Math.min(1, next))
      elapsed = 0
      // A reversal halfway through takes half the time, not the full
      // duration again, so interrupted hovers feel continuous.
      span = durationMs * Math.abs(target - from)
      if (span <= 0) {
        arrive()
        return
      }
      unregister = getSharedScheduler().add(
        (deltaMs) => tick(deltaMs),
        () => unregister !== null,
      )
    },
    stop,
  }
}
