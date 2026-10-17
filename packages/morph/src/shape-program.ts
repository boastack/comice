import { getResidencyPool } from 'comice/gl'
import type { GLContext, Plane } from 'comice/gl'
import { shapeFragmentShader } from './shape-shader.js'
import type { SurfaceOptions } from './surface.js'
import type { InteractionOptions } from './index.js'
import type { JoinOptions } from './shape-shader.js'
export type MorphShaderOptions = SurfaceOptions & { shapeTransition?: boolean; signedMask?: boolean; hasFromMask?: boolean; join?: JoinOptions | false; liquid?: number; liquidSheen?: number; cursorFollow?: boolean | { offset?: number; zoom?: number }; bend?: boolean | { x?: number; y?: number }; direction?: 'forward' | 'reverse'; interaction?: InteractionOptions | boolean }
const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

export type MorphProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  buffer: WebGLBuffer
  isMask: boolean
  uResolution: WebGLUniformLocation | null
  uProgress: WebGLUniformLocation | null
  uMouse: WebGLUniformLocation | null
  uVelocity: WebGLUniformLocation | null
  uFollow: WebGLUniformLocation | null
  uInteraction: WebGLUniformLocation | null
  uTime: WebGLUniformLocation | null
  uMediaAspect: WebGLUniformLocation | null
  uMedia: WebGLUniformLocation | null
  /** Null for a non-mask program — getUniformLocation() on a name the
   *  shader never declared returns null anyway, but `isMask` is the
   *  authoritative flag drawMorph() checks, not "is this null." */
  uMask: WebGLUniformLocation | null
  uMaskScale: WebGLUniformLocation | null
  hasFromMask: boolean
  uFromMask: WebGLUniformLocation | null
  uFromScale: WebGLUniformLocation | null
  uSourceRadius: WebGLUniformLocation | null
  uJoinPoints: WebGLUniformLocation | null
  uJoinCount: WebGLUniformLocation | null
  uJoinFrom: WebGLUniformLocation | null
}

/** A program whose compile and link have been asked for, not yet checked. */
export type PendingMorphProgram = {
  program: WebGLProgram
  shaders: [WebGLShader, WebGLShader]
  /** KHR_parallel_shader_compile, where the browser has it. */
  parallel: { COMPLETION_STATUS_KHR: number } | null
  options: MorphShaderOptions
}

/**
 * Starts compiling and linking this instance's shader without waiting for
 * it. Asking for COMPILE_STATUS or LINK_STATUS blocks the main thread until
 * the driver is done (50-300ms for this shader on a first compile, which is
 * a dropped frame or ten as a demo scrolls in); with
 * KHR_parallel_shader_compile the driver works in the background and
 * morphProgramReady() says when the result can be read for free.
 */
export function beginMorphProgram(gl: WebGL2RenderingContext, options: MorphShaderOptions): PendingMorphProgram | null {
  const program = gl.createProgram()
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)
  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)
  if (!program || !vertexShader || !fragmentShader) {
    if (program) gl.deleteProgram(program)
    if (vertexShader) gl.deleteShader(vertexShader)
    if (fragmentShader) gl.deleteShader(fragmentShader)
    return null
  }
  gl.shaderSource(vertexShader, VERTEX_SHADER)
  gl.shaderSource(fragmentShader, shapeFragmentShader(options))
  gl.compileShader(vertexShader)
  gl.compileShader(fragmentShader)
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  return { program, shaders: [vertexShader, fragmentShader], parallel: gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null, options }
}

/** Whether a pending program can be finished without blocking. */
export function morphProgramReady(gl: WebGL2RenderingContext, pending: PendingMorphProgram): boolean {
  return !pending.parallel || !!gl.getProgramParameter(pending.program, pending.parallel.COMPLETION_STATUS_KHR)
}

/** Releases a pending program that will never be finished (a teardown first). */
export function abandonMorphProgram(gl: WebGL2RenderingContext, pending: PendingMorphProgram): void {
  pending.shaders.forEach((shader) => gl.deleteShader(shader))
  gl.deleteProgram(pending.program)
}

/** Compile this instance's shape/surface shader, waiting for it. Clean all
 * surviving allocations on failure, allowing the plugin to restore the
 * original media. */
export function compileMorphProgram(gl: WebGL2RenderingContext, options: MorphShaderOptions): MorphProgram | null {
  const pending = beginMorphProgram(gl, options)
  return pending ? finishMorphProgram(gl, pending) : null
}

/** Reads a pending program's result and builds what drawing needs. Blocks only
 *  if called before morphProgramReady(). Null (with everything released) if the
 *  shader failed to compile or link. */
export function finishMorphProgram(gl: WebGL2RenderingContext, pending: PendingMorphProgram): MorphProgram | null {
  const { program, shaders, options } = pending
  const compiled = shaders.every((shader) => gl.getShaderParameter(shader, gl.COMPILE_STATUS))
  shaders.forEach((shader) => gl.deleteShader(shader))
  if (!compiled || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const buffer = gl.createBuffer()
  if (!vao || !buffer) {
    if (vao) gl.deleteVertexArray(vao)
    if (buffer) gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    gl.bindVertexArray(null)
    return null
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  // A clip-space full quad with matching UVs — legacy's THREE.PlaneGeometry(2, 2)
  // mesh, reproduced as a raw triangle strip since morph doesn't need
  // Three.js's mesh machinery, only the same clip-space coverage.
  // prettier-ignore
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1,
    ]),
    gl.STATIC_DRAW,
  )
  const aPosition = gl.getAttribLocation(program, 'a_position')
  const aUv = gl.getAttribLocation(program, 'a_uv')
  const stride = 4 * Float32Array.BYTES_PER_ELEMENT
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(aUv)
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT)
  gl.bindVertexArray(null)

  const isMask = true
  return {
    program,
    vao,
    buffer: buffer!,
    isMask,
    uResolution: gl.getUniformLocation(program, 'u_resolution'),
    uProgress: gl.getUniformLocation(program, 'u_progress'),
    uMouse: gl.getUniformLocation(program, 'u_mouse'),
    uVelocity: gl.getUniformLocation(program, 'u_velocity'),
    uFollow: gl.getUniformLocation(program, 'u_follow'),
    uInteraction: gl.getUniformLocation(program, 'u_interaction'),
    uTime: gl.getUniformLocation(program, 'u_time'),
    uMediaAspect: gl.getUniformLocation(program, 'u_mediaAspect'),
    uMedia: gl.getUniformLocation(program, 'u_media'),
    uMask: isMask ? gl.getUniformLocation(program, 'u_mask') : null,
    uMaskScale: isMask ? gl.getUniformLocation(program, 'u_maskScale') : null,
    hasFromMask: !!options.hasFromMask,
    uFromMask: options.hasFromMask ? gl.getUniformLocation(program, 'u_fromMask') : null,
    uFromScale: options.hasFromMask ? gl.getUniformLocation(program, 'u_fromScale') : null,
    uSourceRadius: options.shapeTransition ? gl.getUniformLocation(program, 'u_sourceRadius') : null,
    uJoinPoints: options.shapeTransition && options.join ? gl.getUniformLocation(program, 'u_joinPoints[0]') : null,
    uJoinCount: options.join ? gl.getUniformLocation(program, 'u_joinCount') : null,
    uJoinFrom: gl.getUniformLocation(program, 'u_joinFrom'),
  }
}

export function destroyMorphProgram(gl: WebGL2RenderingContext, morphProgram: MorphProgram): void {
  gl.deleteProgram(morphProgram.program)
  gl.deleteVertexArray(morphProgram.vao)
  gl.deleteBuffer(morphProgram.buffer)
}

export type MorphDrawState = {
  progress: number
  mouseX: number
  mouseY: number
  velocity: number
  /** How far the media's cursor-follow zoom and parallax have eased in, 0..1. */
  follow?: number
  interaction?: Float32Array | number[]
  time?: number
  mediaAspect: number
  resolutionWidth: number
  resolutionHeight: number
  /** Only read when `morphProgram.isMask` is true. The MaskField texture
   *  gl/mask.ts's `createRasterizedMask()` produced (with `{ sdf: true }`)
   *  — a plugin using operation: 'merge'/'breakout'/'distribute' never
   *  sets this. */
  maskTexture?: WebGLTexture | null
  /** Only read when `morphProgram.isMask` is true. See shader.ts's
   *  u_maskScale doc comment — must be computed from the SAME bake
   *  dimensions the mask texture was actually rasterized with. */
  maskScale?: number
  fromMaskTexture?: WebGLTexture | null
  fromScale?: number
  sourceRadius?: number
  joinPoints?: Float32Array
  joinCount?: number
  joinFrom?: boolean
}

/**
 * Draws one morph pass. Assumes the caller has already cleared/sized the
 * canvas for this frame AND already called the residency pool's
 * `beginPass()` for this frame, matching gl/plane.ts's drawPlane()
 * contract exactly — drawMorph() does not call `beginPass()` itself, so a
 * caller compositing morph alongside other draws in one pass (a plane plus
 * a mask lookup, say) controls exactly when the pass boundary resets, the
 * same reasoning drawPlane()'s own doc comment gives. A caller drawing
 * exactly one morph instance and nothing else in a frame may call
 * `getResidencyPool(context).beginPass()` once per frame itself; index.ts
 * does exactly that.
 *
 * Uses the SAME ResidencyPool the rest of this package's texture binding
 * goes through (T2) — morph is a genuine multi-instance texture consumer,
 * not a special case that reaches for `gl.activeTexture(TEXTURE0)`
 * directly. For `operation: 'mask'`, TWO textures are resident this pass
 * (media + mask) — the first real, non-synthetic exercise of the
 * residency pool binding more than one texture for a single draw call
 * anywhere in this package so far.
 *
 * Returns without drawing, never throwing, if `plane.texture` is null (the
 * media hasn't decoded yet, or the underlying GLContext never got WebGL2),
 * if a mask program's `state.maskTexture` is null (the mask hasn't
 * rasterized yet), or if the residency pool's unit budget is exhausted
 * this pass.
 */
export function drawMorph(context: GLContext, morphProgram: MorphProgram, plane: Plane, state: MorphDrawState): void {
  if (!plane.texture) return
  if (morphProgram.isMask && !state.maskTexture) return
  if (morphProgram.hasFromMask && !state.fromMaskTexture) return

  const pool = getResidencyPool(context)
  const mediaUnit = pool.bind(plane.texture)
  if (mediaUnit === null) return

  let maskUnit: number | null = null
  if (morphProgram.isMask) {
    maskUnit = pool.bind(state.maskTexture!)
    if (maskUnit === null) return // budget exhausted before the mask texture got a unit
  }
  const fromUnit = morphProgram.hasFromMask ? pool.bind(state.fromMaskTexture!) : null
  if (morphProgram.hasFromMask && fromUnit === null) return

  const { gl } = context
  gl.useProgram(morphProgram.program)
  gl.bindVertexArray(morphProgram.vao)

  gl.uniform2f(morphProgram.uResolution, state.resolutionWidth, state.resolutionHeight)
  gl.uniform1f(morphProgram.uProgress, state.progress)
  gl.uniform2f(morphProgram.uMouse, state.mouseX, state.mouseY)
  gl.uniform1f(morphProgram.uVelocity, state.velocity)
  gl.uniform1f(morphProgram.uFollow, state.follow ?? 1)
  gl.uniform4fv(morphProgram.uInteraction, state.interaction ?? [0, 0, 0, 0])
  gl.uniform1f(morphProgram.uTime, state.time ?? 0)
  gl.uniform1f(morphProgram.uMediaAspect, state.mediaAspect)
  gl.uniform1i(morphProgram.uMedia, mediaUnit)

  if (morphProgram.isMask) {
    gl.uniform1i(morphProgram.uMask, maskUnit!)
    gl.uniform1f(morphProgram.uMaskScale, state.maskScale ?? 0.345)
  }
  if (morphProgram.hasFromMask) {
    gl.uniform1i(morphProgram.uFromMask, fromUnit!)
    gl.uniform1f(morphProgram.uFromScale, state.fromScale ?? state.maskScale ?? .345)
  }
  gl.uniform1f(morphProgram.uSourceRadius, state.sourceRadius ?? 0)
  if (morphProgram.uJoinPoints && state.joinPoints) gl.uniform2fv(morphProgram.uJoinPoints, state.joinPoints)
  gl.uniform1i(morphProgram.uJoinCount, state.joinCount ?? 0)
  gl.uniform1i(morphProgram.uJoinFrom, state.joinFrom === false ? 0 : 1)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  gl.bindVertexArray(null)
}
