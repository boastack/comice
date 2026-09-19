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

  function tick(timestamp: number): void {
    const deltaMs = lastTimestamp ? timestamp - lastTimestamp : 16.67
    lastTimestamp = timestamp

    entries.forEach((entry) => {
      if (entry.isActive()) entry.callback(deltaMs, timestamp)
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
  destroy(): void
} {
  let onScreen = false
  let tabVisible = !document.hidden

  const observer = new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting
    },
    { threshold: 0 },
  )
  observer.observe(target)

  function onVisibilityChange(): void {
    tabVisible = !document.hidden
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return {
    isVisible: () => onScreen && tabVisible,
    destroy(): void {
      observer.disconnect()
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
