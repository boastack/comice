/**
 * comice/core/drivers/click
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 04: { toggle }. "A single discrete event, useful for state
 * machines with only two states."
 *
 * The simplest driver in the catalogue — no smoothing, no velocity, no
 * scheduler registration at all, because there is nothing continuous to
 * track between events. A click either reports progress 1 (entering the
 * clicked state) or, with `toggle: true`, alternates 1/0 on successive
 * clicks so the same handler can drive a state machine open and closed
 * without external bookkeeping.
 */

import type { Driver } from '../types.js'
import { eventReachesTarget, listenOnDocument } from './hit.js'

export type ClickOptions = {
  /** When true, each click alternates progress between 1 and 0 instead of
   *  always reporting 1 — lets a single click driver open and close the
   *  same state machine. Default false (every click reports 1). */
  toggle?: boolean
}

export function click(options: ClickOptions = {}): Driver {
  const { toggle = false } = options

  return {
    name: 'click',
    attach(target, onSignal) {
      let toggledOn = false

      function onClick(event: MouseEvent): void {
        if (!eventReachesTarget(target, event)) return
        if (!toggle) {
          onSignal({ progress: 1 })
          return
        }
        toggledOn = !toggledOn
        onSignal({ progress: toggledOn ? 1 : 0 })
      }

      // On the document, not the target: a GL plugin's hidden target never
      // receives clicks (see hit.ts).
      return listenOnDocument(target, 'click', onClick)
    },
  }
}
