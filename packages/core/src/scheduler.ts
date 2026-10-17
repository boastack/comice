/**
 * comice/core/scheduler
 * ─────────────────────────────────────────────────────────────────────────────
 * One shared requestAnimationFrame loop for every Comice instance on a page.
 *
 * Section 06 of the plan: "One shared requestAnimationFrame, visibility
 * gating, per-element state." Ten instances cost one rAF registration, not
 * ten. Off-screen and backgrounded instances are skipped entirely rather
 * than rendered and discarded, which is the actual mobile-battery saving,
 * not just a smaller pass chain.
 */

export type FrameCallback = (deltaMs: number, timestamp: number) => void

export type Scheduler = {
  /** Register a callback to run every frame while `isActive()` is true. Returns an unregister function. */
  add(callback: FrameCallback, isActive: () => boolean): () => void
  /** Cancel every pending frame and stop the loop. Used in tests and full teardown. */
  stop(): void
}

import { isPoster, recordFrame } from './budget.js'

declare const process: { env: { NODE_ENV?: string } } | undefined
const __DEV__ = typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

/**
 * Creates a new, independent scheduler. Used directly by tests, and by
 * anything that deliberately wants its own rAF loop separate from core's.
 * Core itself, and every driver that needs the shared loop (including
 * audio.ts — see `getSharedScheduler` below), use the module-level
 * singleton instead so "one shared requestAnimationFrame loop for every
 * Comice instance on a page" is actually true across entry points, not
 * just within index.ts.
 */
export function createScheduler(): Scheduler {
  const entries = new Set<{ callback: FrameCallback; isActive: () => boolean }>()
  let rafId: number | null = null
  let lastTimestamp = 0
  // Tracked separately from lastTimestamp's own value — a real frame
  // timestamp can legitimately BE 0 (the fake requestAnimationFrame every
  // test in this package drives frames through commonly starts callers at
  // 0, and even a real rAF timestamp is a DOMHighResTimeStamp that is 0 at
  // the start of a very short-lived page). Using `lastTimestamp ? ... :
  // ...` to detect "first tick" treated that legitimate 0 as falsy, so the
  // tick immediately AFTER a first tick at timestamp 0 fell back to the
  // 16.67 default instead of computing the real elapsed delta — surfaced
  // by drivers/time.ts's own tests, which drive exactly that sequence.
  let hasTicked = false

  function tick(timestamp: number): void {
    const deltaMs = hasTicked ? timestamp - lastTimestamp : 16.67
    hasTicked = true
    lastTimestamp = timestamp
    // Spec §13's frame clock: budget.ts steps quality down when frames keep
    // missing their budget (see there).
    recordFrame(deltaMs)

    // Every entry runs inside its own try/catch. This loop is SHARED
    // across every Comice instance, plugin and driver on the page — one
    // instance's bug (a plugin's update() throwing, a driver's per-frame
    // callback throwing) must not silently kill every other instance's
    // animation. Without this isolation, an uncaught throw here would
    // both abort the remaining entries THIS frame (Set#forEach stops
    // iterating on a thrown error) and abort tick() itself, which means
    // the `requestAnimationFrame(tick)` call below never runs again —
    // the entire shared loop stops forever, for everyone, silently.
    entries.forEach((entry) => {
      try {
        if (!entry.isActive()) return
        entry.callback(deltaMs, timestamp)
      } catch (err) {
        if (__DEV__) {
          console.warn(
            '[comice] A scheduler callback threw and was skipped this frame. ' +
              'The shared loop continues for every other instance.',
            err,
          )
        }
      }
    })

    if (entries.size > 0) {
      rafId = requestAnimationFrame(tick)
    } else {
      rafId = null
    }
  }

  function ensureRunning(): void {
    if (rafId === null) {
      lastTimestamp = 0
      hasTicked = false
      rafId = requestAnimationFrame(tick)
    }
  }

  function add(callback: FrameCallback, isActive: () => boolean): () => void {
    const entry = { callback, isActive }
    entries.add(entry)
    ensureRunning()
    return () => {
      entries.delete(entry)
    }
  }

  function stop(): void {
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
    entries.clear()
  }

  return { add, stop }
}

/**
 * Tracks whether an element is currently on screen and its tab is visible.
 * Feeds the `isActive()` guard passed to `scheduler.add()` — this is the
 * mechanism, not the scheduler itself, that makes "render only when
 * visible" real rather than aspirational.
 */
export function createVisibilityGate(target: Element): {
  isVisible(): boolean
  /** isVisible(), and the frame budget has not dropped to a static poster
   *  (budget.ts) — what every GPU-drawing loop should gate on. */
  shouldDraw(): boolean
  destroy(): void
} {
  let tabVisible = !document.hidden
  // No IntersectionObserver (some embedded webviews, test DOMs): treat the
  // element as on screen and keep drawing, rather than throwing — it used
  // to, from inside comice(el) itself.
  const canObserve = typeof IntersectionObserver !== 'undefined'
  let onScreen = !canObserve

  const observer = canObserve
    ? new IntersectionObserver(
        (records) => {
          // The LAST record is the element's current state. A fast scroll queues several in
          // one batch ("left the screen", then "came back"), and reading the first left the
          // gate stuck on "not visible" with the element in plain view, so nothing ever drew.
          onScreen = records[records.length - 1]?.isIntersecting ?? false
        },
        { threshold: 0 },
      )
    : null
  observer?.observe(target)

  function onVisibilityChange(): void {
    tabVisible = !document.hidden
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return {
    isVisible: () => onScreen && tabVisible,
    shouldDraw: () => onScreen && tabVisible && !isPoster(),
    destroy(): void {
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    },
  }
}

let sharedScheduler: Scheduler | null = null

/**
 * Returns the one scheduler every Comice entry point shares, creating it on
 * first call. index.ts uses this (rather than a private `createScheduler()`
 * call of its own) specifically so that drivers/audio.ts — a separate
 * bundle entry point that never imports index.ts, to stay tree-shakeable —
 * still ticks on the exact same rAF loop as every plugin, instead of
 * running a second one. "One shared requestAnimationFrame" means one
 * across the whole package, not one per file that happens to need a loop.
 */
export function getSharedScheduler(): Scheduler {
  if (!sharedScheduler) sharedScheduler = createScheduler()
  return sharedScheduler
}
