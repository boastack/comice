import { compileMorphProgram, drawMorph, destroyMorphProgram } from './build/shader.js'
import { createPlane, createRasterizedMask, getResidencyPool } from 'comice/gl'

// Preserve the user's supplied document as the independent reference. Only
// evaluate its GLSL template; do not load its scripts or execute its app code.
async function referenceFragment() {
  const html = await (await fetch('/harness/morph/fixtures/liquid-frame.html')).text()
  const begin = html.indexOf('const fragmentShader = `'), start = html.indexOf('`', begin)
  const end = html.lastIndexOf('`;', html.indexOf('const vertexShader'))
  const original = new Function('CONFIG', `return ${html.slice(start, end + 1)}`)({ enableBend: false, enableLiquid: true, enableCursorFollow: false })
  const smoothUnion = original.slice(original.indexOf('float smin'), original.indexOf('float sdRoundedBox'))
  const timings = original.slice(original.indexOf('float pRope'), original.indexOf('// Frame Metrics'))
  const drops = original.slice(original.indexOf('float rDrop'), original.indexOf('float dFinalBox'))
  const sheen = original.match(/liquidSheen = smoothstep[^;]+;/)[0]
  // Substitute SVG fields for the three hardcoded rounded boxes. Retain the
  // reference's drop growth, smooth-union strength, final blend and sheen.
  // Bound the adapted join to the endpoint union, then use Comice pixel AA/crop.
  // This intentionally removes the original reference's outer-edge overshoot.
  return `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 outColor;
uniform vec2 u_resolution;
uniform float u_progress, u_maskScale;
uniform vec2 u_joinPoints[32];
uniform sampler2D u_media, u_mask, u_fromMask;
${smoothUnion}
void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 st = (v_uv - .5) * vec2(aspect, 1.0);
  float p = clamp(u_progress, 0.0, 1.0);
  ${timings}
  float dFrom = (texture(u_fromMask, v_uv).r - .5) * 2.0 * u_maskScale;
  float dTo = (texture(u_mask, v_uv).r - .5) * 2.0 * u_maskScale;
  float dCards = mix(dFrom, dTo, pMerge);
  vec2 bridge1Center = ((u_joinPoints[0] + u_joinPoints[1]) * .5 - .5) * vec2(aspect, -1.0);
  vec2 bridge2Center = ((u_joinPoints[1] + u_joinPoints[2]) * .5 - .5) * vec2(aspect, -1.0);
  ${drops}
  float dResult = max(mix(dLiquid, dTo, pFinal), min(dFrom, dTo));
  float liquidSheen = 0.0;
  ${sheen}
  if (p == 0.0) { dResult = dFrom; liquidSheen = 0.0; }
  if (p == 1.0) { dResult = dTo; liquidSheen = 0.0; }
  float px = 1.0 / u_resolution.y;
  float aa = clamp(fwidth(dResult), .5 * px, 2.0 * px);
  float alpha = 1.0 - smoothstep(-aa, aa, dResult);
  vec4 media = texture(u_media, v_uv);
  float a = media.a * alpha;
  outColor = vec4((media.rgb + vec3(liquidSheen)) * a, a);
}`
}

export async function metaballReferenceChecks() {
  const canvas = document.createElement('canvas'); canvas.width = 612; canvas.height = 344
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
  if (!gl) throw new Error('WebGL2 unavailable for midpoint-drop reference.')
  const context = { canvas, gl, resizeToDisplay() {}, destroy() {} }
  const media = new Image(); media.src = '/harness/morph/fixtures/midtone.png'; await media.decode()
  const plane = createPlane(context, media), from = createRasterizedMask(context), to = createRasterizedMask(context)
  const programs = [], reference = gl.createProgram()
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, '#version 300 es\nin vec2 a_position; in vec2 a_uv; out vec2 v_uv; void main(){v_uv=a_uv;gl_Position=vec4(a_position,0,1);}'], [gl.FRAGMENT_SHADER, await referenceFragment()]]) {
      const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
      gl.attachShader(reference, shader); gl.deleteShader(shader)
    }
    gl.linkProgram(reference)
    if (!gl.getProgramParameter(reference, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(reference))
    for (const [mask, url] of [[from, '/demo/morph/assets/panel.svg'], [to, '/demo/morph/assets/shape.svg']]) {
      const image = new Image(); image.src = url; await image.decode()
      mask.rasterize({ type: 'image', source: image }, 612, 344, { sdf: true, precision: 'half', maxDistance: 612, fill: 1, components: true, resolution: [612, 344] })
    }
    const points = new Float32Array(64); from.components.forEach(([x,y],i)=>{points[i*2]=x;points[i*2+1]=y})
    if (from.components.length !== 3) throw new Error('Reference fixture must contain three SVG components.')
    const state = { mouseX:0, mouseY:0, velocity:0, mediaAspect:612/344, resolutionWidth:612, resolutionHeight:344, maskScale:612/344, fromScale:612/344, maskTexture:to.field.texture, fromMaskTexture:from.field.texture, joinPoints:points, joinCount:3 }
    const read = () => {const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels}
    const clear = () => {gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT)}
    const at = name => gl.getUniformLocation(reference,name)
    let mean = 0, alpha = 0, compared = 0
    for (const direction of ['forward','reverse']) {
      const current = compileMorphProgram(gl,{ operation:'mask', shapeTransition:true, hasFromMask:true, join:{}, direction, cursorFollow:false })
      if (!current) throw new Error('Midpoint-drop shader did not compile.')
      programs.push(current)
      for (const progress of [0,.025,.075,.1,.15,.25,.5,.85,.925,1]) {
        clear(); gl.useProgram(reference); gl.bindVertexArray(current.vao)
        for (const [unit,name,texture] of [[0,'u_media',plane.texture],[1,'u_mask',to.field.texture],[2,'u_fromMask',from.field.texture]]) {
          gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(gl.TEXTURE_2D,texture); gl.uniform1i(at(name),unit)
        }
        gl.uniform2f(at('u_resolution'),612,344);gl.uniform1f(at('u_progress'),direction==='reverse'?1-progress:progress)
        gl.uniform1f(at('u_maskScale'),state.maskScale);gl.uniform2fv(at('u_joinPoints'),points)
        gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.drawArrays(gl.TRIANGLE_STRIP,0,4)
        const expected=read()
        clear();getResidencyPool(context).beginPass();drawMorph(context,current,plane,{...state,progress})
        const actual=read();let sum=0,alphaSum=0
        for(let i=0;i<actual.length;i++){const delta=Math.abs(actual[i]-expected[i]);sum+=delta;if(i%4===3)alphaSum+=delta}
        mean=Math.max(mean,sum/actual.length);alpha=Math.max(alpha,alphaSum/(actual.length/4));compared++
      }
    }
    if(mean>.02||alpha>.01||gl.getError()!==0)throw new Error(`Midpoint drops differ from the supplied reference: RGBA=${mean}, alpha=${alpha}`)
    return {mean,alpha,compared}
  } finally {programs.forEach(p=>destroyMorphProgram(gl,p));gl.deleteProgram(reference);plane.destroy();from.destroy();to.destroy();gl.getExtension('WEBGL_lose_context')?.loseContext()}
}
