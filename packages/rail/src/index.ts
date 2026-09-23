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

  let railState: RailState = 'settled'
  let position = 0 // continuous item-index-space position
  let velocity = 0 // position units per frame-at-60fps
  let lastActiveIndex = -1

  let dragging = false
  let pointerId: number | null = null
  let dragStartClientX = 0
  let dragStartPosition = 0
  let lastMoveTimestamp = 0

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
      el.style.transform = `translateX(${px}px) scale(${t.scale}) rotate(${t.rotate}deg)`
      el.style.opacity = `${t.opacity}`
      el.style.zIndex = `${Math.round(t.z)}`
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
    stopInertia()
    setState('dragging')
    pointerId = event.pointerId
    dragStartClientX = clientX(event)
    dragStartPosition = position
    lastMoveTimestamp = 0
    velocity = 0
    target?.setPointerCapture?.(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging || event.pointerId !== pointerId) return
    const x = clientX(event)
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
    target?.releasePointerCapture?.(event.pointerId)
    // Same threshold physics.ts's own decayVelocity() snaps to — a
    // released velocity below this would settle on the very first
    // inertia frame anyway, so starting the decay loop for it at all is
    // pure overhead. Matches core/drivers/drag.ts's own
    // INERTIA_SETTLE_THRESHOLD gate exactly, rather than the two nearly-
    // identical pieces of logic drifting to different thresholds.
    if (Math.abs(velocity) >= SETTLE_THRESHOLD) {
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

    setup(rawTarget: Element, _instance: ComiceInstance) {
      if (!(rawTarget instanceof HTMLElement)) {
        throw new Error('[comice] rail() requires an HTMLElement target.')
      }
      target = rawTarget

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
        el.style.transform = ''
        el.style.opacity = ''
        el.style.zIndex = ''
        el.removeAttribute('tabindex')
      })
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
