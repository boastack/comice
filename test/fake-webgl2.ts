/**
 * test/fake-webgl2 — a minimal WebGL2RenderingContext stand-in
 * ─────────────────────────────────────────────────────────────────────────────
 * happy-dom's canvas.getContext('webgl2') returns null (no WebGL2
 * implementation at all — see gl-context.test.ts, which tests exactly that
 * as the real fallback path). That leaves plane.ts's actual GL-touching
 * code (shader compile/link, texture upload, draw calls) with nothing real
 * to run against in this test environment.
 *
 * This fake is not a WebGL2 emulator — it does no rasterization and tracks
 * no pixels. It implements just enough of the interface surface plane.ts
 * calls, with configurable failure points, so plane.ts's own logic (upload
 * gating, program caching, error-path fallbacks) gets exercised against
 * realistic call sequences instead of being unreachable in this suite.
 */

export type FakeGLOptions = {
  /** Make compileShader report failure (getShaderParameter returns false). */
  failShaderCompile?: boolean
  /** Make linkProgram report failure (getProgramParameter returns false). */
  failProgramLink?: boolean
  /** Make texImage2D throw, simulating a CORS-tainted canvas. */
  failTexImage?: boolean
  /** Make createProgram() return null, simulating a context that fails to
   *  allocate a program object at all (distinct from a program that links
   *  successfully but reports a failed LINK_STATUS). */
  failCreateProgram?: boolean
  /** Make getExtension('WEBGL_lose_context') return a real extension
   *  object with a spyable loseContext(), instead of the default null
   *  (simulating a browser that doesn't expose the extension). */
  withLoseContextExtension?: boolean
  /** What getParameter(MAX_TEXTURE_IMAGE_UNITS) reports. Default 16 (the
   *  WebGL2 spec's guaranteed minimum), overridable so residency.test.ts
   *  can exercise a small ceiling without allocating 16+ fake textures. */
  maxTextureUnits?: number
  /** Make getParameter return an invalid value (not a finite positive
   *  number) for MAX_TEXTURE_IMAGE_UNITS, simulating a context that
   *  misbehaves on that query — exercises residency.ts's fallback floor. */
  invalidMaxTextureUnits?: boolean
  /** Make createFramebuffer() return null, simulating a context that fails
   *  to allocate a framebuffer object — exercises mask.ts's render-target
   *  allocation failure path. */
  failCreateFramebuffer?: boolean
  /** Make createTexture() return null (distinct from failCreateFramebuffer
   *  — exercises the "texture allocation failed" half of the same
   *  render-target failure path independently). */
  failCreateTexture?: boolean
}

/** Mutable box a caller can pass in to observe whether the fake's
 *  WEBGL_lose_context.loseContext() was actually invoked — used instead of
 *  a mocking library, matching this file's "minimal fake, not an emulator"
 *  approach. */
export type LoseContextSpy = { called: boolean }

export function createFakeGL2(
  options: FakeGLOptions = {},
  loseContextSpy?: LoseContextSpy,
): WebGL2RenderingContext {
  let shaderId = 0
  let objectId = 0
  // Concatenated source of every shader compiled against this fake context
  // — used by getAttribLocation() below to catch a real, browser-observed
  // bug class this fake previously couldn't: a GLSL `in` attribute
  // declared but never actually READ in a shader's main() (only ever
  // referenced in its own `in vec2 a_x;` declaration line) is legal to
  // optimize away entirely under the spec, and a real compiler may do
  // exactly that — getAttribLocation() then returns -1, and the WebGL2
  // spec makes enableVertexAttribArray(-1)/vertexAttribPointer(-1, ...)
  // both throw INVALID_VALUE. This was caught for real against an actual
  // browser (packages/particles/src/shader.ts's 'cloud' mode, where
  // a_baseVertex is declared but unused — see that fix's own commit) and
  // the previous version of this fake (getAttribLocation always
  // returning 0) could never have caught it, since it tracked no shader
  // source at all. Deliberately NOT a real GLSL parser — a whole-word
  // regex match against the concatenated source, excluding each
  // attribute's own `in vec2 a_x;`-style declaration line, is enough to
  // catch "never read anywhere else" without the cost/fragility of
  // actually parsing GLSL.
  let allShaderSource = ''

  // UNPACK_FLIP_Y_WEBGL is sticky context state, and every media/mask
  // upload must happen with it ON (and leave it OFF after) — the real bug
  // being guarded: without it every GL plugin drew media upside down, which
  // a fake that ignores pixelStorei could never have shown. __uploadFlips
  // records the flag's value at the moment of each texImage2D, and
  // __flipY its current value, so a test can assert both.
  let flipY = false
  const uploadFlips: boolean[] = []

  function isAttributeReferencedOutsideItsDeclaration(name: string): boolean {
    const declarationLine = new RegExp(`^\\s*in\\s+\\S+\\s+${name}\\s*;`, 'm')
    const withoutDeclarations = allShaderSource.replace(declarationLine, '')
    const wholeWordUse = new RegExp(`\\b${name}\\b`)
    return wholeWordUse.test(withoutDeclarations)
  }

  const gl = {
    // Constants plane.ts references. Values are arbitrary but distinct.
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TEXTURE_2D: 8,
    TEXTURE_WRAP_S: 9,
    TEXTURE_WRAP_T: 10,
    CLAMP_TO_EDGE: 11,
    TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13,
    LINEAR: 14,
    RGBA: 15,
    UNSIGNED_BYTE: 16,
    TEXTURE0: 17,
    BLEND: 18,
    ONE: 19,
    ONE_MINUS_SRC_ALPHA: 20,
    TRIANGLES: 21,
    MAX_TEXTURE_IMAGE_UNITS: 22,
    TRIANGLE_STRIP: 23,
    FRAMEBUFFER: 24,
    COLOR_ATTACHMENT0: 25,
    R8: 26,
    RED: 27,
    RGBA8: 28,
    UNPACK_ALIGNMENT: 29,
    UNPACK_FLIP_Y_WEBGL: 30,
    COLOR_BUFFER_BIT: 31,

    get __flipY() {
      return flipY
    },
    __uploadFlips: uploadFlips,

    // residency.ts only ever queries MAX_TEXTURE_IMAGE_UNITS through this
    // fake — no branch for other pnames, since nothing in this package
    // calls getParameter with anything else, and an unreachable branch
    // here would just be dead code the coverage floor would then demand
    // a test for no production code actually exercises.
    getParameter(_pname: number) {
      if (options.invalidMaxTextureUnits) return null
      return options.maxTextureUnits ?? 16
    },
    viewport(_x: number, _y: number, _width: number, _height: number) {},
    clearColor(_r: number, _g: number, _b: number, _a: number) {},
    clear(_mask: number) {},
    pixelStorei(pname: number, param: number | boolean) {
      if (pname === 30) flipY = !!param
    },

    createShader(_type: number) {
      return { __id: `shader${objectId++}` } as unknown as WebGLShader
    },
    shaderSource(_shader: WebGLShader, source: string) {
      allShaderSource += `\n${source}`
    },
    compileShader(_shader: WebGLShader) {
      shaderId++
    },
    getShaderParameter(_shader: WebGLShader, _pname: number) {
      return !options.failShaderCompile
    },
    deleteShader(_shader: WebGLShader) {},

    createProgram() {
      if (options.failCreateProgram) return null
      return { __id: `program${objectId++}` } as unknown as WebGLProgram
    },
    attachShader(_program: WebGLProgram, _shader: WebGLShader) {},
    linkProgram(_program: WebGLProgram) {},
    getProgramParameter(_program: WebGLProgram, _pname: number) {
      return !options.failProgramLink
    },
    deleteProgram(_program: WebGLProgram) {},
    useProgram(_program: WebGLProgram | null) {},

    createVertexArray() {
      return { __id: `vao${objectId++}` } as unknown as WebGLVertexArrayObject
    },
    bindVertexArray(_vao: WebGLVertexArrayObject | null) {},
    deleteVertexArray(_vao: WebGLVertexArrayObject | null) {},

    createBuffer() {
      return { __id: `buffer${objectId++}` } as unknown as WebGLBuffer
    },
    bindBuffer(_target: number, _buffer: WebGLBuffer | null) {},
    bufferData(_target: number, _data: BufferSource, _usage: number) {},
    deleteBuffer(_buffer: WebGLBuffer | null) {},

    getAttribLocation(_program: WebGLProgram, name: string) {
      // A real GLSL compiler may optimize away an `in` attribute that's
      // declared but never read anywhere else in the shader — see the
      // allShaderSource comment above for the real bug this catches.
      if (allShaderSource && !isAttributeReferencedOutsideItsDeclaration(name)) return -1
      return 0
    },
    enableVertexAttribArray(index: number) {
      if (index === -1) throw new Error('WebGL: INVALID_VALUE: enableVertexAttribArray: index out of range (fake)')
    },
    vertexAttribPointer(
      index: number,
      _size: number,
      _type: number,
      _normalized: boolean,
      _stride: number,
      _offset: number,
    ) {
      if (index === -1) throw new Error('WebGL: INVALID_VALUE: vertexAttribPointer: index out of range (fake)')
    },

    getUniformLocation(_program: WebGLProgram, name: string) {
      return { __id: name } as unknown as WebGLUniformLocation
    },
    uniform2f(_loc: WebGLUniformLocation | null, _x: number, _y: number) {},
    uniform1i(_loc: WebGLUniformLocation | null, _v: number) {},
    uniform1iv(_loc: WebGLUniformLocation | null, _v: number[] | Int32Array) {},

    createTexture() {
      if (options.failCreateTexture) return null
      return { __id: `texture${objectId++}` } as unknown as WebGLTexture
    },
    deleteTexture(_texture: WebGLTexture | null) {},
    bindTexture(_target: number, _texture: WebGLTexture | null) {},
    texParameteri(_target: number, _pname: number, _param: number) {},
    texImage2D(..._args: unknown[]) {
      uploadFlips.push(flipY)
      if (options.failTexImage) throw new Error('tainted canvas (fake)')
    },

    createFramebuffer() {
      if (options.failCreateFramebuffer) return null
      return { __id: `framebuffer${objectId++}` } as unknown as WebGLFramebuffer
    },
    deleteFramebuffer(_framebuffer: WebGLFramebuffer | null) {},
    bindFramebuffer(_target: number, _framebuffer: WebGLFramebuffer | null) {},
    framebufferTexture2D(
      _target: number,
      _attachment: number,
      _textarget: number,
      _texture: WebGLTexture | null,
      _level: number,
    ) {},

    uniform1f(_loc: WebGLUniformLocation | null, _v: number) {},
    uniform3fv(_loc: WebGLUniformLocation | null, _v: Float32Array | number[]) {},
    uniformMatrix3fv(_loc: WebGLUniformLocation | null, _transpose: boolean, _value: Float32Array | number[]) {},

    activeTexture(_unit: number) {},
    enable(_cap: number) {},
    disable(_cap: number) {},
    blendFunc(_sfactor: number, _dfactor: number) {},
    drawArrays(_mode: number, _first: number, _count: number) {},
    // Instanced drawing — @comice/particles's shader.ts is the first
    // consumer of any of these three in this codebase (see its own file
    // header). Trivial no-ops/fixed-shape returns are enough: nothing in
    // this repo's tests reads GPU pixel output back for real, only
    // exercises that the call sequence doesn't throw.
    drawArraysInstanced(_mode: number, _first: number, _count: number, _instanceCount: number) {},
    vertexAttribDivisor(_index: number, _divisor: number) {},
    readPixels(_x: number, _y: number, width: number, height: number, _format: number, _type: number, pixels: ArrayBufferView) {
      // Leaves `pixels` zeroed (its already-allocated initial state) —
      // callers (aura's downsample.ts) only need a same-shaped buffer
      // back, never real rendered content, under this fake.
      void width
      void height
    },

    getExtension(name: string) {
      if (name === 'WEBGL_lose_context' && options.withLoseContextExtension) {
        return {
          loseContext() {
            if (loseContextSpy) loseContextSpy.called = true
          },
        }
      }
      return null
    },
  }

  return gl as unknown as WebGL2RenderingContext
}

/**
 * A minimal CanvasRenderingContext2D stand-in — happy-dom's own
 * getContext('2d') is unconditionally null (no 2D canvas implementation at
 * all, unlike WebGL2 which at least returns null predictably), and
 * `Path2D` doesn't exist as a global. mask.ts's createRasterizedMask()
 * uses both for real in a browser, so this fake exists to exercise that
 * success path here, the same reasoning as createFakeGL2 above. Tracks
 * just enough call history (fillText/fill args) for a test to assert
 * rasterize() actually drove the 2D context, without rendering real pixels.
 */
export type Fake2DCallLog = {
  filledPaths: number
  filledTexts: string[]
}

export type Fake2DOptions = {
  /**
   * Pixel alpha value (0-255) getImageData() reports for every pixel —
   * exercises mask.ts's SDF bake path (bakeSignedDistanceField()'s own
   * `alpha > 96` inside/outside threshold) against a controllable "shape
   * covers everything" (255) vs "shape covers nothing" (0) input, without
   * this fake needing to actually rasterize a Path2D/text glyph, which
   * happy-dom has no support for at all. Default 255 (fully inside),
   * matching "something was drawn here."
   */
  imageDataAlpha?: number
}

export function installFake2DContext(options: Fake2DOptions = {}): { callLog: Fake2DCallLog; uninstall(): void } {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalPath2D = (globalThis as any).Path2D
  const callLog: Fake2DCallLog = { filledPaths: 0, filledTexts: [] }
  const alpha = options.imageDataAlpha ?? 255

  class FakePath2D {
    constructor(_d?: string) {}
  }
  ;(globalThis as any).Path2D = FakePath2D

  ;(HTMLCanvasElement.prototype as any).getContext = function (type: string, ...rest: unknown[]) {
    if (type !== '2d') return originalGetContext.call(this, type, ...rest)
    return {
      clearRect(_x: number, _y: number, _w: number, _h: number) {},
      fillStyle: '#000',
      font: '10px sans-serif',
      textBaseline: 'alphabetic' as CanvasTextBaseline,
      fill(_path: unknown) {
        callLog.filledPaths += 1
      },
      fillText(text: string, _x: number, _y: number) {
        callLog.filledTexts.push(text)
      },
      getImageData(_x: number, _y: number, w: number, h: number) {
        const data = new Uint8ClampedArray(w * h * 4)
        for (let i = 0; i < w * h; i++) data[i * 4 + 3] = alpha
        return { width: w, height: h, data } as unknown as ImageData
      },
      // createImageData/putImageData — @comice/seed's rgbaToDataUrl() uses
      // both to paint a decoded thumbhash/blurhash bitmap before reading
      // it back via toDataURL(). Kept as trivial passthroughs: no real
      // rasterization happens under happy-dom, only enough call-shape
      // fidelity for that caller's own logic (not this fake's) to be
      // exercised.
      createImageData(w: number, h: number) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData
      },
      putImageData(_imageData: ImageData, _x: number, _y: number) {},
      // drawImage — @comice/particles's sampler.ts rasterizes an <img>/
      // <video> source into an offscreen canvas before reading it back;
      // a no-op here is enough, since this fake's own getImageData()
      // above is what actually supplies the (synthetic) pixel data any
      // caller's test reads back, not real drawImage compositing.
      drawImage(..._args: unknown[]) {},
    } as unknown as CanvasRenderingContext2D
  }

  // toDataURL lives on the canvas element itself, not the 2D context —
  // faked separately here since HTMLCanvasElement.prototype.toDataURL is
  // also unimplemented under happy-dom (throws "not implemented").
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL
  ;(HTMLCanvasElement.prototype as any).toDataURL = function (..._args: unknown[]) {
    return 'data:image/png;base64,AAAA'
  }

  return {
    callLog,
    uninstall() {
      HTMLCanvasElement.prototype.getContext = originalGetContext
      HTMLCanvasElement.prototype.toDataURL = originalToDataURL
      ;(globalThis as any).Path2D = originalPath2D
    },
  }
}

/** A minimal GLContext-shaped object wrapping a fake GL, for plane.ts/
 *  residency.ts tests that need a non-null `context` without going through
 *  createGLContext (which is null-only under happy-dom — see
 *  gl-context.test.ts). `resizeToDisplay()` mirrors the real
 *  context.ts implementation closely enough to exercise callers that
 *  invoke it, without re-deriving DPR-capping logic in the fake. */
export function createFakeGLContext(canvas: HTMLCanvasElement, options: FakeGLOptions = {}) {
  const gl = createFakeGL2(options)
  return {
    canvas,
    gl,
    resizeToDisplay() {
      const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
      const targetWidth = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const targetHeight = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width === targetWidth && canvas.height === targetHeight) return
      canvas.width = targetWidth
      canvas.height = targetHeight
      gl.viewport(0, 0, targetWidth, targetHeight)
    },
    destroy() {},
  }
}
