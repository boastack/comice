/**
 * @comice/reveal/stagger
 * ─────────────────────────────────────────────────────────────────────────────
 * Each reveal() plugin instance is attached separately per matched element —
 * comice(selector) wraps every match in its own independent ComiceHandle and
 * state machine (see core's index.ts), so there is no shared object one
 * reveal() call could use to coordinate timing across siblings. Instead,
 * each instance computes its own position among the group at setup() time,
 * statelessly, by re-querying the DOM — no registry, nothing to leak,
 * nothing that can go stale if elements are added/removed later (the next
 * setup() just re-derives the current answer).
 */

export type StaggerOptions = {
  /** Delay per step, in ms. Default 60. */
  each?: number
  /** Where the stagger originates. 'start' (default), 'end', or 'center'. */
  from?: 'start' | 'end' | 'center'
  /** Selector identifying the sibling group to stagger across. Defaults to
   *  every element matching the same tag+class as the target, found via
   *  the target's own DOM position — see resolveGroup(). */
  grid?: string | 'auto'
  /** Adds up to this many ms of random jitter on top of the computed delay. */
  random?: number
}

/** Resolves the sibling group a target participates in for staggering.
 *  'auto' (the default) walks up to the target's parent and treats every
 *  child matching the target's own tag as the group — the common case of
 *  `comice('.grid figure')` where all matches share a parent. An explicit
 *  selector string queries the whole document instead, for groups that
 *  aren't DOM siblings. */
function resolveGroup(target: Element, grid: StaggerOptions['grid']): Element[] {
  if (typeof grid === 'string' && grid !== 'auto') {
    return Array.from(document.querySelectorAll(grid))
  }
  const parent = target.parentElement
  if (!parent) return [target]
  return Array.from(parent.children).filter((el) => el.tagName === target.tagName)
}

/** Computes this target's delay in ms, given its position within its
 *  stagger group. Deterministic except for the `random` jitter term. */
export function computeStaggerDelay(target: Element, options: StaggerOptions): number {
  const { each = 60, from = 'start', grid = 'auto', random = 0 } = options
  const group = resolveGroup(target, grid)
  const index = group.indexOf(target)
  const count = group.length

  if (index === -1 || count <= 1) return 0

  let step: number
  switch (from) {
    case 'end':
      step = count - 1 - index
      break
    case 'center': {
      const center = (count - 1) / 2
      step = Math.abs(index - center)
      break
    }
    case 'start':
    default:
      step = index
  }

  const base = step * each
  const jitter = random > 0 ? Math.random() * random : 0
  return base + jitter
}
