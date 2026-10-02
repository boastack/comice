/**
 * comice/core/drivers/drag
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 04: { axis, inertia }. "Pointer and touch drag with momentum,
 * feeding the same event shape as scroll."
 *
 * "The same event shape as scroll" means a plain Driver reporting
 * `progress` 0..1 — dragging the target across its own width (or height,
 * per `axis`) sweeps progress start to end, exactly like scroll sweeping an
 * element through the viewport. Momentum after release continues that same
 * progress sweep, decaying by `inertia` each frame, rather than snapping
 * straight to rest — this is what makes a drag feel like it has weight
 * instead of stopping dead the instant the pointer lifts.
 *
 * Rides the shared scheduler (getSharedScheduler(), scheduler.ts) for the
 * inertia decay loop rather than a private requestAnimationFrame — this is
 * a driver written after T1-T5 established that discipline for every
 * GPU-adjacent file in this package, and there is no reason a new driver
 * should regress to a private loop just because pointer.ts (written
 * earlier) still has one of its own.
 */

import { prefersReducedMotion } from '../motion.js'
import { getSharedScheduler } from '../scheduler.js'
import type { Driver } from '../types.js'
import { eventReachesTarget, listenOnDocument } from './hit.js'

export type DragOptions = {
  /** Which axis progress is measured along. Default 'x'. */
  axis?: 'x' | 'y'
  /** Momentum decay per frame after release, 0..1. 0 stops instantly
   *  (no inertia). Closer to 1 coasts longer. Default 0.92. */
  inertia?: number
}

// Below this per-frame velocity (progress units per 16.67ms frame), the
// inertia phase is considered settled and stops ticking rather than
// decaying forever toward an imperceptible fraction — matches the
// discipline elsewhere in this package of never running a scheduler entry
// that isn't doing meaningful work.
const INERTIA_SETTLE_THRESHOLD = 0.0005

export function drag(options: DragOptions = {}): Driver {
  const { axis = 'x', inertia = 0.92 } = options

  return {
    name: 'drag',
    attach(target, onSignal) {
      let progress = 0
      let velocity = 0 // progress units per frame-at-60fps, signed
      let dragging = false
      let pointerId: number | null = null
      let startClientPos = 0
      let startProgress = 0
      let lastClientPos = 0
      let lastMoveTimestamp = 0
      let unregisterInertia: (() => void) | null = null

      function extent(): number {
        const rect = target.getBoundingClientRect()
        const size = axis === 'x' ? rect.width : rect.height
        return size > 0 ? size : 1 // guard divide-by-zero for a zero-size target
      }

      function clientPos(event: PointerEvent): number {
        return axis === 'x' ? event.clientX : event.clientY
      }

      function report(): void {
        onSignal({ progress, velocity: velocity * 60 }) // per-second, matching pointer.ts's convention
      }

      function stopInertia(): void {
        unregisterInertia?.()
        unregisterInertia = null
      }

      function startInertia(): void {
        stopInertia()
        unregisterInertia = getSharedScheduler().add(
          () => {
            if (Math.abs(velocity) < INERTIA_SETTLE_THRESHOLD) {
              velocity = 0
              stopInertia()
              return
            }
            progress = Math.max(0, Math.min(1, progress + velocity))
            velocity *= inertia
            report()
          },
          () => !dragging,
        )
      }

      function onPointerDown(event: PointerEvent): void {
        // Only one active drag pointer at a time — a second pointerdown
        // while already dragging is ignored rather than fighting the
        // first for control of progress.
        if (dragging) return
        if (!eventReachesTarget(target, event)) return
        dragging = true
        stopInertia()
        pointerId = event.pointerId
        startClientPos = clientPos(event)
        lastClientPos = startClientPos
        startProgress = progress
        velocity = 0
        lastMoveTimestamp = 0
        // No setPointerCapture: moves and the release are already tracked
        // on the document, so the drag keeps following the pointer outside
        // the target without it — and capture retargets the browser's own
        // follow-up `click` to the capturing element, the same bug found and
        // fixed in @comice/rail (clicks on content inside never arrived).
      }

      function onPointerMove(event: PointerEvent): void {
        if (!dragging || event.pointerId !== pointerId) return
        const pos = clientPos(event)
        const delta = (pos - startClientPos) / extent()
        const now = event.timeStamp
        const dt = lastMoveTimestamp ? now - lastMoveTimestamp : 16.67

        const nextProgress = Math.max(0, Math.min(1, startProgress + delta))
        // Velocity tracked per-frame-at-60fps, matching the units
        // startInertia()'s decay loop expects — frame-rate-independent by
        // scaling the raw per-ms delta up to a 16.67ms-equivalent step.
        velocity = dt > 0 ? ((nextProgress - progress) / dt) * 16.67 : 0
        progress = nextProgress
        lastClientPos = pos
        lastMoveTimestamp = now

        report()
      }

      function endDrag(event: PointerEvent): void {
        if (!dragging || event.pointerId !== pointerId) return
        dragging = false
        pointerId = null
        // Under reduced motion a release stops where the pointer let go —
        // no coasting on after the person has stopped moving.
        if (Math.abs(velocity) >= INERTIA_SETTLE_THRESHOLD && !prefersReducedMotion()) {
          startInertia()
        }
      }

      // On the document (see hit.ts): the target may be hidden by a GL
      // plugin, and a drag has to keep tracking once it leaves the target.
      const removers = [
        listenOnDocument(target, 'pointerdown', onPointerDown),
        listenOnDocument(target, 'pointermove', onPointerMove),
        listenOnDocument(target, 'pointerup', endDrag),
        listenOnDocument(target, 'pointercancel', endDrag),
      ]

      return () => {
        stopInertia()
        removers.forEach((remove) => remove())
      }
    },
  }
}
