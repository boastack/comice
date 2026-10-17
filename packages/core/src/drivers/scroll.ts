/**
 * comice/core/drivers/scroll
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 04: "Comice does not need ScrollTrigger. It reads native browser
 * scroll-linked animation where available and falls back to a lightweight
 * IntersectionObserver and scroll listener where it is not, entirely inside
 * core."
 *
 * Native ViewTimeline supplies browser-measured element progress, sampled
 * by the shared scheduler. Custom ranges/root containers use scroll-event
 * measurements batched to an animation frame. GPU uniforms are updated on
 * the main thread in both paths.
 */

import { getSharedScheduler } from '../scheduler.js'
import type { Driver, DriverSignal } from '../types.js'
import { prefersReducedMotion } from '../motion.js'

export type ScrollOptions = {
  /** Measure a surrounding section instead of the driven media (sticky stages). */
  subject?: Element | string
  /** cover: enters bottom to exits top; contain: section top at top to bottom at bottom. */
  range?: 'cover' | 'contain'
  /** Fraction of the element that must be visible before progress starts. Default 0. */
  threshold?: number
  /** Scroll container. Defaults to the viewport. (The native path finds
   *  the element's nearest scroller itself.) */
  root?: Element | null
  /** Pixel offset applied to the start/end of the progress range. */
  offset?: number
  /**
   * Seconds the progress takes to catch up with the scroll, so it glides behind the
   * wheel instead of tracking it frame for frame: the "scrub" of a ScrollTrigger, with
   * no library. About 95% of the way in `smooth` seconds, easing out; it stops
   * the moment it arrives. Short values (.2 to .4) read as polish, longer ones as drag.
   * Skipped with `prefers-reduced-motion`. Default 0: the progress follows the scroll.
   */
  smooth?: number
}

/**
 * Wraps a signal sink with the `smooth` lag. With no smoothing it is the sink itself.
 * The first signal lands at once (nothing to glide from), later ones set a target that
 * a shared-scheduler entry eases toward, and the entry sits idle between glides.
 */
function smoothed(onSignal: (signal: DriverSignal) => void, seconds: number): { push: (signal: DriverSignal) => void; stop: () => void } {
  if (!(seconds > 0) || prefersReducedMotion()) return { push: onSignal, stop() {} }
  let want = 0
  let have = 0
  let started = false
  const tau = seconds / 3
  const unregister = getSharedScheduler().add(
    (deltaMs) => {
      // Capped, so a stalled frame does not leap most of the distance in one step.
      have += (want - have) * (1 - Math.exp(-Math.min(deltaMs, 100) / 1000 / tau))
      if (Math.abs(want - have) < 5e-4) have = want
      onSignal({ progress: have })
    },
    () => started && have !== want,
  )
  return {
    push(signal) {
      want = signal.progress
      if (!started) { started = true; have = want; onSignal(signal) }
    },
    stop: unregister,
  }
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
    const start = options.range === 'contain' ? offset : viewportHeight * (1 - threshold) + offset
    const end = options.range === 'contain' ? viewportHeight - rect.height + offset : -rect.height + offset
    const raw = start === end ? (top <= start ? 1 : 0) : (start - top) / (start - end)
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

  let last: number | null = null

  function poll(): void {
    const timing = probe.effect?.getComputedTiming()
    const progress = typeof timing?.progress === 'number' ? Math.max(0, Math.min(1, timing.progress)) : 0
    // Only changes go out: an element sitting still costs one read a frame.
    if (progress !== last) {
      last = progress
      onSignal({ progress })
    }
  }
  const unregister = getSharedScheduler().add(poll, () => target.isConnected && !document.hidden)

  return () => {
    probe.cancel()
    unregister()
  }
}

export function scroll(options: ScrollOptions = {}): Driver {
  return {
    name: 'scroll',
    attach(target, onSignal) {
      if (options.subject) {
        const subject = typeof options.subject === 'string' ? target.ownerDocument.querySelector(options.subject) : options.subject
        if (!subject) throw new Error('[comice] scroll subject did not match an element.')
        target = subject
      }
      if (options.smooth !== undefined && (!Number.isFinite(options.smooth) || options.smooth < 0)) throw new RangeError('[comice] scroll smooth must be a finite number of seconds, 0 or more.')
      const glide = smoothed(onSignal, options.smooth ?? 0)
      // threshold/offset reshape the range, which the fallback measures
      // directly; the native timeline is the plain 'cover' range.
      const detach = supportsViewTimeline() && !options.root && !options.threshold && !options.offset && options.range !== 'contain'
        ? attachNative(target, glide.push)
        : attachFallback(target, glide.push, options)
      return () => { detach(); glide.stop() }
    },
  }
}
