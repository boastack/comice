/**
 * comice/core/drivers/audio.test
 * ─────────────────────────────────────────────────────────────────────────────
 * happy-dom (see /bunfig.toml preload) has no Web Audio API, so this file
 * installs a minimal fake AudioContext/AnalyserNode/MediaElementAudioSourceNode
 * on globalThis before each test — enough to drive audio.ts's actual logic
 * (band math, onset/beat/drop detection, source resolution, teardown,
 * visibility gating) deterministically, without needing a real browser.
 *
 * The fake AnalyserNode's frequency data is entirely test-controlled via
 * `fakeAnalyser.setFrequencyData(...)`, so every test drives the driver with
 * exact, known bin values rather than anything random.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { audio } from './audio.js'
import { getSharedScheduler } from '../scheduler.js'

// ─────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────

class FakeAnalyserNode {
  fftSize = 1024
  smoothingTimeConstant = 0.8
  frequencyBinCount = 512
  private data = new Uint8Array(512)

  setFrequencyData(data: number[]): void {
    for (let i = 0; i < this.data.length; i++) {
      this.data[i] = data[i] ?? 0
    }
  }

  getByteFrequencyData(target: Uint8Array): void {
    target.set(this.data.subarray(0, target.length))
  }

  connect(): void {}
  disconnect(): void {}
}

class FakeMediaElementAudioSourceNode {
  connect = mock()
  disconnect = mock()
}

class FakeAudioContext {
  state: 'running' | 'suspended' = 'running'
  sampleRate = 44100
  destination = {}
  analyser: FakeAnalyserNode | null = null

  createAnalyser(): FakeAnalyserNode {
    this.analyser = new FakeAnalyserNode()
    return this.analyser
  }

  createMediaElementSource(_el: HTMLMediaElement): FakeMediaElementAudioSourceNode {
    return new FakeMediaElementAudioSourceNode()
  }

  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
}

let lastContext: FakeAudioContext | null = null

function installFakeWebAudio(): void {
  ;(globalThis as any).AudioContext = class extends FakeAudioContext {
    constructor() {
      super()
      lastContext = this
    }
  }
}

function uninstallFakeWebAudio(): void {
  delete (globalThis as any).AudioContext
  lastContext = null
}

// audio.ts gates its scheduler entry behind createVisibilityGate(), which
// defaults to "not visible" until IntersectionObserver reports an
// intersection — and happy-dom's IntersectionObserver never fires that
// callback on its own. Every test in this file needs the target treated
// as on-screen, so IntersectionObserver is replaced with a fake that
// reports "intersecting" synchronously on observe(), close enough to real
// browser behavior for an already-visible element.
let originalIntersectionObserver: typeof IntersectionObserver
function installFakeIntersectionObserver(): void {
  originalIntersectionObserver = globalThis.IntersectionObserver
  ;(globalThis as any).IntersectionObserver = class {
    private callback: IntersectionObserverCallback
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback
    }
    observe(target: Element): void {
      this.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    }
    disconnect(): void {}
    unobserve(): void {}
  }
}
function uninstallFakeIntersectionObserver(): void {
  globalThis.IntersectionObserver = originalIntersectionObserver
}

/** Drives the scheduler's rAF loop manually, same pattern as pointer.test.ts / scheduler.test.ts. */
function installFakeRaf(): { flush(timestamp: number): void; queued: FrameRequestCallback[] } {
  const queued: FrameRequestCallback[] = []
  const original = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queued.push(cb)
    return queued.length
  }) as typeof requestAnimationFrame
  return {
    queued,
    flush(timestamp: number) {
      const callbacks = queued.splice(0, queued.length)
      callbacks.forEach((cb) => cb(timestamp))
    },
  }
}

describe('audio driver', () => {
  let target: HTMLElement
  let mediaEl: HTMLAudioElement
  let raf: ReturnType<typeof installFakeRaf>

  beforeEach(() => {
    installFakeWebAudio()
    installFakeIntersectionObserver()
    target = document.createElement('div')
    mediaEl = document.createElement('audio')
    mediaEl.id = 'track'
    target.appendChild(mediaEl)
    document.body.appendChild(target)
    raf = installFakeRaf()
  })

  afterEach(() => {
    // getSharedScheduler() is a true module-level singleton (shared with
    // index.ts too), so a driver's scheduler.add() entry from one test
    // would otherwise still be registered — and still holding a stale
    // rafId scheduled against the PREVIOUS test's fake requestAnimationFrame
    // — when the next test installs its own fake. stop() clears every
    // entry and resets rafId to null so each test starts the shared loop
    // clean.
    getSharedScheduler().stop()
    target.remove()
    uninstallFakeWebAudio()
    uninstallFakeIntersectionObserver()
  })

  it('exposes the NamedSignalDriver contract: name + attachSignals, no attach', () => {
    const driver = audio({ source: '#track' })
    expect(driver.name).toBe('audio')
    expect(typeof driver.attachSignals).toBe('function')
    expect(driver.attach).toBeUndefined()
  })

  it('reports a signal bag with bass/mid/high/energy/amplitude/spectrum', () => {
    const driver = audio({ source: '#track', bands: 4 })
    const onSignals = mock()
    driver.attachSignals!(target, onSignals)

    raf.flush(16) // first frame creates the AudioContext lazily
    expect(lastContext).not.toBeNull()
    lastContext!.analyser!.setFrequencyData(new Array(512).fill(100))
    raf.flush(32)

    expect(onSignals).toHaveBeenCalled()
    const signals = onSignals.mock.calls[onSignals.mock.calls.length - 1][0]
    expect(typeof signals.bass).toBe('number')
    expect(typeof signals.mid).toBe('number')
    expect(typeof signals.high).toBe('number')
    expect(typeof signals.energy).toBe('number')
    expect(typeof signals.amplitude).toBe('number')
    expect(Array.isArray(signals.spectrum)).toBe(true)
    expect(signals.spectrum.length).toBe(4)
  })

  it('normalises all scalar signals to 0..1', () => {
    const driver = audio({ source: '#track' })
    const onSignals = mock()
    driver.attachSignals!(target, onSignals)
    raf.flush(16)
    lastContext!.analyser!.setFrequencyData(new Array(512).fill(255)) // max
    raf.flush(32)

    const signals = onSignals.mock.calls[onSignals.mock.calls.length - 1][0]
    expect(signals.bass).toBeCloseTo(1, 1)
    expect(signals.energy).toBeCloseTo(1, 1)
    expect(signals.amplitude).toBeCloseTo(1, 1)
  })

  it('reuses the same spectrum array reference across frames (no per-frame allocation)', () => {
    const driver = audio({ source: '#track', bands: 4 })
    const onSignals = mock()
    driver.attachSignals!(target, onSignals)
    raf.flush(16)
    lastContext!.analyser!.setFrequencyData(new Array(512).fill(50))
    raf.flush(32)
    const first = onSignals.mock.calls[onSignals.mock.calls.length - 1][0].spectrum
    lastContext!.analyser!.setFrequencyData(new Array(512).fill(150))
    raf.flush(48)
    const second = onSignals.mock.calls[onSignals.mock.calls.length - 1][0].spectrum
    expect(first).toBe(second) // same array reference, mutated in place
  })

  it('resolves an implicit source: an <audio>/<video> inside the target when no `source` option is given', () => {
    const driver = audio() // no source
    const onSignals = mock()
    driver.attachSignals!(target, onSignals)
    raf.flush(16)
    expect(lastContext).not.toBeNull() // context created => a source was found
  })

  it('returns without creating a context when the selector matches nothing', () => {
    const driver = audio({ source: '#does-not-exist' })
    const onSignals = mock()
    driver.attachSignals!(target, onSignals)
    raf.flush(16)
    expect(onSignals).not.toHaveBeenCalled()
  })

  it('does not create a new AudioContext on every frame once resolved', () => {
    const driver = audio({ source: '#track' })
    const onSignals = mock()
    driver.attachSignals!(target, onSignals)
    raf.flush(16)
    const first = lastContext
    raf.flush(32)
    raf.flush(48)
    expect(lastContext).toBe(first)
  })

  it('teardown disconnects the analyser and stops the scheduler entry', () => {
    const driver = audio({ source: '#track' })
    const onSignals = mock()
    const teardown = driver.attachSignals!(target, onSignals)
    raf.flush(16)
    const analyser = lastContext!.analyser!
    const disconnectSpy = mock(analyser.disconnect.bind(analyser))
    analyser.disconnect = disconnectSpy

    teardown()

    expect(disconnectSpy).toHaveBeenCalled()
  })

  it('is silent (never throws) when Web Audio is unsupported', () => {
    uninstallFakeWebAudio() // no AudioContext at all
    const driver = audio({ source: '#track' })
    const onSignals = mock()
    expect(() => driver.attachSignals!(target, onSignals)).not.toThrow()
    expect(() => raf.flush(16)).not.toThrow()
    expect(onSignals).not.toHaveBeenCalled()
  })
})

describe('audio driver — beat/onset/drop events', () => {
  let target: HTMLElement
  let mediaEl: HTMLAudioElement
  let raf: ReturnType<typeof installFakeRaf>

  beforeEach(() => {
    installFakeWebAudio()
    installFakeIntersectionObserver()
    target = document.createElement('div')
    mediaEl = document.createElement('audio')
    mediaEl.id = 'track'
    target.appendChild(mediaEl)
    document.body.appendChild(target)
    raf = installFakeRaf()
  })

  afterEach(() => {
    getSharedScheduler().stop()
    target.remove()
    uninstallFakeWebAudio()
    uninstallFakeIntersectionObserver()
  })

  function warmUpRollingAverage(quietLevel: number, frames: number): void {
    for (let i = 0; i < frames; i++) {
      lastContext!.analyser!.setFrequencyData(new Array(512).fill(quietLevel))
      raf.flush(16 * (i + 2))
    }
  }

  it('calls onBeat when energy spikes well above the recent rolling average', () => {
    const onBeat = mock()
    const driver = audio({ source: '#track', onBeat })
    driver.attachSignals!(target, mock())
    raf.flush(16) // create context

    warmUpRollingAverage(40, 45) // quiet, steady — warms the rolling average

    lastContext!.analyser!.setFrequencyData(new Array(512).fill(220)) // sudden spike
    raf.flush(2000)

    expect(onBeat).toHaveBeenCalled()
  })

  it('also emits onset alongside every beat', () => {
    const onOnset = mock()
    const driver = audio({ source: '#track', onOnset })
    driver.attachSignals!(target, mock())
    raf.flush(16)

    warmUpRollingAverage(40, 45)
    lastContext!.analyser!.setFrequencyData(new Array(512).fill(220))
    raf.flush(2000)

    expect(onOnset).toHaveBeenCalled()
  })

  it('does not fire onBeat for a steady, unchanging signal', () => {
    const onBeat = mock()
    const driver = audio({ source: '#track', onBeat })
    driver.attachSignals!(target, mock())
    raf.flush(16)

    warmUpRollingAverage(100, 60)

    expect(onBeat).not.toHaveBeenCalled()
  })

  it('respects the beat refractory window: two spikes within it produce only one call', () => {
    const onBeat = mock()
    const driver = audio({ source: '#track', onBeat })
    driver.attachSignals!(target, mock())
    raf.flush(16)

    warmUpRollingAverage(40, 45)

    lastContext!.analyser!.setFrequencyData(new Array(512).fill(220))
    raf.flush(2000)
    raf.flush(2010) // 10ms later, well within the ~120ms refractory window

    expect(onBeat).toHaveBeenCalledTimes(1)
  })

  it('.on("beat", ...) receives the same event as the onBeat option', () => {
    const driver = audio({ source: '#track' })
    const listener = mock()
    driver.on!('beat', listener)
    driver.attachSignals!(target, mock())
    raf.flush(16)

    warmUpRollingAverage(40, 45)
    lastContext!.analyser!.setFrequencyData(new Array(512).fill(220))
    raf.flush(2000)

    expect(listener).toHaveBeenCalled()
  })

  it('on() returns an unsubscribe function', () => {
    const driver = audio({ source: '#track' })
    const listener = mock()
    const unsub = driver.on!('beat', listener)
    unsub()
    driver.attachSignals!(target, mock())
    raf.flush(16)

    warmUpRollingAverage(40, 45)
    lastContext!.analyser!.setFrequencyData(new Array(512).fill(220))
    raf.flush(2000)

    expect(listener).not.toHaveBeenCalled()
  })
})
