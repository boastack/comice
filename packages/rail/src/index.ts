/**
 * @comice/rail
 * ─────────────────────────────────────────────────────────────────────────────
 * Media collections you move through, with physics that feel physical —
 * spec §08's own words. T9 (ROADMAP.md §4). No new GPU primitive: every
 * mode is a CSS-transform layout over the collection's own DOM children
 * (spec's own "Not a 3D engine" line, §05 — flat items, clever transforms,
 * no meshes/cameras), so this plugin is pure DOM/CSS, same category as
 * spotlight and reveal.
 *
 * ALL SEVEN MODES SHIP THIS PASS: canvas, strip, compare, stack, marquee,
 * arc, coverflow — see physics.ts's `layoutFor()` for each mode's own
 * per-item transform math, kept pure and separately tested there.
 *
 * DRIVER, NOT `.driver(drag())`: rail owns its own pointer/touch drag
 * handling directly rather than routing through core's `drag()` driver.
 * `drag()` reports a single 0..1 progress number sweeping the WHOLE
 * element once — correct for a scroll-linked reveal, wrong for a
 * collection where dragging moves a continuous "which item am I between"
 * position across N items and must keep working exactly the same
 * regardless of how many items exist. rail's own pointer handling below
 * is structurally the same shape as drag.ts (same pointer capture,
 * same "same event shape as scroll" velocity tracking, same
 * getSharedScheduler()-driven inertia decay), just parameterised over
 * itemCount instead of a fixed 0..1 sweep.
 *
 * KEYBOARD + ANNOUNCEMENTS, PER SPEC: "Arrow key stepping, roving focus,
 * live region announcements. Default true" (the `keyboard` option).
 * Implemented directly — arrow keys step `position` by one item with the
 * same snap-to-nearest rail.transition() uses, roving tabindex keeps only
 * the active item focusable, and an `aria-live="polite"` region
 * (visually hidden, not display:none, so screen readers still announce
 * it) reports "item N of M" on every settle.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { prefersReducedMotion } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { clampPosition, computeItemTransform, decayVelocity, nearestIndex, SETTLE_THRESHOLD, wrapIndex, type ItemTransform, type RailMode, type RailState } from './physics.js'

export type RailOptions = {
  /** Layout mode. Required, matching spec exactly. */
  mode: RailMode
  /** Momentum decay per frame after release, 0..1. Default 0.92, matching
   *  spec exactly. */
  inertia?: number
  /** Snap to the nearest item once decelerating settles below the drag
   *  threshold. Default true. */
  snap?: boolean
  /** Arrow key stepping, roving focus, live region announcements. Default
   *  true, matching spec exactly. */
  keyboard?: boolean
  /** Fires with the centred (nearest) index whenever it changes, matching
   *  spec's own `onActive` option exactly. */
  onActive?: (index: number) => void
  /** Selector (relative to the target) matching each item element. When
   *  omitted, the target's direct children are used — the common case for
   *  a purpose-built rail container. */
  items?: string
}

const AXIS_PX_PER_ITEM = 320 // matches spec's carousel-scale examples; a caller with different item sizing overrides via CSS, this only sets the drag-distance-per-item feel

// A real bug found running rail against a real page with clickable item
// content (see harness/site/): capturing the pointer on EVERY pointerdown,
// including a plain stationary click, retargets the browser's own
// synthesized `click` event to `target` itself per the Pointer Events spec
// — it never reaches a clicked child (a project card's own click listener)
// at all, since a captured pointer's events (click included) fire on the
// capturing element regardless of what's visually under the cursor. Real
// drag gestures still need capture (so a fast drag that leaves the rail's
// own bounds keeps tracking), but a plain click must not trigger it. This
// threshold — capture only once the pointer has actually moved past a
// small deadzone — is the same "distinguish a click from a drag" pattern
// browsers themselves use for native draggable elements.
const CAPTURE_THRESHOLD_PX = 6

/** Visually hidden but still announced — the standard sr-only pattern,
 *  never display:none (which pulls it out of the accessibility tree
 *  entirely, defeating the whole point of a live region). */
function applyVisuallyHiddenStyle(el: HTMLElement): void {
  el.style.position = 'absolute'
  el.style.width = '1px'
  el.style.height = '1px'
  el.style.overflow = 'hidden'
  el.style.clip = 'rect(0,0,0,0)'
  el.style.whiteSpace = 'nowrap'
}

export function rail(options: RailOptions): ComicePlugin {
  const { mode, inertia = 0.92, snap = true, keyboard = true, onActive, items: itemsSelector } = options

  let target: HTMLElement | null = null
  let itemEls: HTMLElement[] = []
  let liveRegion: HTMLElement | null = null
  let unregisterInertia: (() => void) | null = null
  let destroyed = false
  let targetPositionWasSetByThisPlugin = false

  let railState: RailState = 'settled'
  let position = 0 // continuous item-index-space position
  let velocity = 0 // position units per frame-at-60fps
  let lastActiveIndex = -1

  let dragging = false
  let pointerId: number | null = null
  let dragStartClientX = 0
  let dragStartPosition = 0
  let lastMoveTimestamp = 0
  let hasCaptured = false // true once movement has passed CAPTURE_THRESHOLD_PX and setPointerCapture was actually called

  function itemCount(): number {
    return itemEls.length
  }

  function setState(next: RailState): void {
    railState = next
  }

  function announceIfChanged(): void {
    const index = nearestIndex(position, itemCount())
    if (index === lastActiveIndex) return
    lastActiveIndex = index
    onActive?.(index)
    if (liveRegion && itemCount() > 0) {
      liveRegion.textContent = `Item ${index + 1} of ${itemCount()}`
    }
    if (keyboard) {
      itemEls.forEach((el, i) => {
        el.tabIndex = i === index ? 0 : -1
      })
    }
  }

  function render(): void {
    itemEls.forEach((el, i) => {
      const t: ItemTransform = computeItemTransform(mode, i, position, itemCount())
      const px = t.offset * AXIS_PX_PER_ITEM
      // position: absolute is what actually makes translateX() a free
      // repositioning rather than an offset layered on top of whatever
      // normal-flow position the caller's own CSS already gave this
      // item (flex/grid/block) — a real bug found running this against
      // a real page: with items left in normal flow, translateX() moves
      // the PAINTED pixels but never the item's own hit-testable box, so
      // clicking/hovering where an item visually renders can miss it
      // entirely and hit a sibling or the container instead. Owned here,
      // not left as an undocumented "the caller must know to do this"
      // requirement — matches every other plugin in this repo owning
      // the CSS it actually depends on rather than relying on caller
      // convention (see setup()'s own position:relative fix-up on
      // `target`, right above, for the matching stacking-context half
      // of this same class of bug).
      el.style.position = 'absolute'
      el.style.top = '0'
      el.style.left = '0'
      el.style.transform = `translateX(${px}px) scale(${t.scale}) rotate(${t.rotate}deg)`
      el.style.opacity = `${t.opacity}`
      // physics.ts's own z values (stack/arc/coverflow) are relative
      // depth, some genuinely negative (the active item at 0, others
      // receding to -1, -2, ...) — correct as RELATIVE ordering, but a
      // second real bug found running this against a real page: a
      // negative z-index child of a `position: relative` (or `absolute`/
      // `fixed`) parent renders and HIT-TESTS behind that parent's own
      // box, even with a fully transparent background — confirmed
      // against a real browser with a minimal repro, not assumed. Every
      // item behind position 0 was therefore genuinely unclickable/
      // unhoverable once `target` itself became a positioning root
      // (this file's own fix, right above). Offsetting by itemCount()
      // guarantees the on-DOM z-index is never negative (the most any
      // single item's |delta| can be is itemCount() - 1) while leaving
      // physics.ts's own return values, and every one of its own tests,
      // completely unchanged — this is a render-time-only translation
      // from "relative depth" to "a real, non-negative CSS z-index."
      el.style.zIndex = `${Math.round(t.z) + itemCount()}`
    })
    announceIfChanged()
  }

  function stopInertia(): void {
    unregisterInertia?.()
    unregisterInertia = null
  }

  function settleAt(index: number): void {
    position = index
    velocity = 0
    setState('settled')
    render()
  }

  function startInertia(): void {
    stopInertia()
    setState('decelerating')
    unregisterInertia = getSharedScheduler().add(
      () => {
        if (velocity === 0) {
          // Deceleration ran out — either snap to the nearest item or
          // settle exactly where inertia left off.
          stopInertia()
          if (snap) {
            setState('snapping')
            settleAt(nearestIndex(position, itemCount()))
          } else {
            settleAt(Math.round(position * 1000) / 1000)
          }
          return
        }
        position = mode === 'marquee' ? position + velocity : clampPosition(position + velocity, itemCount())
        velocity = decayVelocity(velocity, inertia)
        render()
      },
      () => !destroyed && !dragging,
    )
  }

  function clientX(event: PointerEvent): number {
    return event.clientX
  }

  function onPointerDown(event: PointerEvent): void {
    if (dragging || itemCount() === 0) return
    dragging = true
    hasCaptured = false
    stopInertia()
    // NOT setState('dragging') yet — a plain click never moves past
    // CAPTURE_THRESHOLD_PX, and switching railState (which items'
    // rendering/announcements key off) for what turns out to be a click,
    // not a drag, would be an observable behavior change for a no-op
    // gesture. State flips to 'dragging' in onPointerMove, the same place
    // capture itself is now deferred to.
    pointerId = event.pointerId
    dragStartClientX = clientX(event)
    dragStartPosition = position
    lastMoveTimestamp = 0
    velocity = 0
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging || event.pointerId !== pointerId) return
    const x = clientX(event)
    if (!hasCaptured) {
      if (Math.abs(x - dragStartClientX) < CAPTURE_THRESHOLD_PX) return
      hasCaptured = true
      setState('dragging')
      target?.setPointerCapture?.(event.pointerId)
    }
    const deltaItems = -(x - dragStartClientX) / AXIS_PX_PER_ITEM
    const now = event.timeStamp
    const dt = lastMoveTimestamp ? now - lastMoveTimestamp : 16.67

    const nextPosition = mode === 'marquee' ? dragStartPosition + deltaItems : clampPosition(dragStartPosition + deltaItems, itemCount())
    velocity = dt > 0 ? ((nextPosition - position) / dt) * 16.67 : 0
    position = nextPosition
    lastMoveTimestamp = now
    render()
  }

  function endDrag(event: PointerEvent): void {
    if (!dragging || event.pointerId !== pointerId) return
    dragging = false
    pointerId = null
    if (!hasCaptured) return // never moved past the deadzone — this was a click, not a drag; nothing to settle/decay
    hasCaptured = false
    target?.releasePointerCapture?.(event.pointerId)
    // Same threshold physics.ts's own decayVelocity() snaps to — a
    // released velocity below this would settle on the very first
    // inertia frame anyway, so starting the decay loop for it at all is
    // pure overhead. Matches core/drivers/drag.ts's own
    // INERTIA_SETTLE_THRESHOLD gate exactly, rather than the two nearly-
    // identical pieces of logic drifting to different thresholds.
    // Under reduced motion a release stops (or snaps) where the pointer let
    // go — no coasting on after the person has stopped moving.
    if (Math.abs(velocity) >= SETTLE_THRESHOLD && !prefersReducedMotion()) {
      startInertia()
    } else if (snap) {
      setState('snapping')
      settleAt(nearestIndex(position, itemCount()))
    } else {
      setState('settled')
    }
  }

  function stepBy(delta: number): void {
    stopInertia()
    const index = wrapIndex(nearestIndex(position, itemCount()) + delta, itemCount())
    setState('snapping')
    settleAt(mode === 'marquee' ? index : nearestIndex(clampPosition(index, itemCount()), itemCount()))
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!keyboard) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      stepBy(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      stepBy(-1)
    }
  }

  return {
    name: 'rail',
    // A fresh, identically configured copy, for comice('.many') giving every
    // matched element its own instance (see core's ComicePlugin.create).
    create: () => rail(options),

    setup(rawTarget: Element, instance: ComiceInstance) {
      if (!(rawTarget instanceof HTMLElement)) {
        throw new Error('[comice] rail() requires an HTMLElement target.')
      }
      target = rawTarget

      // Every non-`strip`/`marquee` mode assigns items a NEGATIVE z-index
      // (physics.ts's own `z: -Math.abs(d)`, the depth-ordering stack/arc/
      // coverflow all use) — a real bug found running this against a real
      // page (see ROADMAP.md's own T9 gap note): without `target` itself
      // establishing a stacking context, those negative-z items paint (and
      // hit-test) BEHIND whatever else is in the page's own stacking
      // order at that point, not just behind `target`'s own background —
      // on a real page, that can mean literally unclickable/unhoverable
      // items despite being visually on top. `position: relative` (or
      // `absolute`/`fixed`) plus this element's own implicit `z-index: 0`
      // once it has a position value is what actually traps its
      // children's negative z-index values inside its own paint order,
      // matching the identical "make the ancestor a real positioning
      // root" fix-up every other plugin's own canvas-overlay insertion
      // already applies to ITS parent — this one applies to `target`
      // itself instead, since rail's own items are the ones carrying
      // z-index, not a sibling canvas.
      if (getComputedStyle(target).position === 'static') {
        target.style.position = 'relative'
        targetPositionWasSetByThisPlugin = true
      }

      itemEls = itemsSelector
        ? Array.from(target.querySelectorAll<HTMLElement>(itemsSelector))
        : Array.from(target.children).filter((el): el is HTMLElement => el instanceof HTMLElement)

      if (keyboard) {
        itemEls.forEach((el, i) => {
          el.tabIndex = i === 0 ? 0 : -1
        })
        target.addEventListener('keydown', onKeyDown)

        liveRegion = target.ownerDocument.createElement('div')
        liveRegion.setAttribute('aria-live', 'polite')
        liveRegion.setAttribute('role', 'status')
        applyVisuallyHiddenStyle(liveRegion)
        target.appendChild(liveRegion)
      }

      target.addEventListener('pointerdown', onPointerDown as EventListener)
      target.addEventListener('pointermove', onPointerMove as EventListener)
      target.addEventListener('pointerup', endDrag as EventListener)
      target.addEventListener('pointercancel', endDrag as EventListener)

      setState('idle')
      render()
      // `ready` lifecycle event (spec §04): no GPU work to wait for, so this
      // plugin's effect is in place once setup has run.
      instance.ready('rail')
    },

    teardown() {
      destroyed = true
      stopInertia()
      if (target) {
        target.removeEventListener('keydown', onKeyDown)
        target.removeEventListener('pointerdown', onPointerDown as EventListener)
        target.removeEventListener('pointermove', onPointerMove as EventListener)
        target.removeEventListener('pointerup', endDrag as EventListener)
        target.removeEventListener('pointercancel', endDrag as EventListener)
      }
      itemEls.forEach((el) => {
        el.style.position = ''
        el.style.top = ''
        el.style.left = ''
        el.style.transform = ''
        el.style.opacity = ''
        el.style.zIndex = ''
        el.removeAttribute('tabindex')
      })
      if (target && targetPositionWasSetByThisPlugin) {
        target.style.position = ''
        targetPositionWasSetByThisPlugin = false
      }
      liveRegion?.remove()
      target = null
      itemEls = []
      liveRegion = null
    },

    // MappableTarget: `position` (item-index space, not 0..1 like every
    // other plugin's `progress`) is rail's one mappable parameter — a
    // driver mapping onto rail scrubs which item is centred directly,
    // e.g. `.map('bass').to(rail, 'position', { output: [0, itemCount] })`.
    params: {
      getParam(name: string): number {
        if (name === 'position') return position
        return 0
      },
      setParam(name: string, value: number): void {
        if (name !== 'position') return
        stopInertia()
        position = mode === 'marquee' ? value : clampPosition(value, itemCount())
        setState('settled')
        render()
      },
    },
  }
}

export type { RailMode } from './physics.js'
