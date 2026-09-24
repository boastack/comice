/**
 * comice/core/drivers/hover
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 04: { intent }. Enter and leave with a debounce so fast pass-overs
 * do not fire a full state cycle.
 *
 * Tracks enter/leave from document-level pointermove rather than the
 * target's own pointerenter/pointerleave: those never fire on a target a GL
 * plugin has hidden (see hit.ts). "Over" means the same thing native hover
 * would mean if the target were visible — an overlay drawn on top of it
 * counts as leaving.
 */

import type { Driver } from '../types.js'
import { eventReachesTarget, isWindowLeave, listenOnDocument } from './hit.js'

export type HoverOptions = {
  /** Delay in ms before an enter counts, filtering out fast pointer pass-overs. Default 80. */
  intent?: number
}

export function hover(options: HoverOptions = {}): Driver {
  const { intent = 80 } = options

  return {
    name: 'hover',
    attach(target, onSignal) {
      let enterTimer: ReturnType<typeof setTimeout> | null = null
      let over = false

      function enter(): void {
        over = true
        if (enterTimer) clearTimeout(enterTimer)
        enterTimer = setTimeout(() => {
          enterTimer = null
          onSignal({ progress: 1 })
        }, intent)
      }

      function leave(): void {
        over = false
        if (enterTimer) {
          clearTimeout(enterTimer)
          enterTimer = null
        }
        onSignal({ progress: 0 })
      }

      function onMove(event: PointerEvent): void {
        const reaches = eventReachesTarget(target, event)
        if (reaches && !over) enter()
        else if (!reaches && over) leave()
      }

      function onLeaveWindow(event: PointerEvent): void {
        if (over && isWindowLeave(target, event)) leave()
      }

      const removeMove = listenOnDocument(target, 'pointermove', onMove)
      const removeLeave = listenOnDocument(target, 'pointerleave', onLeaveWindow)

      return () => {
        if (enterTimer) clearTimeout(enterTimer)
        removeMove()
        removeLeave()
      }
    },
  }
}
