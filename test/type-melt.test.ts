/**
 * test/type-melt — packages/type/src/melt.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The spec's melt: change the text, and it melts from the old word into the
 * new. It used to blur one element while the caller swapped the text, so
 * the two words never met. Verified rendering in Chromium; these pin the
 * wiring with a fake requestAnimationFrame.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { type } from '../packages/type/src/index.js'
import { createMelt } from '../packages/type/src/melt.js'

let originalRAF: typeof requestAnimationFrame
let queued: FrameRequestCallback[]
let now = 0

beforeEach(() => {
  queued = []
  now = 0
  originalRAF = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queued.push(cb)
    return queued.length
  }) as typeof requestAnimationFrame
})

afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF
  getSharedScheduler().stop()
  document.body.innerHTML = ''
})

function frames(n: number, ms = 20): void {
  for (let i = 0; i < n; i++) {
    now += ms
    const pending = queued
    queued = []
    pending.forEach((cb) => cb(now))
  }
}
const mutations = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function heading(text: string): HTMLHeadingElement {
  const el = document.createElement('h1')
  el.textContent = text
  document.body.appendChild(el)
  return el
}
const melting = (el: Element) => el.hasAttribute('data-comice-melt')

describe('melt: the spec example', () => {
  it('changing the text melts old into new, then restores everything', async () => {
    const el = heading('Aurora')
    el.style.visibility = 'visible'
    el.style.position = 'static' // happy-dom computes an unset position as ''
    comice(el).use(type({ mode: 'melt', melt: { blur: 14, threshold: [0.5, 18], hold: true } }))
    el.textContent = 'Basalt'
    await mutations()
    frames(1)
    expect(melting(el)).toBe(true)
    expect(el.getAttribute('data-comice-melt-from')).toBe('Aurora')
    expect(el.getAttribute('data-comice-melt-to')).toBe('Basalt')
    expect(el.textContent).toBe('Basalt') // the real text, never ghost copies
    expect(el.children).toHaveLength(0)
    expect(el.style.visibility).toBe('hidden')
    expect(el.style.filter).toMatch(/^url\(["']?#comice-melt-\d+["']?\)$/)
    expect(el.style.position).toBe('relative')
    expect(el.style.getPropertyValue('--comice-melt-to-filter')).toMatch(/^blur\(/)

    frames(40) // past the default 600ms
    expect(melting(el)).toBe(false)
    expect(el.style.visibility).toBe('visible')
    expect(el.style.filter).toBe('')
    expect(el.style.position).toBe('static')
    expect(el.style.getPropertyValue('--comice-melt-to-filter')).toBe('')
  })

  it('hold: the same text again stays perfectly still', async () => {
    const el = heading('Aurora')
    comice(el).use(type({ mode: 'melt' }))
    el.textContent = 'Aurora'
    await mutations()
    frames(1)
    expect(melting(el)).toBe(false)
  })

  it('hold: false melts even into the same text', async () => {
    const el = heading('Aurora')
    comice(el).use(type({ mode: 'melt', melt: { hold: false } }))
    el.textContent = 'Aurora'
    await mutations()
    frames(1)
    expect(melting(el)).toBe(true)
  })

  it('a change mid-melt starts a new melt from the word it was heading to', async () => {
    const el = heading('A')
    comice(el).use(type({ mode: 'melt', melt: { duration: 400 } }))
    el.textContent = 'B'
    await mutations()
    frames(5)
    el.textContent = 'C'
    await mutations()
    expect(el.getAttribute('data-comice-melt-from')).toBe('B')
    expect(el.getAttribute('data-comice-melt-to')).toBe('C')
  })

  it('curve shapes the melt', async () => {
    const at = async (curve: 'linear' | 'easeIn') => {
      const el = heading('A')
      const handle = comice(el).use(type({ mode: 'melt', melt: { curve, duration: 100 } }))
      el.textContent = 'B'
      await mutations()
      frames(1, 50) // halfway
      const opacity = el.style.getPropertyValue('--comice-melt-to-opacity')
      handle.destroy()
      return Number(opacity)
    }
    expect(await at('easeIn')).toBeLessThan(await at('linear'))
  })

  it('a position: absolute element keeps its own positioning', async () => {
    const el = heading('A')
    el.style.position = 'absolute'
    comice(el).use(type({ mode: 'melt' }))
    el.textContent = 'B'
    await mutations()
    expect(el.style.position).toBe('absolute')
  })
})

describe('melt: driven progress scrubs the last pair', () => {
  it('0 shows the old word, 1 the real text; before any change there is nothing to scrub', async () => {
    const el = heading('Aurora')
    const plugin = type({ mode: 'melt' })
    const handle = comice(el).use(plugin)
    handle.set({ progress: 0.5 })
    expect(melting(el)).toBe(false)

    el.textContent = 'Basalt'
    await mutations()
    plugin.params!.setParam('progress', 0)
    expect(el.style.getPropertyValue('--comice-melt-from-opacity')).toBe('1')
    frames(40) // scrubbing stopped the auto melt: nothing moves on its own
    expect(el.style.getPropertyValue('--comice-melt-from-opacity')).toBe('1')
    handle.set({ progress: 1 })
    expect(melting(el)).toBe(false)
  })
})

describe('melt: reduced motion and teardown', () => {
  it('under reduced motion the new text simply replaces the old', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    try {
      const el = heading('A')
      comice(el).use(type({ mode: 'melt' }))
      el.textContent = 'B'
      await mutations()
      frames(1)
      expect(melting(el)).toBe(false)
    } finally {
      window.matchMedia = original
    }
  })

  it('destroy mid-melt restores the element, removes the filter and stops listening', async () => {
    const el = heading('A')
    const handle = comice(el).use(type({ mode: 'melt' }))
    el.textContent = 'B'
    await mutations()
    expect(document.querySelectorAll('filter')).toHaveLength(1)
    handle.destroy()
    expect(melting(el)).toBe(false)
    expect(el.style.visibility).toBe('')
    expect(document.querySelectorAll('filter')).toHaveLength(0)
    el.textContent = 'C'
    await mutations()
    expect(melting(el)).toBe(false)
  })

  it('stops quietly if the element leaves the page mid-melt', async () => {
    const el = heading('A')
    const melt = createMelt(el)
    el.textContent = 'B'
    await mutations()
    el.remove()
    expect(() => frames(40)).not.toThrow()
    melt.destroy()
  })
})

describe('melt: the ghost stylesheet', () => {
  it('is added once per document: a constructable sheet in a window, a <style> without one', () => {
    const count = () => document.adoptedStyleSheets.filter((sheet) => Array.from(sheet.cssRules).some((r) => r.cssText.includes('data-comice-melt'))).length
    createMelt(heading('A')).destroy()
    createMelt(heading('B')).destroy()
    expect(count()).toBe(1)

    const doc = document.implementation.createHTMLDocument('no window') // defaultView is null
    const el = doc.createElement('h1')
    doc.body.appendChild(el)
    createMelt(el).destroy()
    createMelt(el).destroy()
    expect(Array.from(doc.querySelectorAll('style')).filter((style) => style.textContent?.includes('data-comice-melt'))).toHaveLength(1)
  })
})
