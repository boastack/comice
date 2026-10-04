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
 * PEERS ARE SHARED: with `.project` spotlighting `.project` peers, every
 * card is every other card's peer, so peer styling goes through peers.ts
 * (each peer recedes by the strongest spotlight on it), never written
 * directly by one instance.
 *
 * EXPAND: the active item takes more of its row — the expanding-gallery
 * pattern. Unlike `lift` (a transform, nothing else moves), this is a
 * layout change: in a flex row, the target's flex-grow rises and its peers
 * give up the space.
 *
 * `wake`/`lift` (the two named effects on the target itself, per the
 * card's own Effects chip row alongside "peers dim/blur" and "reveal
 * caption") are implemented as the target's own progress-driven transform:
 * a small `scale`/`translateY` lift, matching `reveal`'s own `expand()`
 * effect in kind (CSS transform, not a new mechanism).
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { snapForReducedMotion } from 'comice'
import { contribute, setEmphasis, withdraw } from './peers.js'

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
   *  no default peers config makes sense without a selector). A string is
   *  shorthand for `{ selector }`. */
  peers?: SpotlightPeersOptions | string | false
  /** Selector for caption children (relative to the target) to reveal.
   *  Stays real DOM — see the file header. Undefined reveals nothing. */
  reveal?: string
  /** How far the target lifts (scale + translateY) at full active
   *  progress. 0 disables the lift entirely. Default 0.04 (a 4% scale). */
  lift?: number
  /** The flex-grow the target reaches at full progress, for an item in a
   *  flex row: the active one widens and its neighbours give up the space.
   *  E.g. `expand: 3` on items with `flex: 1` grows the active one to three
   *  shares. Needs a flex container; off by default. */
  expand?: number
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** Reads the inline style properties this plugin owns on one element, so
 *  teardown() can restore them cleanly — same pattern reveal's own
 *  snapshotOwnedStyle() uses. */
function snapshotOwnedStyle(el: HTMLElement): { transform: string; flexGrow: string } {
  return {
    transform: el.style.transform,
    flexGrow: el.style.flexGrow,
  }
}

function restoreStyle(el: HTMLElement, snapshot: { transform: string; flexGrow: string }): void {
  el.style.transform = snapshot.transform
  el.style.flexGrow = snapshot.flexGrow
}

export function spotlight(options: SpotlightOptions = {}): ComicePlugin {
  const { reveal, lift = 0.04, expand } = options
  const peers: SpotlightPeersOptions | false = typeof options.peers === 'string' ? { selector: options.peers } : (options.peers ?? false)
  // This instance's identity in the shared peer registry.
  const owner = {}

  let target: HTMLElement | null = null
  let unsubscribe: (() => void) | null = null
  let originalTargetStyle: { transform: string; flexGrow: string } | null = null
  let restingGrow = 0
  let peerElements: HTMLElement[] = []
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
    if (expand !== undefined) target.style.flexGrow = `${restingGrow + (expand - restingGrow) * p}`
    setEmphasis(target, p)
  }

  function renderPeers(progress: number): void {
    if (!peers) return
    const contribution = { progress: clamp01(progress), blur: peers.blur ?? 4, dim: peers.dim ?? 0.4 }
    peerElements.forEach((el) => contribute(owner, el, contribution))
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
    // Reduced motion: jump to whichever end state is closer, never animate between.
    currentProgress = clamp01(snapForReducedMotion(progress))
    renderTarget(currentProgress)
    renderPeers(currentProgress)
    renderReveal(currentProgress)
  }

  return {
    name: 'spotlight',
    // A fresh, identically configured copy, for comice('.many') giving every
    // matched element its own instance (see core's ComicePlugin.create).
    create: () => spotlight(options),

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
      if (expand !== undefined) restingGrow = Number.parseFloat(getComputedStyle(target).flexGrow) || 0

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
      // `ready` lifecycle event (spec §04): no GPU work to wait for, so this
      // plugin's effect is in place once setup has run.
      instance.ready('spotlight')
    },

    teardown() {
      unsubscribe?.()
      if (target && originalTargetStyle) restoreStyle(target, originalTargetStyle)
      if (target) setEmphasis(target, 0)
      peerElements.forEach((el) => withdraw(owner, el))
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
