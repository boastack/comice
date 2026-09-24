/**
 * @comice/particles/shader
 * ─────────────────────────────────────────────────────────────────────────────
 * T10 (ROADMAP.md §4): spec §08's `particles` card — "Owns: media as a
 * cloud of points, and media broken into tiles. Both are instanced
 * geometry with velocity and scatter, the only difference is how the
 * instances are produced." Both modes ship: `cloud` (one GL_POINTS
 * instance per sampled pixel) and `shatter` (one small quad instance per
 * sampled pixel, big enough to read as a tile rather than a dot — the
 * literal "the only difference is how the instances are produced" spec
 * line: shatter reuses every uniform/attribute cloud does, just with a
 * quad base-geometry vertex buffer swapped in for a single-point one).
 *
 * THE FIRST INSTANCED-GEOMETRY PRIMITIVE IN THIS REPO — every prior
 * shader plugin (morph, dissolve, distort, color, mosaic, ascii) draws
 * one full-screen quad per frame. Particles draws thousands of small
 * instances in one drawArraysInstanced() call, each instance's own
 * origin/target/color coming from per-instance vertex attributes
 * (vertexAttribDivisor(loc, 1)) rather than a uniform — this is real,
 * new GL surface for this codebase, not a variation on the existing
 * full-screen-quad pattern every other T7-T10 shader.ts file shares.
 *
 * PER-PARTICLE A<->B TARGETS, PER SPEC'S OWN CONSTRAINT: "Each particle
 * carries its destination as well as its origin... that per-particle
 * target is a constraint on the instance buffer layout, which is why it
 * belongs in the spec before the buffer is designed rather than after."
 * `a_origin`/`a_target` are both real per-instance attributes here (not
 * one attribute reused/aliased for both), exactly because of that
 * constraint — a shatter/cloud with no `to` still populates `a_target`
 * with the SAME value as `a_origin` (index.ts's own reassembly default),
 * so the vertex shader's interpolation math never needs a runtime branch
 * for "do I have a target or not."
 *
 * MOTION, PER SPEC'S `{ fluid: true }`: a per-particle curl-noise drift
 * layered on top of the origin->target interpolation, using
 * `gl/noise.ts`'s own `curlNoise()` (T5's divergence-free flow field) —
 * "continuous momentum and surface tension without a full simulation,"
 * spec's own words, is exactly what a curl field gives for free: particles
 * drift along smooth, non-crossing paths without any per-particle
 * velocity integration/state at all.
 */

import { composeNoiseGLSL } from 'comice/gl'
import type { GLContext } from 'comice/gl'

export type ParticlesMode = 'cloud' | 'shatter'

export type ParticlesShaderOptions = {
  mode: ParticlesMode
  fluid?: boolean
}

const VERTEX_SHADER_HEADER = `#version 300 es
in vec2 a_baseVertex;   // base geometry: (0,0) for cloud's single point, a unit-quad corner for shatter
in vec2 a_origin;       // per-instance, UV space 0..1
in vec2 a_target;       // per-instance, UV space 0..1
in vec4 a_color;        // per-instance RGBA, 0..1

uniform float u_progress;      // 0..1, origin->target interpolation
uniform float u_pointSize;     // cloud: point size px. shatter: tile size px.
uniform float u_noiseAmount;   // motion.fluid drift magnitude, UV units
uniform float u_time;          // seconds, drives the curl field's own third dimension

out vec4 v_color;
`

function buildVertexShader(options: ParticlesShaderOptions): string {
  const { mode, fluid = false } = options
  const noiseGLSL = fluid ? composeNoiseGLSL({ curl: true, displacement: false }) : ''

  const driftGLSL = fluid
    ? `
  vec3 flow = curlNoise(vec3(basePos * 6.0, u_time * 0.15));
  basePos += flow.xy * u_noiseAmount;`
    : ''

  if (mode === 'cloud') {
    return `${VERTEX_SHADER_HEADER}
${noiseGLSL}

void main() {
  vec2 basePos = mix(a_origin, a_target, u_progress);
  ${driftGLSL}
  vec2 clip = basePos * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = u_pointSize;
  v_color = a_color;
}`
  }

  // shatter: a_baseVertex carries a unit-quad corner offset (-0.5..0.5),
  // scaled to u_pointSize px and added to the interpolated instance
  // position, so each instance draws as a small tile rather than a point.
  return `${VERTEX_SHADER_HEADER}
uniform vec2 u_resolution;

${noiseGLSL}

void main() {
  vec2 basePos = mix(a_origin, a_target, u_progress);
  ${driftGLSL}
  vec2 tileOffsetPx = a_baseVertex * u_pointSize;
  vec2 tileOffsetUv = tileOffsetPx / u_resolution;
  vec2 finalPos = basePos + tileOffsetUv;
  vec2 clip = finalPos * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}`
}

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
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
  colorBuffer: WebGLBuffer
  uProgress: WebGLUniformLocation | null
  uPointSize: WebGLUniformLocation | null
  uNoiseAmount: WebGLUniformLocation | null
  uTime: WebGLUniformLocation | null
  uResolution: WebGLUniformLocation | null
  mode: ParticlesMode
  baseVertexCount: number
}

const PROGRAM_CACHE = new WeakMap<WebGL2RenderingContext, Map<string, ParticlesProgram | null>>()
// A real bug found running many particles() instances on one real page: two
// instances compiling the same config share ONE cached program (and, for
// particles specifically, its origin/target/color/baseVertex BUFFERS too —
// they're part of the same cached ParticlesProgram object), so the first
// instance to tear down must not delete any of it out from under a
// still-live second instance holding the same reference.
const REFCOUNTS = new WeakMap<WebGL2RenderingContext, Map<string, number>>()

function cacheKey(options: ParticlesShaderOptions): string {
  return `${options.mode}:${options.fluid ?? false}`
}

export function compileParticlesProgram(gl: WebGL2RenderingContext, options: ParticlesShaderOptions): ParticlesProgram | null {
  let byConfig = PROGRAM_CACHE.get(gl)
  if (!byConfig) {
    byConfig = new Map()
    PROGRAM_CACHE.set(gl, byConfig)
  }
  let refcounts = REFCOUNTS.get(gl)
  if (!refcounts) {
    refcounts = new Map()
    REFCOUNTS.set(gl, refcounts)
  }
  const key = cacheKey(options)
  const cached = byConfig.get(key)
  if (cached !== undefined) {
    if (cached !== null) refcounts.set(key, (refcounts.get(key) ?? 0) + 1)
    return cached
  }

  const vertexSource = buildVertexShader(options)
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  if (!vertexShader || !fragmentShader) {
    byConfig.set(key, null)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    byConfig.set(key, null)
    return null
  }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    byConfig.set(key, null)
    return null
  }

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)

  const aBaseVertex = gl.getAttribLocation(program, 'a_baseVertex')
  const aOrigin = gl.getAttribLocation(program, 'a_origin')
  const aTarget = gl.getAttribLocation(program, 'a_target')
  const aColor = gl.getAttribLocation(program, 'a_color')

  // Base geometry: cloud is a single point at (0,0) (one vertex, drawn
  // via gl.POINTS with instancing over origin/target/color); shatter is a
  // unit quad (-0.5..0.5 both axes, drawn via TRIANGLE_STRIP) so each
  // instance covers a small tile rather than a single pixel.
  const baseVertices = options.mode === 'cloud' ? new Float32Array([0, 0]) : new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5])
  const baseVertexCount = options.mode === 'cloud' ? 1 : 4

  const baseVertexBuffer = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, baseVertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, baseVertices, gl.STATIC_DRAW)
  // a_baseVertex is declared in the shared vertex-shader header but only
  // actually READ in the 'shatter' branch's main() — 'cloud' mode's own
  // main() never references it (a single point needs no per-vertex
  // offset). A spec-compliant GLSL compiler is free to optimize out an
  // unused `in` variable entirely, which makes getAttribLocation() return
  // -1 for 'cloud' specifically — confirmed against a real browser's own
  // WebGL2 implementation (not just the fake-GL context this package's
  // unit tests use, which never enforces this). enableVertexAttribArray/
  // vertexAttribPointer both throw INVALID_VALUE on a -1 location, so
  // this guards the same way a caller would guard any "may not exist"
  // attribute — every other shader.ts in this repo never needs this
  // guard because none of them have an attribute a real compiler could
  // legally discard.
  if (aBaseVertex !== -1) {
    gl.enableVertexAttribArray(aBaseVertex)
    gl.vertexAttribPointer(aBaseVertex, 2, gl.FLOAT, false, 0, 0)
  }
  // No divisor on base geometry — every instance re-draws the SAME base
  // vertices (per-vertex, not per-instance).

  const originBuffer = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, originBuffer)
  gl.enableVertexAttribArray(aOrigin)
  gl.vertexAttribPointer(aOrigin, 2, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(aOrigin, 1)

  const targetBuffer = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, targetBuffer)
  gl.enableVertexAttribArray(aTarget)
  gl.vertexAttribPointer(aTarget, 2, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(aTarget, 1)

  const colorBuffer = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer)
  gl.enableVertexAttribArray(aColor)
  gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(aColor, 1)

  gl.bindVertexArray(null)

  const result: ParticlesProgram = {
    program,
    vao,
    baseVertexBuffer,
    originBuffer,
    targetBuffer,
    colorBuffer,
    uProgress: gl.getUniformLocation(program, 'u_progress'),
    uPointSize: gl.getUniformLocation(program, 'u_pointSize'),
    uNoiseAmount: gl.getUniformLocation(program, 'u_noiseAmount'),
    uTime: gl.getUniformLocation(program, 'u_time'),
    uResolution: gl.getUniformLocation(program, 'u_resolution'),
    mode: options.mode,
    baseVertexCount,
  }
  byConfig.set(key, result)
  refcounts.set(key, 1) // this compile call is itself the first live reference
  return result
}

export function destroyParticlesProgram(gl: WebGL2RenderingContext, particlesProgram: ParticlesProgram): void {
  const byConfig = PROGRAM_CACHE.get(gl)
  const refcounts = REFCOUNTS.get(gl)
  const key = byConfig ? [...byConfig.entries()].find(([, program]) => program === particlesProgram)?.[0] : undefined

  if (key !== undefined && refcounts) {
    const remaining = (refcounts.get(key) ?? 1) - 1
    if (remaining > 0) {
      refcounts.set(key, remaining)
      return // other instances still hold this program (and its buffers) — do not delete it
    }
    refcounts.delete(key)
    byConfig?.delete(key)
  }

  gl.deleteProgram(particlesProgram.program)
  gl.deleteVertexArray(particlesProgram.vao)
  gl.deleteBuffer(particlesProgram.baseVertexBuffer)
  gl.deleteBuffer(particlesProgram.originBuffer)
  gl.deleteBuffer(particlesProgram.targetBuffer)
  gl.deleteBuffer(particlesProgram.colorBuffer)
}

/** Uploads origin/target/color instance buffers — called once per
 *  from/to change (setup, or a runtime source swap), never per frame,
 *  same "upload once, draw many" discipline every instanced-geometry
 *  API (WebGL or otherwise) is built around. */
export function uploadParticleBuffers(gl: WebGL2RenderingContext, particlesProgram: ParticlesProgram, origins: Float32Array, targets: Float32Array, colors: Float32Array): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, particlesProgram.originBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, origins, gl.DYNAMIC_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, particlesProgram.targetBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, targets, gl.DYNAMIC_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, particlesProgram.colorBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW)
}

export type ParticlesDrawState = {
  progress: number
  pointSize: number
  noiseAmount: number
  time: number
  resolutionWidth: number
  resolutionHeight: number
  instanceCount: number
}

/**
 * Draws one particles pass via drawArraysInstanced(). Assumes the caller
 * has already uploaded buffers via uploadParticleBuffers() and, if this
 * draw participates in the shared texture-unit budget (it doesn't — no
 * texture sampling happens in this shader at all, every color comes from
 * a per-instance vertex attribute), would have called beginPass(). No
 * ResidencyPool interaction here for exactly that reason: particles is
 * the first shader plugin in this repo with zero texture reads.
 *
 * Returns without drawing, never throwing, if instanceCount is 0 (no
 * particles sampled yet, or a zero-count configuration).
 */
export function drawParticles(context: GLContext, particlesProgram: ParticlesProgram, state: ParticlesDrawState): void {
  if (state.instanceCount <= 0) return

  const { gl } = context
  gl.useProgram(particlesProgram.program)
  gl.bindVertexArray(particlesProgram.vao)

  gl.uniform1f(particlesProgram.uProgress, state.progress)
  gl.uniform1f(particlesProgram.uPointSize, state.pointSize)
  gl.uniform1f(particlesProgram.uNoiseAmount, state.noiseAmount)
  gl.uniform1f(particlesProgram.uTime, state.time)
  if (particlesProgram.uResolution) {
    gl.uniform2f(particlesProgram.uResolution, state.resolutionWidth, state.resolutionHeight)
  }

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  const primitive = particlesProgram.mode === 'cloud' ? gl.POINTS : gl.TRIANGLE_STRIP
  gl.drawArraysInstanced(primitive, 0, particlesProgram.baseVertexCount, state.instanceCount)

  gl.bindVertexArray(null)
}
