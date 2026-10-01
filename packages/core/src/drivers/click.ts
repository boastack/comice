/**
 * comice/core/drivers/click
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 04: { toggle }. "A single discrete event, useful for state
 * machines with only two states."
 *
 * A click moves progress to 1 (entering the clicked state) or, with
 * `toggle: true`, alternates 1/0 on successive clicks so the same handler
 * can drive a state machine open and closed without external bookkeeping.
 *
 * The move is ANIMATED over `duration` (see tween.ts), not a single jump:
 * a lone `{ progress: 1 }` left every click-driven instance stuck in
 * 'entering' at progress 0, so nothing that reads progress ever moved.
 */

import type { Driver } from '../types.js'
import { eventReachesTarget, listenOnDocument } from './hit.js'
import { createTween } from './tween.js'

export type ClickOptions = {
  /** When true, each click alternates progress between 1 and 0 instead of
   *  always reporting 1 — lets a single click driver open and close the
   *  same state machine. Default false (every click reports 1). */
  toggle?: boolean
  /** Milliseconds a full 0 -> 1 takes. A click mid-animation reverses from
   *  where progress is, taking proportionally less. 0 jumps instantly (and
   *  still settles the state machine). Default 400. */
  duration?: number
}

export function click(options: ClickOptions = {}): Driver {
  const { toggle = false, duration = 400 } = options

  return {
    name: 'click',
    attach(target, onSignal) {
      let toggledOn = false
      const tween = createTween(onSignal, duration)

      function onClick(event: MouseEvent): void {
        if (!eventReachesTarget(target, event)) return
        if (!toggle) {
          tween.to(1)
          return
        }
        toggledOn = !toggledOn
        tween.to(toggledOn ? 1 : 0)
      }

      // On the document, not the target: a GL plugin's hidden target never
      // receives clicks (see hit.ts).
      const removeClick = listenOnDocument(target, 'click', onClick)
      return () => {
        tween.stop()
        removeClick()
      }
    },
  }
}
