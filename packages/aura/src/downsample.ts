/**
 * @comice/aura/downsample
 * ─────────────────────────────────────────────────────────────────────────────
 * A tiny offscreen framebuffer that draws a Plane's media texture down to
 * a small fixed size (DOWNSAMPLE_SIZE^2), then reads it back via
 * readPixels() for sample.ts's CPU-side color math to consume. Same
 * "private framebuffer, not the shared ResidencyPool" reasoning
 * gl/mask.ts's own createDerivedMask() uses for its reduction pass — this
 * is an offscreen render target with its own bind/unbind cycle, not an
 * on-screen draw competing for the pool's per-frame texture-unit budget.
 *
 * WHY DOWNSAMPLE AT ALL, RATHER THAN readPixels() ON THE FULL FRAME:
 * aura only ever needs a handful of averaged/clustered colors, never
 * per-pixel fidelity — reading back a full 1920x1080 frame every tick to
 * average it down to 5 colors would be enormously wasteful GPU->CPU
 * bandwidth for no visual benefit; a 32x32 downsample already carries
 * more color information than any of sample.ts's functions need.
 */

const DOWNSAMPLE_SIZE = 32

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_source;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = texture(u_source, v_uv);
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

type DownsampleProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  uSource: WebGLUniformLocation | null
}

const PROGRAM_CACHE = new WeakMap<WebGL2RenderingContext, DownsampleProgram | null>()

function getDownsampleProgram(gl: WebGL2RenderingContext): DownsampleProgram | null {
  const cached = PROGRAM_CACHE.get(gl)
  if (cached !== undefined) return cached

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  if (!vertexShader || !fragmentShader) {
    PROGRAM_CACHE.set(gl, null)
    return null
  }
  const program = gl.createProgram()
  if (!program) {
    PROGRAM_CACHE.set(gl, null)
    return null
  }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    PROGRAM_CACHE.set(gl, null)
    return null
  }

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
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

  const result: DownsampleProgram = { program, vao, uSource: gl.getUniformLocation(program, 'u_source') }
  PROGRAM_CACHE.set(gl, result)
  return result
}

export type Downsampler = {
  /** Draws `sourceTexture` down to the internal DOWNSAMPLE_SIZE^2 target
   *  and reads it back. Returns null, never throws, on any GL failure
   *  (no program, no framebuffer support) — degrade-never-disappear. */
  sample(sourceTexture: WebGLTexture): { width: number; height: number; pixels: Uint8ClampedArray } | null
  destroy(): void
}

/** Creates a reusable downsampler against one WebGL2 context — the
 *  framebuffer/texture are allocated once here, never per sample() call,
 *  matching every other primitive's "allocate at setup, never in the
 *  render loop" discipline. */
export function createDownsampler(gl: WebGL2RenderingContext): Downsampler {
  const texture = gl.createTexture()
  const framebuffer = gl.createFramebuffer()
  let destroyed = false

  if (texture && framebuffer) {
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, DOWNSAMPLE_SIZE, DOWNSAMPLE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  return {
    sample(sourceTexture: WebGLTexture) {
      if (destroyed || !texture || !framebuffer) return null
      const program = getDownsampleProgram(gl)
      if (!program) return null

      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.viewport(0, 0, DOWNSAMPLE_SIZE, DOWNSAMPLE_SIZE)
      gl.useProgram(program.program)
      gl.bindVertexArray(program.vao)

      // A private, fixed unit for this offscreen pass's one input — same
      // reasoning gl/mask.ts's own reduce() uses for not going through
      // the shared ResidencyPool here.
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
      gl.uniform1i(program.uSource, 0)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      const pixels = new Uint8ClampedArray(DOWNSAMPLE_SIZE * DOWNSAMPLE_SIZE * 4)
      gl.readPixels(0, 0, DOWNSAMPLE_SIZE, DOWNSAMPLE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

      gl.bindVertexArray(null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      // Restore the full-canvas viewport. The context is shared per element,
      // so when aura samples an element another plugin draws on (the stress
      // page's hero), leaving the 32x32 viewport set made that plugin's next
      // frames render into a 32x32 corner — resizeToDisplay() only resets
      // the viewport when the canvas SIZE changes, which it hadn't.
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)

      return { width: DOWNSAMPLE_SIZE, height: DOWNSAMPLE_SIZE, pixels }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      if (framebuffer) gl.deleteFramebuffer(framebuffer)
      if (texture) gl.deleteTexture(texture)
    },
  }
}
