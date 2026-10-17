import { compileMorphProgram, drawMorph, destroyMorphProgram } from './build/shader.js'
import { createRasterizedMask, getResidencyPool } from 'comice/gl'
import { examples } from './legacy-examples.js'
import { legacyReference, legacyMasks } from './reference.js'

const source = await legacyReference()
const referenceMask = await legacyMasks()
const canvas = document.createElement('canvas')
canvas.width = 612; canvas.height = 344
canvas.style.width = '612px'; canvas.style.height = '344px'
document.querySelector('#canvases').append(canvas)
const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true })
if (!gl) throw new Error('WebGL2 unavailable')
const context = { gl, canvas, resizeToDisplay() {}, destroy() {} }
function texture(image) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  return t
}
function program(fragment) {
  const p = gl.createProgram()
  const vertex = `#version 300 es\nin vec2 a_position;in vec2 a_uv;out vec2 v_uv;void main(){v_uv=a_uv;gl_Position=vec4(a_position,0,1);}`
  fragment = '#version 300 es\nprecision mediump float;\nout vec4 outColor;\n' + fragment.replaceAll('varying vec2 vUv', 'in vec2 v_uv').replaceAll('vUv', 'v_uv').replaceAll('texture2D', 'texture').replaceAll('gl_FragColor', 'outColor')
  for (const [type, code] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
    const shader = gl.createShader(type); gl.shaderSource(shader, code); gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
    gl.attachShader(p, shader); gl.deleteShader(shader)
  }
  gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
  return p
}
function drawReference(p, vao, media, mask, state) {
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(p); gl.bindVertexArray(vao)
  // Independent texture binding, matching the prototype's two uniforms.
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, media)
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mask)
  const at = (name) => gl.getUniformLocation(p, name)
  gl.uniform1i(at('u_media'), 0); gl.uniform1i(at('u_wordmark'), 1)
  gl.uniform2f(at('u_resolution'), state.resolutionWidth, state.resolutionHeight)
  gl.uniform1f(at('u_progress'), state.progress); gl.uniform2f(at('u_mouse'), state.mouseX, state.mouseY)
  gl.uniform1f(at('u_velocity'), state.velocity); gl.uniform1f(at('u_mediaAspect'), state.mediaAspect)
  gl.enable(gl.BLEND)
  // THREE.NormalBlending on a transparent, non-premultiplied material.
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.bindVertexArray(null)
}
const read = () => { const bytes = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return bytes }
const mediaCache = new Map()
async function mediaFor(demo) {
  if (mediaCache.has(demo.src)) return mediaCache.get(demo.src)
  const media = document.createElement(demo.image ? 'img' : 'video')
  if (demo.image) { media.src = demo.src; await media.decode() }
  else {
    media.muted = true; media.preload = 'auto'; media.src = demo.src
    await new Promise((resolve, reject) => { media.onloadeddata = resolve; media.onerror = () => reject(new Error('Video load failed')); media.load() })
    await new Promise((resolve) => { media.onseeked = resolve; media.currentTime = .5 })
  }
  const result = { t: texture(media), aspect: demo.image ? media.naturalWidth / media.naturalHeight : media.videoWidth / media.videoHeight }
  mediaCache.set(demo.src, result); return result
}
const layouts = { shelf: 'gallery', fan: 'radialFan', deck: 'cardDeck', symbols: 'gameSymbols', spectrum: 'audioSpectrum' }
const results = []
await document.fonts.ready
for (const demo of examples.filter((d) => !['progress-dial', 'medallion', 'lotus'].includes(d.id))) {
  try {
    const w = demo.square ? 344 : 612
    canvas.width = w; canvas.height = 344; canvas.style.width = `${w}px`; gl.viewport(0, 0, w, 344)
    const media = await mediaFor(demo)
    let mask = null
    const opts = { ...demo.options }
    if (demo.mask || demo.text) {
      mask = createRasterizedMask(context)
      let input
      if (demo.mask) { const image = new Image(); image.src = demo.mask; await image.decode(); input = { type: 'image', source: image } }
      else {
        const size = demo.square ? 184 : 152
        const ctx = document.createElement('canvas').getContext('2d')
        const family = '"Familjen Grotesk", "DM Sans", sans-serif'; ctx.font = `600 ${size}px ${family}`
        const fitted = Math.min(size, Math.floor(size * 1024 * (demo.square ? .84 : .78) / ctx.measureText(demo.text).width))
        input = { type: 'text', text: demo.text, font: `600 ${fitted}px ${family}` }
      }
      mask.rasterize(input, w, 344, { sdf: true, ...opts.maskRasterization })
    }
    let maskMean = 0
    if (mask) {
      const originalMask = await referenceMask(demo)
      const reference = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, reference)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, originalMask.width, originalMask.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, originalMask.data)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      const fbo = gl.createFramebuffer()
      const readMask = (texture) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
        const bytes = new Uint8Array(originalMask.width * originalMask.height * 4)
        gl.readPixels(0, 0, originalMask.width, originalMask.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
        return bytes
      }
      const expectedMask = readMask(reference), actualMask = readMask(mask.field.texture)
      for (let i = 0; i < actualMask.length; i += 4) maskMean += Math.abs(actualMask[i] - expectedMask[i])
      maskMean /= actualMask.length / 4
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbo); gl.deleteTexture(reference)
    }
    const current = compileMorphProgram(gl, opts)
    if (!current) throw new Error('Current shader failed to compile')
    const config = { layout: layouts[opts.layout] ?? opts.layout ?? 'appleLogo', enableLiquid: true, enableCursorFollow: true, cardCount: 3, maskScale: .84, liquidSheen: opts.liquidSheen, finalShape: demo.text && !demo.square ? 'wordmark' : 'frame', finalBlendStart: opts.recomposeStart, finalBlendEnd: opts.recomposeEnd }
    const original = program(demo.square ? source.liquid() : source.main(config))
    let maxMean = 0, maxChanged = 0, maxAlpha = 0
    for (const progress of [0, .2, .5, .8, 1]) {
      const state = { progress, mouseX: .18, mouseY: -.12, velocity: .15, mediaAspect: media.aspect, resolutionWidth: w, resolutionHeight: 344, maskTexture: mask?.field?.texture, maskScale: opts.maskDistance }
      const legacyState = { ...state, progress: opts.direction === 'reverse' ? 1 - progress : progress }
      drawReference(original, current.vao, media.t, mask?.field?.texture ?? null, legacyState)
      const expected = read()
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); getResidencyPool(context).beginPass()
      drawMorph(context, current, { texture: media.t }, state)
      const actual = read()
      let sum = 0, changed = 0, alpha = 0
      for (let i = 0; i < actual.length; i += 4) {
        let difference = 0
        for (let j = 0; j < 4; j++) { const d = Math.abs(actual[i + j] - expected[i + j]); sum += d; difference = Math.max(difference, d) }
        if (difference > 3) changed++
        alpha += Math.abs(actual[i + 3] - expected[i + 3])
      }
      maxMean = Math.max(maxMean, sum / actual.length)
      maxChanged = Math.max(maxChanged, changed / (actual.length / 4))
      maxAlpha = Math.max(maxAlpha, alpha / (actual.length / 4))
    }
    const ok = maxMean < .12 && maxChanged < .01 && maxAlpha < .01 && maskMean < 3
    results.push({ id: demo.id, ok, mean: maxMean, maskMean, changed: maxChanged, alpha: maxAlpha })
    gl.deleteProgram(original); destroyMorphProgram(gl, current); mask?.destroy()
  } catch (error) { results.push({ id: demo.id, ok: false, error: error.message }) }
  document.querySelector('#results').textContent = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.id}: ${r.error ?? `mean=${r.mean.toFixed(4)} changed=${(r.changed * 100).toFixed(3)}% alpha=${r.alpha.toFixed(4)} mask=${r.maskMean.toFixed(4)}`}`).join('\n')
}
for (const media of mediaCache.values()) gl.deleteTexture(media.t)
window.__parity = { done: true, results }
document.querySelector('#status').textContent = `${results.filter((r) => r.ok).length} / ${results.length} passing`
