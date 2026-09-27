/**
 * comice/core/gl/plane
 * ─────────────────────────────────────────────────────────────────────────────
 * One texture-on-plane per Comice instance: a source <img>/<video>, uploaded
 * to a WebGL2 texture, drawn as a flat rectangle sized and positioned to sit
 * exactly where the source element's layout box already is. Spec §01's
 * "as a texture on a flat rectangle that sits exactly where the original
 * element was" — this file is that sentence.
 *
 * Deliberately minimal for T1: upload + position tracking + a plain
 * textured-quad draw. No shaders beyond the pass-through pair below, no
 * masks, no multi-texture, no feedback — those are T2-T5. Every future
 * primitive sits on top of what's here: a live GLTexture kept in sync with
 * its source element, addressable by the renderer.
 */

import { waitForMediaReady } from './ready.js'
import { getResidencyPool } from './residency.js'
import { getSharedScheduler } from '../scheduler.js'
import type { GLContext } from './context.js'

export type PlaneSource = HTMLImageElement | HTMLVideoElement

export type Plane = {
  /** The live WebGLTexture backing this plane. Null until the source has
   *  decoded/loaded at least one uploadable frame. */
  readonly texture: WebGLTexture | null
  /** Forces an immediate re-upload (a video's current frame, a still image
   *  that changed via `src`). Uploads also happen automatically once per
   *  frame for <video> sources while visible — see the scheduler
   *  registration below. */
  upload(): void
  /** Re-reads the source element's layout box. Called automatically on a
   *  ResizeObserver signal; exposed so a caller can force a sync (e.g.
   *  right after a layout-affecting DOM change the observer hasn't fired
   *  for yet). */
  syncLayout(): void
  /** Current CSS-pixel box the plane is tracking, in the coordinate space
   *  of `context.canvas`'s offset parent. Undefined until the first
   *  syncLayout(). */
  readonly box: { x: number; y: number; width: number; height: number } | null
  destroy(): void
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
uniform vec2 u_planeOrigin;   // CSS px, top-left, canvas coordinate space
uniform vec2 u_planeSize;     // CSS px
uniform vec2 u_canvasSize;    // CSS px
out vec2 v_uv;

void main() {
  vec2 px = u_planeOrigin + a_position * u_planeSize;
  vec2 clip = (px / u_canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
}`

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_texture;
out vec4 outColor;

void main() {
  outColor = texture(u_texture, v_uv);
}`

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

type PassThroughProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  uPlaneOrigin: WebGLUniformLocation | null
  uPlaneSize: WebGLUniformLocation | null
  uCanvasSize: WebGLUniformLocation | null
  uTexture: WebGLUniformLocation | null
}

// One pass-through program per GL context, shared by every plane drawn into
// that context — matches the mobile budget discipline elsewhere in this
// package (one thing allocated once, not once per instance). Keyed by the
// WebGL2RenderingContext itself rather than GLContext, since that's what a
// draw call actually needs to look up against.
const programsByGL = new WeakMap<WebGL2RenderingContext, PassThroughProgram | null>()

function getPassThroughProgram(gl: WebGL2RenderingContext): PassThroughProgram | null {
  const cached = programsByGL.get(gl)
  if (cached !== undefined) return cached

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  if (!vertexShader || !fragmentShader) {
    programsByGL.set(gl, null)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    programsByGL.set(gl, null)
    return null
  }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    programsByGL.set(gl, null)
    return null
  }

  // A unit quad, two triangles, position + UV interleaved. Built once per
  // context and reused by every plane — this is geometry data, not
  // per-instance state.
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  // x, y, u, v — v flipped (1 at y=0) because canvas-space y grows downward
  // while a plain image texture's first row is the top of the image.
  // prettier-ignore
  const quad = new Float32Array([
    0, 0, 0, 1,
    1, 0, 1, 1,
    0, 1, 0, 0,
    0, 1, 0, 0,
    1, 0, 1, 1,
    1, 1, 1, 0,
  ])
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)

  const aPosition = gl.getAttribLocation(program, 'a_position')
  const aUv = gl.getAttribLocation(program, 'a_uv')
  const stride = 4 * Float32Array.BYTES_PER_ELEMENT
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(aUv)
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT)

  gl.bindVertexArray(null)

  const result: PassThroughProgram = {
    program,
    vao,
    uPlaneOrigin: gl.getUniformLocation(program, 'u_planeOrigin'),
    uPlaneSize: gl.getUniformLocation(program, 'u_planeSize'),
    uCanvasSize: gl.getUniformLocation(program, 'u_canvasSize'),
    uTexture: gl.getUniformLocation(program, 'u_texture'),
  }
  programsByGL.set(gl, result)
  return result
}

function isUploadableNow(source: PlaneSource): boolean {
  if (source instanceof HTMLVideoElement) {
    // HAVE_CURRENT_DATA, pinned as a literal for the same reason
    // packages/reveal/src/decode.ts pins it: some DOM implementations
    // (happy-dom, at time of writing) expose HTMLMediaElement without its
    // static readyState constants.
    return source.readyState >= 2
  }
  return source.complete && source.naturalWidth > 0
}

/**
 * Creates a plane tracking `source`, drawn into `context`. Uploads the
 * source's current frame as soon as it's ready (reusing
 * packages/reveal/src/decode.ts's exact "never a guessed delay" mechanism
 * rather than re-deriving it), keeps the plane's on-canvas box in sync with
 * the source's real layout box via ResizeObserver, and re-uploads a
 * <video> source once per visible frame via the shared scheduler — never a
 * private rAF loop, per scheduler.ts's whole reason for existing.
 *
 * Degrade-never-disappear: if `context` is null (see createGLContext), this
 * still returns a Plane whose `texture` stays null forever and whose
 * upload()/syncLayout() are no-ops. Callers do not need a separate
 * WebGL-unsupported branch — a plane with no texture simply never draws,
 * and the source element is left exactly as the browser already renders it.
 */
export function createPlane(context: GLContext | null, source: PlaneSource): Plane {
  let box: Plane['box'] = null
  let destroyed = false

  if (!context) {
    return {
      texture: null,
      upload() {},
      syncLayout() {},
      get box() {
        return box
      },
      destroy() {},
    }
  }

  const { gl, canvas } = context
  const texture = gl.createTexture()
  let hasUploadedOnce = false

  function configureTexture(): void {
    if (!texture) return
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  }

  function upload(): void {
    if (destroyed || !texture) return
    if (!isUploadableNow(source)) return
    configureTexture()
    // Flip on upload. A DOM image's first row is its TOP, but every shader
    // in this repo samples with the full-screen quad's v_uv, whose v=0 is
    // the BOTTOM of the canvas (clip-space y=-1). Without this, every GL
    // plugin (distort, color, mosaic, ascii, dissolve, morph) drew media
    // upside down — found on harness/site/ with an asymmetric test image;
    // the demo's symmetric gradients and the fake-GL unit tests hid it.
    // Reset right after so no other upload on this shared context inherits it.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      hasUploadedOnce = true
    } catch {
      // A cross-origin source without CORS headers taints the canvas and
      // texImage2D throws — degrade, never disappear: the plane simply
      // never gets a texture, same as the no-WebGL2 path above, rather
      // than crashing the instance that owns it.
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    }
  }

  function syncLayout(): void {
    if (destroyed) return
    const rect = source.getBoundingClientRect()
    // Canvas is position:absolute against its offset parent, so its own
    // bounding rect is the origin every plane's box is relative to.
    const canvasRect = canvas.getBoundingClientRect()
    box = {
      x: rect.left - canvasRect.left,
      y: rect.top - canvasRect.top,
      width: rect.width,
      height: rect.height,
    }
  }

  waitForMediaReady(source).then(() => {
    if (destroyed) return
    upload()
    syncLayout()
  })
  // Already-ready sources (e.g. a still image already in the browser
  // cache) resolve waitForMediaReady on a microtask — also try eagerly so
  // a caller reading .texture synchronously after createPlane() for an
  // already-decoded image isn't left waiting a tick for no reason.
  if (isUploadableNow(source)) {
    upload()
    syncLayout()
  }

  const resizeObserver = new ResizeObserver(() => syncLayout())
  resizeObserver.observe(source)

  // <video> frames change every tick while playing; <img> sources only
  // need the one upload from decode above (or a caller-forced upload() if
  // its `src` changes). Re-uploading a still image every frame would be
  // pure waste — the render-loop-allocation discipline this package holds
  // to everywhere else (scheduler.ts, audio.ts) applies here too: only pay
  // per-frame cost for a source that actually changes per frame.
  let unregisterFromScheduler: (() => void) | null = null
  if (source instanceof HTMLVideoElement) {
    unregisterFromScheduler = getSharedScheduler().add(
      () => upload(),
      () => !destroyed && !source.paused && !source.ended,
    )
  }

  return {
    get texture() {
      return hasUploadedOnce ? texture : null
    },
    upload,
    syncLayout,
    get box() {
      return box
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      unregisterFromScheduler?.()
      resizeObserver.disconnect()
      if (texture) gl.deleteTexture(texture)
    },
  }
}

/**
 * Draws `plane` into `context` using the shared pass-through program.
 * Assumes the caller has already sized/cleared the canvas for this frame —
 * draw() itself never clears, so multiple planes can be drawn into one
 * frame without one erasing the last.
 *
 * Texture binding goes through the same ResidencyPool (see residency.ts,
 * T2) every multi-texture consumer uses — a single plane is simply the
 * one-texture case of "textures resident this pass", not a separate
 * binding mechanism. A caller drawing several planes (or a plane plus a
 * mask/displacement texture) in one pass calls `pool.beginPass()` once,
 * then draws each plane — this function does not call beginPass() itself,
 * so a caller composing multiple draws into one pass controls exactly
 * when the pass boundary resets. A caller drawing exactly one plane and
 * nothing else may skip beginPass() entirely; bind() degrades safely
 * either way, it just may reuse stale unit bookkeeping across pass
 * boundaries the caller never marked.
 *
 * Returns without drawing, never throwing, if the pool's unit budget is
 * already exhausted for this pass (degrade-never-disappear applied to the
 * mobile texture-unit ceiling from §13 — see residency.ts).
 */
export function drawPlane(context: GLContext, plane: Plane): void {
  const { gl, canvas } = context
  if (!plane.texture || !plane.box) return

  const passThrough = getPassThroughProgram(gl)
  if (!passThrough) return

  const pool = getResidencyPool(context)
  const unit = pool.bind(plane.texture)
  if (unit === null) return // unit budget exhausted this pass, per §13

  gl.useProgram(passThrough.program)
  gl.bindVertexArray(passThrough.vao)

  gl.uniform2f(passThrough.uPlaneOrigin, plane.box.x, plane.box.y)
  gl.uniform2f(passThrough.uPlaneSize, plane.box.width, plane.box.height)
  gl.uniform2f(passThrough.uCanvasSize, canvas.clientWidth, canvas.clientHeight)
  gl.uniform1i(passThrough.uTexture, unit)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.TRIANGLES, 0, 6)

  gl.bindVertexArray(null)
}
