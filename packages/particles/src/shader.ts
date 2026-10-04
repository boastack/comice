/**
 * @comice/particles/shader
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec §08: "media as a cloud of points, and media broken into tiles. Both
 * are instanced geometry with velocity and scatter, the only difference is
 * how the instances are produced." `cloud` draws one point per instance,
 * `shatter` one textured tile; both share every attribute and uniform.
 *
 * PER-PARTICLE A<->B: `a_origin` and `a_target` are both per-instance
 * attributes (the spec: "each particle carries its destination as well as
 * its origin... a constraint on the instance buffer layout"). With no
 * `to`, target === origin, and the image reforms exactly.
 *
 * IN FLIGHT: everything that isn't the straight A->B path — the scatter
 * (each instance's own direction, from a hash of gl_InstanceID), the curl-
 * noise drift (`motion.noise`, gl/noise.ts: smooth, non-crossing paths with
 * no simulation state — "continuous momentum and surface tension without a
 * full simulation") and a tile's spin — is scaled by sin(pi * progress).
 * So both ends land pixel-exact, and A -> A still breaks apart and comes
 * back. It used to be a straight mix(): A -> A never moved at all, and the
 * drift ran even at rest.
 *
 * COLOUR COMES FROM THE SOURCE TEXTURES (sampler.ts's stage-shaped
 * canvases): a point reads its colour in the vertex shader, a tile samples
 * its own piece of the picture in the fragment shader — "a hero image that
 * breaks into a hundred squares" means squares OF the image (they used to
 * be single-colour dots), and a video source stays live.
 */

import { composeNoiseGLSL } from 'comice/gl'
import type { GLContext } from 'comice/gl'

export type ParticlesMode = 'cloud' | 'shatter'

const HEADER = `#version 300 es
in vec2 a_baseVertex;   // shatter: a unit-quad corner (-0.5..0.5); cloud: unused
in vec2 a_origin;       // per instance, UV (y down)
in vec2 a_target;       // per instance, UV (y down)

uniform float u_progress;      // 0..1, origin -> target
uniform float u_pointSize;     // cloud: point size, device px
uniform float u_noiseAmount;   // drift, UV
uniform float u_scatter;       // how far instances fly apart mid-flight, UV
uniform float u_time;          // seconds, the drift field's third dimension
uniform vec2 u_cell;           // one grid cell, UV: a shatter tile's size
uniform vec2 u_resolution;     // the stage, CSS px
uniform sampler2D u_from;
uniform sampler2D u_to;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

${composeNoiseGLSL({ curl: true, displacement: false })}

// Where this instance is, in UV: the A -> B path plus everything in flight.
vec2 flightPosition(float flight) {
  float id = float(gl_InstanceID);
  float angle = hash(id * 1.31 + 0.17) * 6.2831853;
  float reach = 0.35 + 0.65 * hash(id * 2.71 + 0.53);
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 pos = mix(a_origin, a_target, u_progress);
  pos += vec2(cos(angle), sin(angle) * aspect) * reach * u_scatter * flight;
  vec3 flow = curlNoise(vec3(pos * 6.0, u_time * 0.15));
  pos += flow.xy * u_noiseAmount * flight;
  return pos;
}

vec4 toClip(vec2 uv) {
  return vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}
`

const CLOUD_VERTEX = `${HEADER}
out vec4 v_color;
void main() {
  float flight = sin(3.14159265 * u_progress);
  gl_Position = toClip(flightPosition(flight));
  gl_PointSize = u_pointSize;
  v_color = mix(textureLod(u_from, a_origin, 0.0), textureLod(u_to, a_target, 0.0), u_progress);
}`

const CLOUD_FRAGMENT = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}`

const SHATTER_VERTEX = `${HEADER}
out vec2 v_uvFrom;
out vec2 v_uvTo;
void main() {
  float flight = sin(3.14159265 * u_progress);
  float spin = (hash(float(gl_InstanceID) * 3.17 + 0.91) - 0.5) * 3.14159265 * flight;
  // The tile in px (so it spins without shearing on a wide stage), a
  // little smaller in flight so the pieces read as pieces.
  vec2 px = a_baseVertex * u_cell * u_resolution * (1.0 - 0.12 * flight);
  px = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * px;
  gl_Position = toClip(flightPosition(flight) + px / u_resolution);
  v_uvFrom = a_origin + a_baseVertex * u_cell;
  v_uvTo = a_target + a_baseVertex * u_cell;
}`

// highp: u_progress is shared with the vertex shader (highp by default),
// and a uniform's precision must match across stages or the link fails.
const SHATTER_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
in vec2 v_uvFrom;
in vec2 v_uvTo;
out vec4 outColor;
void main() {
  outColor = mix(texture(u_from, v_uvFrom), texture(u_to, v_uvTo), smoothstep(0.3, 0.7, u_progress));
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

export type ParticlesProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  baseVertexBuffer: WebGLBuffer
  originBuffer: WebGLBuffer
  targetBuffer: WebGLBuffer
  uniforms: Record<'progress' | 'pointSize' | 'noiseAmount' | 'scatter' | 'time' | 'cell' | 'resolution' | 'from' | 'to', WebGLUniformLocation | null>
  mode: ParticlesMode
  baseVertexCount: number
}

export function compileParticlesProgram(gl: WebGL2RenderingContext, mode: ParticlesMode): ParticlesProgram | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, mode === 'cloud' ? CLOUD_VERTEX : SHATTER_VERTEX)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, mode === 'cloud' ? CLOUD_FRAGMENT : SHATTER_FRAGMENT)
  if (!vertexShader || !fragmentShader) return null

  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }

  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)

  // Base geometry: cloud is one point; shatter a unit quad (strip).
  const baseVertices = mode === 'cloud' ? new Float32Array([0, 0]) : new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5])
  const baseVertexBuffer = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, baseVertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, baseVertices, gl.STATIC_DRAW)
  // cloud never reads a_baseVertex, and a real compiler drops an unused
  // attribute (location -1, which vertexAttribPointer rejects) — found in
  // a real browser, not the fake GL.
  const aBaseVertex = gl.getAttribLocation(program, 'a_baseVertex')
  if (aBaseVertex !== -1) {
    gl.enableVertexAttribArray(aBaseVertex)
    gl.vertexAttribPointer(aBaseVertex, 2, gl.FLOAT, false, 0, 0)
  }

  const instanceBuffer = (name: string): WebGLBuffer => {
    const buffer = gl.createBuffer()!
    const location = gl.getAttribLocation(program, name)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(location, 1)
    return buffer
  }
  const originBuffer = instanceBuffer('a_origin')
  const targetBuffer = instanceBuffer('a_target')
  gl.bindVertexArray(null)

  const at = (name: string) => gl.getUniformLocation(program, name)
  return {
    program,
    vao,
    baseVertexBuffer,
    originBuffer,
    targetBuffer,
    uniforms: {
      progress: at('u_progress'),
      pointSize: at('u_pointSize'),
      noiseAmount: at('u_noiseAmount'),
      scatter: at('u_scatter'),
      time: at('u_time'),
      cell: at('u_cell'),
      resolution: at('u_resolution'),
      from: at('u_from'),
      to: at('u_to'),
    },
    mode,
    baseVertexCount: mode === 'cloud' ? 1 : 4,
  }
}

export function destroyParticlesProgram(gl: WebGL2RenderingContext, particlesProgram: ParticlesProgram): void {
  gl.deleteProgram(particlesProgram.program)
  gl.deleteVertexArray(particlesProgram.vao)
  gl.deleteBuffer(particlesProgram.baseVertexBuffer)
  gl.deleteBuffer(particlesProgram.originBuffer)
  gl.deleteBuffer(particlesProgram.targetBuffer)
}

/** Uploads the per-instance origins and targets — once per source or box
 *  change, never per frame. */
export function uploadParticleBuffers(gl: WebGL2RenderingContext, particlesProgram: ParticlesProgram, origins: Float32Array, targets: Float32Array): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, particlesProgram.originBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, origins, gl.DYNAMIC_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, particlesProgram.targetBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, targets, gl.DYNAMIC_DRAW)
}

/** A texture for one source's stage-shaped canvas. */
export function createSourceTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  return texture
}

/** (Re)uploads `canvas` into `texture`. Row 0 stays the top: particle UVs
 *  are y-down, like the canvas. */
export function uploadSourceTexture(gl: WebGL2RenderingContext, texture: WebGLTexture, canvas: HTMLCanvasElement): void {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
}

export type ParticlesDrawState = {
  progress: number
  /** cloud's point size, device px. */
  pointSize: number
  noiseAmount: number
  scatter: number
  time: number
  /** One grid cell, UV. */
  cell: readonly [number, number]
  resolutionWidth: number
  resolutionHeight: number
  instanceCount: number
  from: WebGLTexture
  to: WebGLTexture
}

/** Clears and draws one frame. Draws nothing while there are no instances
 *  (sources still loading, or all transparent). */
export function drawParticles(context: GLContext, particlesProgram: ParticlesProgram, state: ParticlesDrawState): void {
  const { gl } = context
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  if (state.instanceCount <= 0) return

  gl.useProgram(particlesProgram.program)
  gl.bindVertexArray(particlesProgram.vao)
  const u = particlesProgram.uniforms
  gl.uniform1f(u.progress, state.progress)
  gl.uniform1f(u.pointSize, state.pointSize)
  gl.uniform1f(u.noiseAmount, state.noiseAmount)
  gl.uniform1f(u.scatter, state.scatter)
  gl.uniform1f(u.time, state.time)
  gl.uniform2f(u.cell, state.cell[0], state.cell[1])
  gl.uniform2f(u.resolution, state.resolutionWidth, state.resolutionHeight)
  // This context is the element's alone (mountCanvas), so units 0 and 1
  // are free.
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, state.from)
  gl.uniform1i(u.from, 0)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, state.to)
  gl.uniform1i(u.to, 1)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArraysInstanced(particlesProgram.mode === 'cloud' ? gl.POINTS : gl.TRIANGLE_STRIP, 0, particlesProgram.baseVertexCount, state.instanceCount)
  gl.bindVertexArray(null)
}
