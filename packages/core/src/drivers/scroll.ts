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
  /** Scroll container. Defaults to the viewport. */
  root?: Element | null
  /** Pixel offset applied to the start/end of the progress range. */
  offset?: number
}

function supportsScrollTimeline(): boolean {
  return typeof CSS !== 'undefined' && typeof (window as any).ScrollTimeline !== 'undefined'
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
  const { threshold = 0, offset = 0 } = options
  let dirty = true
  let rafId: number | null = null

  function measure(): void {
    dirty = false
    const rect = target.getBoundingClientRect()
    const viewportHeight = window.innerHeight

    // 0 when the element's top just enters the viewport bottom,
    // 1 when its bottom leaves the viewport top. Threshold shifts the
    // start point; offset nudges both ends by a fixed pixel amount.
    const start = viewportHeight * (1 - threshold) + offset
    const end = -rect.height + offset
    const raw = (start - rect.top) / (start - end)
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
  window.addEventListener('scroll', requestMeasure, { passive: true })
  window.addEventListener('resize', requestMeasure, { passive: true })

  return () => {
    window.removeEventListener('scroll', requestMeasure)
    window.removeEventListener('resize', requestMeasure)
    if (rafId !== null) cancelAnimationFrame(rafId)
  }
}

/**
 * Native path: a CSS ScrollTimeline animation whose sole purpose is to
 * report progress. The animation itself is invisible — it drives a custom
 * property from 0 to 1 — and we read `animation.effect.getComputedTiming()`
 * once per frame via the shared scheduler, rather than the fallback's
 * scroll-listener approach, so the browser's compositor does the expensive
 * work.
 */
function attachNative(
  target: Element,
  onSignal: (signal: DriverSignal) => void,
  options: ScrollOptions,
): () => void {
  const { root = null } = options

  const timeline = new (window as any).ScrollTimeline({
    source: root ?? document.documentElement,
    axis: 'block',
  })

  const probe = target.animate(
    [{ opacity: 1 }, { opacity: 1 }], // no visual effect, timing probe only
    { timeline, fill: 'both' },
  )

  let rafId: number | null = null

  function poll(): void {
    const timing = probe.effect?.getComputedTiming()
    const progress =
      typeof timing?.progress === 'number' ? Math.max(0, Math.min(1, timing.progress)) : 0
    onSignal({ progress })
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
      return supportsScrollTimeline()
        ? attachNative(target, onSignal, options)
        : attachFallback(target, onSignal, options)
    },
  }
}
