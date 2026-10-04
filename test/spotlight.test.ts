/**
 * test/spotlight.test — packages/spotlight/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom, pure CSS/DOM — no GL, no scheduler singleton
 * concerns (spotlight never calls getSharedScheduler()), so this file
 * imports core the same way every non-GL test file in this repo does:
 * `../packages/core/src` directly (see test/morph.test.ts's own header for
 * why a GL-touching plugin package needs the package-name import instead —
 * spotlight doesn't qualify).
 */

import { describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from '../packages/core/src/index.js'
import { spotlight } from '../packages/spotlight/src/index.js'

function makeGrid(): { container: HTMLDivElement; cards: HTMLDivElement[] } {
  const container = document.createElement('div')
  const cards: HTMLDivElement[] = []
  for (let i = 0; i < 3; i++) {
    const card = document.createElement('div')
    card.className = 'project'
    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.textContent = `Project ${i}`
    card.appendChild(meta)
    container.appendChild(card)
    cards.push(card)
  }
  document.body.appendChild(container)
  return { container, cards }
}

describe('spotlight — target contract', () => {
  it('throws for a non-HTMLElement target', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    document.body.appendChild(svg as unknown as Element)
    const handle = comice(svg as unknown as Element) as ComiceHandle
    expect(() => handle.use(spotlight())).toThrow()
    svg.remove()
  })

  it('accepts an HTMLElement target without throwing', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    expect(() => handle.use(spotlight())).not.toThrow()
    container.remove()
  })
})

describe('spotlight — peers', () => {
  it('dims and blurs peers matching the selector as progress advances, excluding the target itself', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ peers: { selector: '.project', blur: 8, dim: 0.2 } }))

    handle.setProgress(1)

    expect(cards[0]!.style.filter).toBe('')
    expect(cards[1]!.style.filter).toBe('blur(8px)')
    expect(cards[2]!.style.filter).toBe('blur(8px)')
    expect(Number.parseFloat(cards[1]!.style.opacity)).toBeCloseTo(0.2)

    container.remove()
  })

  it('peer dim/blur interpolates linearly with progress', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ peers: { selector: '.project', blur: 10, dim: 0 } }))

    handle.setProgress(0.5)
    expect(cards[1]!.style.filter).toBe('blur(5px)')
    expect(Number.parseFloat(cards[1]!.style.opacity)).toBeCloseTo(0.5)

    container.remove()
  })

  it('peers: false applies no peer styling at all', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ peers: false }))
    handle.setProgress(1)

    expect(cards[1]!.style.filter).toBe('')
    expect(cards[1]!.style.opacity).toBe('')

    container.remove()
  })
})

describe('spotlight — reveal', () => {
  it('reveals matched caption children as real DOM (visibility/opacity), not synthetic content', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ reveal: '.meta' }))

    const meta = cards[0]!.querySelector('.meta') as HTMLElement
    expect(meta.style.visibility).toBe('hidden')

    handle.setProgress(1)
    expect(meta.style.visibility).toBe('visible')
    expect(meta.textContent).toBe('Project 0') // still real DOM text, never replaced

    container.remove()
  })

  it('hides revealed captions again when progress returns to 0', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ reveal: '.meta' }))
    const meta = cards[0]!.querySelector('.meta') as HTMLElement

    handle.setProgress(1)
    handle.setProgress(0)
    expect(meta.style.visibility).toBe('hidden')

    container.remove()
  })

  it('does nothing when reveal is unset', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    expect(() => handle.use(spotlight())).not.toThrow()
    container.remove()
  })
})

describe('spotlight — target lift', () => {
  it('applies a scale/translateY transform to the target at full progress', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ lift: 0.1 }))
    handle.setProgress(1)
    expect(cards[0]!.style.transform).toContain('scale(1.1)')
    container.remove()
  })

  it('lift: 0 leaves the target transform empty', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ lift: 0 }))
    handle.setProgress(1)
    expect(cards[0]!.style.transform).toBe('')
    container.remove()
  })
})

describe('spotlight — params (MappableTarget)', () => {
  it('getParam("progress") reflects the current progress', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    const plugin = spotlight()
    handle.use(plugin)
    plugin.params!.setParam('progress', 0.6)
    expect(plugin.params!.getParam('progress')).toBeCloseTo(0.6)
    container.remove()
  })

  it('getParam for an unknown name returns 0', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    const plugin = spotlight()
    handle.use(plugin)
    expect(plugin.params!.getParam('bogus')).toBe(0)
    container.remove()
  })

  it('setParam for an unknown name is a no-op', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    const plugin = spotlight()
    handle.use(plugin)
    expect(() => plugin.params!.setParam('bogus', 1)).not.toThrow()
    expect(plugin.params!.getParam('progress')).toBe(0)
    container.remove()
  })

  it('setParam clamps to [0, 1]', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    const plugin = spotlight()
    handle.use(plugin)
    plugin.params!.setParam('progress', 5)
    expect(plugin.params!.getParam('progress')).toBe(1)
    plugin.params!.setParam('progress', -5)
    expect(plugin.params!.getParam('progress')).toBe(0)
    container.remove()
  })
})

describe('spotlight — teardown', () => {
  it('restores original target/peer/reveal styles on destroy', () => {
    const { container, cards } = makeGrid()
    cards[1]!.style.opacity = '0.77' // a pre-existing style the plugin must restore, not clobber
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ peers: { selector: '.project' }, reveal: '.meta' }))
    handle.setProgress(1)

    handle.destroy()

    expect(cards[0]!.style.transform).toBe('')
    expect(cards[1]!.style.opacity).toBe('0.77')
    const meta = cards[0]!.querySelector('.meta') as HTMLElement
    expect(meta.style.visibility).toBe('')

    container.remove()
  })

  it('teardown does not throw when called without ever setting progress', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ peers: { selector: '.project' } }))
    expect(() => handle.destroy()).not.toThrow()
    container.remove()
  })
})

describe('spotlight — driven by hover()', () => {
  it('active state (via the state machine) drives progress toward 1', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!) as ComiceHandle
    handle.use(spotlight({ peers: { selector: '.project' } }))

    handle.transition('entering')
    handle.setProgress(1)
    handle.transition('active')

    expect(cards[1]!.style.opacity).not.toBe('')
    container.remove()
  })
})

describe('spotlight — the spec example: every .project spotlights .project peers', () => {
  it("peers: '.project' is shorthand for { selector: '.project' }", () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!).use(spotlight({ peers: '.project' }))
    handle.setProgress(1)
    expect(cards[1]!.style.filter).toBe('blur(4px)')
    expect(Number.parseFloat(cards[1]!.style.opacity)).toBeCloseTo(0.4)
    handle.destroy()
    container.remove()
  })

  it('moving from A to B: C stays receded whichever tween writes last; B is never dimmed by A', () => {
    const { container, cards } = makeGrid()
    const [a, b, c] = comice('.project').use(spotlight({ peers: '.project' })).handles
    a!.setProgress(1)
    // A leaves while B enters; B finishes first, then A's last frame lands.
    a!.setProgress(0.5)
    b!.setProgress(1)
    expect(cards[1]!.style.opacity).toBe('') // B: spotlighted, A's 0.5 cancelled by B's own 1
    a!.setProgress(0) // used to write C back to opacity 1 here
    expect(Number.parseFloat(cards[2]!.style.opacity)).toBeCloseTo(0.4)
    expect(Number.parseFloat(cards[0]!.style.opacity)).toBeCloseTo(0.4) // A is now B's peer
    expect(c!.progress).toBe(0)
    container.remove()
  })

  it('a peer recedes by the strongest spotlight on it, and is restored once the last one is gone', () => {
    const { container, cards } = makeGrid()
    cards[2]!.style.opacity = '0.9'
    const group = comice([cards[0]!, cards[1]!] as unknown as NodeListOf<Element>)
    group.use(spotlight({ peers: { selector: '.project', dim: 0 } }))
    const [a, b] = group.handles
    a!.setProgress(0.3)
    b!.setProgress(0.6)
    expect(Number.parseFloat(cards[2]!.style.opacity)).toBeCloseTo(0.4)
    a!.destroy()
    expect(Number.parseFloat(cards[2]!.style.opacity)).toBeCloseTo(0.4) // B still holds it
    b!.destroy()
    expect(cards[2]!.style.opacity).toBe('0.9')
    container.remove()
  })

  it('forced transition("active") shows the effect fully (it used to render at rest)', () => {
    const { container, cards } = makeGrid()
    const card = comice(cards[0]!).use(spotlight({ peers: '.project' }))
    card.transition('entering')
    card.transition('active')
    expect(Number.parseFloat(cards[1]!.style.opacity)).toBeCloseTo(0.4)
    card.destroy()
    container.remove()
  })
})

describe('spotlight — expand', () => {
  it('grows the target\'s flex-grow from its resting value to `expand`, and restores it', () => {
    const { container, cards } = makeGrid()
    container.style.display = 'flex'
    cards.forEach((card) => (card.style.flexGrow = '1'))
    const handle = comice(cards[0]!).use(spotlight({ expand: 3 }))
    expect(cards[0]!.style.flexGrow).toBe('1')
    handle.setProgress(0.5)
    expect(cards[0]!.style.flexGrow).toBe('2')
    handle.setProgress(1)
    expect(cards[0]!.style.flexGrow).toBe('3')
    handle.destroy()
    expect(cards[0]!.style.flexGrow).toBe('1')
    container.remove()
  })

  it('an item with no flex-grow expands from 0; without expand, flex-grow is never touched', () => {
    const { container, cards } = makeGrid()
    const handle = comice(cards[0]!).use(spotlight({ expand: 2 }))
    handle.setProgress(0.5)
    expect(cards[0]!.style.flexGrow).toBe('1')
    const other = comice(cards[1]!).use(spotlight())
    other.setProgress(1)
    expect(cards[1]!.style.flexGrow).toBe('')
    container.remove()
  })
})
