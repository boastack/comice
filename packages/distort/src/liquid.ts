/**
 * @comice/distort/liquid
 * ─────────────────────────────────────────────────────────────────────────────
 * The memory behind distort's 'liquid' effect. Spec §08: liquid "pushes
 * [the pixels], carrying momentum so the surface settles after the cursor
 * has gone." A single shader can't remember the last frame, so this keeps a
 * displacement field in core's temporal feedback buffer (gl/feedback.ts,
 * spec §07 — its first consumer): every frame the step pass reads the
 * previous field, decays it, adds a push where the pointer is moving (in the
 * direction it's moving), and writes the result. distort's main pass then
 * samples the media offset by that field.
 *
 * The field is stored around 0.5 in an 8-bit RGBA texture (0.5 = no push),
 * so it's cleared to 0.5 when created.
 */

import { createFeedbackBuffer, effectiveDPR, type GLContext } from 'comice/gl'

const STEP_VERTEX = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

export const LIQUID_STEP_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_previous;
uniform vec2 u_pointer;     // uv, y up
uniform vec2 u_velocity;    // uv per frame, y up
uniform float u_radius;     // in units of the height
uniform float u_strength;
uniform float u_active;     // 0 when the pointer is away (or reduced motion)
uniform float u_aspect;
uniform float u_decay;
void main() {
  vec2 previous = texture(u_previous, v_uv).rg - 0.5;
  float distanceToPointer = length((v_uv - u_pointer) * vec2(u_aspect, 1.0));
  float weight = (1.0 - smoothstep(0.0, u_radius, distanceToPointer)) * u_active;
  vec2 next = previous * u_decay + u_velocity * weight * u_strength * 6.0;
  outColor = vec4(clamp(next, -0.5, 0.5) + 0.5, 0.0, 1.0);
}`

/** Per frame, the field keeps this much of itself: the surface settles over
 *  roughly a second at 60fps rather than snapping still. */
const DECAY = 0.94

export type LiquidStepState = {
  pointerX: number
  pointerY: number
  velocityX: number
  velocityY: number
  radius: number
  strength: number
  active: boolean
  aspect: number
}

export type LiquidField = {
  /** The current field, for distort's main pass. */
  readonly texture: WebGLTexture
  /** Advances the field one frame. Leaves the canvas viewport as it found it. */
  step(state: LiquidStepState): void
  resize(cssWidth: number, cssHeight: number): void
  destroy(): void
}

/** Null when the GPU can't hold it (no program, no buffer) — distort then
 *  reports the failure like any compile failure. */
export function createLiquidField(context: GLContext, cssWidth: number, cssHeight: number): LiquidField | null {
  const { gl } = context
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
    gl.deleteShader(shader)
    return null
  }
  const vs = compile(gl.VERTEX_SHADER, STEP_VERTEX)
  const fs = compile(gl.FRAGMENT_SHADER, LIQUID_STEP_SHADER)
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

  // A quarter of the media's size: the field is smooth, and this pass runs
  // every visible frame.
  const buffer = createFeedbackBuffer(context, cssWidth / 4, cssHeight / 4)
  if (!buffer.read.texture) {
    gl.deleteProgram(program)
    return null
  }

  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const aPosition = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  const at = (name: string) => gl.getUniformLocation(program, name)
  const u = {
    previous: at('u_previous'),
    pointer: at('u_pointer'),
    velocity: at('u_velocity'),
    radius: at('u_radius'),
    strength: at('u_strength'),
    active: at('u_active'),
    aspect: at('u_aspect'),
    decay: at('u_decay'),
  }

  /** Both halves of the ping-pong to "no push". */
  function clearToNeutral(): void {
    gl.clearColor(0.5, 0.5, 0, 1)
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.write.framebuffer)
      gl.clear(gl.COLOR_BUFFER_BIT)
      buffer.swap()
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.clearColor(0, 0, 0, 0)
  }
  clearToNeutral()

  // The buffer's pixel size, which the step pass's viewport must match:
  // feedback.ts sizes by CSS size x effectiveDPR, so the viewport does too.
  const pixels = (css: number) => Math.max(1, Math.round((css / 4) * effectiveDPR()))
  let width = pixels(cssWidth)
  let height = pixels(cssHeight)

  return {
    get texture() {
      return buffer.read.texture
    },
    step(state): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.write.framebuffer)
      gl.viewport(0, 0, width, height)
      gl.disable(gl.BLEND)
      gl.useProgram(program)
      gl.bindVertexArray(vao)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, buffer.read.texture)
      gl.uniform1i(u.previous, 0)
      gl.uniform2f(u.pointer, state.pointerX, state.pointerY)
      gl.uniform2f(u.velocity, state.velocityX, state.velocityY)
      gl.uniform1f(u.radius, state.radius)
      gl.uniform1f(u.strength, state.strength)
      gl.uniform1f(u.active, state.active ? 1 : 0)
      gl.uniform1f(u.aspect, state.aspect)
      gl.uniform1f(u.decay, DECAY)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.bindVertexArray(null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      // Back to the full canvas. Leaving the field's small viewport set made
      // the next frame draw into a corner — the exact bug aura's downsample
      // had on a shared context.
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      buffer.swap()
    },
    resize(cssWidthNext, cssHeightNext): void {
      const nextWidth = pixels(cssWidthNext)
      const nextHeight = pixels(cssHeightNext)
      if (nextWidth === width && nextHeight === height) return
      width = nextWidth
      height = nextHeight
      buffer.resize(cssWidthNext / 4, cssHeightNext / 4)
      clearToNeutral()
    },
    destroy(): void {
      buffer.destroy()
      gl.deleteProgram(program)
      gl.deleteVertexArray(vao)
    },
  }
}
