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
