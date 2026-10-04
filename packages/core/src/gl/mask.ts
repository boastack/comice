/**
 * comice/core/gl/mask
 * ─────────────────────────────────────────────────────────────────────────────
 * T3 (ROADMAP.md §4): the mask field. Design settled in the spec artifact's
 * §07 addendum ("The mask field, in full") before this file was written —
 * this is that design, implemented, not a new design pass. Seven producers
 * (shape, text, cursor, image, video, subject, depth), one contract every
 * consumer (reveal, morph, dissolve, distort, vision) samples identically.
 *
 * Three producer mechanisms, because the seven sources don't need the same
 * work:
 *
 *   - Procedural (cursor only) — a tiny uniform block, sampled analytically
 *     in-shader. No texture, no render target, no per-frame upload. This is
 *     deliberate, not an inconsistency: forcing the cursor through a
 *     texture would mean rendering to one every frame just to sample it
 *     back, exactly the layout/perf cost §07 promises the cursor case
 *     avoids. See createCursorMask().
 *
 *   - Rasterized (shape, text) — drawn once to an off-screen single-channel
 *     render target at creation time, re-rasterized only when the source
 *     path/text actually changes, never per frame. See createRasterizedMask().
 *
 *   - Derived (image, video, subject, depth) — an existing texture reduced
 *     to one channel by a small fragment pass: luminance for image/video,
 *     passthrough for subject (already vision's single-channel alpha),
 *     threshold+softness for depth. Depth-threshold conversion is owned
 *     HERE, not by vision — vision's job (§08) is producing plain textures,
 *     never deciding what counts as inside/outside a mask. See
 *     createDerivedMask().
 *
 * Every producer except the cursor lands on the same shape: a single-
 * channel texture in element-local UV space, values 0..1. One tagged
 * union (MaskField), one sampling function (the MASK_SAMPLE_GLSL chunk),
 * and the branch between "texture" and "analytic-cursor" lives once, here
 * — never copied into reveal/morph/dissolve/distort/vision individually.
 *
 * Lifecycle matches every other primitive in this package: rasterized
 * masks allocate their render target once at creation; derived masks reuse
 * one shared reduction render target per GLContext, sized against the
 * §13 DPR cap (gl/context.ts's effectiveDPR()); nothing allocates inside
 * the render loop; everything releases on destroy().
 */

import { effectiveDPR } from './context.js'
import type { GLContext } from './context.js'

// ─────────────────────────────────────────────────────────────────────────
// THE CONTRACT
// ─────────────────────────────────────────────────────────────────────────

/** A 3x3 UV transform (row-major, 9 numbers) mapping a mask texture's own
 *  texel space into the element-local UV space every consumer samples in.
 *  The identity transform for a mask that already matches the plane's UVs
 *  exactly. */
export type UVTransform = readonly [number, number, number, number, number, number, number, number, number]

export const IDENTITY_UV_TRANSFORM: UVTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export type MaskFalloff = 'linear' | 'smooth' | 'sharp'

/**
 * The shape every mask producer resolves to — exactly the type from the
 * spec artifact's §07 addendum. A consumer never branches on the seven
 * source kinds (shape/text/cursor/image/video/subject/depth); it branches
 * on these two, and only inside the shared GLSL chunk below.
 */
export type MaskField =
  | { kind: 'texture'; texture: WebGLTexture; uvTransform: UVTransform }
  | { kind: 'analytic-cursor'; center: readonly [number, number]; radius: number; softness: number; falloff: MaskFalloff }

// ─────────────────────────────────────────────────────────────────────────
// PROCEDURAL: cursor
// ─────────────────────────────────────────────────────────────────────────

export type CursorMaskOptions = {
  center?: readonly [number, number]
  radius?: number
  softness?: number
  falloff?: MaskFalloff
}

/** A mutable, live-updatable procedural mask. No GL resources at all — see
 *  the file header for why the cursor is deliberately kept out of the
 *  texture path. `field` is a fresh MaskField snapshot on every read
 *  (cheap: it's a plain object, no allocdation-in-the-render-loop concern
 *  applies to a handful of numbers). */
export type CursorMask = {
  readonly field: MaskField
  /** Updates the tracked pointer position. Typically driven by the
   *  pointer driver's signal, not called directly by a plugin author. */
  setCenter(x: number, y: number): void
  setRadius(radius: number): void
  setSoftness(softness: number): void
}

/** Creates a procedural cursor mask. Pure — no `GLContext` needed, since
 *  there is nothing to allocate on the GPU for this producer. */
export function createCursorMask(options: CursorMaskOptions = {}): CursorMask {
  let center: readonly [number, number] = options.center ?? [0.5, 0.5]
  let radius = options.radius ?? 0.2
  let softness = options.softness ?? 0.1
  const falloff = options.falloff ?? 'smooth'

  return {
    get field(): MaskField {
      return { kind: 'analytic-cursor', center, radius, softness, falloff }
    },
    setCenter(x: number, y: number): void {
      center = [x, y]
    },
    setRadius(next: number): void {
      radius = next
    },
    setSoftness(next: number): void {
      softness = next
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Shared: a single-channel offscreen render target
// ─────────────────────────────────────────────────────────────────────────

type RenderTarget = {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  width: number
  height: number
}

/** Allocates (or, given a previous target, reallocates only if the size
 *  changed) a single-channel (R8) render target sized against the §13 DPR
 *  cap. Returns null, never throws, if any GL object creation fails —
 *  rule 04 at the render-target level, same as every other allocation
 *  point in this package. */
function createOrResizeRenderTarget(
  gl: WebGL2RenderingContext,
  cssWidth: number,
  cssHeight: number,
  existing: RenderTarget | null,
): RenderTarget | null {
  const dpr = effectiveDPR()
  const width = Math.max(1, Math.round(cssWidth * dpr))
  const height = Math.max(1, Math.round(cssHeight * dpr))

  if (existing && existing.width === width && existing.height === height) {
    return existing // no-op resize, same discipline as context.ts's resizeToDisplay()
  }

  const texture = existing?.texture ?? gl.createTexture()
  const framebuffer = existing?.framebuffer ?? gl.createFramebuffer()
  if (!texture || !framebuffer) return null

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  // R8: single channel, exactly what a mask is — every producer that
  // lands on the 'texture' MaskField kind resolves to one value per
  // texel, never RGBA, per the "single-channel texture" line in §07.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null)

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  return { texture, framebuffer, width, height }
}

function destroyRenderTarget(gl: WebGL2RenderingContext, target: RenderTarget | null): void {
  if (!target) return
  gl.deleteTexture(target.texture)
  gl.deleteFramebuffer(target.framebuffer)
}

// ─────────────────────────────────────────────────────────────────────────
// RASTERIZED: shape, text
// ─────────────────────────────────────────────────────────────────────────

/** A shape is fitted into the box (centred, contained, with a margin): by
 *  `viewBox` when given, else by the path's own bounds — so an icon path
 *  drawn on a 24x24 grid ('M12 2L2 7…', spec §08) fills the media rather
 *  than drawing at 24px in its corner, as it used to. A Path2D has no
 *  readable bounds: without a viewBox it's drawn as is. Text is centred
 *  and sized to fit. */
export type RasterizedMaskSource =
  | { type: 'shape'; path: Path2D | string; viewBox?: readonly [number, number, number, number] }
  | { type: 'text'; text: string; font?: string }

/** How much of the box a fitted shape or text fills. */
const FIT = 0.8

const SVG_NS = 'http://www.w3.org/2000/svg'

/** A path string's bounds, measured by the browser's own SVG engine
 *  (null where there's none, or the path is empty). */
export function pathBounds(doc: Document, d: string): [number, number, number, number] | null {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden')
  const path = doc.createElementNS(SVG_NS, 'path') as SVGPathElement
  path.setAttribute('d', d)
  svg.appendChild(path)
  doc.body.appendChild(svg)
  try {
    const box = typeof path.getBBox === 'function' ? path.getBBox() : null
    return box && box.width > 0 && box.height > 0 ? [box.x, box.y, box.width, box.height] : null
  } catch {
    return null
  } finally {
    svg.remove()
  }
}

/** The transform [scale, x, y] that fits `bounds` into width x height,
 *  centred, filling FIT of it. */
export function fitTransform(bounds: readonly [number, number, number, number], width: number, height: number): [number, number, number] {
  const [x, y, w, h] = bounds
  const scale = Math.min((width * FIT) / w, (height * FIT) / h)
  return [scale, width / 2 - (x + w / 2) * scale, height / 2 - (y + h / 2) * scale]
}

export type RasterizeOptions = {
  /**
   * When true, bakes a signed-distance FIELD instead of a hard 0/1
   * coverage mask — the mechanism `legacy/index.html`'s `appleLogo` layout
   * and `legacy/african.html`'s whole 17-shape catalogue both use to get a
   * smooth, liquid-morphable edge instead of a hard cutout. Ported here,
   * generalized from "one hardcoded logo" (appleLogo) or "one hand-rolled
   * table of 17 shapes plus its own copy of this exact sweep"
   * (african.html) into the one shared mask primitive every source (shape
   * or text) can opt into. Default false (the original hard-coverage
   * behavior, unchanged for existing callers).
   */
  sdf?: boolean
  /** Only meaningful when `sdf: true`. The distance (in the rasterized
   *  target's own texel space, same units as its width/height) beyond
   *  which the field saturates to fully inside/outside. Matches legacy's
   *  `maxDistance` constant (96 for the wordmark bake, 192 for
   *  appleLogo/african.html's larger 1024px canvases) — kept as a caller
   *  option rather than a fixed constant since morph's on-canvas mask size
   *  varies per instance, unlike legacy's fixed-size offscreen bakes.
   *  Default 96. */
  maxDistance?: number
}

export type RasterizedMask = {
  /** Null until the first rasterize() call has actually run (e.g. context
   *  was null at creation — degrade-never-disappear, same shape as
   *  Plane['texture']). */
  readonly field: MaskField | null
  /** Re-rasterizes from the current source at the given CSS-pixel size.
   *  Call once at creation and again only when the source path/text or
   *  the element's size actually changes — never per frame, per §07's
   *  "Re-rasterized only when the source path or text actually changes."
   *  See RasterizeOptions for the coverage-vs-signed-distance-field choice. */
  rasterize(source: RasterizedMaskSource, cssWidth: number, cssHeight: number, options?: RasterizeOptions): void
  destroy(): void
}

/**
 * The two-pass chamfer distance transform legacy uses in three places
 * (`legacy/index.html`'s `createWordmarkTexture`/`createAppleLogoTexture`,
 * `legacy/african.html`'s `distanceTransform`) — identical math in all
 * three, ported here once as the shared implementation every rasterized
 * SDF mask in this package goes through, rather than a fourth copy.
 * `inside` is a 0/1 mask (1 = inside the shape); returns, per pixel, the
 * approximate distance (in texel units) to the nearest pixel matching
 * `target` (0 or 1). Two sweeps (forward raster order, then reverse)
 * approximate the true Euclidean distance cheaply — the standard
 * "chamfer"/two-pass distance transform, not an exact Euclidean one, which
 * is exactly what legacy already used and is more than adequate for a
 * soft mask edge.
 */
function distanceTransform(inside: Uint8Array, width: number, height: number, target: 0 | 1): Float32Array {
  const distances = new Float32Array(width * height)
  const infinity = 1e6
  const diagonal = Math.SQRT2

  for (let index = 0; index < distances.length; index += 1) {
    distances[index] = inside[index] === target ? 0 : infinity
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      let value = distances[index]
      if (x) value = Math.min(value, distances[index - 1] + 1)
      if (y) value = Math.min(value, distances[index - width] + 1)
      if (x && y) value = Math.min(value, distances[index - width - 1] + diagonal)
      if (x + 1 < width && y) value = Math.min(value, distances[index - width + 1] + diagonal)
      distances[index] = value
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x
      let value = distances[index]
      if (x + 1 < width) value = Math.min(value, distances[index + 1] + 1)
      if (y + 1 < height) value = Math.min(value, distances[index + width] + 1)
      if (x + 1 < width && y + 1 < height) value = Math.min(value, distances[index + width + 1] + diagonal)
      if (x && y + 1 < height) value = Math.min(value, distances[index + width - 1] + diagonal)
      distances[index] = value
    }
  }

  return distances
}

/**
 * Bakes `imageData`'s alpha channel into an R8 signed-distance field,
 * encoded exactly the way legacy encodes it: `0.5 * 255` at the shape
 * boundary, ramping toward 0 outside and 255 inside over `maxDistance`
 * texels, clamped beyond that. A consuming shader recovers a distance
 * value via `(sample - 0.5) * (2.0 * maxDistanceInUvUnits)`, the same
 * `(appleSdf - 0.5) * 0.345`-shaped expression legacy's own shaders use.
 */
function bakeSignedDistanceField(imageData: ImageData, maxDistance: number): Uint8Array {
  const { width, height, data: rgba } = imageData
  const inside = new Uint8Array(width * height)
  for (let index = 0; index < inside.length; index += 1) {
    inside[index] = rgba[index * 4 + 3] > 96 ? 1 : 0
  }

  const toInside = distanceTransform(inside, width, height, 1)
  const toOutside = distanceTransform(inside, width, height, 0)

  const encoded = new Uint8Array(width * height)
  for (let index = 0; index < inside.length; index += 1) {
    const signed = inside[index] ? -toOutside[index] : toInside[index]
    encoded[index] = Math.round((Math.max(-maxDistance, Math.min(maxDistance, signed)) / maxDistance) * 0.5 * 255 + 0.5 * 255)
  }
  return encoded
}

/**
 * Creates a rasterized mask producer (shape or text) against `context`.
 * Uses an offscreen 2D canvas to rasterize the vector source into an
 * ImageData buffer. By default uploads that buffer's alpha channel
 * directly as a hard coverage mask (a 2D canvas is the correct tool for
 * "draw an SVG path or text glyph outline to a raster," not a WebGL
 * fragment shader; nothing here draws through WebGL2 until the upload
 * step) — pass `{ sdf: true }` to rasterize() to bake a signed-distance
 * field instead, via bakeSignedDistanceField() above, for a mask with a
 * smooth, liquid-morphable edge (what `morph`'s `mask` operation uses).
 *
 * Degrade-never-disappear: if `context` is null (no WebGL2), returns a
 * RasterizedMask whose `field` stays permanently null and whose
 * rasterize()/destroy() are no-ops — matching createPlane()'s null-context
 * shape exactly, so callers don't need a second branch for "no WebGL2"
 * specific to masks.
 */
export function createRasterizedMask(context: GLContext | null): RasterizedMask {
  let destroyed = false

  if (!context) {
    return {
      field: null,
      rasterize() {},
      destroy() {},
    }
  }

  const { gl, canvas } = context
  let target: RenderTarget | null = null

  function rasterize(
    source: RasterizedMaskSource,
    cssWidth: number,
    cssHeight: number,
    options: RasterizeOptions = {},
  ): void {
    if (destroyed) return
    const { sdf = false, maxDistance = 96 } = options
    const dpr = effectiveDPR()
    const width = Math.max(1, Math.round(cssWidth * dpr))
    const height = Math.max(1, Math.round(cssHeight * dpr))

    // Rasterize via an offscreen 2D canvas — the browser's own vector
    // rasterizer, not a hand-rolled one. White-on-black-alpha: the mask's
    // "inside" value is drawn opaque white, everything else stays
    // transparent, so alpha alone becomes the mask channel below (as
    // direct coverage, or as the bakeSignedDistanceField() input).
    // context.canvas (GLContext's own field, typed HTMLCanvasElement) is
    // used for ownerDocument rather than gl.canvas, which WebGL2's own
    // types allow to be an OffscreenCanvas with no ownerDocument at all.
    const raster = canvas.ownerDocument!.createElement('canvas')
    raster.width = width
    raster.height = height
    const ctx2d = raster.getContext('2d')
    if (!ctx2d) return // degrade: leave the previous field (if any) as-is

    ctx2d.clearRect(0, 0, width, height)
    ctx2d.fillStyle = '#fff'
    if (source.type === 'shape') {
      const path = typeof source.path === 'string' ? new Path2D(source.path) : source.path
      const bounds = source.viewBox ?? (typeof source.path === 'string' ? pathBounds(canvas.ownerDocument!, source.path) : null)
      if (bounds) {
        const [scale, x, y] = fitTransform(bounds, width, height)
        ctx2d.setTransform(scale, 0, 0, scale, x, y)
      }
      ctx2d.fill(path)
      ctx2d.setTransform(1, 0, 0, 1, 0, 0)
    } else {
      // Centred, as large as fits FIT of the box (it used to be drawn
      // left-aligned at 80% of the height, running off a narrow box).
      const fontAt = (size: number) => source.font ?? `${size}px sans-serif`
      let size = Math.round(height * 0.6)
      ctx2d.font = fontAt(size)
      const measured = ctx2d.measureText(source.text).width
      if (!source.font && measured > width * FIT) size = Math.max(1, Math.floor((size * width * FIT) / measured))
      ctx2d.font = fontAt(size)
      ctx2d.textAlign = 'center'
      ctx2d.textBaseline = 'middle'
      ctx2d.fillText(source.text, width / 2, height / 2)
    }

    target = createOrResizeRenderTarget(gl, cssWidth, cssHeight, target)
    if (!target) return

    gl.bindTexture(gl.TEXTURE_2D, target.texture)

    // Flipped on upload for the same reason plane.ts flips media: the
    // raster's first row is its TOP, the quad's v=0 is the BOTTOM. Both
    // paths below (canvas source and raw SDF bytes, whose rows come from
    // getImageData top-down) need it, and mask and media must agree or a
    // morph mask lands upside down relative to the image it cuts.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    if (!sdf) {
      // texImage2D from a <canvas> source reads its alpha into every
      // requested channel per the WebGL spec's format conversion — RED
      // here pulls the canvas's own alpha channel in as the mask's one
      // channel, since the raster above is drawn as opaque-white-on-transparent.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, raster)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      return
    }

    // SDF path: read the rasterized pixels back out, run the
    // distance-transform bake, and upload the RESULT as raw pixel data —
    // this can't go through the same "hand texImage2D a canvas" path
    // above, since the encoded distance values aren't literally the
    // canvas's own alpha channel.
    const imageData = ctx2d.getImageData(0, 0, width, height)
    const encoded = bakeSignedDistanceField(imageData, maxDistance)
    // R8 is 1 byte/pixel — WebGL2's default UNPACK_ALIGNMENT of 4 assumes
    // each row starts on a 4-byte boundary, which an odd-width single-
    // channel buffer violates (rows silently shift for any width not a
    // multiple of 4). The canvas-source upload path above never hits this
    // (the browser handles canvas uploads internally), but a raw
    // Uint8Array upload does — legacy never hit it either, since its own
    // bakes went through RGBA (4 bytes/pixel, always aligned).
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, encoded)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4) // restore the default for whatever the next upload assumes
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  }

  return {
    get field(): MaskField | null {
      if (!target) return null
      return { kind: 'texture', texture: target.texture, uvTransform: IDENTITY_UV_TRANSFORM }
    },
    rasterize,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      destroyRenderTarget(gl, target)
      target = null
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DERIVED: image, video, subject, depth
// ─────────────────────────────────────────────────────────────────────────

/** Which reduction a derived mask's source texture needs. 'subject' is a
 *  passthrough (vision's alpha output is already single-channel) rather
 *  than a no-op skip, so it still goes through the same shared reduction
 *  render target and the same MaskField shape as the other three —
 *  keeping "every producer except the cursor lands on the same shape"
 *  true without a special case in any consumer. */
export type DerivedMaskKind = 'image' | 'video' | 'subject' | 'depth'

export type DerivedMaskOptions = {
  /** Only meaningful for kind: 'depth'. Values nearer than this (in the
   *  source depth texture's own units, 0..1) are "inside" the mask. */
  threshold?: number
  /** Softness of the threshold edge, 0..1. Only meaningful for 'depth'. */
  softness?: number
  /** For 'image'/'video': read brightness ('luminance', default) or
   *  opacity ('alpha' — a silhouette on transparency, where a black logo
   *  has no luminance to read). Spec §08: "sampled by luminance or alpha". */
  channel?: 'luminance' | 'alpha'
}

const REDUCE_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

// One fragment shader, kind selected by a uniform rather than four
// separate programs — this is the reduction-side mirror of the mask
// field's own "one sampleMask(), branch lives once" principle: the four
// derived kinds are one shader with one branch, not four shaders a future
// editor drifts out of sync.
const REDUCE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform int u_kind;        // 0 = image/video (luminance), 1 = subject (passthrough), 2 = depth (threshold), 3 = image/video (alpha)
uniform float u_threshold;
uniform float u_softness;
out vec4 outColor;

void main() {
  vec4 src = texture(u_source, v_uv);
  float value;
  if (u_kind == 3) {
    value = src.a; // image/video by alpha: its silhouette
  } else if (u_kind == 1) {
    value = src.r; // subject: vision's alpha, already single-channel, passed through
  } else if (u_kind == 2) {
    // depth: threshold with a soft edge, owned here per §07 — never in vision.
    value = smoothstep(u_threshold - u_softness, u_threshold + u_softness, src.r);
  } else {
    // image/video: standard luminance weights.
    value = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  }
  outColor = vec4(value, 0.0, 0.0, 1.0);
}`

type ReduceProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  uSource: WebGLUniformLocation | null
  uKind: WebGLUniformLocation | null
  uThreshold: WebGLUniformLocation | null
  uSoftness: WebGLUniformLocation | null
}

const reduceProgramsByGL = new WeakMap<WebGL2RenderingContext, ReduceProgram | null>()

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

function getReduceProgram(gl: WebGL2RenderingContext): ReduceProgram | null {
  const cached = reduceProgramsByGL.get(gl)
  if (cached !== undefined) return cached

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, REDUCE_VERTEX_SHADER)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, REDUCE_FRAGMENT_SHADER)
  if (!vertexShader || !fragmentShader) {
    reduceProgramsByGL.set(gl, null)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    reduceProgramsByGL.set(gl, null)
    return null
  }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    reduceProgramsByGL.set(gl, null)
    return null
  }

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  // A full-screen triangle strip (clip space), reduction passes cover the
  // whole target — no plane positioning needed, unlike plane.ts's quad.
  // prettier-ignore
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const aPosition = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  const result: ReduceProgram = {
    program,
    vao,
    uSource: gl.getUniformLocation(program, 'u_source'),
    uKind: gl.getUniformLocation(program, 'u_kind'),
    uThreshold: gl.getUniformLocation(program, 'u_threshold'),
    uSoftness: gl.getUniformLocation(program, 'u_softness'),
  }
  reduceProgramsByGL.set(gl, result)
  return result
}

function kindToUniform(kind: DerivedMaskKind, channel: DerivedMaskOptions['channel']): number {
  if (kind === 'subject') return 1
  if (kind === 'depth') return 2
  return channel === 'alpha' ? 3 : 0 // image, video
}

export type DerivedMask = {
  readonly field: MaskField | null
  /** Runs the reduction pass against `sourceTexture` at the given
   *  CSS-pixel size. For 'image', called once when the source is ready
   *  (matching plane.ts's still-image upload cadence). For 'video',
   *  'subject' and 'depth', called by the caller's own update cadence
   *  (a video's per-frame upload, vision's decoupled analysis rate per
   *  §08 — this function has no opinion on cadence, it just runs the pass
   *  when asked, same separation of concerns as plane.ts's upload()). */
  reduce(sourceTexture: WebGLTexture, cssWidth: number, cssHeight: number): void
  destroy(): void
}

/**
 * Creates a derived mask producer against `context`, reducing a source
 * texture (already-existing image/video/subject/depth texture) to one
 * channel via the shared reduction shader above.
 *
 * Uses the shared ResidencyPool's binding mechanism is deliberately NOT
 * done here — a reduction pass binds exactly one input texture to a
 * private, fixed unit of its own (see reduce()'s implementation) rather
 * than sharing a pass-scoped pool with plane.ts draws, because a
 * reduction pass renders to an offscreen target, not the on-screen
 * canvas, so it is never "in the same pass" as a plane draw in the
 * ResidencyPool's sense — it's a fully separate framebuffer bind.
 *
 * Degrade-never-disappear: null `context` yields a DerivedMask whose
 * `field` stays null and whose reduce()/destroy() are no-ops, same shape
 * as every other producer here.
 */
export function createDerivedMask(
  context: GLContext | null,
  kind: DerivedMaskKind,
  options: DerivedMaskOptions = {},
): DerivedMask {
  let destroyed = false

  if (!context) {
    return {
      field: null,
      reduce() {},
      destroy() {},
    }
  }

  const { gl } = context
  const threshold = options.threshold ?? 0.5
  const softness = options.softness ?? 0.05
  let target: RenderTarget | null = null

  function reduce(sourceTexture: WebGLTexture, cssWidth: number, cssHeight: number): void {
    if (destroyed) return
    const program = getReduceProgram(gl)
    if (!program) return

    target = createOrResizeRenderTarget(gl, cssWidth, cssHeight, target)
    if (!target) return

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, target.width, target.height)
    gl.useProgram(program.program)
    gl.bindVertexArray(program.vao)

    // A private, fixed unit for the reduction pass's one input — see the
    // file-level doc comment above for why this doesn't go through
    // ResidencyPool (offscreen framebuffer, not an on-screen pass).
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
    gl.uniform1i(program.uSource, 0)
    gl.uniform1i(program.uKind, kindToUniform(kind, options.channel))
    gl.uniform1f(program.uThreshold, threshold)
    gl.uniform1f(program.uSoftness, softness)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  return {
    get field(): MaskField | null {
      if (!target) return null
      return { kind: 'texture', texture: target.texture, uvTransform: IDENTITY_UV_TRANSFORM }
    },
    reduce,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      destroyRenderTarget(gl, target)
      target = null
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// THE SHARED SAMPLING CHUNK
// ─────────────────────────────────────────────────────────────────────────

/**
 * The GLSL chunk every mask-consuming shader (reveal, morph, dissolve,
 * distort, vision) splices into its fragment shader source and calls as
 * `sampleMask(uv)`. The branch between 'texture' and 'analytic-cursor'
 * MaskField kinds lives exactly once, here — a consumer never
 * re-implements it. `bindMaskUniforms()` below sets the uniforms this
 * chunk reads, from a live MaskField value.
 */
export const MASK_SAMPLE_GLSL = `
uniform int u_maskKind;              // 0 = texture, 1 = analytic-cursor
uniform sampler2D u_maskTexture;
uniform mat3 u_maskUvTransform;
uniform vec2 u_maskCursorCenter;
uniform float u_maskCursorRadius;
uniform float u_maskCursorSoftness;
uniform int u_maskCursorFalloff;     // 0 = linear, 1 = smooth, 2 = sharp

float sampleMask(vec2 uv) {
  if (u_maskKind == 1) {
    float d = distance(uv, u_maskCursorCenter);
    float inner = max(u_maskCursorRadius - u_maskCursorSoftness, 0.0);
    if (u_maskCursorFalloff == 0) {
      return 1.0 - clamp((d - inner) / max(u_maskCursorSoftness, 1e-5), 0.0, 1.0);
    } else if (u_maskCursorFalloff == 2) {
      return d <= u_maskCursorRadius ? 1.0 : 0.0;
    }
    return 1.0 - smoothstep(inner, u_maskCursorRadius, d);
  }
  vec3 transformed = u_maskUvTransform * vec3(uv, 1.0);
  return texture(u_maskTexture, transformed.xy).r;
}
`

/**
 * Sets every uniform MASK_SAMPLE_GLSL's sampleMask() reads, from a live
 * MaskField. Binds the mask's texture into `textureUnit` (the caller
 * chooses the unit — typically the next free one from a ResidencyPool
 * bind() call alongside the plane's own texture) when `field.kind` is
 * 'texture'; a no-op on the texture uniforms when it's 'analytic-cursor',
 * since there is nothing to bind.
 *
 * A null `field` (a producer that hasn't rasterized/reduced/moved yet, or
 * a permanently-null one from the no-WebGL2 degrade path) sets the mask
 * kind to a value sampleMask() treats as texture-mode against an unbound
 * texture, i.e. reads 0 — an absent mask reveals nothing, not everything,
 * matching "degrade, never disappear" for the CONSUMER: a broken mask
 * producer must never accidentally reveal media that was supposed to stay
 * masked.
 */
export function bindMaskUniforms(
  gl: WebGL2RenderingContext,
  locations: {
    uMaskKind: WebGLUniformLocation | null
    uMaskTexture: WebGLUniformLocation | null
    uMaskUvTransform: WebGLUniformLocation | null
    uMaskCursorCenter: WebGLUniformLocation | null
    uMaskCursorRadius: WebGLUniformLocation | null
    uMaskCursorSoftness: WebGLUniformLocation | null
    uMaskCursorFalloff: WebGLUniformLocation | null
  },
  field: MaskField | null,
  textureUnit: number,
): void {
  if (!field || field.kind === 'texture') {
    gl.uniform1i(locations.uMaskKind, 0)
    if (field?.kind === 'texture') {
      gl.activeTexture(gl.TEXTURE0 + textureUnit)
      gl.bindTexture(gl.TEXTURE_2D, field.texture)
      gl.uniform1i(locations.uMaskTexture, textureUnit)
      gl.uniformMatrix3fv(locations.uMaskUvTransform, false, field.uvTransform as unknown as Float32Array)
    }
    return
  }

  gl.uniform1i(locations.uMaskKind, 1)
  gl.uniform2f(locations.uMaskCursorCenter, field.center[0], field.center[1])
  gl.uniform1f(locations.uMaskCursorRadius, field.radius)
  gl.uniform1f(locations.uMaskCursorSoftness, field.softness)
  gl.uniform1i(locations.uMaskCursorFalloff, field.falloff === 'linear' ? 0 : field.falloff === 'sharp' ? 2 : 1)
}
