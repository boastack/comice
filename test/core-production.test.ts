import { afterEach, describe, expect, it } from 'bun:test'
import { comice, type ComicePlugin } from '../packages/core/src/index.js'
import { createInstance } from '../packages/core/src/machine.js'
import { createScheduler } from '../packages/core/src/scheduler.js'
import { scroll } from '../packages/core/src/drivers/scroll.js'
import type { Driver, DriverSignal, NamedSignalDriver, SignalValues } from '../packages/core/src/types.js'
import { waitForMediaReady } from '../packages/core/src/gl/ready.js'

const handles: ReturnType<typeof comice>[] = []
function handle() { const el = document.createElement('div'); document.body.append(el); const h = comice(el); handles.push(h); return h }
function plugin() {
  const values: Record<string, number> = {}
  return { name: 'test', setup() {}, params: { getParam: (key: string) => values[key] ?? 0, setParam: (key: string, value: number) => { values[key] = value } }, values }
}
function named() {
  let emit: (values: Readonly<SignalValues>) => void = () => {}
  const driver: NamedSignalDriver = { name: 'signals', attachSignals(_el, cb) { emit = cb; return () => {} } }
  return { driver, emit: (values: SignalValues) => emit(values) }
}
function plain() {
  let emit: (signal: DriverSignal) => void = () => {}
  const driver: Driver = { name: 'input', attach(_el, cb) { emit = cb; return () => {} } }
  return { driver, emit: (signal: DriverSignal) => emit(signal) }
}
afterEach(() => { handles.splice(0).forEach((h) => h.destroy()); document.body.innerHTML = '' })

describe('core production regressions', () => {
  it('keeps mappings bound to the driver they were created from', () => {
    const h = handle(), p = plugin(), a = named(), b = named()
    h.use(p).driver(a.driver).map('energy').to(p, 'a')
    h.driver(b.driver).map('energy').to(p, 'b')
    a.emit({ energy: .2 }); b.emit({ energy: .8 }); a.emit({ energy: .3 })
    expect(p.values).toEqual({ a: .3, b: .8 })
  })
  it('a mapping builder captures its driver even if another driver is attached before to()', () => {
    const h = handle(), p = plugin(), a = named(), b = named()
    h.use(p).driver(a.driver)
    const builder = h.map('energy')
    h.driver(b.driver); builder.to(p, 'amount')
    b.emit({ energy: .8 }); expect(p.values.amount).toBeUndefined()
    a.emit({ energy: .2 }); expect(p.values.amount).toBe(.2)
  })
  it('maps progress, pointer coordinates and velocity from plain drivers', () => {
    const h = handle(), p = plugin(), d = plain()
    h.use(p).driver(d.driver)
    h.map('progress').to(p, 'progress')
    h.map('pointerX').to(p, 'x', { range: [0, 100] })
    h.map('velocity').to(p, 'bend', { range: [-2000, 2000], output: [-1, 1] })
    d.emit({ progress: .4, pointer: { x: 50, y: 25 }, velocity: -1000 })
    expect(p.values).toEqual({ progress: .4, x: 50, bend: -.5 })
  })
  it('applies a synchronous initial signal when the mapping is attached', () => {
    const h = handle(), p = plugin()
    h.use(p).driver({ name: 'initial', attachSignals(_el, emit) { emit({ energy: .7 }); return () => {} } }).map('energy').to(p, 'amount')
    expect(p.values.amount).toBe(.7)
  })
  it('fails clearly when no driver precedes a mapping', () => {
    const h = handle(), p = plugin(); h.use(p)
    expect(() => h.map('energy').to(p, 'amount')).toThrow(/Attach a driver/)
  })
  it('settles a single endpoint signal and reverses from the actual intermediate progress', () => {
    const h = handle(), d = plain(); h.driver(d.driver)
    const states: string[] = []; h.on('*', (_, event) => { if (['entering', 'active', 'leaving', 'idle'].includes(event.type)) states.push(event.type) })
    d.emit({ progress: 1 }); expect(h.state).toBe('active')
    d.emit({ progress: .6 }); expect(h.state).toBe('leaving'); expect(h.progress).toBe(.6)
    d.emit({ progress: .7 }); expect(h.state).toBe('entering'); expect(h.progress).toBe(.7)
    d.emit({ progress: 0 }); expect(h.state).toBe('idle')
    expect(states).toEqual(['entering', 'active', 'leaving', 'entering', 'leaving', 'idle'])
  })
  it('ignores non-finite progress rather than poisoning state', () => {
    const instance = createInstance(); instance.setProgress(.4); instance.setProgress(NaN); instance.setProgress(Infinity)
    expect(instance.progress).toBe(.4)
    const h = handle(), d = plain(); h.driver(d.driver); d.emit({ progress: NaN }); expect(h.state).toBe('idle')
  })
  it('destroy runs each teardown once and rejects new attachments', () => {
    const h = handle(); let torn = 0
    h.use({ name: 'once', setup() {}, teardown() { torn++ } }); h.destroy(); h.destroy()
    expect(torn).toBe(1)
    expect(() => h.use(plugin())).toThrow(/destroyed/)
    expect(() => h.driver(plain().driver)).toThrow(/destroyed/)
  })
  it('does not deliver signals from a badly behaved driver after destroy', () => {
    const h = handle(), p = plugin(), d = named(); h.use(p).driver(d.driver).map('energy').to(p, 'amount')
    d.emit({ energy: .4 }); h.destroy(); d.emit({ energy: .8 }); expect(p.values.amount).toBe(.4)
  })
  it('rejects new and previously captured mapping builders after destroy', () => {
    const h = handle(), p = plugin(), d = named(); h.use(p).driver(d.driver)
    const builder = h.map('energy'); h.destroy()
    expect(() => h.map('energy')).toThrow(/destroyed/)
    expect(() => builder.to(p, 'amount')).toThrow(/destroyed/)
    expect(p.values.amount).toBeUndefined()
  })
  it('group mapping builders capture each original driver channel', () => {
    for (let i = 0; i < 2; i++) { const el = document.createElement('div'); el.className = 'mapped-group'; document.body.append(el) }
    const h = comice('.mapped-group'); handles.push(h)
    const p = plugin(), a = named(), b = named()
    const copies = [p]; const shared = { ...p, create() { const copy = plugin(); copies.push(copy); return copy } }
    h.use(shared).driver(a.driver)
    const builder = h.map('energy'); h.driver(b.driver); builder.to(shared, 'amount')
    b.emit({ energy: .8 }); expect(copies[1]!.values.amount).toBeUndefined()
    a.emit({ energy: .2 }); expect(copies[1]!.values.amount).toBe(.2)
  })
  it('refuses sharing a stateful plugin between two handles without tearing down its owner', () => {
    const a = handle(), b = handle(); let torn = 0
    const p = { ...plugin(), teardown() { torn++ } }; a.use(p)
    expect(() => b.use(p)).toThrow(/already attached/); expect(torn).toBe(0)
  })
  it('cleans partial setup once and preserves the setup error', () => {
    const h = handle(); let torn = 0
    expect(() => h.use({ name: 'failed', setup() { throw new Error('setup failed') }, teardown() { torn++ } })).toThrow('setup failed')
    h.destroy(); expect(torn).toBe(1)
  })
  it('rolls back earlier elements when a group plugin fails on a later element', () => {
    for (let i = 0; i < 2; i++) { const el = document.createElement('div'); el.className = 'group'; document.body.append(el) }
    const h = comice('.group'); handles.push(h); let setup = 0, torn = 0
    const make = (): ComicePlugin => ({ name: 'partial', create: make, setup() { if (++setup === 2) throw new Error('second failed') }, teardown() { torn++ } })
    expect(() => h.use(make())).toThrow('second failed'); expect(torn).toBe(2)
    h.destroy(); expect(torn).toBe(2)
  })
  it('rolls back the attached half of a failed hybrid driver', () => {
    const h = handle(); let torn = 0
    expect(() => h.driver({ name: 'hybrid', attach() { return () => { torn++ } }, attachSignals() { throw new Error('signals failed') } })).toThrow('signals failed')
    expect(h.driven).toBe(false); expect(torn).toBe(1); h.destroy(); expect(torn).toBe(1)
  })
  it('ignores late signals from a driver whose attachment failed', () => {
    const h = handle(); let emit: (signal: DriverSignal) => void = () => {}
    expect(() => h.driver({ name: 'failed', attach(_target, callback) { emit = callback; return () => {} }, attachSignals() { throw new Error('failed') } })).toThrow('failed')
    emit({ progress: 1 }); expect(h.progress).toBe(0); expect(h.state).toBe('idle')
  })
  it('a throwing scheduler predicate cannot kill other entries or the loop', () => {
    const original = requestAnimationFrame; let tick: FrameRequestCallback = () => {}; let frames = 0
    globalThis.requestAnimationFrame = ((callback) => { tick = callback; return 1 })
    const scheduler = createScheduler()
    try {
      scheduler.add(() => {}, () => { throw new Error('predicate') })
      scheduler.add(() => { frames++ }, () => true)
      tick(0); tick(16); expect(frames).toBe(2)
    } finally { scheduler.stop(); globalThis.requestAnimationFrame = original }
  })
  it('supports contained progress measured on a surrounding sticky section', () => {
    const subject = document.createElement('section'); subject.id = 'subject'; document.body.append(subject)
    Object.defineProperty(subject, 'getBoundingClientRect', { configurable: true, value: () => ({ top: -400, height: 1600 } as DOMRect) })
    const media = document.createElement('img'); subject.append(media)
    const old = innerHeight; Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    try { const signals: DriverSignal[] = []; const detach = scroll({ subject: '#subject', range: 'contain' }).attach(media, (s) => signals.push(s)); expect(signals[0]?.progress).toBe(.5); detach() }
    finally { Object.defineProperty(window, 'innerHeight', { configurable: true, value: old }) }
  })
  it('a missing scroll subject fails clearly', () => {
    expect(() => scroll({ subject: '#missing' }).attach(document.createElement('img'), () => {})).toThrow(/subject/)
  })
  it('aborting a media wait removes the pending event listeners', async () => {
    const video = document.createElement('video'), abort = new AbortController()
    let removed = 0; const original = video.removeEventListener.bind(video)
    video.removeEventListener = ((...args: Parameters<typeof video.removeEventListener>) => { removed++; original(...args) }) as typeof video.removeEventListener
    const waiting = waitForMediaReady(video, abort.signal); abort.abort(); await waiting
    expect(removed).toBe(2)
  })
})
