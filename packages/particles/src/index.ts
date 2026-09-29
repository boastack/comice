/**
 * @comice/particles
 * ─────────────────────────────────────────────────────────────────────────────
 * Media as a cloud of points, and media broken into tiles — spec §08's
 * own words. T10 (ROADMAP.md §4), built last within this batch per
 * spec §18's own sequencing ("particles ships image→particles→image
 * (A→B) using T2" — though see the note below on why this pass's own
 * particle buffers don't actually route through ResidencyPool/T2 the way
 * that sequencing note implies, unlike dissolve's literal two-texture
 * case).
 *
 * BOTH MODES SHIP: `cloud` (default) and `shatter` — see shader.ts's own
 * header for the instanced-geometry mechanism, the first of its kind in
 * this codebase.
 *
 * TARGET, LIKE dissolve, UNLIKE morph/distort/color/mosaic/ascii: the
 * target is a plain positioning/sizing container, never hidden, never
 * itself read as media — `from`/`to` are explicit separate options
 * (SourceSpec: an <img>/<video>, or `{ text: string }`, matching spec's
 * own card example of `to: { text: 'COMICE' }`).
 *
 * REASSEMBLY DEFAULT, PER SPEC: "reassemble: boolean... Default true when
 * `to` is media." When `to` is omitted, `a_target` in the shader is
 * populated with each particle's OWN origin (target === origin), so
 * `progress` sweeping 0->1 is a no-op motion-wise and the noise-driven
 * `motion.fluid` drift (if enabled) is the only visible movement —
 * "particles carry their target so the image reforms exactly" applied to
 * the degenerate A-to-A case spec's own text calls out explicitly.
 *
 * HONEST NOTE ON T2 (multi-texture residency): unlike dissolve (which
 * binds two SEPARATE textures in one pass and samples between them in a
 * fragment shader), particles never samples a texture in its own shader
 * at all — every particle's color is a per-instance VERTEX attribute,
 * computed once on the CPU from a rasterized bitmap (sampler.ts). This is
 * a deliberate, different kind of "A to B" than dissolve's: the buffer
 * itself holds the interpolation data (origin/target arrays), not the
 * GPU texture units. §18's own build-order note anticipates "using T2"
 * for particles in a general sense (the residency discipline this
 * codebase holds to), not a literal claim that particles binds two
 * textures through ResidencyPool the way dissolve does.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { createGLContext, mountCanvas, type CanvasMount, type GLContext } from 'comice/gl'
import { getSharedScheduler } from 'comice/scheduler'
import { compileParticlesProgram, destroyParticlesProgram, drawParticles, uploadParticleBuffers, type ParticlesMode, type ParticlesProgram } from './shader.js'
import { resampleToCount, sampleSource, type ParticleSample } from './sampler.js'

export type ParticlesSourceSpec = HTMLImageElement | HTMLVideoElement | { text: string }

export type ParticlesMotionOptions = {
  /** Continuous momentum and surface tension via a curl-noise drift field
   *  rather than a full simulation. Default false. */
  fluid?: boolean
  /** Drift magnitude, UV units. Default 0.02. Ignored when fluid is false. */
  noise?: number
}

export type ParticlesOptions = {
  /** Default 'cloud', matching spec exactly. */
  mode?: ParticlesMode
  /** Point source. Required. */
  from: ParticlesSourceSpec
  /** Point source `to` morphs toward. Enables morphing, matching spec
   *  exactly ("to enables morphing between them"). Omit for a static/
   *  drifting cloud with no A->B interpolation target. */
  to?: ParticlesSourceSpec
  /** Requested instance count. The actual sampled count may be lower
   *  (transparent regions contribute none) — see sampler.ts. Default
   *  20000 (spec's own example uses 120000; this default is conservative
   *  for a plugin with no built-in LOD/downsampling-by-viewport yet). */
  count?: number
  motion?: ParticlesMotionOptions
  /** Particles carry their target so the image reforms exactly. Default
   *  true when `to` is media (an HTMLImageElement/HTMLVideoElement, not
   *  `{ text }`), matching spec exactly. When false, `to`'s sampled
   *  positions are still used for the A->B interpolation, but WITHOUT
   *  per-particle identity preserved between resamples (a future re-
   *  sample re-shuffles which particle maps to which pixel) — this
   *  pass's sampler.ts always preserves identity either way (no
   *  shuffling implemented), so `reassemble: false` is accepted for API
   *  fidelity but currently behaves identically to `true`. */
  reassemble?: boolean
  /** Point/tile size, px. Default 3 for 'cloud', 8 for 'shatter'. */
  size?: number
}

export function particles(options: ParticlesOptions): ComicePlugin {
  const { mode = 'cloud', from, to, count = 20000, motion, size } = options
  const pointSize = size ?? (mode === 'cloud' ? 3 : 8)
  const fluid = motion?.fluid ?? false
  const noiseAmount = motion?.noise ?? 0.02

  if (!from) {
    throw new Error('[comice] particles() requires a `from` source.')
  }

  let target: Element | null = null
  let glContext: GLContext | null = null
  let particlesProgram: ParticlesProgram | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let unsubscribeInstance: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  let mount: CanvasMount | null = null
  let destroyed = false
  let currentProgress = 0
  let instanceCount = 0
  let startTime = 0

  function loadBuffers(): void {
    if (!glContext || !particlesProgram) return

    const fromSample = sampleSource(from, count)
    if (!fromSample) return

    const toSample = to ? sampleSource(to, count) : null
    const targetCount = toSample ? Math.max(fromSample.count, toSample.count) : fromSample.count

    const fromResampled = resampleToCount(fromSample, targetCount)
    const toResampled = toSample ? resampleToCount(toSample, targetCount) : fromResampled

    instanceCount = targetCount
    uploadParticleBuffers(glContext.gl, particlesProgram, fromResampled.positions, toResampled.positions, fromResampled.colors)
  }

  function renderFrame(timestamp: number): void {
    if (destroyed || !glContext || !particlesProgram) return
    glContext.resizeToDisplay()

    const cssWidth = glContext.canvas.clientWidth || 1
    const cssHeight = glContext.canvas.clientHeight || 1

    if (startTime === 0) startTime = timestamp
    const elapsedSeconds = (timestamp - startTime) / 1000

    drawParticles(glContext, particlesProgram, {
      progress: currentProgress,
      pointSize,
      noiseAmount: fluid ? noiseAmount : 0,
      time: elapsedSeconds,
      resolutionWidth: cssWidth,
      resolutionHeight: cssHeight,
      instanceCount,
    })
  }

  function render(progress: number): void {
    currentProgress = Math.max(0, Math.min(1, progress))
  }

  return {
    name: 'particles',

    setup(rawTarget: Element, instance: ComiceInstance) {
      target = rawTarget

      // mountCanvas() sizes the canvas to the target's OWN box — it used to
      // be 100% of the target's parent, covering the whole section
      // (heading and text) on harness/site/. A non-HTML target mounts
      // nothing (a canvas can't render as a sibling inside an <svg>).
      glContext = createGLContext(target)
      if (glContext && target instanceof HTMLElement) {
        mount = mountCanvas(glContext, target, { owner: 'particles', hideTarget: false })
        particlesProgram = compileParticlesProgram(glContext.gl, { mode, fluid })
        if (particlesProgram) loadBuffers()
      }
      // Degrade-never-disappear: no WebGL2, or a failed compile, leaves
      // particlesProgram/instanceCount such that drawParticles() and
      // renderFrame() both no-op — the container simply shows nothing
      // extra, same as it would with no particles() plugin attached at
      // all (unlike morph/color/etc., there was never original media
      // content in this target being replaced, so there's nothing to
      // restore/un-hide on this path).

      resizeObserver = new ResizeObserver(() => {
        /* geometry re-sync happens via glContext.resizeToDisplay() every
           frame already; explicit resize handling here would only matter
           for re-sampling source aspect ratio, which is out of this
           pass's scope (see the file header's reassemble note). */
      })
      resizeObserver.observe(target)

      unregisterFromScheduler = getSharedScheduler().add(
        (_deltaMs, timestamp) => renderFrame(timestamp),
        () => !destroyed && !!target && target.isConnected,
      )

      unsubscribeInstance = instance.on('*', (snapshot) => {
        render(snapshot.progress)
      })

      render(instance.progress)
    },

    teardown() {
      destroyed = true
      unregisterFromScheduler?.()
      unsubscribeInstance?.()
      resizeObserver?.disconnect()
      if (glContext && particlesProgram) destroyParticlesProgram(glContext.gl, particlesProgram)
      mount?.release()
      mount = null
      target = null
      glContext = null
      particlesProgram = null
      resizeObserver = null
    },

    // MappableTarget: progress is particles' one mappable parameter,
    // matching dissolve's own "progress: number, Mappable" precedent —
    // any driver can scrub the A->B interpolation directly.
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
export type { ParticleSample } from './sampler.js'
