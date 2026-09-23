/**
 * @comice/spotlight
 * ─────────────────────────────────────────────────────────────────────────────
 * One item emphasised, its peers receding — spec §08's own words: "Owns:
 * one item emphasised, its peers receding. A state machine, idle, entering,
 * active, leaving." T9 (ROADMAP.md §4), the first of the four "mechanical
 * once the pipeline is proven" plugins — no new GPU primitive needed here,
 * spotlight is pure CSS driven directly off the existing state machine.
 *
 * DRIVEN BY STATE, NOT DURATION, same discipline reveal established: this
 * plugin never guesses "the hover animation is probably done by now" — it
 * reacts to instance.on('*') and instance.state, which core's own
 * `.driver(hover())` wiring already advances through idle -> entering ->
 * active -> leaving using hover()'s own intent-debounced enter/leave
 * events (see packages/core/src/index.ts's `.driver()` handler — a plain
 * Driver's `progress` 0/1 already drives these same transitions, so
 * spotlight adds no state-machine logic of its own).
 *
 * SPEC CARD, IN FULL: `peers: { selector, blur, dim }` applied to sibling
 * elements matched by `selector` (softening everything else on the page
 * while one item is active); `reveal: string`, a selector for caption
 * children to show — "stays real DOM" is spec's own explicit requirement,
 * so `reveal` toggles a real CSS property (visibility/opacity), never
 * swaps in synthetic content, keeping revealed captions keyboard- and
 * touch-reachable exactly as spec's own Excludes note demands: "Anything
 * revealed must be reachable by keyboard and touch, which is why reveal
 * targets real DOM."
 *
 * `wake`/`lift` (the two named effects on the target itself, per the
 * card's own Effects chip row alongside "peers dim/blur" and "reveal
 * caption") are implemented as the target's own progress-driven transform:
 * a small `scale`/`translateY` lift, matching `reveal`'s own `expand()`
 * effect in kind (CSS transform, not a new mechanism).
 */

import type { ComiceInstance, ComicePlugin } from 'comice'

export type SpotlightPeersOptions = {
  /** Selector matching sibling elements to dim/blur while this instance is
   *  active. Required if `peers` is set at all. */
  selector: string
  /** Gaussian blur applied to peers at full active progress, in px. Default 4. */
  blur?: number
  /** Opacity peers recede to at full active progress, 0..1. Default 0.4
   *  (spec's own example: `dim: 0.4`). */
  dim?: number
}

export type SpotlightOptions = {
  /** Siblings to dim/blur while this instance is emphasised. `false`
   *  disables peer response entirely — spotlight then only affects the
   *  target itself. Default false (spec's own type is `object | false`,
   *  no default peers config makes sense without a selector). */
  peers?: SpotlightPeersOptions | false
  /** Selector for caption children (relative to the target) to reveal.
   *  Stays real DOM — see the file header. Undefined reveals nothing. */
  reveal?: string
  /** How far the target lifts (scale + translateY) at full active
   *  progress. 0 disables the lift entirely. Default 0.04 (a 4% scale). */
  lift?: number
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** Reads the inline style properties this plugin owns on one element, so
 *  teardown() can restore them cleanly — same pattern reveal's own
 *  snapshotOwnedStyle() uses. */
function snapshotOwnedStyle(el: HTMLElement): { transform: string; filter: string; opacity: string } {
  return {
    transform: el.style.transform,
    filter: el.style.filter,
    opacity: el.style.opacity,
  }
}

function restoreStyle(el: HTMLElement, snapshot: { transform: string; filter: string; opacity: string }): void {
  el.style.transform = snapshot.transform
  el.style.filter = snapshot.filter
  el.style.opacity = snapshot.opacity
}

export function spotlight(options: SpotlightOptions = {}): ComicePlugin {
  const { peers = false, reveal, lift = 0.04 } = options

  let target: HTMLElement | null = null
  let unsubscribe: (() => void) | null = null
  let originalTargetStyle: { transform: string; filter: string; opacity: string } | null = null
  let peerElements: HTMLElement[] = []
  let peerOriginalStyle: WeakMap<HTMLElement, { filter: string; opacity: string }> = new WeakMap()
  let revealElements: HTMLElement[] = []
  let revealOriginalStyle: WeakMap<HTMLElement, { visibility: string; opacity: string }> = new WeakMap()
  let currentProgress = 0

  function resolvePeers(): HTMLElement[] {
    if (!peers || !target) return []
    const doc = target.ownerDocument ?? document
    const matches = Array.from(doc.querySelectorAll<HTMLElement>(peers.selector))
    // A target matching its own peer selector (e.g. `.project` spotlighting
    // `.project` siblings, spec's own example) must never dim/blur itself —
    // only genuine siblings recede.
    return matches.filter((el) => el !== target)
  }

  function renderTarget(progress: number): void {
    if (!target) return
    const p = clamp01(progress)
    const scale = 1 + lift * p
    const liftPx = -lift * 20 * p // a small upward drift alongside the scale, same direction reveal's own expand() lifts toward
    target.style.transform = lift !== 0 ? `translateY(${liftPx}px) scale(${scale})` : ''
  }

  function renderPeers(progress: number): void {
    if (!peers) return
    const p = clamp01(progress)
    const blurPx = (peers.blur ?? 4) * p
    const dimTo = peers.dim ?? 0.4
    const opacity = 1 - (1 - dimTo) * p
    peerElements.forEach((el) => {
      el.style.filter = blurPx > 0 ? `blur(${blurPx}px)` : ''
      el.style.opacity = `${opacity}`
    })
  }

  function renderReveal(progress: number): void {
    if (!reveal) return
    const visible = progress > 0
    revealElements.forEach((el) => {
      el.style.visibility = visible ? 'visible' : 'hidden'
      el.style.opacity = visible ? `${clamp01(progress)}` : '0'
    })
  }

  function render(progress: number): void {
    currentProgress = clamp01(progress)
    renderTarget(currentProgress)
    renderPeers(currentProgress)
    renderReveal(currentProgress)
  }

  return {
    name: 'spotlight',

    setup(rawTarget: Element, instance: ComiceInstance) {
      if (!(rawTarget instanceof HTMLElement)) {
        // Same "programmer error throws" discipline reveal/morph/distort
        // all follow — spotlight styles a DOM element directly (transform/
        // filter/opacity), which requires .style, so a non-HTMLElement
        // target (a raw SVGElement, say) can't be spotlighted.
        throw new Error('[comice] spotlight() requires an HTMLElement target.')
      }
      target = rawTarget
      originalTargetStyle = snapshotOwnedStyle(target)

      peerElements = resolvePeers()
      peerElements.forEach((el) => {
        peerOriginalStyle.set(el, { filter: el.style.filter, opacity: el.style.opacity })
      })

      if (reveal) {
        revealElements = Array.from(target.querySelectorAll<HTMLElement>(reveal))
        revealElements.forEach((el) => {
          revealOriginalStyle.set(el, { visibility: el.style.visibility, opacity: el.style.opacity })
        })
      }

      // Idle appearance: peers at rest (no dim/blur), captions hidden,
      // target un-lifted — matches reveal's own idleStyle() convention of
      // rendering progress 0 immediately at setup() rather than waiting
      // for the first driver signal, so nothing flashes at the wrong
      // appearance for one frame.
      render(instance.progress)

      unsubscribe = instance.on('*', (snapshot) => {
        render(snapshot.progress)
      })
    },

    teardown() {
      unsubscribe?.()
      if (target && originalTargetStyle) restoreStyle(target, originalTargetStyle)
      peerElements.forEach((el) => {
        const original = peerOriginalStyle.get(el)
        if (original) {
          el.style.filter = original.filter
          el.style.opacity = original.opacity
        }
      })
      revealElements.forEach((el) => {
        const original = revealOriginalStyle.get(el)
        if (original) {
          el.style.visibility = original.visibility
          el.style.opacity = original.opacity
        }
      })
      target = null
      originalTargetStyle = null
      peerElements = []
      revealElements = []
      peerOriginalStyle = new WeakMap()
      revealOriginalStyle = new WeakMap()
    },

    // MappableTarget: progress is spotlight's one mappable parameter, same
    // pattern every other Comice plugin's params object follows.
    params: {
      getParam(name: string): number {
        if (name === 'progress') return currentProgress
        return 0
      },
      setParam(name: string, value: number): void {
        if (name !== 'progress') return
        render(value)
      },
    },
  }
}
