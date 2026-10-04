/**
 * comice/core/drivers/audio
 * ─────────────────────────────────────────────────────────────────────────────
 * "Comice doesn't make audio visual. It makes audio an interaction input."
 *
 * A NamedSignalDriver (see types.ts) rather than a plain Driver — audio has
 * no single honest "progress" number the way scroll or a drag does, so this
 * driver only implements `attachSignals`, not `attach`. It reports a bag of
 * normalised values every shared-scheduler tick:
 *
 *   { bass, mid, high, energy, amplitude, spectrum }
 *
 * plus discrete 'beat' / 'onset' / 'drop' events via `.on()`.
 *
 * DELIBERATELY NOT PART OF core's main bundle: this file has its own
 * package.json export (`comice/drivers/audio`) and is never imported by
 * drivers/index.ts or index.ts, so a page that never imports it never pays
 * for Web Audio API boilerplate or the AnalyserNode setup. It imports
 * scheduler.ts (for the shared rAF loop and visibility gating) but nothing
 * scheduler.ts exports pulls in index.ts or any plugin, so this stays a
 * one-directional dependency and audio.ts remains tree-shakeable on its
 * own. See tsup.config.ts.
 *
 * WHAT THIS FILE DOES NOT DO, per the brief:
 *  - play audio (it never calls .play()/.pause() on the source)
 *  - create UI controls
 *  - render anything
 *  - own plugin-specific effects (no distortion/color/particle logic here —
 *    that lives in whichever plugin a `.map()` call points signals at)
 */

import { createVisibilityGate, getSharedScheduler } from '../scheduler.js'
import type { NamedSignalDriver, SignalValues } from '../types.js'

// audio.ts is a standalone bundle entry (see the file header) and does not
// import index.ts or machine.ts, so it keeps its own copy of the __DEV__
// guard rather than sharing one — same pattern, independently declared.
declare const process: { env: { NODE_ENV?: string } } | undefined
const __DEV__ = typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

export type AudioSource = string | HTMLMediaElement | AudioNode

export type AudioOptions = {
  /** A CSS selector resolving to an <audio>/<video> element, an element
   *  reference, or an existing AudioNode/AudioBufferSourceNode. */
  source?: AudioSource
  /** Number of frequency bands exposed via `spectrum`. Default 8. */
  bands?: number
  /** FFT size for the underlying AnalyserNode. Must be a power of 2.
   *  Larger gives finer frequency resolution at higher cost. Default 1024. */
  fftSize?: number
  /** Exponential smoothing the AnalyserNode itself applies, 0..1, before
   *  this driver reads frequency data. Default 0.8 (AnalyserNode default). */
  smoothing?: number
  /** Called on a detected beat/onset (see the onset-detection note below). */
  onBeat?: () => void
  /** Called on a detected onset. Distinct callback from onBeat so a caller
   *  that wants only strong beats, not every onset, can ignore this. */
  onOnset?: () => void
  /** Called on a detected "drop" — a sustained, large jump in overall
   *  energy relative to the recent rolling average (see below). */
  onDrop?: () => void
}

/**
 * Resolves an AudioSource into a Web Audio graph:
 *
 *   MediaElementAudioSourceNode | (caller-supplied AudioNode)
 *        -> AnalyserNode (created here, never connected onward)
 *
 * Connecting the analyser onward to context.destination would double-route
 * or silence audio depending on the source, so this driver only ever taps
 * a side branch: `sourceNode.connect(analyser)`. It does not connect
 * `analyser` to anything. For a fresh HTMLMediaElement, the element's own
 * normal output path (its own <audio>/<video> playback) is untouched —
 * `createMediaElementSource` is the one call that reroutes an element's
 * audio through the Web Audio graph, so this driver connects that same
 * source node BACK to `context.destination` as well, to preserve playback
 * the element already had before this driver ever touched it.
 */
function resolveSourceNode(
  source: AudioSource | undefined,
  target: Element,
  context: AudioContext,
): AudioNode | null {
  let resolved: AudioSource | undefined = source

  if (typeof resolved === 'string') {
    const found = document.querySelector(resolved)
    if (!found) return null
    resolved = found as HTMLMediaElement
  }

  if (!resolved) {
    // No explicit source: fall back to a <audio>/<video> element inside
    // the target Comice was attached to, if there is one — matches
    // `comice('.particles').use(particles()).driver(audio())` from the
    // brief, where no `source` option is given at all.
    const implicit = target.querySelector('audio, video') as HTMLMediaElement | null
    if (!implicit) return null
    resolved = implicit
  }

  if (resolved instanceof HTMLMediaElement) {
    // A given element may already have been wrapped by a prior audio()
    // call (e.g. two Comice instances sharing one <audio>) — Web Audio
    // throws if you call createMediaElementSource twice on the same
    // element, so the node is cached on the element itself.
    const cached = (resolved as HTMLMediaElement & { __comiceSourceNode?: MediaElementAudioSourceNode })
      .__comiceSourceNode
    if (cached) return cached
    const node = context.createMediaElementSource(resolved)
    node.connect(context.destination)
    ;(resolved as HTMLMediaElement & { __comiceSourceNode?: MediaElementAudioSourceNode }).__comiceSourceNode = node
    return node
  }

  // Already an AudioNode (including AudioBufferSourceNode) — the caller
  // owns its connection to destination, if any; this driver only taps it.
  return resolved as AudioNode
}

/**
 * Splits an analyser's frequency bins into `bass`/`mid`/`high` (the fixed
 * three-band summary) plus an N-band `spectrum` for finer-grained mapping.
 * Band boundaries are frequency-proportional (not linear bin index), so
 * `bass` covers roughly 20-250Hz regardless of fftSize/sampleRate.
 */
function bandEdges(bandCount: number, sampleRate: number, fftSize: number): number[] {
  const nyquist = sampleRate / 2
  const minFreq = 20
  const maxFreq = Math.min(nyquist, 16000)
  const edges: number[] = []
  for (let i = 0; i <= bandCount; i++) {
    // Log-spaced edges: perceptually, frequency bands are logarithmic —
    // linear spacing would put almost the whole audible range in one bin.
    const t = i / bandCount
    const freq = minFreq * Math.pow(maxFreq / minFreq, t)
    edges.push(Math.min(fftSize / 2, Math.round((freq / nyquist) * (fftSize / 2))))
  }
  return edges
}

/**
 * One AudioContext for every audio() driver on the page. Each attachment
 * used to make its own, but a media element can be wrapped in a source
 * node only once, and that node is tied to the context that made it: the
 * second element of `comice('.cards').driver(audio({ source: '#track' }))`
 * connected it to an analyser from ANOTHER context, which throws, so every
 * element after the first got no signals (silently — the shared loop
 * isolates the throw). Browsers also cap how many contexts a page may hold.
 */
let sharedContext: AudioContext | null = null
function getSharedAudioContext(): AudioContext | null {
  if (sharedContext) return sharedContext
  const AudioContextCtor = (window as any).AudioContext ?? (window as any).webkitAudioContext
  if (!AudioContextCtor) return null // Web Audio unsupported; driver goes silent, never throws
  sharedContext = new AudioContextCtor() as AudioContext
  return sharedContext
}

/** Test seam: forget the shared context. */
export function resetSharedAudioContext(): void {
  sharedContext = null
}

export function audio(options: AudioOptions = {}): NamedSignalDriver {
  const {
    source,
    bands = 8,
    fftSize = 1024,
    smoothing = 0.8,
    onBeat,
    onOnset,
    onDrop,
  } = options

  const listeners = new Map<string, Set<(payload?: unknown) => void>>()
  // One driver attached to many elements (a group handle) hears the same
  // audio N times: beat/onset/drop come from the first live attachment
  // only, or onBeat would run N times a beat.
  const attachments = new Set<object>()

  // Every .on() listener is notified in isolation, same discipline as
  // machine.ts's emit(). This driver's detectOnsets() calls emit()
  // immediately before calling the matching onBeat/onOnset/onDrop
  // constructor callback on the same line (see below) — without
  // isolation here, one bad .on('beat', ...) listener would also take
  // down the onBeat() callback that was about to run right after it.
  function emit(event: string, payload?: unknown): void {
    listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload)
      } catch (err) {
        if (__DEV__) console.warn(`[comice] An audio driver "${event}" listener threw.`, err)
      }
    })
  }

  return {
    name: 'audio',

    // No `attach` — audio has no single honest progress number (see the
    // file header). Plugins that want a discrete "is playing" signal
    // should map `energy` or listen for 'beat' instead.

    attachSignals(target, onSignals) {
      const token = {}
      attachments.add(token)
      const leads = () => attachments.values().next().value === token
      let context: AudioContext | null = null
      let analyser: AnalyserNode | null = null
      let sourceNode: AudioNode | null = null
      let unregister: (() => void) | null = null

      // Reused every frame — the brief's "avoid allocations inside the
      // render loop, reuse typed arrays for FFT data" requirement.
      // Typed `Uint8Array<ArrayBuffer>` (not the default ArrayBufferLike)
      // because AnalyserNode.getByteFrequencyData's DOM types require
      // exactly that specialisation.
      let freqData: Uint8Array<ArrayBuffer> | null = null
      let edges: number[] = []
      const signals: SignalValues = {
        bass: 0,
        mid: 0,
        high: 0,
        energy: 0,
        amplitude: 0,
        spectrum: new Array(bands).fill(0),
      }

      // Onset/beat detection: a lightweight rolling-average energy
      // comparison, not FFT-based tempo tracking. This is the standard
      // "spectral flux vs. local average" cheap approach: keep a short
      // rolling average of `energy`; when the instantaneous value exceeds
      // that average by a threshold factor, and we are past a refractory
      // window (so one transient doesn't fire ten events), call it a beat.
      // A larger, sustained excess over a longer window is treated as a
      // 'drop'. This is intentionally simple — real beat tracking (tempo,
      // downbeats) is a much larger problem than "lightweight, real-time,
      // browser-suitable" calls for here.
      const ROLLING_WINDOW = 43 // ~0.7s at 60fps
      const rollingEnergy: number[] = []
      let rollingSum = 0
      let lastBeatAt = 0
      let lastDropAt = 0
      const BEAT_REFRACTORY_MS = 120
      const DROP_REFRACTORY_MS = 2000
      const BEAT_THRESHOLD = 1.35
      const DROP_THRESHOLD = 1.8
      const DROP_MIN_ENERGY = 0.35

      function detectOnsets(energy: number, timestamp: number): void {
        const average = rollingEnergy.length > 0 ? rollingSum / rollingEnergy.length : energy

        if (rollingEnergy.length >= ROLLING_WINDOW) {
          rollingSum -= rollingEnergy.shift()!
        }
        rollingEnergy.push(energy)
        rollingSum += energy

        if (average <= 0 || !leads()) return // not warmed up yet, or another attachment reports

        const ratio = energy / average

        if (ratio >= BEAT_THRESHOLD && timestamp - lastBeatAt >= BEAT_REFRACTORY_MS) {
          lastBeatAt = timestamp
          emit('onset')
          onOnset?.()
          emit('beat')
          onBeat?.()
        }

        if (
          ratio >= DROP_THRESHOLD &&
          energy >= DROP_MIN_ENERGY &&
          timestamp - lastDropAt >= DROP_REFRACTORY_MS
        ) {
          lastDropAt = timestamp
          emit('drop')
          onDrop?.()
        }
      }

      function ensureContext(): boolean {
        if (context) return true
        const newContext = getSharedAudioContext()
        if (!newContext) return false
        const newSourceNode = resolveSourceNode(source, target, newContext)
        if (!newSourceNode) return false

        const newAnalyser = newContext.createAnalyser()
        newAnalyser.fftSize = fftSize
        newAnalyser.smoothingTimeConstant = smoothing
        newSourceNode.connect(newAnalyser)

        context = newContext
        sourceNode = newSourceNode
        analyser = newAnalyser
        freqData = new Uint8Array(newAnalyser.frequencyBinCount)
        edges = bandEdges(bands, newContext.sampleRate, fftSize)
        return true
      }

      function averageBin(from: number, to: number): number {
        const data = freqData
        if (!data) return 0
        const start = Math.max(0, from)
        const end = Math.max(start + 1, Math.min(data.length, to))
        let sum = 0
        for (let i = start; i < end; i++) sum += data[i]
        return sum / (end - start) / 255
      }

      function tick(timestamp: number): void {
        if (!analyser || !freqData) return
        analyser.getByteFrequencyData(freqData)

        // spectrum: N log-spaced bands, reusing the same array reference
        // every frame (spectrum values are overwritten in place, not
        // reallocated) — the caller must treat it as read-only per frame.
        const spectrum = signals.spectrum as number[]
        for (let i = 0; i < bands; i++) {
          spectrum[i] = averageBin(edges[i], edges[i + 1])
        }

        // bass/mid/high: fixed three-band summary over the same log
        // spacing, independent of `bands`, since these three names are
        // part of the driver's stable public contract regardless of how
        // finely `spectrum` is sliced.
        const fixedEdges = bandEdges(3, context!.sampleRate, fftSize)
        signals.bass = averageBin(fixedEdges[0], fixedEdges[1])
        signals.mid = averageBin(fixedEdges[1], fixedEdges[2])
        signals.high = averageBin(fixedEdges[2], fixedEdges[3])

        // energy: overall loudness this frame, mean of all bins.
        signals.energy = averageBin(0, freqData.length)

        // amplitude: peak bin this frame, normalised — distinct from
        // energy (mean) so a single sharp transient still registers even
        // when the overall mix is quiet.
        let peak = 0
        for (let i = 0; i < freqData.length; i++) {
          if (freqData[i] > peak) peak = freqData[i]
        }
        signals.amplitude = peak / 255

        detectOnsets(signals.energy, timestamp)
        onSignals(signals)
      }

      // Visibility gating: audio analysis pauses when the target is
      // off-screen, per "Pause analysis when the target is not visible
      // where possible" — reuses the same gate every other driver's
      // scheduler entry is gated by, rather than a second
      // IntersectionObserver of its own.
      const visibility = createVisibilityGate(target)

      // "Do not create a separate animation loop if Comice already has a
      // shared RAF" — registers against the one scheduler every Comice
      // entry point shares (see scheduler.ts's getSharedScheduler), rather
      // than this driver running its own requestAnimationFrame loop.
      const unregisterFromScheduler = getSharedScheduler().add(
        (_deltaMs, timestamp) => {
          // AudioContext typically requires a user gesture before it can
          // start, and .driver(audio()) frequently runs before any
          // interaction has happened — so the context is created lazily,
          // on the first tick the scheduler actually grants this entry,
          // rather than at attach time.
          if (!ensureContext()) return
          if (context!.state === 'suspended') {
            context!.resume().catch(() => {})
          }
          tick(timestamp)
        },
        () => visibility.isVisible(),
      )

      unregister = () => {
        unregisterFromScheduler()
        visibility.destroy()
        analyser?.disconnect()
        attachments.delete(token)
        // .on() listeners belong to the driver: kept while any element
        // still uses it.
        if (attachments.size === 0) listeners.clear()
      }

      return () => {
        unregister?.()
      }
    },

    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
      return () => {
        listeners.get(event)?.delete(listener)
      }
    },
  }
}
