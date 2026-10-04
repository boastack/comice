/**
 * @comice/reveal/stagger
 * ─────────────────────────────────────────────────────────────────────────────
 * Each reveal() plugin instance is attached separately per matched element,
 * so there is no shared object to coordinate timing across siblings. Each
 * instance computes its own place in the group at setup() time,
 * statelessly, from the DOM — no registry, nothing to leak or go stale.
 *
 * UNITS AND GRIDS, AS THE SPEC WRITES THEM: `{ each: 0.06, grid: 'auto' }`
 * (spec §08) — `each` in SECONDS, the convention the spec's option shape
 * follows. It used to be milliseconds (default 60), so the spec's own grid
 * staggered by 0.06ms, which is nothing. And `grid: 'auto'` used to mean
 * only "the target's same-tag siblings"; it now reads the 2D grid the
 * items are laid out in and staggers by distance from `from`, so a grid
 * opens as a wave from a corner (or the centre), not in reading order.
 */

export type StaggerOptions = {
  /** Delay per step, in seconds. Default 0.06. */
  each?: number
  /** Where the stagger starts: 'start' (default; the first item, or a
   *  grid's top-left), 'end', or 'center'. */
  from?: 'start' | 'end' | 'center'
  /** 'auto': the items form a grid; rows and columns are read from where
   *  they sit on the page, and the delay grows with distance from `from`.
   *  `[rows, columns]`: the same, with the grid given. A selector string:
   *  which elements form the group (in document order, one by one).
   *  Without it: the target's same-tag siblings, one by one. */
  grid?: 'auto' | readonly [number, number] | string
  /** Up to this many seconds of random jitter on top. */
  random?: number
}

/** The group a target is staggered across: a selector's matches, or the
 *  target's same-tag siblings. */
function resolveGroup(target: Element, grid: StaggerOptions['grid']): Element[] {
  if (typeof grid === 'string' && grid !== 'auto') {
    return Array.from(document.querySelectorAll(grid))
  }
  const parent = target.parentElement
  if (!parent) return [target]
  return Array.from(parent.children).filter((el) => el.tagName === target.tagName)
}

/** [row, column] of every item. 'auto' reads rows from layout: items
 *  sharing a top edge (to the pixel) share a row, in document order. */
function gridPositions(group: Element[], grid: 'auto' | readonly [number, number]): Array<[number, number]> {
  if (grid !== 'auto') {
    const columns = Math.max(1, grid[1])
    return group.map((_el, i) => [Math.floor(i / columns), i % columns])
  }
  let row = -1
  let column = 0
  let lastTop: number | null = null
  return group.map((el) => {
    const top = Math.round(el.getBoundingClientRect().top)
    if (top !== lastTop) {
      row++
      column = 0
      lastTop = top
    } else {
      column++
    }
    return [row, column]
  })
}

/** The stagger delay for `target`, in ms. */
export function computeStaggerDelay(target: Element, options: StaggerOptions): number {
  const { each = 0.06, from = 'start', grid, random = 0 } = options
  const group = resolveGroup(target, grid)
  const index = group.indexOf(target)
  const count = group.length

  if (index === -1 || count <= 1) return 0

  let step: number
  if (grid === 'auto' || Array.isArray(grid)) {
    const positions = gridPositions(group, grid as 'auto' | readonly [number, number])
    const lastRow = Math.max(...positions.map(([r]) => r))
    const lastColumn = Math.max(...positions.map(([, c]) => c))
    const origin: [number, number] = from === 'end' ? [lastRow, lastColumn] : from === 'center' ? [lastRow / 2, lastColumn / 2] : [0, 0]
    const [row, column] = positions[index]!
    step = Math.hypot(row - origin[0], column - origin[1])
  } else if (from === 'end') {
    step = count - 1 - index
  } else if (from === 'center') {
    step = Math.abs(index - (count - 1) / 2)
  } else {
    step = index
  }

  const jitter = random > 0 ? Math.random() * random : 0
  return (step * each + jitter) * 1000
}
