/**
 * test/reveal.test — packages/reveal/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload). This is the file that
 * matters most for the reveal plugin's actual purpose: it exercises the
 * REAL comice() public API from packages/core, not a fake plugin harness —
 * proving .use()/setup()/teardown()/params against the first genuine
 * consumer those contracts have ever had.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { comice, type ComiceHandle } from '../packages/core/src/index.js'
import { reveal } from '../packages/reveal/src/index.js'

describe('reveal — setup/teardown against the real comice() API', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
  })

  afterEach(() => {
    el.remove()
  })

  it('attaches without throwing, via the real .use()', () => {
    const handle = comice(el) as ComiceHandle
    expect(() => handle.use(reveal())).not.toThrow()
  })

  it('applies the idle-state style immediately on setup (progress 0)', () => {
    const handle = comice(el) as ComiceHandle
    handle.use(reveal({ effect: 'scale', waitForDecode: false }))
    expect(el.style.opacity).toBe('0')
  })

  it('throws for a non-HTMLElement target, per the plugin contract', () => {
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    document.body.appendChild(svgEl)
    const handle = comice(svgEl) as ComiceHandle
    expect(() => handle.use(reveal())).toThrow()
    svgEl.remove()
  })

  it('restores the element\'s original inline style on destroy()', () => {
    el.style.opacity = '0.42' // pre-existing author style
    const handle = comice(el) as ComiceHandle
    handle.use(reveal({ effect: 'scale', waitForDecode: false }))
    expect(el.style.opacity).not.toBe('0.42') // plugin took over

    handle.destroy()
    expect(el.style.opacity).toBe('0.42') // restored, not left at the plugin's last value
  })

  it('a second .use(reveal()) on a different element does not affect the first', () => {
    const elB = document.createElement('div')
    document.body.appendChild(elB)

    const handleA = comice(el) as ComiceHandle
    const handleB = comice(elB) as ComiceHandle
    handleA.use(reveal({ effect: 'blur', waitForDecode: false }))
    handleB.use(reveal({ effect: 'scale', waitForDecode: false }))

    expect(el.style.filter).toContain('blur')
    expect(elB.style.transform).toContain('scale')

    elB.remove()
  })
})

describe('reveal — driven by state, not duration', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
  })

  afterEach(() => {
    el.remove()
  })

  it('renders progress as the driver reports it, with no internal timer', () => {
    const handle = comice(el) as ComiceHandle
    handle.use(reveal({ effect: 'scale', waitForDecode: false }))

    handle.setProgress(0.5)
    // setProgress alone doesn't emit unless a transition also fires, but
    // instance.on('*', ...) inside reveal listens to every event type —
    // transition into 'entering' is what actually carries progress here.
    handle.transition('entering')
    handle.setProgress(0.5)

    expect(el.style.opacity).toBe('0.5')
  })

  it('reverses correctly when interrupted mid-transition (interrupt safety)', () => {
    const handle = comice(el) as ComiceHandle
    handle.use(reveal({ effect: 'scale', waitForDecode: false }))

    handle.transition('entering')
    handle.setProgress(0.7)
    expect(el.style.opacity).toBe('0.7')

    // Interrupted mid-enter: per machine.ts, entering -> leaving is legal
    // and reverses from wherever progress actually is, not from a
    // hardcoded start.
    handle.transition('leaving')
    handle.setProgress(0.3)
    expect(el.style.opacity).toBe('0.3')
  })
})

describe('reveal — params / MappableTarget contract', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
  })

  afterEach(() => {
    el.remove()
  })

  it('exposes a params object with getParam/setParam', () => {
    const plugin = reveal({ waitForDecode: false })
    expect(plugin.params).toBeDefined()
    expect(typeof plugin.params?.getParam).toBe('function')
    expect(typeof plugin.params?.setParam).toBe('function')
  })

  it('setParam("progress", ...) renders the effect at that progress', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = reveal({ effect: 'scale', waitForDecode: false })
    handle.use(plugin)

    plugin.params!.setParam('progress', 0.6)
    expect(el.style.opacity).toBe('0.6')
  })

  it('getParam("progress") reads back the current rendered progress', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = reveal({ effect: 'scale', waitForDecode: false })
    handle.use(plugin)

    plugin.params!.setParam('progress', 0.35)
    expect(plugin.params!.getParam('progress')).toBeCloseTo(0.35);
  })

  it('setParam ignores an unknown parameter name rather than throwing', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = reveal({ waitForDecode: false })
    handle.use(plugin)
    expect(() => plugin.params!.setParam('nonexistent', 1)).not.toThrow()
  })

  it('setParam buffers rather than renders while waiting on decode, same as instance.on()', async () => {
    const img = document.createElement('img')
    document.body.appendChild(img)
    Object.defineProperty(img, 'complete', { value: false, configurable: true })
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })
    let resolveDecode: () => void = () => {}
    img.decode = () => new Promise((resolve) => { resolveDecode = resolve })

    const handle = comice(img) as ComiceHandle
    const plugin = reveal({ effect: 'scale', waitForDecode: true })
    handle.use(plugin)

    plugin.params!.setParam('progress', 0.77)
    // Not ready yet — the value must be buffered, not rendered.
    expect(img.style.opacity).toBe('0')

    resolveDecode()
    await Promise.resolve()
    await Promise.resolve()

    expect(img.style.opacity).toBe('0.77')
    img.remove()
  })

  it('works end to end through .map().to(), the real mapping layer, no reveal-specific driver code', () => {
    const handle = comice(el) as ComiceHandle
    const plugin = reveal({ effect: 'scale', waitForDecode: false })
    handle.use(plugin)

    let onSignals: ((signals: any) => void) | null = null
    const fakeDriver = {
      name: 'fake',
      attachSignals(_target: Element, cb: (signals: any) => void) {
        onSignals = cb
        return () => {}
      },
    }

    handle.driver(fakeDriver as any).map('level').to(plugin, 'progress', { output: [0, 1] })
    onSignals!({ level: 0.8 })

    expect(el.style.opacity).toBe('0.8')
  })
})

describe('reveal — waitForDecode', () => {
  let el: HTMLImageElement

  beforeEach(() => {
    el = document.createElement('img')
    document.body.appendChild(el)
  })

  afterEach(() => {
    el.remove()
  })

  it('holds at the idle style until the image reports ready', async () => {
    Object.defineProperty(el, 'complete', { value: false, configurable: true })
    Object.defineProperty(el, 'naturalWidth', { value: 0, configurable: true })
    el.decode = () => new Promise(() => {}) // never resolves, simulating still-loading

    const handle = comice(el) as ComiceHandle
    handle.use(reveal({ effect: 'scale', waitForDecode: true }))
    handle.transition('entering')
    handle.setProgress(1)

    // Still at the idle style — decode() hasn't resolved, so the buffered
    // progress must not have rendered yet.
    expect(el.style.opacity).toBe('0')
  })

  it('renders the buffered progress once decode resolves', async () => {
    Object.defineProperty(el, 'complete', { value: false, configurable: true })
    Object.defineProperty(el, 'naturalWidth', { value: 0, configurable: true })
    let resolveDecode: () => void = () => {}
    el.decode = () => new Promise((resolve) => { resolveDecode = resolve })

    const handle = comice(el) as ComiceHandle
    handle.use(reveal({ effect: 'scale', waitForDecode: true }))
    handle.transition('entering')
    handle.setProgress(1)
    expect(el.style.opacity).toBe('0')

    resolveDecode()
    await Promise.resolve()
    await Promise.resolve() // let the .then() chain in setup() actually run

    expect(el.style.opacity).toBe('1')
  })

  it('renders immediately when waitForDecode is false, even before decode', () => {
    Object.defineProperty(el, 'complete', { value: false, configurable: true })
    Object.defineProperty(el, 'naturalWidth', { value: 0, configurable: true })
    el.decode = () => new Promise(() => {})

    const handle = comice(el) as ComiceHandle
    handle.use(reveal({ effect: 'scale', waitForDecode: false }))
    handle.transition('entering')
    handle.setProgress(0.9)

    expect(el.style.opacity).toBe('0.9')
  })
})

describe('reveal — stagger, exercised against real sibling elements', () => {
  let container: HTMLElement
  let items: HTMLElement[]

  beforeEach(() => {
    container = document.createElement('div')
    items = Array.from({ length: 3 }, () => document.createElement('figure'))
    items.forEach((item) => container.appendChild(item))
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('later siblings start rendering after an earlier one, per the stagger delay', async () => {
    const handles = items.map((item) => comice(item) as ComiceHandle)
    handles.forEach((handle) =>
      handle.use(reveal({ effect: 'scale', waitForDecode: false, stagger: { each: 0.01 } })),
    )
    handles.forEach((handle) => {
      handle.transition('entering')
      handle.setProgress(1)
    })

    // Item 0 has delay 0, renders immediately.
    expect(items[0].style.opacity).toBe('1')
    // Items 1 and 2 have positive delay — not yet rendered.
    expect(items[1].style.opacity).not.toBe('1')
    expect(items[2].style.opacity).not.toBe('1')

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(items[1].style.opacity).toBe('1')
    expect(items[2].style.opacity).toBe('1')
  })
})
