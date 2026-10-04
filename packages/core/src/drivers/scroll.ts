/**
 * comice/core/drivers/scroll
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 04: "Comice does not need ScrollTrigger. It reads native browser
 * scroll-linked animation where available and falls back to a lightweight
 * IntersectionObserver and scroll listener where it is not, entirely inside
 * core."
 *
 * Where the browser supports ScrollTimeline, this driver runs on the
 * compositor thread and never touches the main thread per frame. Where it
 * does not, it falls back to computing progress from getBoundingClientRect()
 * on scroll and resize, throttled to one read per animation frame.
 */

import type { Driver, DriverSignal } from '../types.js'

export type ScrollOptions = {
  /** Fraction of the element that must be visible before progress starts. Default 0. */
  threshold?: number
  /** Scroll container. Defaults to the viewport. (The native path finds
   *  the element's nearest scroller itself.) */
  root?: Element | null
  /** Pixel offset applied to the start/end of the progress range. */
  offset?: number
}

function supportsViewTimeline(): boolean {
  return typeof CSS !== 'undefined' && typeof (window as any).ViewTimeline !== 'undefined'
}

/**
 * Fallback path: compute 0..1 progress from the element's position within
 * the viewport (or `root`), updated on scroll and resize, batched to one
 * measurement per animation frame via a dirty flag rather than reading
 * layout on every scroll event.
 */
function attachFallback(
  target: Element,
  onSignal: (signal: DriverSignal) => void,
  options: ScrollOptions,
): () => void {
  const { threshold = 0, offset = 0, root = null } = options
  // `root` used to be accepted and ignored: everything measured against
  // the window.
  const scroller: Element | Window = root ?? window
  let dirty = true
  let rafId: number | null = null

  function measure(): void {
    dirty = false
    const rect = target.getBoundingClientRect()
    const view = root ? root.getBoundingClientRect() : { top: 0, height: window.innerHeight }
    const viewportHeight = view.height
    const top = rect.top - view.top

    // 0 when the element's top just enters the viewport bottom,
    // 1 when its bottom leaves the viewport top. Threshold shifts the
    // start point; offset nudges both ends by a fixed pixel amount.
    const start = viewportHeight * (1 - threshold) + offset
    const end = -rect.height + offset
    const raw = (start - top) / (start - end)
    const progress = Math.max(0, Math.min(1, raw))

    onSignal({ progress })
  }

  function requestMeasure(): void {
    dirty = true
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (dirty) measure()
    })
  }

  measure()
  scroller.addEventListener('scroll', requestMeasure, { passive: true })
  window.addEventListener('resize', requestMeasure, { passive: true })

  return () => {
    scroller.removeEventListener('scroll', requestMeasure)
    window.removeEventListener('resize', requestMeasure)
    if (rafId !== null) cancelAnimationFrame(rafId)
  }
}

/**
 * Native path: a ViewTimeline on the target, read through an invisible
 * probe animation once per frame, so the browser does the measuring.
 *
 * Same range as the fallback: 0 as the element's top enters the bottom of
 * its scroller, 1 as its bottom leaves the top ('cover'). It used to be a
 * ScrollTimeline over the whole DOCUMENT — page scroll, not the element
 * (it read 1.00 at the top of a short page in Chrome) — and its probe
 * animated the target's opacity with fill: 'both', which overrides inline
 * styles: every plugin fading or dimming a scroll()-driven element (reveal,
 * spotlight) was pinned to opacity 1. The probe has no keyframes now.
 */
function attachNative(target: Element, onSignal: (signal: DriverSignal) => void): () => void {
  const timeline = new (window as any).ViewTimeline({ subject: target, axis: 'block' })
  const probe = (target as any).animate([], { timeline, fill: 'both', rangeStart: 'cover 0%', rangeEnd: 'cover 100%' }) as Animation

  let rafId: number | null = null
  let last: number | null = null

  function poll(): void {
    const timing = probe.effect?.getComputedTiming()
    const progress = typeof timing?.progress === 'number' ? Math.max(0, Math.min(1, timing.progress)) : 0
    // Only changes go out: an element sitting still costs one read a frame.
    if (progress !== last) {
      last = progress
      onSignal({ progress })
    }
    rafId = requestAnimationFrame(poll)
  }
  rafId = requestAnimationFrame(poll)

  return () => {
    probe.cancel()
    if (rafId !== null) cancelAnimationFrame(rafId)
  }
}

export function scroll(options: ScrollOptions = {}): Driver {
  return {
    name: 'scroll',
    attach(target, onSignal) {
      // threshold/offset reshape the range, which the fallback measures
      // directly; the native timeline is the plain 'cover' range.
      return supportsViewTimeline() && !options.threshold && !options.offset
        ? attachNative(target, onSignal)
        : attachFallback(target, onSignal, options)
    },
  }
}
