/** Morph shader assembly and GPU lifecycle. Geometry and liquid refraction
 * are ported from the legacy prototypes. All five operations share a media
 * texture, signed-distance mask, progress and input uniform contract. */

import { getResidencyPool } from 'comice/gl'
import type { GLContext, Plane } from 'comice/gl'
import { composeSdfGLSL, SD_ROUNDED_BOX_GLSL } from './sdf.js'
import { buildLayoutGLSL, LAYOUT_SDF_DEPENDENCIES, perPieceProgress, type LayoutName } from './layouts.js'
import { SD_THREAD_GLSL } from './thread.js'
import { liquidMaskShader } from './mask-shader.js'
import { surfaceGLSL, type SurfaceOptions } from '../../../packages/morph/src/surface.js'
import { shapeFragmentShader, type JoinOptions } from '../../../packages/morph/src/shape-shader.js'

export type MorphOperation = 'merge' | 'breakout' | 'distribute' | 'mask' | 'recompose'

/** Recomposition destination; 'mask' uses a caller-supplied SVG, image or text SDF. */
export type RecomposeTarget = 'circle' | 'square' | 'frame' | 'mask'

export type MorphShaderOptions = SurfaceOptions & {
  /** Internal SDF-to-SDF rendering path used by caller-supplied shapes. */
  shapeTransition?: boolean
  hasFromMask?: boolean
  join?: JoinOptions | false
  /** Delay between pieces as a fraction of progress. 0 moves all pieces together. Default 0.3. */
  stagger?: number
  /** Reverse the entire progress domain, including the final blend. */
  direction?: 'forward' | 'reverse'
  /** Mask transition geometry. Default linear. */
  maskStyle?: 'linear' | 'contour' | 'liquid'
  /** Size of a contour mask in height-normalized coordinates. Default 0.84. */
  maskSize?: number
  /** Edge highlight strength. Default 0.16 * liquid. */
  liquidSheen?: number
  /** Media parallax and its 5% overscan. Default true. */
  cursorFollow?: boolean
  /** Required for merge/breakout/distribute/recompose (the starting
   *  distribute arrangement) — ignored for 'mask', which has no
   *  distribute layout at all. */
  layout?: LayoutName
  operation: MorphOperation
  /** smin blend amount, 0..1, matching spec §08's `liquid` option on the
   *  `morph` plugin card. Mapped to legacy's `blendK` the same way legacy
   *  itself derived it: `sin(pMerge * PI) * 0.16 * liquid + 0.002` — liquid
   *  0 degrades to legacy's `enableLiquid: false` hard-min case (a tiny
   *  epsilon k, not exactly 0, matching legacy's own non-liquid blendK of
   *  0.001 so smin never divides by literally zero). Default 0.5. Also
   *  scales the liquid sheen highlight for `mask`/`recompose`, same as
   *  every other operation — the "liquid" feel is not layout-specific. */
  liquid?: number
  /** Number of distribute targets, forwarded to the layout generator.
   *  Ignored by layouts with a fixed target count (every layout except
   *  'shelf', currently) and by the 'mask' operation entirely. */
  count?: number
  /** Required for `operation: 'recompose'`, ignored otherwise. Which
   *  fixed shape the distribute arrangement settles into. */
  recomposeTarget?: RecomposeTarget
  /** Only meaningful for `operation: 'recompose'`. Where in the 0..1
   *  progress range the settle-into-`recomposeTarget` blend starts/ends —
   *  legacy's `finalBlendStart`/`finalBlendEnd`. Deliberately LATER than
   *  `pMerge`'s own 0.10–0.90 window (legacy's own choice: the distribute
   *  shape fully forms first, THEN recomposes, rather than the two blends
   *  racing each other) — default 0.85/1.0, matching legacy's own
   *  defaults exactly. */
  recomposeStart?: number
  recomposeEnd?: number
  /** Spec §08's `thread` option: `{ width, pinch, sag, dissolve }`, a
   *  stretching/snapping bridge between each distribute target and the
   *  point it merges toward; for 'mask', strands holding corner drops to
   *  the collapsing frame (see maskThreadGLSL). Undefined (the default) omits thread entirely —
   *  no thread GLSL is composed in, matching every other optional feature
   *  in this shader (mask's own uniforms, recompose's pFinal) that only
   *  appears in the compiled source when actually requested. */
  thread?: ThreadOptions | false
  /** Spec §08: the order the pieces move in. 'sequence' (default) one
   *  after another in index order; 'alternate' dealt either side of a seed
   *  origin — the centre piece first, then outward, alternating sides.
   *  Either way each piece gets its own window of the timeline (see
   *  ORDER_STAGGER). Before this, every piece moved at once. */
  order?: MorphOrder
}

export type MorphOrder = 'sequence' | 'alternate'

/** How much of the timeline separates the first piece's start from the
 *  last's. Each piece's own move takes the remaining 1 - ORDER_STAGGER, so
 *  neighbours overlap and the whole thing still finishes at progress 1. */
const ORDER_STAGGER = 0.3

/** Each piece's place in the deal (0 moves first). 'alternate' starts at
 *  the centre — the seed origin — and works outward, left before right. */
export function orderRanks(count: number, order: MorphOrder): number[] {
  if (order === 'sequence') return Array.from({ length: count }, (_, i) => i)
  const centre = (count - 1) / 2
  const dealt = Array.from({ length: count }, (_, i) => i).sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b)
  const ranks = new Array<number>(count)
  dealt.forEach((piece, rank) => (ranks[piece] = rank))
  return ranks
}

/** See thread.ts's own header for the full design. All four fields are
 *  optional with the defaults noted — `width` alone is enough to get a
 *  visible, undecorated (no sag, no pinch, no tear) connecting strand. */
export type ThreadOptions = {
  /** The strand's half-thickness at its thickest, CSS px. Default 8. */
  width?: number
  /** 0..1, how much the strand narrows toward the point it's merging
   *  into, relative to `width`. Default 0.4. */
  pinch?: number
  /** How far the strand droops at its middle when fully stretched, CSS px.
   *  0 disables sag. Default 10. */
  sag?: number
  /** How deeply the strand's edge tears as it stretches, CSS px — 0 is a
   *  clean strand that simply thins to nothing. Default 3. */
  dissolve?: number
}

/** When each corner's strand snaps, in `mask` progress — staggered, so
 *  they don't all go at once. */
const MASK_THREAD_SNAPS = [0.5, 0.58, 0.54, 0.62]

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

/**
 * Builds the full fragment shader source for one MorphShaderOptions
 * configuration. Distinct from gl/plane.ts's/gl/mask.ts's shaders in one
 * structural way worth calling out: this shader is NOT positioned/sized
 * against a CSS box the way a Plane is — legacy's own mesh is a full
 * clip-space quad (`gl_Position = vec4(position, 1.0)`, no per-plane
 * origin/size uniforms), because morph's whole effect is defined in its
 * own aspect-normalized `st` space, independent of where the element sits
 * in the page. A morph instance therefore owns its OWN plane positioning
 * at the DOM/CSS layer (matching legacy's `.canvas-container` sizing),
 * not through gl/plane.ts's drawPlane() — see index.ts's setup() for how
 * the DOM side of that is handled. What this shader DOES share with
 * gl/plane.ts is the actual media texture it samples — morph draws the
 * plane's own uploaded texture, reusing Plane.texture directly rather than
 * re-uploading a second copy.
 */
function buildFragmentShader(options: MorphShaderOptions): string {
  if (options.shapeTransition) return shapeFragmentShader(options)
  const {
    layout,
    operation,
    liquid = 0.5,
    count,
    recomposeTarget = 'frame',
    recomposeStart = 0.85,
    recomposeEnd = 1.0,
    thread: requestedThread,
    order = 'sequence',
    stagger = ORDER_STAGGER,
    direction = 'forward',
    maskStyle = 'linear',
    maskSize = 0.84,
    liquidSheen,
    cursorFollow = true,
  } = options
  const thread = requestedThread || undefined
  if (operation === 'mask' && maskStyle === 'liquid') return liquidMaskShader(direction === 'reverse', options)
  const clampedLiquid = Math.max(0, Math.min(1, liquid))
  const isMask = operation === 'mask'
  const isRecompose = operation === 'recompose'
  const usesMask = isMask || (isRecompose && recomposeTarget === 'mask')
  const usesLayout = !isMask // every operation except 'mask' needs layouts.ts's shape GLSL
  const usesThread = !!thread

  // mask has no distribute layout at all — dResult comes from the sampled
  // SDF texture instead of a shape union, so none of layouts.ts's GLSL (or
  // its SDF dependencies) gets composed in for this operation. See the
  // dResultGLSL branch below for the actual sampling/recovery expression.
  // recompose DOES use layouts.ts, exactly like merge/breakout/distribute
  // — it composes a second blend stage on top of the same dShapes union,
  // it does not replace it.
  const layoutShape = usesLayout ? buildLayoutGLSL(layout!, { count, liquid: clampedLiquid > 0 }) : null
  const shapeGLSL = perPieceProgress(layoutShape?.glsl ?? '')
  const sdfGLSL = usesLayout ? composeSdfGLSL(LAYOUT_SDF_DEPENDENCIES[layout!]) : ''

  // thread: one sdThread() call per distribute target, connecting that
  // target's plain-number start position (layoutShape.targetPositions,
  // see layouts.ts) to the origin — the SAME point every layout already
  // interpolates each target toward via mix(pos, vec2(0.0), pMerge).
  // `separation` is 1.0 - pMerge: a fully-spread target (pMerge near 0)
  // has a fully-formed thread; a fully-merged one (pMerge near 1) has
  // none, matching "the bridge that appears as pieces pull apart."
  // Unioned into the SAME dShapes expression as the target shapes
  // themselves — a thread is one more smin/min operand, not a separate
  // draw or a separate blend stage.
  // px in the options, st in the shader: `px` is one CSS pixel in st.
  const threadWidth = `${Math.max(0, thread?.width ?? 8).toFixed(6)} * px`
  const threadPinch = Math.max(0, Math.min(1, thread?.pinch ?? 0.4)).toFixed(6)
  const threadSag = `${(thread?.sag ?? 10).toFixed(6)} * px`
  const threadDissolve = `${Math.max(0, thread?.dissolve ?? 3).toFixed(6)} * px`
  let threadGLSL = ''
  if (usesThread && usesLayout) {
    const declarations = layoutShape!.targetPositions
      .map(
        ([x, y], index) => `
  float dThread${index} = sdThread(
    st,
    vec2(${x.toFixed(6)}, ${y.toFixed(6)}),
    vec2(0.0, 0.0),
    ${threadWidth},
    ${threadPinch},
    ${threadSag},
    ${threadDissolve},
    1.0 - pMerge
  );`,
      )
      .join('')
    // Threads union with a hard min(), never smin() — a thread is meant
    // to read as a distinct strand bridging two shapes, not liquid-blend
    // into them (smin here would just make it look like part of the
    // target shape, defeating the whole "visible connecting tissue" point
    // of the option).
    const threadNames = layoutShape!.targetPositions.map((_position, index) => `dThread${index}`)
    const withThreads = threadNames.reduce((current, name) => `min(${current}, ${name})`, 'dShapes')
    // Each strand follows its own piece's progress, not the shared one.
    threadGLSL = `${perPieceProgress(declarations)}\n  float dShapesWithThread = ${withThreads};`
  }
  // recompose's fixed target shapes (circle/square/frame) all need
  // sdRoundedBox even when the chosen distribute layout's own
  // LAYOUT_SDF_DEPENDENCIES wouldn't otherwise pull it in (every layout
  // already includes it per sdf.ts's composeSdfGLSL — see its own doc
  // comment, "sdRoundedBox is always included" — so this is actually
  // always satisfied already; called out here so that invariant is
  // documented at the one place recompose newly depends on it, not left
  // implicit).
  const finalShapeGLSL =
    recomposeTarget === 'mask' ? '(texture(u_mask, v_uv).r - 0.5) * 2.0 * u_maskScale' :
    recomposeTarget === 'circle'
      ? 'length(st) - 0.50'
      : recomposeTarget === 'square'
        ? 'sdRoundedBox(st, vec2(0.50), 0.035)'
        : 'sdRoundedBox(st, vec2(totalW * 0.5, 0.5), 32.0 / 688.0)' // 'frame', legacy's default/fallback case

  // pMerge direction: 'merge' sweeps targets -> one shape as progress 0->1
  // (matching legacy's `direction: 'full-to-split'` inverted — legacy
  // names directions by visual result, this package names by spec
  // operation). 'breakout' is the exact reverse: one shape -> targets.
  // 'distribute'/'recompose' hold at the spread-out arrangement — progress
  // drives pMerge across the SAME 0..1 range, but a consumer typically
  // drives it with .transition()/.setProgress() rather than a scroll
  // sweep, since "distribute" per spec §06 is "pieces travel into an
  // arrangement," a one-directional settle rather than a merge/split pair
  // ('recompose' extends that same one-directional settle with a second
  // stage — see pFinal below). 'mask' doesn't use pMerge at all (no
  // distribute shape to interpolate toward) — p itself drives the
  // media-frame -> mask-shape blend directly, see dResultGLSL below.
  const separating = operation === 'breakout' || operation === 'distribute'
  const pMergeExpr = separating ? '1.0 - p' : 'p'

  // One progress value per piece (`order`). The stagger is applied to TIME
  // (p) before breakout's reversal, so the piece ranked first moves first
  // in either direction. Each piece's window is ORDER_STAGGER-offset by
  // its rank and 1 - ORDER_STAGGER long; the last finishes at p = 1.
  const pieceCount = layoutShape?.targetPositions.length ?? 0
  const ranks = orderRanks(pieceCount, order)
  const span = 1 - stagger
  const pieceProgressGLSL = ranks
    .map((rank, piece) => {
      const start = pieceCount > 1 ? (rank / (pieceCount - 1)) * stagger : 0
      const local = `clamp((p - ${start.toFixed(6)}) / ${span.toFixed(6)}, 0.0, 1.0)`
      if (stagger === 0) return `  float pMerge${piece} = pMerge;`
      return `  float pMerge${piece} = smoothstep(0.10, 0.90, ${separating ? `1.0 - ${local}` : local});`
    })
    .join('\n')

  // blendK: legacy's exact formula, `liquid` (this package's 0..1 option)
  // taking the place of legacy's boolean enableLiquid as a continuous
  // scale on the same expression — liquid: 0 collapses toward legacy's
  // non-liquid 0.001 constant blendK. Still computed for 'mask' (used by
  // the liquidSheen highlight below, shared across every operation) even
  // though mask has no smin union to blend with it.
  const blendKExpr = `sin(pMerge * 3.14159265) * ${(0.16 * clampedLiquid).toFixed(6)} + 0.002`

  // dResultGLSL: the one handoff point every operation converges on,
  // exactly matching legacy's own `dResult` variable — everything after
  // this point (surface tension, edge AA, refraction, media sampling) is
  // shared, unconditional GLSL, not duplicated per operation.
  //
  // For 'mask': sample the SDF baked by gl/mask.ts's createRasterizedMask
  // with { sdf: true }, recover a distance the same way legacy's appleLogo
  // layout does (`(sample - 0.5) * (2.0 * maxDistance)`), then blend from
  // a full-media-frame rounded box at p=0 to that recovered shape at p=1 —
  // "media takes the shape of something" per spec §06's own description
  // of the mask operation, a direct settle rather than a merge/breakout
  // pair (mask has no meaningful "reverse" the way breakout is merge's
  // reverse).
  //
  // u_maskScale converts the recovered texel-space distance into this
  // shader's own aspect-normalized st space (roughly [-0.5, 0.5]) — a
  // RUNTIME uniform, not a compile-time shader constant, computed by
  // index.ts from the mask's ACTUAL bake dimensions (maxDistance /
  // bakeWidthInStUnits), unlike legacy's appleLogo, which hand-tuned one
  // constant (0.345) for its one specific 1024px bake and never had to
  // generalize it to an arbitrary caller-supplied shape/size.
  //
  // For 'recompose': legacy's dFinalShape/pFinal blend verbatim — a
  // second, LATER smoothstep window (pFinal, recomposeStart/recomposeEnd)
  // mixes dShapes (or dShapesWithThread, when thread is active) into the
  // fixed finalShapeGLSL target, composing on top of the exact same shape
  // union merge/breakout/distribute already build, not replacing it.
  // mask with a thread (the spec's own example: "the footage collapses
  // into the client's logo, the connecting tissue stretches and visibly
  // snaps"): a collapse has no separate pieces to bridge, so material at
  // the frame's four corners lags behind as drops, each held to the
  // shrinking body by a strand that stretches and tears as the body pulls
  // away (sdThread, toward the centre — the part inside the shape is
  // hidden by the union). At its own moment each strand snaps — gone in
  // one step, not faded — and its drop evaporates.
  const maskThreadGLSL =
    isMask && usesThread
      ? MASK_THREAD_SNAPS.map((snap, i) => {
          const sx = i % 2 === 0 ? -1 : 1
          const sy = i < 2 ? -1 : 1
          return `
  {
    vec2 drop = vec2(${sx}.0 * aspect * 0.5, ${sy}.0 * 0.5) * 0.8 * (1.0 - 0.1 * p);
    // Ends just below zero: a radius of exactly 0 still antialiases one speck.
    float radius = mix(0.05, -0.01, smoothstep(${snap.toFixed(2)}, ${(snap + 0.12).toFixed(2)}, p));
    dResult = sminMask(dResult, length(st - drop) - radius, 0.04);
    if (p < ${snap.toFixed(2)}) {
      dResult = min(dResult, sdThread(st, drop, vec2(0.0), ${threadWidth}, ${threadPinch}, ${threadSag}, ${threadDissolve}, clamp(p / ${snap.toFixed(2)}, 0.0, 1.0)));
    }
  }`
        }).join('')
      : ''
  const shapesExpr = usesThread ? 'dShapesWithThread' : 'dShapes'
  const dResultGLSL = isMask && maskStyle === 'contour'
    ? `
  vec2 maskUv = st / ${maskSize.toFixed(6)} + 0.5;
  float bounds = step(0.0, maskUv.x) * step(maskUv.x, 1.0) * step(0.0, maskUv.y) * step(maskUv.y, 1.0);
  float dMask = (texture(u_mask, maskUv).r - 0.5) * 2.0 * u_maskScale;
  dMask = mix(0.18, dMask, bounds);
  float logoLiquidPhase = sin(pMerge * 3.14159265);
  dMask += (sin(maskUv.y * 28.0 + p * 9.0) + sin(maskUv.x * 23.0 - p * 7.0)) * 0.0025 * logoLiquidPhase * bounds;
  float contract = smoothstep(0.55, 0.92, pMerge);
  vec2 frameSize = mix(vec2(0.47, 0.44), vec2(0.89, 0.50), contract);
  float dFrame = sdRoundedBox(st, frameSize, mix(0.18, 0.045, contract));
  float dShapes = mix(dMask, dFrame, smoothstep(0.45, 0.70, pMerge));
  float dResult = mix(dShapes, sdRoundedBox(st, vec2(1224.0 / 688.0 * 0.5, 0.5), 32.0 / 688.0), smoothstep(${recomposeStart.toFixed(6)}, ${recomposeEnd.toFixed(6)}, p));`
    : isMask
    ? `
  float maskBounds = step(0.0, v_uv.x) * step(v_uv.x, 1.0) * step(0.0, v_uv.y) * step(v_uv.y, 1.0);
  float maskSample = texture(u_mask, clamp(v_uv, 0.0, 1.0)).r;
  float dMask = (maskSample - 0.5) * 2.0 * u_maskScale;
  dMask = mix(0.18, dMask, maskBounds);
  float dFrame = sdRoundedBox(st, vec2(aspect * 0.5, 0.5) * 0.94, 0.045);
  float dResult = mix(dFrame, dMask, p);${maskThreadGLSL}`
    : isRecompose
      ? `
  float totalW = 1224.0 / 688.0;
  float pFinal = smoothstep(${recomposeStart.toFixed(6)}, ${recomposeEnd.toFixed(6)}, p);
  ${shapeGLSL}
  ${threadGLSL}
  float dFinalShape = ${finalShapeGLSL};
  float dResult = mix(${shapesExpr}, dFinalShape, pFinal);`
      : `
  ${shapeGLSL}
  ${threadGLSL}
  float dResult = ${shapesExpr};`

  return `#version 300 es
precision mediump float;

uniform vec2 u_resolution;
uniform float u_progress;
uniform vec2 u_mouse;
uniform float u_velocity;
uniform float u_mediaAspect;
uniform sampler2D u_media;
${usesMask ? 'uniform sampler2D u_mask;\nuniform float u_maskScale;' : ''}

in vec2 v_uv;
out vec4 outColor;

${isMask ? SD_ROUNDED_BOX_GLSL : sdfGLSL}
${usesThread ? SD_THREAD_GLSL : ''}
${isMask && usesThread ? 'float sminMask(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }' : ''}

${options.glass || options.outline ? surfaceGLSL(options) : ''}
void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 st = (v_uv - 0.5) * vec2(aspect, 1.0);

  float arch = sin(v_uv.x * 3.14159265);
  st.y += arch * u_velocity * 0.04;

  float pinch = cos(st.y * 3.14159265 * 2.0);
  st.x += pinch * u_velocity * 0.02;

  float p = clamp(${direction === 'reverse' ? '1.0 - u_progress' : 'u_progress'}, 0.0, 1.0);
  float pMerge = smoothstep(0.10, 0.90, ${pMergeExpr});
${pieceProgressGLSL}
  float blendK = ${blendKExpr};
  float px = 1.0 / u_resolution.y; // one CSS pixel, in st
  ${dResultGLSL}

  float morphEnergy = sin(p * 3.14159265);
  float surfaceTension = (
    sin(st.x * 18.0 + p * 8.0)
    + sin((st.x + st.y) * 27.0 - p * 6.0) * 0.52
    + cos(st.y * 22.0 + p * 7.0) * 0.34
  ) * (0.0028 + abs(u_velocity) * 0.0022) * morphEnergy;
  dResult += surfaceTension;

  float edgeAA = max(fwidth(dResult), 1.15 / min(u_resolution.x, u_resolution.y));
  vec2 fieldGradient = vec2(dFdx(dResult), dFdy(dResult));
  vec2 fieldNormal = fieldGradient / max(length(fieldGradient), 0.00001);
  float edgeDepth = clamp(-dResult / 0.035, 0.0, 1.0);
  float glassLip = (1.0 - smoothstep(0.05, 1.0, edgeDepth)) * morphEnergy;
  float liquidSheen = glassLip * ${(liquidSheen ?? 0.16 * clampedLiquid).toFixed(6)};

  float shapeAlpha = 1.0 - smoothstep(-edgeAA, edgeAA, dResult);
  float alpha = shapeAlpha;

  vec2 coverScale = vec2(1.0);
  if (u_mediaAspect > aspect) {
    coverScale.x = aspect / u_mediaAspect;
  } else {
    coverScale.y = u_mediaAspect / aspect;
  }

  vec2 mediaOffset = u_mouse * ${cursorFollow ? '0.035' : '0.0'};
  vec2 centeredUv = (v_uv - 0.5) * coverScale * ${cursorFollow ? '0.95' : '1.0'} + 0.5;
  vec2 parallaxUV = centeredUv - mediaOffset;

  vec2 refractedUv = parallaxUV + fieldNormal * glassLip * (0.010 + abs(u_velocity) * 0.006);
  vec2 fringe = fieldNormal * glassLip * 0.0022;
  vec2 safeUv = clamp(refractedUv, 0.0, 1.0);
  vec4 mediaColor = texture(u_media, safeUv);
  vec3 refractedColor = vec3(
    texture(u_media, clamp(safeUv + fringe, 0.0, 1.0)).r,
    mediaColor.g,
    texture(u_media, clamp(safeUv - fringe, 0.0, 1.0)).b
  );
  vec3 finalColor = refractedColor + vec3(0.92, 1.0, 0.96) * liquidSheen;

  // Premultiplied: the canvas is (premultipliedAlpha: true). Unmultiplied,
  // every pixel outside the shape (alpha 0) still added its full media
  // colour over the page — every operation showed the whole frame, the
  // shape only a slightly darker patch. Found running the spec's own
  // mask example in Chromium.
  float outAlpha = mediaColor.a * alpha;
  outColor = ${options.glass || options.outline ? 'shadeSurface(parallaxUV, dResult, alpha)' : 'vec4(finalColor * outAlpha, outAlpha)'};
}`
}

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

export type MorphProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  buffer: WebGLBuffer
  isMask: boolean
  uResolution: WebGLUniformLocation | null
  uProgress: WebGLUniformLocation | null
  uMouse: WebGLUniformLocation | null
  uVelocity: WebGLUniformLocation | null
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

/**
 * Compiles a MorphProgram for `options`. Unlike gl/plane.ts's single
 * cached pass-through program (one shape, reused by every plane), morph's
 * shader varies per (layout, operation, liquid, count) — a program cache
 * keyed on that combination, not a single program per GLContext, since two
 * different morph plugin instances legitimately want different shaders on
 * the same context (a cardDeck-shelf hero next to a radialFan gallery,
 * say). The cache is still real, still avoids recompiling on every draw —
 * just keyed more specifically than plane.ts's "one thing per context".
 *
 * Returns null, never throws, on any compile/link failure — same rule 04
 * discipline as every T1-T6 file.
 */
export function compileMorphProgram(gl: WebGL2RenderingContext, options: MorphShaderOptions): MorphProgram | null {
  const fragmentSource = buildFragmentShader(options)
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader)
    if (fragmentShader) gl.deleteShader(fragmentShader)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    return null
  }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
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

  const isMask = options.operation === 'mask' || (options.operation === 'recompose' && options.recomposeTarget === 'mask')
  return {
    program,
    vao,
    buffer: buffer!,
    isMask,
    uResolution: gl.getUniformLocation(program, 'u_resolution'),
    uProgress: gl.getUniformLocation(program, 'u_progress'),
    uMouse: gl.getUniformLocation(program, 'u_mouse'),
    uVelocity: gl.getUniformLocation(program, 'u_velocity'),
    uMediaAspect: gl.getUniformLocation(program, 'u_mediaAspect'),
    uMedia: gl.getUniformLocation(program, 'u_media'),
    uMask: isMask ? gl.getUniformLocation(program, 'u_mask') : null,
    uMaskScale: isMask ? gl.getUniformLocation(program, 'u_maskScale') : null,
    hasFromMask: !!options.hasFromMask,
    uFromMask: options.hasFromMask ? gl.getUniformLocation(program, 'u_fromMask') : null,
    uFromScale: options.hasFromMask ? gl.getUniformLocation(program, 'u_fromScale') : null,
    uSourceRadius: options.shapeTransition ? gl.getUniformLocation(program, 'u_sourceRadius') : null,
    uJoinPoints: options.shapeTransition && options.join ? gl.getUniformLocation(program, 'u_joinPoints[0]') : null,
    uJoinCount: options.shapeTransition && options.join ? gl.getUniformLocation(program, 'u_joinCount') : null,
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
  gl.uniform1i(morphProgram.uJoinFrom, 1)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  gl.bindVertexArray(null)
}
