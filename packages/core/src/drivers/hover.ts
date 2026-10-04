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
 *
 * Enter and leave are ANIMATED over `duration` (see tween.ts): a single
 * `{ progress: 1 }` left every hover-driven instance stuck in 'entering' at
 * progress 0, so nothing reading progress ever moved.
 */

import type { Driver } from '../types.js'
import { eventReachesTarget, isWindowLeave, listenOnDocument } from './hit.js'
import { createTween } from './tween.js'

export type HoverOptions = {
  /** Delay in ms before an enter counts, filtering out fast pointer pass-overs. Default 80. */
  intent?: number
  /** Milliseconds a full 0 -> 1 takes; leaving mid-enter reverses from the
   *  current value. 0 jumps instantly. Default 400. */
  duration?: number
}

export function hover(options: HoverOptions = {}): Driver {
  const { intent = 80, duration = 400 } = options

  return {
    name: 'hover',
    attach(target, onSignal) {
      let enterTimer: ReturnType<typeof setTimeout> | null = null
      let over = false
      let entered = false // whether an enter actually went out (intent elapsed)
      const tween = createTween(onSignal, duration)

      function enter(): void {
        over = true
        if (enterTimer) clearTimeout(enterTimer)
        enterTimer = setTimeout(() => {
          enterTimer = null
          entered = true
          tween.to(1)
        }, intent)
      }

      function leave(): void {
        over = false
        if (enterTimer) {
          clearTimeout(enterTimer)
          enterTimer = null
        }
        // A pass-over cancelled inside `intent` never entered: nothing to
        // animate back from.
        if (!entered) return
        entered = false
        tween.to(0)
      }

      function onMove(event: PointerEvent): void {
        // A finger moving is a scroll, not a hover: it would light up every
        // card it passes on the way down the page.
        if (event.pointerType === 'touch') return
        const reaches = eventReachesTarget(target, event)
        if (reaches && !over) enter()
        else if (!reaches && over) leave()
      }

      /** Touch has no hover: a tap on the element enters (at once — a tap
       *  is already deliberate), a tap anywhere else leaves. Without this,
       *  a hover()-driven spotlight never responded on a phone, and its
       *  revealed captions were unreachable by touch, which the spec's
       *  spotlight card rules out. */
      function onDown(event: PointerEvent): void {
        if (event.pointerType !== 'touch') return
        if (eventReachesTarget(target, event)) {
          if (entered || over) return
          over = true
          entered = true
          tween.to(1)
        } else if (over) {
          leave()
        }
      }

      function onLeaveWindow(event: PointerEvent): void {
        // A lifted finger "leaves" every element, the document included: not
        // a hover ending (only a tap elsewhere ends it on touch).
        if (event.pointerType === 'touch') return
        if (over && isWindowLeave(target, event)) leave()
      }

      const removeMove = listenOnDocument(target, 'pointermove', onMove)
      const removeLeave = listenOnDocument(target, 'pointerleave', onLeaveWindow)
      const removeDown = listenOnDocument(target, 'pointerdown', onDown)

      return () => {
        if (enterTimer) clearTimeout(enterTimer)
        tween.stop()
        removeMove()
        removeLeave()
        removeDown()
      }
    },
  }
}
