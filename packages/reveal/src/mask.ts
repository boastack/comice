/**
 * @comice/reveal/mask
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec §08's reveal `mask` effect: "A shape, text, the cursor, an image, a
 * video, a subject or depth, see section 07." The first real consumer of
 * core's mask field (gl/mask.ts), which existed but was never wired in.
 *
 * Reveal's other effects are CSS on any element; this one draws the media
 * itself on the GPU, through the mask, so it needs an <img> or <video>
 * target. As progress goes 0 -> 1:
 *
 *  - shape / text / image / video: the media appears through the mask
 *    first (an image mask: its brightest areas first), then fills in — at
 *    1 everything is revealed. Media entering through a shape.
 *  - cursor: the media shows only inside a soft circle following the
 *    pointer, fading in with progress (the pointer() driver supplies both).
 *
 * 'subject' and 'depth' need @comice/vision, which isn't built yet; they
 * throw at construction rather than quietly revealing nothing.
 *
 * Degrade, never disappear: no WebGL2, a shader that won't compile, or a
 * mask/media upload that fails all hand the element back (the media shows
 * unmasked) and report `error`. An absent mask field reveals nothing by
 * core's design — so reveal never leaves the media hidden behind one.
 */

import type { ComiceInstance } from 'comice'
import {
  bindMaskUniforms,
  createCursorMask,
  createDerivedMask,
  createGLContext,
  createGLReporter,
  createPlane,
  createRasterizedMask,
  getResidencyPool,
  MASK_SAMPLE_GLSL,
  mountCanvas,
  type CanvasMount,
  type CursorMask,
  type DerivedMask,
  type GLContext,
  type GLReporter,
  type Plane,
  type RasterizedMask,
} from 'comice/gl'
import { createVisibilityGate, getSharedScheduler } from 'comice/scheduler'

type Media = HTMLImageElement | HTMLVideoElement

export type RevealMaskSource =
  /** A soft circle following the pointer. `radius` in px (default 160),
   *  `softness` 0..1 of the radius (default 0.4). Drive with pointer(). */
  | { type: 'cursor'; radius?: number; softness?: number }
  /** An SVG path, fitted to the media (by its own bounds, or `viewBox`). */
  | { type: 'shape'; path: string | Path2D; viewBox?: readonly [number, number, number, number] }
  | { type: 'text'; text: string; font?: string }
  /** Another image or video (spec: "sampled by luminance or alpha"). An
   *  image with any transparency is read by alpha — its silhouette — and
   *  an opaque one or a video by luminance, brightest first. */
  | Media
  /** The same, choosing the channel. */
  | { source: Media; channel: 'luminance' | 'alpha' }
  /** Need @comice/vision (not built yet) — throw. */
  | 'subject'
  | 'depth'

/** Throws for a mask reveal can't use, at construction. */
export function validateMaskSource(mask: RevealMaskSource | undefined): void {
  if (mask === undefined) {
    throw new Error("[comice] reveal(): effect 'mask' needs a `mask` — a cursor, a shape, text, an image or a video.")
  }
  if (mask === 'subject' || mask === 'depth') {
    throw new Error(`[comice] reveal(): a '${mask}' mask needs @comice/vision, which isn't built yet.`)
  }
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

// Cursor masks sample in aspect-corrected space so the circle stays round
// on a wide image; texture masks sample at plain uv (they're the media's
// own size). The threshold sweep runs from just above the brightest mask
// value at 0 to just below the darkest at 1, with a soft edge.
export const REVEAL_MASK_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_media;
uniform float u_progress;
uniform float u_aspect;
${MASK_SAMPLE_GLSL}
void main() {
  vec4 color = texture(u_media, v_uv);
  float alpha;
  if (u_maskKind == 1) {
    alpha = sampleMask(vec2(v_uv.x * u_aspect, v_uv.y)) * u_progress;
  } else {
    float edge = 0.08;
    float threshold = mix(1.0 + edge, -edge, u_progress);
    alpha = smoothstep(threshold - edge, threshold + edge, sampleMask(v_uv));
  }
  outColor = color * alpha;
}`

type Program = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  locations: Record<string, WebGLUniformLocation | null>
}

function compile(gl: WebGL2RenderingContext): Program | null {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, source)
    gl.compileShader(s)
    if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s
    gl.deleteShader(s)
    return null
  }
  const vs = shader(gl.VERTEX_SHADER, VERTEX_SHADER)
  const fs = shader(gl.FRAGMENT_SHADER, REVEAL_MASK_FRAGMENT_SHADER)
  const program = vs && fs ? gl.createProgram() : null
  if (!program) return null
  gl.attachShader(program, vs!)
  gl.attachShader(program, fs!)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }

  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  // prettier-ignore
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]), gl.STATIC_DRAW)
  const stride = 4 * Float32Array.BYTES_PER_ELEMENT
  const aPosition = gl.getAttribLocation(program, 'a_position')
  const aUv = gl.getAttribLocation(program, 'a_uv')
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(aUv)
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT)
  gl.bindVertexArray(null)

  const names = ['u_media', 'u_progress', 'u_aspect', 'u_maskKind', 'u_maskTexture', 'u_maskUvTransform', 'u_maskCursorCenter', 'u_maskCursorRadius', 'u_maskCursorSoftness', 'u_maskCursorFalloff']
  const locations: Program['locations'] = {}
  for (const name of names) locations[name] = gl.getUniformLocation(program, name)
  return { program, vao, locations }
}

export type MaskReveal = {
  setProgress(progress: number): void
  destroy(): void
}

/** Whether an image has any transparency, from a small sample (once). A
 *  video, an image not decoded yet, or one that can't be read back
 *  (cross-origin without CORS) counts as opaque. */
export function hasTransparency(media: Media): boolean {
  if (!(media instanceof HTMLImageElement) || !media.complete || !media.naturalWidth) return false
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return false
    ctx.drawImage(media, 0, 0, 16, 16)
    const { data } = ctx.getImageData(0, 0, 16, 16)
    for (let i = 3; i < data.length; i += 4) if (data[i]! < 250) return true
    return false
  } catch {
    return false
  }
}

export function createMaskReveal(target: Media, instance: ComiceInstance, source: RevealMaskSource): MaskReveal {
  let progress = 0
  let destroyed = false
  let mount: CanvasMount | null = null
  let maskPlane: Plane | null = null
  let cursor: CursorMask | null = null
  let rasterized: RasterizedMask | null = null
  let derived: DerivedMask | null = null
  let unregister: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null

  const maskMedia: Media | null =
    source instanceof HTMLImageElement || source instanceof HTMLVideoElement ? source : typeof source === 'object' && 'source' in source ? source.source : null
  const explicitChannel = typeof source === 'object' && 'channel' in source ? source.channel : undefined

  const glContext: GLContext | null = createGLContext(target)
  const reporter: GLReporter = createGLReporter(instance, 'reveal', () => mount?.release())
  const visibility = createVisibilityGate(target)
  if (!glContext) reporter.noContext()

  const program = glContext ? compile(glContext.gl) : null
  if (glContext && !program) reporter.noProgram()

  const plane = glContext && program ? createPlane(glContext, target) : null

  function rasterize(): void {
    if (!rasterized || typeof source !== 'object' || !('type' in source) || source.type === 'cursor') return
    rasterized.rasterize(source, target.clientWidth || target.offsetWidth, target.clientHeight || target.offsetHeight)
  }

  if (glContext && program) {
    mount = mountCanvas(glContext, target, { owner: 'reveal', hideTarget: true })
    if (maskMedia) {
      // The derived mask is made at the first draw with the mask image
      // decoded, so 'auto' can look at its pixels.
      maskPlane = createPlane(glContext, maskMedia)
    } else if (typeof source === 'object' && 'type' in source && source.type === 'cursor') {
      cursor = createCursorMask({ falloff: 'smooth' })
    } else {
      rasterized = createRasterizedMask(glContext)
      rasterize()
      resizeObserver = new ResizeObserver(rasterize)
      resizeObserver.observe(target)
    }
    unregister = getSharedScheduler().add(
      () => draw(),
      () => !destroyed && target.isConnected && visibility.shouldDraw(),
    )
  }

  function draw(): void {
    if (destroyed || !glContext || !program || !plane) return
    glContext.resizeToDisplay()
    const width = glContext.canvas.clientWidth || 1
    const height = glContext.canvas.clientHeight || 1
    const aspect = width / height

    if (cursor && typeof source === 'object' && 'type' in source && source.type === 'cursor') {
      // pointer() reports px from the media's top-left, y down; the mask
      // works in aspect-corrected uv, y up, radius in units of the height.
      const radius = (source.radius ?? 160) / height
      cursor.setCenter((instance.display.x / width) * aspect, 1 - instance.display.y / height)
      cursor.setRadius(radius)
      cursor.setSoftness(radius * Math.max(0, Math.min(1, source.softness ?? 0.4)))
    }
    if (!derived && maskMedia && maskPlane?.texture) {
      const channel = explicitChannel ?? (hasTransparency(maskMedia) ? 'alpha' : 'luminance')
      derived = createDerivedMask(glContext, maskMedia instanceof HTMLVideoElement ? 'video' : 'image', { channel })
    }
    if (derived && maskPlane?.texture) derived.reduce(maskPlane.texture, width, height)

    const field = cursor?.field ?? rasterized?.field ?? derived?.field ?? null
    const pool = getResidencyPool(glContext)
    pool.beginPass()
    const mediaUnit = plane.texture ? pool.bind(plane.texture) : null
    if (mediaUnit !== null) {
      const maskUnit = field?.kind === 'texture' ? (pool.bind(field.texture) ?? mediaUnit) : mediaUnit
      const { gl } = glContext
      gl.useProgram(program.program)
      gl.bindVertexArray(program.vao)
      gl.uniform1i(program.locations.u_media!, mediaUnit)
      gl.uniform1f(program.locations.u_progress!, progress)
      gl.uniform1f(program.locations.u_aspect!, aspect)
      bindMaskUniforms(
        gl,
        {
          uMaskKind: program.locations.u_maskKind!,
          uMaskTexture: program.locations.u_maskTexture!,
          uMaskUvTransform: program.locations.u_maskUvTransform!,
          uMaskCursorCenter: program.locations.u_maskCursorCenter!,
          uMaskCursorRadius: program.locations.u_maskCursorRadius!,
          uMaskCursorSoftness: program.locations.u_maskCursorSoftness!,
          uMaskCursorFalloff: program.locations.u_maskCursorFalloff!,
        },
        field,
        maskUnit,
      )
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.bindVertexArray(null)
    }
    // Only the planes that exist: a cursor/shape/text mask has no mask plane,
    // and a missing plane would read as "not ready yet" forever.
    reporter.afterDraw(...(maskPlane ? [plane, maskPlane] : [plane]))
  }

  return {
    setProgress(next: number): void {
      progress = next
      draw()
    },
    destroy(): void {
      destroyed = true
      unregister?.()
      visibility.destroy()
      resizeObserver?.disconnect()
      rasterized?.destroy()
      derived?.destroy()
      maskPlane?.destroy()
      plane?.destroy()
      if (glContext && program) {
        glContext.gl.deleteProgram(program.program)
        glContext.gl.deleteVertexArray(program.vao)
      }
      mount?.release()
    },
  }
}
