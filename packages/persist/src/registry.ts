/**
 * @comice/persist/registry
 * ─────────────────────────────────────────────────────────────────────────────
 * The one piece of state this plugin needs that CANNOT live inside a
 * single ComicePlugin instance: `match`-keyed entries surviving from one
 * page's setup()/teardown() cycle into the NEXT page's setup() call.
 *
 * Every other plugin in this repo is scoped to one comice(target).use()
 * call — its whole life fits between setup() and teardown(). persist's
 * entire job spans TWO separate comice() calls on two DIFFERENT elements,
 * on two different "pages" of an SPA (the DOM subtree the old route
 * rendered, then the DOM subtree the new route rendered after the router
 * swapped them) — there is no single instance whose setup()/teardown()
 * could hold this state, so it lives at module scope instead, keyed by the
 * caller's own `match` string (spec's own option: "Attribute pairing
 * elements across routes").
 *
 * Pure state + pure functions here, zero DOM — index.ts is the only file
 * that touches elements, GL contexts, or the View Transitions API. Kept
 * separate the same way every other plugin in this repo splits pure logic
 * (physics.ts, sample.ts, gooey.ts, sampler.ts) from its own DOM-facing
 * index.ts.
 */

export type PersistTransition = 'shared' | 'blend' | 'curtain' | 'iris'

/** What one page's setup() hands the registry when it claims a `match`
 *  key first — everything the SECOND page's setup() needs to actually
 *  perform the handoff. `element` is the real, live DOM node (an <img> or
 *  <video>, never a clone) whose playback/GL state must survive. */
export type PersistEntry = {
  match: string
  element: HTMLImageElement | HTMLVideoElement
  transition: PersistTransition
  /** The element's own box at the moment it was registered — used as the
   *  handoff's starting rect for transitions (`blend`/`curtain`/`iris`)
   *  that animate FROM this box TO the new target's box, rather than
   *  cutting instantly. */
  fromRect: { x: number; y: number; width: number; height: number }
  /** True once a second setup() has claimed this entry — an entry stays
   *  in the registry after being claimed only long enough for the
   *  claiming setup() call to read it; see claim() below. */
  claimed: boolean
}

const registry = new Map<string, PersistEntry>()

/**
 * Registers `element` under `match`, to be claimed by the NEXT setup()
 * call using the same `match` key — typically on the page a router
 * navigates to next. Overwrites any existing (unclaimed) entry for the
 * same key rather than stacking multiple candidates: only the most
 * recently registered element for a given `match` can ever be the one
 * still on screen when a navigation happens, so an older, presumably
 * already-torn-down entry is simply stale.
 */
export function register(match: string, element: HTMLImageElement | HTMLVideoElement, transition: PersistTransition): void {
  const rect = element.getBoundingClientRect()
  registry.set(match, {
    match,
    element,
    transition,
    fromRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    claimed: false,
  })
}

/**
 * Looks up and removes the entry for `match`, if one exists and hasn't
 * already been claimed — the actual "does a persisted element exist for
 * this route transition" check the NEW page's setup() makes. Returns null
 * (never throws) when there's nothing to claim: the common case of a
 * plugin instance whose `match` simply has no earlier counterpart yet
 * (the very first page load, or a `match` key that's genuinely new this
 * navigation) — persist degrades to "this is just a normal, freshly-
 * mounted media element" on that path, never an error.
 */
export function claim(match: string): PersistEntry | null {
  const entry = registry.get(match)
  if (!entry || entry.claimed) return null
  entry.claimed = true
  registry.delete(match)
  return entry
}

/**
 * Removes `match`'s entry without claiming it — used when a registered
 * element's own page unloads without ever being claimed (the user
 * navigated somewhere that has no matching persist() target at all, or
 * closed the tab). Prevents a stale entry holding a reference to a
 * detached element from lingering in the registry forever. Safe to call
 * for a `match` with no entry at all.
 */
export function unregister(match: string): void {
  registry.delete(match)
}

/** True if `match` currently has an unclaimed entry waiting — exposed for
 *  testing and for a caller that wants to know synchronously whether a
 *  handoff is about to happen, without actually claiming it. */
export function hasPending(match: string): boolean {
  const entry = registry.get(match)
  return !!entry && !entry.claimed
}

/** Clears every entry — test-only escape hatch, since this module's state
 *  is otherwise genuinely global/persistent for the lifetime of the page,
 *  same as getSharedScheduler()'s own module-level singleton that
 *  test/scheduler.test.ts's own .stop() resets between tests. */
export function clearRegistryForTests(): void {
  registry.clear()
}
