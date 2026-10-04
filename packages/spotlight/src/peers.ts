/**
 * @comice/spotlight/peers
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared peer styling. The spec's own example spotlights every `.project`
 * with `.project` as its peers, so each card is a peer of every other: when
 * the pointer moves from A to B, A's leaving tween and B's entering tween
 * both style C. Writing directly, whichever wrote last won, and C could
 * end up sharp while B was active.
 *
 * Here every spotlight CONTRIBUTES to its peers instead, and each peer
 * recedes by the strongest contribution, less its own emphasis (an item
 * being spotlighted is never dimmed by the one it is taking over from).
 * Its own inline style is snapshotted once, by the first contributor, and
 * restored when the last one withdraws.
 */

export type PeerContribution = { progress: number; blur: number; dim: number }

type Entry = {
  original: { filter: string; opacity: string }
  from: Map<object, PeerContribution>
}

const entries = new WeakMap<HTMLElement, Entry>()
const emphasis = new WeakMap<HTMLElement, number>()

function apply(el: HTMLElement, entry: Entry): void {
  let strongest: PeerContribution = { progress: 0, blur: 0, dim: 1 }
  entry.from.forEach((c) => {
    if (c.progress > strongest.progress) strongest = c
  })
  const recede = Math.max(0, strongest.progress - (emphasis.get(el) ?? 0))
  const blur = strongest.blur * recede
  el.style.filter = blur > 0 ? `blur(${blur}px)` : entry.original.filter
  el.style.opacity = recede > 0 ? `${1 - (1 - strongest.dim) * recede}` : entry.original.opacity
}

/** `owner` (one spotlight instance) sets how strongly it pushes `el` back. */
export function contribute(owner: object, el: HTMLElement, contribution: PeerContribution): void {
  let entry = entries.get(el)
  if (!entry) {
    entry = { original: { filter: el.style.filter, opacity: el.style.opacity }, from: new Map() }
    entries.set(el, entry)
  }
  entry.from.set(owner, contribution)
  apply(el, entry)
}

/** `owner` stops affecting `el`; the last one out restores its own style. */
export function withdraw(owner: object, el: HTMLElement): void {
  const entry = entries.get(el)
  if (!entry) return
  entry.from.delete(owner)
  if (entry.from.size > 0) return apply(el, entry)
  el.style.filter = entry.original.filter
  el.style.opacity = entry.original.opacity
  entries.delete(el)
}

/** How spotlighted `el` itself is (its own progress), which cancels out
 *  that much of any recede pushed onto it. */
export function setEmphasis(el: HTMLElement, progress: number): void {
  emphasis.set(el, progress)
  const entry = entries.get(el)
  if (entry) apply(el, entry)
}
