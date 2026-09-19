/**
 * comice/core/drivers/hover
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 04: { intent }. Enter and leave with a debounce so fast pass-overs
 * do not fire a full state cycle.
 */

import type { Driver, DriverSignal } from '../types.js'

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

      function onEnter(): void {
        if (enterTimer) clearTimeout(enterTimer)
        enterTimer = setTimeout(() => {
          onSignal({ progress: 1 })
        }, intent)
      }

      function onLeave(): void {
        if (enterTimer) {
          clearTimeout(enterTimer)
          enterTimer = null
        }
        onSignal({ progress: 0 })
      }

      target.addEventListener('pointerenter', onEnter)
      target.addEventListener('pointerleave', onLeave)

      return () => {
        if (enterTimer) clearTimeout(enterTimer)
        target.removeEventListener('pointerenter', onEnter)
        target.removeEventListener('pointerleave', onLeave)
      }
    },
  }
}
