/**
 * @comice/particles
 * ─────────────────────────────────────────────────────────────────────────────
 * Media as a cloud of points, and media broken into tiles — spec §08.
 *
 *   comice('#stage').use(particles({
 *     mode: 'cloud', from: { image: '/founder.jpg' }, to: { text: 'COMICE' },
 *     count: 120000, motion: { noise: 0.3 },
 *   })).driver(scroll())
 *
 * TARGET, LIKE dissolve: a positioning/sizing container (the stage), never
 * hidden, never read as media. `from`/`to` are sources: an <img>/<video>,
 * `{ image }` / `{ video }` (an element or a URL), or `{ text }`.
 *
 * THE ROUND TRIP: progress 0 is `from`, exactly; 1 is `to` (or `from`
 * again, without one), exactly; in between, the instances fly — scatter,
 * drift, spin (shader.ts). Each source is rasterized at the stage's aspect
 * and sampled to about `count` instances (sampler.ts); both are redone
 * when the stage changes shape.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { prefersReducedMotion, snapForReducedMotion } from 'comice'
import { createGLContext, createGLReporter, mountCanvas, type CanvasMount, type GLContext, type GLReporter } from 'comice/gl'
import { createVisibilityGate, getSharedScheduler } from 'comice/scheduler'
import { canvasSizeFor, rasterizeSource, resampleToCount, sampleGrid, type TextSource } from './sampler.js'
import { compileParticlesProgram, createSourceTexture, destroyParticlesProgram, drawParticles, uploadParticleBuffers, uploadSourceTexture, type ParticlesMode, type ParticlesProgram } from './shader.js'

type Media = HTMLImageElement | HTMLVideoElement

export type ParticlesSourceSpec = Media | { image: string | HTMLImageElement } | { video: string | HTMLVideoElement } | TextSource

export type ParticlesMotionOptions = {
  /** Continuous momentum and surface tension: the instances drift along a
   *  curl-noise field while in flight. Turns on a gentle drift (noise 0.2)
   *  when `noise` isn't given. */
  fluid?: boolean
  /** How strongly instances drift in flight, 0..1. Default 0 (0.2 with
   *  `fluid`). */
  noise?: number
}

export type ParticlesOptions = {
  /** Default 'cloud'. */
  mode?: ParticlesMode
  /** Where the instances start. Required. */
  from: ParticlesSourceSpec
  /** Where they go: morphing between two sources. Without it they break
   *  apart and come back to `from`. */
  to?: ParticlesSourceSpec
  /** About how many points (cloud) or tiles (shatter). Transparent areas
   *  get none. Default 20000 for cloud, 100 for shatter. */
  count?: number
  motion?: ParticlesMotionOptions
  /** Each instance carries its own destination, so the picture reforms
   *  exactly, every instance back in its place. `false` sends instances to
   *  the destination in shuffled order: it still forms, but out of a swirl.
   *  Default true, except when `to` is text. */
  reassemble?: boolean
  /** How far instances fly apart mid-flight, as a fraction of the stage.
   *  Default 0.12 for cloud, 0.3 for shatter. */
  scatter?: number
  /** Point size for cloud, CSS px. Default: one grid cell, so the picture
   *  is solid at rest. */
  size?: number
}

function ignore(): void {}

function isMedia(value: unknown): value is Media {
  return value instanceof HTMLImageElement || value instanceof HTMLVideoElement
}

/** The element (or text) a source spec stands for; a URL becomes a fresh
 *  element. */
function resolveSource(spec: ParticlesSourceSpec): Media | TextSource {
  if (isMedia(spec) || 'text' in spec) return spec
  if ('image' in spec) {
    if (typeof spec.image !== 'string') return spec.image
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = spec.image
    return image
  }
  if (typeof spec.video !== 'string') return spec.video
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.loop = true
  video.playsInline = true
  video.autoplay = true
  video.src = spec.video
  // Autoplay may be refused (no user gesture yet); the first frame still
  // loads, and `muted` makes a later play() allowed.
  void video.play?.()?.catch?.(ignore)
  return video
}

/** Resolves once `source` can be drawn; rejects if it fails to load. */
function whenReady(source: Media | TextSource): Promise<void> {
  // Text waits for web fonts, or it would rasterize in the fallback font.
  if (!isMedia(source)) return (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(ignore) ?? Promise.resolve()
  const ready = source instanceof HTMLVideoElement ? source.readyState >= 2 : source.complete && source.naturalWidth > 0
  if (ready) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = source instanceof HTMLVideoElement ? 'loadeddata' : 'load'
    source.addEventListener(done, () => resolve(), { once: true })
    source.addEventListener('error', () => reject(new Error(`[comice] particles(): couldn't load ${(source as Media).currentSrc || (source as Media).src || 'a source'}.`)), { once: true })
  })
}

/** A seeded shuffle (the same every time), for `reassemble: false`. */
function shuffled(positions: Float32Array): Float32Array {
  const out = new Float32Array(positions)
  let seed = 1
  for (let i = out.length / 2 - 1; i > 0; i--) {
    seed = (seed * 16807) % 2147483647
    const j = seed % (i + 1)
    ;[out[i * 2], out[j * 2]] = [out[j * 2]!, out[i * 2]!]
    ;[out[i * 2 + 1], out[j * 2 + 1]] = [out[j * 2 + 1]!, out[i * 2 + 1]!]
  }
  return out
}

export function particles(options: ParticlesOptions): ComicePlugin {
  const { mode = 'cloud', from, to, motion } = options
  if (!from) {
    throw new Error('[comice] particles() requires a `from` source.')
  }
  const count = options.count ?? (mode === 'cloud' ? 20000 : 100)
  const scatter = options.scatter ?? (mode === 'cloud' ? 0.12 : 0.3)
  const noise = motion?.noise ?? (motion?.fluid ? 0.2 : 0)
  const reassemble = options.reassemble ?? !(to && 'text' in to)

  let target: Element | null = null
  let instance: ComiceInstance | null = null
  let glContext: GLContext | null = null
  let reporter: GLReporter | null = null
  let program: ParticlesProgram | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let visibility: ReturnType<typeof createVisibilityGate> | null = null
  let unsubscribeInstance: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  let mount: CanvasMount | null = null
  let destroyed = false
  let currentProgress = 0
  let startTime: number | null = null

  let sources: { from: Media | TextSource; to: Media | TextSource } | null = null
  let loaded = false
  const canvases = { from: document.createElement('canvas'), to: document.createElement('canvas') }
  let textures: { from: WebGLTexture; to: WebGLTexture } | null = null
  let built: { width: number; height: number; count: number; cell: [number, number]; columns: number } | null = null

  function stageSize(): { width: number; height: number } {
    const el = target as HTMLElement
    return { width: el.clientWidth || glContext?.canvas.clientWidth || 1, height: el.clientHeight || glContext?.canvas.clientHeight || 1 }
  }

  /** Rasterizes both sources at the stage's shape, samples them, and
   *  uploads instances and textures. */
  function build(): void {
    if (!glContext || !program || !sources || !textures || !target) return
    const { width, height } = stageSize()
    const size = canvasSizeFor(width, height)
    const style = getComputedStyle(target)
    const fontStyle = { fontFamily: style.fontFamily || 'sans-serif', fontWeight: style.fontWeight || '700', color: style.color || '#fff' }
    for (const key of ['from', 'to'] as const) {
      canvases[key].width = size.width
      canvases[key].height = size.height
    }
    // Whatever happens below, this stage size has been tried: a failure
    // draws nothing rather than retrying every frame.
    built = { width, height, count: 0, cell: [1, 1], columns: 1 }
    const hasTo = sources.to !== sources.from
    if (!rasterizeSource(canvases.from, sources.from, fontStyle)) return
    if (hasTo && !rasterizeSource(canvases.to, sources.to, fontStyle)) return

    try {
      const fromSample = sampleGrid(canvases.from, count)
      const toSample = hasTo ? sampleGrid(canvases.to, count) : fromSample
      if (!fromSample || !toSample) return
      const total = Math.max(fromSample.count, toSample.count)
      const origins = resampleToCount(fromSample, total).positions
      const targets = resampleToCount(toSample, total).positions
      uploadParticleBuffers(glContext.gl, program, origins, reassemble ? targets : shuffled(targets))
      uploadSourceTexture(glContext.gl, textures.from, canvases.from)
      uploadSourceTexture(glContext.gl, textures.to, hasTo ? canvases.to : canvases.from)
      built = { width, height, count: total, cell: [1 / fromSample.columns, 1 / fromSample.rows], columns: fromSample.columns }
    } catch (err) {
      // A cross-origin source served without CORS headers taints the
      // canvas: reading it back throws. Say so instead of showing nothing.
      instance?.fail('particles', new Error(`[comice] particles(): a source can't be read (${(err as Error).message}). Cross-origin media needs CORS headers.`))
    }
  }

  /** A playing video's latest frame, into its texture. */
  function refreshVideo(key: 'from' | 'to'): void {
    const source = sources![key]
    if (!(source instanceof HTMLVideoElement) || source.paused || source.readyState < 2) return
    if (key === 'to' && source === sources!.from) return
    rasterizeSource(canvases[key], source, { fontFamily: '', fontWeight: '', color: '' })
    uploadSourceTexture(glContext!.gl, textures![key], canvases[key])
  }

  function renderFrame(timestamp: number): void {
    if (destroyed || !glContext || !program || !textures) return
    glContext.resizeToDisplay()
    if (loaded) {
      const { width, height } = stageSize()
      if (!built || built.width !== width || built.height !== height) build()
    }
    if (built?.count) {
      refreshVideo('from')
      refreshVideo('to')
    }
    startTime ??= timestamp
    const cssWidth = glContext.canvas.clientWidth || 1
    const cssHeight = glContext.canvas.clientHeight || 1
    const dpr = glContext.canvas.width / cssWidth || 1
    const cellPx = built ? built.width / built.columns : 1
    drawParticles(glContext, program, {
      progress: currentProgress,
      pointSize: (options.size ?? Math.max(1, cellPx * 1.05)) * dpr,
      // The drift moves on its own clock: off under reduced motion.
      noiseAmount: prefersReducedMotion() ? 0 : noise * 0.1,
      scatter,
      time: (timestamp - startTime) / 1000,
      cell: built?.cell ?? [1, 1],
      resolutionWidth: cssWidth,
      resolutionHeight: cssHeight,
      instanceCount: built?.count ?? 0,
      from: textures.from,
      to: textures.to,
    })
    if (built?.count) reporter?.afterDraw()
  }

  function render(progress: number): void {
    // Reduced motion: jump to whichever end state is closer, never animate between.
    currentProgress = Math.max(0, Math.min(1, snapForReducedMotion(progress)))
  }

  return {
    name: 'particles',
    // A fresh, identically configured copy, for comice('.many') giving every
    // matched element its own instance (see core's ComicePlugin.create).
    create: () => particles(options),

    setup(rawTarget: Element, inst: ComiceInstance) {
      target = rawTarget
      instance = inst

      // mountCanvas() sizes the canvas to the target's own box. No WebGL2,
      // or a non-HTML target, mounts nothing: the stage stays as it was.
      glContext = createGLContext(target)
      reporter = createGLReporter(inst, 'particles')
      if (!glContext) reporter.noContext()
      if (glContext && target instanceof HTMLElement) {
        mount = mountCanvas(glContext, target, { owner: 'particles', hideTarget: false })
        program = compileParticlesProgram(glContext.gl, mode)
        if (!program) reporter.noProgram()
      }

      if (glContext && program) {
        textures = { from: createSourceTexture(glContext.gl)!, to: createSourceTexture(glContext.gl)! }
        const resolvedFrom = resolveSource(from)
        sources = { from: resolvedFrom, to: to ? resolveSource(to) : resolvedFrom }
        Promise.all([whenReady(sources.from), whenReady(sources.to)]).then(
          () => {
            loaded = true
          },
          (err: Error) => {
            if (!destroyed) inst.fail('particles', err)
          },
        )
      }

      // A stage that changes shape is resampled on the next frame.
      resizeObserver = new ResizeObserver(() => {
        built = built && { ...built, width: -1 }
      })
      resizeObserver.observe(target)

      // Render only when visible (spec §13): off-screen, in a hidden tab, or
      // at the frame budget's static poster, this does zero work.
      visibility = createVisibilityGate(target)
      unregisterFromScheduler = getSharedScheduler().add(
        (_deltaMs, timestamp) => renderFrame(timestamp),
        () => !destroyed && !!target && target.isConnected && visibility!.shouldDraw(),
      )

      unsubscribeInstance = inst.on('*', (snapshot) => {
        render(snapshot.progress)
      })
      render(inst.progress)
    },

    teardown() {
      destroyed = true
      unregisterFromScheduler?.()
      visibility?.destroy()
      visibility = null
      unsubscribeInstance?.()
      resizeObserver?.disconnect()
      if (glContext && program) destroyParticlesProgram(glContext.gl, program)
      if (glContext && textures) {
        glContext.gl.deleteTexture(textures.from)
        glContext.gl.deleteTexture(textures.to)
      }
      // A video this plugin created from a URL stops with it.
      for (const [spec, source] of [
        [from, sources?.from],
        [to, sources?.to],
      ] as const) {
        if (spec && 'video' in spec && typeof spec.video === 'string' && source instanceof HTMLVideoElement) {
          source.pause()
          source.removeAttribute('src')
        }
      }
      mount?.release()
      mount = null
      target = null
      instance = null
      glContext = null
      program = null
      textures = null
      sources = null
      built = null
      resizeObserver = null
    },

    // MappableTarget: progress is particles' one mappable parameter — any
    // driver can scrub the round trip directly.
    params: {
      getParam(name: string): number {
        if (name === 'progress') return currentProgress
        return 0
      },
      setParam(name: string, value: number): void {
        if (name !== 'progress') return
        render(value)
      },
    },
  }
}

export type { ParticlesMode } from './shader.js'
export type { ParticleSample, TextSource } from './sampler.js'
