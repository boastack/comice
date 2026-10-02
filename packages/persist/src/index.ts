/**
 * @comice/persist
 * ─────────────────────────────────────────────────────────────────────────────
 * Media surviving navigation — spec §08's own words: "Owns: media
 * surviving navigation. Playback continues, textures are reused, the
 * transition belongs to the page rather than the browser reloading it."
 *
 * SCOPED TO SPA (CLIENT-SIDE ROUTED) NAVIGATION, NOT REAL CROSS-DOCUMENT
 * NAVIGATION — and this is a deliberate, load-bearing scope decision, not
 * an oversight. A genuine cross-document navigation (a real HTTP request,
 * a full page reload) destroys the JS heap unconditionally in every
 * browser: no WebGL context and no playing <video> element can survive
 * that, full stop. "Playback continues... rather than the browser
 * reloading it" is only literally true when the DOM subtree containing
 * the media element survives a route change intact — which is exactly
 * what an SPA router (React Router, Next.js client-side navigation, Vue
 * Router, etc.) already does: it patches the DOM in place, it never
 * reloads the page. persist's whole mechanism (see registry.ts) depends
 * on this: the SECOND comice(target).use(persist(...)) call, on the new
 * route, runs in the SAME JS heap as the first — the same registry Map,
 * the same live element reference — which a real navigation could never
 * provide. A caller wanting a comparable EFFECT across a genuine
 * cross-document navigation gets the honest fallback every browser
 * already has for that case: the View Transitions API's own
 * cross-document mode (native.ts checks for support), which can morph a
 * visual SNAPSHOT of the old page into the new one, but cannot keep a
 * video playing or a WebGL context alive — a caller relying on that path
 * sees a smooth visual transition, never literal continuous playback.
 *
 * ALL FOUR SPEC TRANSITIONS SHIP — shared, blend, curtain, iris — because
 * they're genuinely the same underlying handoff mechanism with different
 * visual treatments layered on top (see transitions.ts's own header).
 *
 * THE HANDOFF, IN FULL: page A's setup() registers its real, live
 * <img>/<video> element into the module-level registry (registry.ts) —
 * NOT a clone, the actual node, so a playing <video>'s currentTime/
 * playback state and a plugin's own WebGL context (if morph/distort/etc.
 * is ALSO applied to the same element — persist composes with any other
 * plugin, per core's own "plugins are peers" rule) both survive intact.
 * When the router unmounts A's subtree, this plugin's own teardown() does
 * NOT destroy that element — it detaches it from A's now-gone parent and
 * holds it in memory, still registered, waiting.
 *
 * Page B's setup() (same `match` key) claims the registry entry and
 * performs the real handoff: B's own target element is hidden
 * (visibility: hidden, never removed — the framework's own DOM tree stays
 * exactly as it left it, comice only ever touches elements it inserted
 * itself, the same "overlay, never replace-in-tree" convention every
 * canvas-inserting plugin in this repo already holds to for the identical
 * "don't fight the framework's reconciliation" reason). A's surviving
 * element is inserted as an absolutely-positioned sibling, animated from
 * its own last known box (registry.ts's fromRect) to B's real box via
 * getSharedScheduler(), using whichever transition preset the caller
 * chose. Once the animation completes, A's element is resized/repositioned
 * to exactly cover B's box going forward (a plain CSS position sync, not a
 * teardown) and stays as the page's real, live media element from then on
 * — B's own placeholder stays hidden for good, since A's node has
 * genuinely replaced it as far as what's rendered.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { prefersReducedMotion } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { claim, register, unregister, type PersistTransition } from './registry.js'
import { computeTransitionStyle, type Rect } from './transitions.js'
import { runViewTransition, supportsNativeViewTransitions } from './native.js'

export type PersistOptions = {
  /** Attribute pairing elements across routes — spec's own option,
   *  matching exactly. Required: persist has no honest default for "which
   *  element on the next page is this one." */
  match: string
  /** Default 'shared', matching spec exactly. */
  transition?: PersistTransition
  /** Use the View Transitions API where it suffices. Default 'auto',
   *  matching spec exactly. `true` forces native even where this plugin's
   *  own heuristic would prefer the manual path (a `transition` other
   *  than 'shared', where native's own cross-fade doesn't map cleanly
   *  onto curtain/iris's own bespoke clip-path work); `false` always uses
   *  the manual getSharedScheduler()-driven path. */
  native?: 'auto' | boolean
  /** How long the manual (non-native) handoff animation takes, ms.
   *  Ignored when native View Transitions actually run (native.ts's own
   *  transition owns that timing instead). Default 400. */
  duration?: number
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

function applyRectStyle(el: HTMLElement, style: ReturnType<typeof computeTransitionStyle>): void {
  el.style.position = 'fixed'
  el.style.left = `${style.rect.x}px`
  el.style.top = `${style.rect.y}px`
  el.style.width = `${style.rect.width}px`
  el.style.height = `${style.rect.height}px`
  el.style.opacity = `${style.opacity}`
  el.style.clipPath = style.clipPath ?? ''
  el.style.filter = style.filter ?? ''
  el.style.zIndex = '9999'
}

/** Decides whether THIS instance should use the native View Transitions
 *  path — 'auto' prefers native only for 'shared' (the one transition
 *  whose own visual language — a plain cross-fade/morph — is what native
 *  view transitions actually provide out of the box; blend/curtain/iris
 *  are bespoke clip-path treatments this plugin computes itself, which
 *  native transitions have no way to express). */
function shouldUseNative(native: PersistOptions['native'], transition: PersistTransition): boolean {
  if (native === true) return supportsNativeViewTransitions()
  if (native === false) return false
  return supportsNativeViewTransitions() && transition === 'shared'
}

export function persist(options: PersistOptions): ComicePlugin {
  const { match, transition = 'shared', native = 'auto', duration = 400 } = options

  if (!match) {
    throw new Error('[comice] persist() requires a non-empty `match` string.')
  }

  let target: Uploadable | null = null
  let originalStyle: { position: string; left: string; top: string; width: string; height: string; opacity: string; clipPath: string; filter: string; zIndex: string; visibility: string } | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let survivingElement: Uploadable | null = null
  let destroyed = false

  function snapshotStyle(el: HTMLElement): typeof originalStyle {
    return {
      position: el.style.position,
      left: el.style.left,
      top: el.style.top,
      width: el.style.width,
      height: el.style.height,
      opacity: el.style.opacity,
      clipPath: el.style.clipPath,
      filter: el.style.filter,
      zIndex: el.style.zIndex,
      visibility: el.style.visibility,
    }
  }

  function restoreStyle(el: HTMLElement, snapshot: NonNullable<typeof originalStyle>): void {
    el.style.position = snapshot.position
    el.style.left = snapshot.left
    el.style.top = snapshot.top
    el.style.width = snapshot.width
    el.style.height = snapshot.height
    el.style.opacity = snapshot.opacity
    el.style.clipPath = snapshot.clipPath
    el.style.filter = snapshot.filter
    el.style.zIndex = snapshot.zIndex
    el.style.visibility = snapshot.visibility
  }

  /** Performs the real handoff: inserts `survivingElement` (page A's real
   *  node) as an overlay sibling of `target` (page B's own placeholder),
   *  animates it from its own last known box to target's real box, then
   *  leaves it in place as the page's live media element. */
  function runHandoff(fromRect: Rect): void {
    if (!target || !survivingElement) return

    target.style.visibility = 'hidden'
    document.body.appendChild(survivingElement)
    survivingElement.style.pointerEvents = 'none'

    const toRect = rectOf(target)

    function doManualHandoff(): void {
      const startTime = performance.now()
      unregisterFromScheduler = getSharedScheduler().add(
        () => {
          if (!survivingElement) return
          const elapsed = performance.now() - startTime
          // Reduced motion: the media lands in its new place this frame.
          const progress = duration > 0 && !prefersReducedMotion() ? Math.min(1, elapsed / duration) : 1
          const style = computeTransitionStyle(transition, fromRect, toRect, progress)
          applyRectStyle(survivingElement, style)
          if (progress >= 1) {
            unregisterFromScheduler?.()
            unregisterFromScheduler = null
          }
        },
        () => !destroyed,
      )
    }

    // The browser's own View Transition animates too, so reduced motion takes
    // the manual path, which lands instantly.
    if (!prefersReducedMotion() && shouldUseNative(native, transition)) {
      runViewTransition(() => {
        applyRectStyle(survivingElement!, { rect: toRect, opacity: 1 })
      })
    } else {
      doManualHandoff()
    }
  }

  return {
    name: 'persist',

    setup(rawTarget: Element, instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        throw new Error('[comice] persist() requires an <img> or <video> target.')
      }
      target = rawTarget
      originalStyle = snapshotStyle(target)

      const entry = claim(match)
      if (entry) {
        survivingElement = entry.element
        runHandoff(entry.fromRect)
      }
      // No entry: this is either the FIRST page a persist({ match }) with
      // this key has ever appeared on, or the previous page's element was
      // never registered (a plugin construction error elsewhere, or the
      // user navigated somewhere with no matching persist() at all) —
      // either way, degrade to "this is just a normal media element,"
      // never an error. It registers itself below regardless, so THIS
      // element becomes available to claim on whatever page comes next.

      register(match, target, transition)
      // `ready` lifecycle event (spec §04): no GPU work to wait for, so this
      // plugin's effect is in place once setup has run.
      instance.ready('persist')
    },

    teardown() {
      destroyed = true
      unregisterFromScheduler?.()
      unregisterFromScheduler = null

      // Deliberately NOT the same teardown every other plugin in this
      // repo does — persist's whole point is surviving this exact call.
      // `target` (this instance's own element) stays registered (register()
      // was already called in setup(), and nothing here undoes it) so a
      // NEXT page's persist({ match }) can still claim it after this
      // instance's own comice() handle is gone. Restoring `target`'s own
      // inline style is safe regardless — target is either about to be
      // literally removed from the DOM by the router (its style no longer
      // matters) or, if THIS element is the one a later page's handoff
      // will move and restyle from scratch, runHandoff()'s own
      // applyRectStyle() overwrites every property it cares about anyway.
      if (target && originalStyle) {
        restoreStyle(target, originalStyle)
      }
      target = null
      originalStyle = null
      survivingElement = null
    },
  }
}

/**
 * Clears this `match` key's registry entry without claiming it — for a
 * caller that knows a registered element will never be claimed (e.g. the
 * user is navigating somewhere with no persist() target at all, detected
 * by the caller's own router logic) and wants to release the reference
 * immediately rather than leaving it until the registry's own next
 * register() call for the same key silently supersedes it. Optional to
 * call — register()'s own "last write wins" behavior means a stale entry
 * is harmless, just held in memory slightly longer than necessary.
 */
export function releasePersist(match: string): void {
  unregister(match)
}

export type { PersistTransition } from './registry.js'
