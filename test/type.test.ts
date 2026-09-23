/**
 * test/type.test — packages/type/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure CSS/DOM, no GL, no scheduler — imports core from source directly,
 * same as test/spotlight.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from '../packages/core/src/index.js'
import { setMeltTarget, type } from '../packages/type/src/index.js'

function makeTextAndMedia(): { textEl: HTMLHeadingElement; img: HTMLImageElement } {
  const img = document.createElement('img')
  img.id = 'hero-media'
  document.body.appendChild(img)
  const textEl = document.createElement('h1')
  document.body.appendChild(textEl)
  return { textEl, img }
}

describe('type — construction contract', () => {
  it("throws for mode 'fill' with no media selector", () => {
    expect(() => type({ mode: 'fill' })).toThrow()
  })

  it("throws for mode 'behind' with no media selector", () => {
    expect(() => type({ mode: 'behind' })).toThrow()
  })

  it("throws for mode 'knockout' with no media selector", () => {
    expect(() => type({ mode: 'knockout' })).toThrow()
  })

  it("does not throw for mode 'melt' with no media selector", () => {
    expect(() => type({ mode: 'melt' })).not.toThrow()
  })

  it('defaults to mode "fill"', () => {
    expect(() => type({ media: '#nonexistent' })).not.toThrow() // construction never resolves the selector; only setup() does
  })
})

describe('type — target contract', () => {
  it('throws for a non-HTMLElement target', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    document.body.appendChild(svg as unknown as Element)
    const handle = comice(svg as unknown as Element) as ComiceHandle
    expect(() => handle.use(type({ mode: 'melt' }))).toThrow()
    svg.remove()
  })

  it('throws when the media selector matches nothing', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    expect(() => handle.use(type({ mode: 'fill', media: '#does-not-exist' }))).toThrow()
    textEl.remove()
    img.remove()
  })
})

describe('type — mode: fill', () => {
  it('sets background-clip: text and transparent color', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    handle.use(type({ mode: 'fill', media: '#hero-media' }))
    expect(textEl.style.backgroundClip).toBe('text')
    expect(textEl.style.color).toBe('transparent')
    textEl.remove()
    img.remove()
  })

  it('restores original styles on teardown', () => {
    const { textEl, img } = makeTextAndMedia()
    textEl.style.color = 'blue'
    const handle = comice(textEl) as ComiceHandle
    handle.use(type({ mode: 'fill', media: '#hero-media' }))
    handle.destroy()
    expect(textEl.style.color).toBe('blue')
    textEl.remove()
    img.remove()
  })
})

describe('type — mode: behind', () => {
  it('sets position: relative and a positive z-index on the target', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    handle.use(type({ mode: 'behind', media: '#hero-media' }))
    expect(textEl.style.position).toBe('relative')
    expect(textEl.style.zIndex).toBe('1')
    textEl.remove()
    img.remove()
  })

  it("sets the media's own parent to position: relative if it was static", () => {
    const { textEl, img } = makeTextAndMedia()
    const parent = img.parentElement!
    parent.style.position = 'static'
    const handle = comice(textEl) as ComiceHandle
    handle.use(type({ mode: 'behind', media: '#hero-media' }))
    expect(parent.style.position).toBe('relative')
    textEl.remove()
    img.remove()
  })
})

describe('type — mode: knockout', () => {
  it('sets mix-blend-mode: destination-out', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    handle.use(type({ mode: 'knockout', media: '#hero-media' }))
    expect(textEl.style.mixBlendMode).toBe('destination-out')
    textEl.remove()
    img.remove()
  })
})

describe('type — mode: melt', () => {
  it('applies "none" filter at progress 0', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    handle.use(type({ mode: 'melt' }))
    expect(textEl.style.filter).toBe('none')
    textEl.remove()
    img.remove()
  })

  it('applies a blur+contrast filter mid-transition', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    handle.use(type({ mode: 'melt' }))
    handle.setProgress(0.5)
    expect(textEl.style.filter).toContain('blur(')
    expect(textEl.style.filter).toContain('contrast(')
    textEl.remove()
    img.remove()
  })

  it('respects custom melt options', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    handle.use(type({ mode: 'melt', melt: { blur: 30, threshold: [1, 25] } }))
    handle.setProgress(0.5)
    expect(textEl.style.filter).toContain('blur(30.00px)')
    expect(textEl.style.filter).toContain('contrast(25.00)')
    textEl.remove()
    img.remove()
  })

  it('non-melt modes do not react to progress changes at all', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    handle.use(type({ mode: 'fill', media: '#hero-media' }))
    const filterBefore = textEl.style.filter
    handle.setProgress(0.5)
    expect(textEl.style.filter).toBe(filterBefore)
    textEl.remove()
    img.remove()
  })
})

describe('type — params (MappableTarget)', () => {
  it('get/setParam round-trips progress', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    const plugin = type({ mode: 'melt' })
    handle.use(plugin)
    plugin.params!.setParam('progress', 0.7)
    expect(plugin.params!.getParam('progress')).toBeCloseTo(0.7)
    textEl.remove()
    img.remove()
  })

  it('getParam for an unknown name returns 0', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    const plugin = type({ mode: 'melt' })
    handle.use(plugin)
    expect(plugin.params!.getParam('bogus')).toBe(0)
    textEl.remove()
    img.remove()
  })

  it('setParam for an unknown name is a no-op', () => {
    const { textEl, img } = makeTextAndMedia()
    const handle = comice(textEl) as ComiceHandle
    const plugin = type({ mode: 'melt' })
    handle.use(plugin)
    expect(() => plugin.params!.setParam('bogus', 1)).not.toThrow()
    textEl.remove()
    img.remove()
  })
})

describe('setMeltTarget', () => {
  it('swaps text content when it differs', () => {
    const el = document.createElement('div')
    el.textContent = 'old'
    const changed = setMeltTarget(el, 'new')
    expect(changed).toBe(true)
    expect(el.textContent).toBe('new')
  })

  it('hold: true (default) skips the swap and returns false when text is identical', () => {
    const el = document.createElement('div')
    el.textContent = 'same'
    const changed = setMeltTarget(el, 'same')
    expect(changed).toBe(false)
    expect(el.textContent).toBe('same')
  })

  it('hold: false always swaps, even for identical text', () => {
    const el = document.createElement('div')
    el.textContent = 'same'
    const changed = setMeltTarget(el, 'same', false)
    expect(changed).toBe(true)
  })
})
