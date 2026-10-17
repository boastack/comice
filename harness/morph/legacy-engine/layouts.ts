/** Analytic layout geometry from the prototype reference snapshot. Each generator returns
 * the shader expressions and piece origins; shader.ts applies ordering and
 * threads without requiring layout-specific driver logic. */

export type LayoutName = 'shelf' | 'deck' | 'fan' | 'circles' | 'symbols' | 'arches' | 'petals' | 'filmStrip' | 'spectrum' | 'waveTiles'

export type LayoutOptions = {
  /** Number of targets. Clamped to [2, 7] for layouts with a variable
   *  count (currently: 'shelf'). Ignored by every fixed-count layout. */
  count?: number
  /** Whether the liquid union (smin) is used between targets, vs a hard
   *  min(). Mirrors legacy's `enableLiquid` -> combine function choice.
   *  Default true. */
  liquid?: boolean
}

/** A layout's full contribution: the GLSL shader.ts splices in at the
 *  `${shapeShaderGLSL}` position (legacy's `${shapeShader}` position in
 *  its own template literal — the `glsl` field mirrors that closely on
 *  purpose), plus each target's plain-number start position (`st`-space,
 *  before pMerge interpolation) for thread.ts's GLSL generation to
 *  consume directly, without parsing numbers back out of GLSL source. */
export type LayoutShape = {
  glsl: string
  /** One [x, y] per distribute target, in the SAME order the layout's own
   *  `dShapeN` declarations use — thread.ts pairs `targetPositions[i]`
   *  with `dShapeN`'s own centering logic 1:1. Layouts whose targets sit
   *  exactly at the origin at rest (none currently do) would report
   *  [0, 0] here; every real layout's positions are its actual "spread
   *  out" starting coordinates. */
  targetPositions: Array<readonly [number, number]>
}

/** Which sdf.ts primitives (beyond smin/sdRoundedBox, always included —
 *  see sdf.ts's composeSdfGLSL) a given layout's GLSL calls. Read by
 *  shader.ts to compose exactly the SDF chunks a layout needs, no more. */
export type LayoutSdfDependencies = { rotate?: boolean; ellipse?: boolean; arch?: boolean }

function combineExpr(current: string, next: string, liquid: boolean): string {
  return liquid ? `smin(${current}, ${next}, blendK)` : `min(${current}, ${next})`
}

function unionChain(names: string[], liquid: boolean): string {
  return names.slice(1).reduce((current, name) => combineExpr(current, name, liquid), names[0])
}

/**
 * `shelf` — N evenly spaced rounded rectangles, "spread out" at pMerge=0,
 * collapsed to one shape at the origin at pMerge=1 (or the reverse,
 * depending on which direction the consumer drives `pMerge` — see
 * shader.ts's `operation` handling for merge vs breakout). Ported from
 * legacy's default/`cardDeck`-adjacent layout branch (the final fallback
 * branch in `buildShapeShader`, legacy's most general N-card layout).
 *
 * Matches legacy's math exactly: card width/gap interpolate from a
 * spread-out starting layout to a full-width single card, half-extents
 * computed from a 1224×688 reference aspect (legacy's canvas dimensions —
 * kept as the same reference ratio so the ported geometry constants stay
 * meaningful; a consumer at a different aspect ratio still gets correct
 * relative proportions since everything here is expressed in `st` space,
 * which shader.ts's template already normalizes by aspect).
 */
export function shelfLayout(options: LayoutOptions = {}): LayoutShape {
  const count = Math.max(2, Math.min(7, Math.round(options.count ?? 3)))
  const liquid = options.liquid ?? true

  const totalWidth = 1224 / 688
  const startGap = 16 / 688
  const startWidth = (totalWidth - startGap * (count - 1)) / count
  // Card centers are placed along x at `offset * (startWidth + startGap)`
  // (the SAME expression the GLSL below computes for cardCenterN) — this
  // constant is only re-derivable once startWidth/startGap are known,
  // hence computed here rather than duplicated as a separate formula.
  const startPitch = startWidth + startGap

  const declarations = Array.from({ length: count }, (_, index) => {
    const offset = index - (count - 1) / 2
    // Per card, not shared: with `order` each card moves on its own clock
    // (see perPieceProgress), so its gap and width follow its own pMerge.
    return `
      float cardGap${index} = mix(${startGap.toFixed(6)}, 0.0, pMerge);
      float cardWidth${index} = mix(${startWidth.toFixed(6)}, ${(totalWidth / count).toFixed(6)}, pMerge);
      float cardCenter${index} = ${offset.toFixed(1)} * (cardWidth${index} + cardGap${index});
      float dShape${index} = sdRoundedBox(
        st - vec2(cardCenter${index}, 0.0),
        vec2(cardWidth${index} * 0.5, 0.5),
        0.045
      );
    `
  }).join('')

  const union = unionChain(Array.from({ length: count }, (_, index) => `dShape${index}`), liquid)

  return {
    glsl: `
    ${declarations}
    float dShapes = ${union};
  `,
    targetPositions: Array.from({ length: count }, (_, index) => {
      const offset = index - (count - 1) / 2
      return [offset * startPitch, 0] as const
    }),
  }
}

/**
 * `fan` — cards distributed along a rotated arc, each rotating back to
 * upright and collapsing to the origin as pMerge -> 1. Ported directly
 * from legacy's `radialFan` layout branch, including its exact seven-card
 * position/angle table (legacy hand-tuned these to read as a fanned deck,
 * not derived from a formula — reproduced as-is per "port, don't
 * re-derive").
 */
export function fanLayout(options: LayoutOptions = {}): LayoutShape {
  const liquid = options.liquid ?? true

  const cards: Array<[number, number, number]> = [
    [-0.54, -0.1, 1.28],
    [-0.43, 0.1, 0.86],
    [-0.25, 0.25, 0.43],
    [0.0, 0.3, 0.0],
    [0.25, 0.25, -0.43],
    [0.43, 0.1, -0.86],
    [0.54, -0.1, -1.28],
  ]

  const declarations = cards
    .map(
      ([x, y, angle], index) => `
        vec2 fanCenter${index} = mix(vec2(${x.toFixed(2)}, ${y.toFixed(2)}), vec2(0.0), pMerge);
        vec2 fanPoint${index} = rotate2d(${angle.toFixed(2)} * (1.0 - pMerge)) * (st - fanCenter${index});
        vec2 fanSize${index} = mix(vec2(0.072, 0.15), vec2(0.58, 0.42), pMerge);
        float dShape${index} = sdRoundedBox(fanPoint${index}, fanSize${index}, mix(0.026, 0.045, pMerge));
      `,
    )
    .join('')

  const union = unionChain(cards.map((_card, index) => `dShape${index}`), liquid)

  return {
    glsl: `${declarations}\nfloat dShapes = ${union};`,
    targetPositions: cards.map(([x, y]) => [x, y] as const),
  }
}

/**
 * `circles` — five circles (plain `length()` distance, no SDF helper
 * needed) spreading from/collapsing to the origin. Ported from legacy's
 * `circles` layout branch, including its exact five-position table.
 */
export function circlesLayout(options: LayoutOptions = {}): LayoutShape {
  const liquid = options.liquid ?? true

  const positions: Array<[number, number]> = [
    [-0.68, 0.08],
    [-0.34, -0.08],
    [0.0, 0.08],
    [0.34, -0.08],
    [0.68, 0.08],
  ]

  const declarations = positions
    .map(
      ([x, y], index) => `
        vec2 circleCenter${index} = mix(vec2(${x.toFixed(2)}, ${y.toFixed(2)}), vec2(0.0), pMerge);
        float dShape${index} = length(st - circleCenter${index}) - mix(0.16, 0.58, pMerge);
      `,
    )
    .join('')

  const union = unionChain(positions.map((_position, index) => `dShape${index}`), liquid)

  return {
    glsl: `${declarations}\nfloat dShapes = ${union};`,
    targetPositions: positions.map(([x, y]) => [x, y] as const),
  }
}

/**
 * `symbols` — a square, triangle, circle and rotated cross (four distinct
 * shapes, not four copies of one), ported from legacy's `gameSymbols`
 * layout branch verbatim, including its inline triangle SDF (`max()` of
 * a bottom-edge and two side-edge half-plane distances — no separate
 * sdTriangle primitive in sdf.ts, since this is the only shape in the
 * whole catalogue that needs one) and its inline 45°-rotation matrix for
 * the cross (`mat2(0.7071068, -0.7071068, 0.7071068, 0.7071068)`, i.e.
 * rotate2d(π/4) written out as constants the way legacy wrote it, kept
 * as-is per "port, don't re-derive" rather than swapped for a
 * rotate2d(0.7853982) call that would compute the same matrix less
 * directly).
 */
export function symbolsLayout(options: LayoutOptions = {}): LayoutShape {
  const liquid = options.liquid ?? true

  const positions: Array<[number, number]> = [
    [-0.66, 0.0], // square
    [-0.22, 0.0], // triangle
    [0.22, 0.0], // circle
    [0.66, 0.0], // cross
  ]

  return {
    glsl: `
    // Every value numbered by its piece (0 square, 1 triangle, 2 circle,
    // 3 cross), so with \`order\` each symbol moves on its own clock.
    float symbolScale0 = mix(0.16, 0.58, pMerge);
    float symbolScale1 = mix(0.16, 0.58, pMerge);
    float symbolScale2 = mix(0.16, 0.58, pMerge);
    float symbolScale3 = mix(0.16, 0.58, pMerge);
    vec2 symbolCenter0 = mix(vec2(-0.66, 0.0), vec2(0.0), pMerge);
    vec2 symbolCenter1 = mix(vec2(-0.22, 0.0), vec2(0.0), pMerge);
    vec2 symbolCenter2 = mix(vec2(0.22, 0.0), vec2(0.0), pMerge);
    vec2 symbolCenter3 = mix(vec2(0.66, 0.0), vec2(0.0), pMerge);

    float dShape0 = sdRoundedBox(st - symbolCenter0, vec2(symbolScale0), mix(0.035, 0.055, pMerge));
    vec2 trianglePoint1 = st - symbolCenter1;
    float triangleBottom1 = -trianglePoint1.y - symbolScale1;
    float triangleSides1 = trianglePoint1.y + 2.0 * abs(trianglePoint1.x) - symbolScale1;
    float dShape1 = max(triangleBottom1, triangleSides1);
    float dShape2 = length(st - symbolCenter2) - symbolScale2;

    vec2 crossPoint3 = st - symbolCenter3;
    crossPoint3 = mat2(0.7071068, -0.7071068, 0.7071068, 0.7071068) * crossPoint3;
    float crossWidth3 = mix(0.065, 0.24, pMerge);
    float crossLength3 = 1.4142136 * symbolScale3 - crossWidth3 + mix(0.007, 0.0, pMerge);
    float dCrossV3 = sdRoundedBox(crossPoint3, vec2(crossWidth3, crossLength3), crossWidth3 * 0.38);
    float dCrossH3 = sdRoundedBox(crossPoint3, vec2(crossLength3, crossWidth3), crossWidth3 * 0.38);
    float dShape3 = min(dCrossV3, dCrossH3);

    float dShapes = ${unionChain(['dShape0', 'dShape1', 'dShape2', 'dShape3'], liquid)};
  `,
    targetPositions: positions.map(([x, y]) => [x, y] as const),
  }
}

/**
 * `arches` — three rounded-arch shapes (sdArch: a rounded box body plus a
 * half-circle dome, see sdf.ts), spreading from/collapsing to the origin.
 * Ported from legacy's `arches` layout branch, including its exact
 * half-width/pitch geometry (`archHalfWidth = 0.22`, pitch computed from
 * the same `GAP_PX / 688` reference legacy's other multi-target layouts
 * use).
 */
export function archesLayout(options: LayoutOptions = {}): LayoutShape {
  const liquid = options.liquid ?? true
  const GAP_PX = 24
  const archHalfWidth = 0.22
  const archPitch = archHalfWidth * 2 + GAP_PX / 688

  const positions: Array<[number, number]> = [
    [-archPitch, 0],
    [0, 0],
    [archPitch, 0],
  ]

  return {
    glsl: `
    vec2 archSize = mix(vec2(${archHalfWidth.toFixed(2)}, 0.40), vec2(0.62, 0.46), pMerge);
    vec2 archCenter0 = mix(vec2(${(-archPitch).toFixed(4)}, 0.0), vec2(0.0), pMerge);
    vec2 archCenter1 = vec2(0.0);
    vec2 archCenter2 = mix(vec2(${archPitch.toFixed(4)}, 0.0), vec2(0.0), pMerge);
    float dShape0 = sdArch(st - archCenter0, archSize);
    float dShape1 = sdArch(st - archCenter1, archSize);
    float dShape2 = sdArch(st - archCenter2, archSize);
    float dShapes = ${unionChain(['dShape0', 'dShape1', 'dShape2'], liquid)};
  `,
    targetPositions: positions.map(([x, y]) => [x, y] as const),
  }
}

/**
 * `petals` — five ellipses (sdEllipseApprox) arranged radially, each
 * rotated to point outward from the center, blooming from/collapsing to
 * the origin. Ported from legacy's `petals` layout branch, including its
 * formula-derived five-petal position/angle table (legacy computed these
 * from `index * 2π / 5`, not hand-tuned constants like `fan`'s table —
 * reproduced as the same formula here, not as five baked numbers, so the
 * geometry stays exactly traceable back to legacy's own derivation).
 */
export function petalsLayout(options: LayoutOptions = {}): LayoutShape {
  const liquid = options.liquid ?? true

  const petals = Array.from({ length: 5 }, (_petal, index) => {
    const angle = (index * Math.PI * 2) / 5
    const x = Math.cos(angle) * 0.2
    const y = Math.sin(angle) * 0.2
    return [x, y, angle - Math.PI / 2] as const
  })

  const declarations = petals
    .map(
      ([x, y, angle], index) => `
        vec2 petalCenter${index} = mix(vec2(${x.toFixed(4)}, ${y.toFixed(4)}), vec2(0.0), pMerge);
        vec2 petalPoint${index} = rotate2d(${angle.toFixed(4)}) * (st - petalCenter${index});
        float dShape${index} = sdEllipseApprox(petalPoint${index}, mix(vec2(0.115, 0.23), vec2(0.58, 0.44), pMerge));
      `,
    )
    .join('')

  const union = unionChain(petals.map((_petal, index) => `dShape${index}`), liquid)

  return {
    glsl: `${declarations}\nfloat dShapes = ${union};`,
    targetPositions: petals.map(([x, y]) => [x, y] as const),
  }
}

/**
 * `filmStrip` — five slightly-tilted rounded-rectangle frames, ported
 * verbatim from legacy's `filmStrip` layout branch, including its exact
 * five-frame position/angle table (hand-tuned, not formula-derived — same
 * "port, don't re-derive" treatment as `fan`'s table).
 */
export function filmStripLayout(options: LayoutOptions = {}): LayoutShape {
  const liquid = options.liquid ?? true

  const frames: Array<[number, number, number]> = [
    [-0.68, 0.02, -0.12],
    [-0.34, 0.1, -0.06],
    [0, 0.0, 0],
    [0.34, -0.1, 0.06],
    [0.68, -0.02, 0.12],
  ]

  const declarations = frames
    .map(
      ([x, y, angle], index) => `
        vec2 frameCenter${index} = mix(vec2(${x}, ${y}), vec2(0.0), pMerge);
        vec2 framePoint${index} = rotate2d(${angle.toFixed(4)}) * (st - frameCenter${index});
        vec2 frameSize${index} = mix(vec2(0.15, 0.28), vec2(0.58, 0.42), pMerge);
        float dShape${index} = sdRoundedBox(framePoint${index}, frameSize${index}, 0.035);
      `,
    )
    .join('')

  const union = unionChain(frames.map((_frame, index) => `dShape${index}`), liquid)

  return {
    glsl: `${declarations}\nfloat dShapes = ${union};`,
    targetPositions: frames.map(([x, y]) => [x, y] as const),
  }
}

/**
 * `spectrum` — nine rounded-rectangle bars at varying heights, reading as
 * an audio spectrum visualizer. Ported from legacy's `audioSpectrum`
 * layout branch, including its exact nine-bar height table (hand-tuned to
 * look like a plausible spectrum, not randomly or formula generated).
 */
export function spectrumLayout(options: LayoutOptions = {}): LayoutShape {
  const liquid = options.liquid ?? true
  const GAP_PX = 24
  const bars = [0.14, 0.23, 0.34, 0.46, 0.3, 0.43, 0.32, 0.22, 0.14]
  const barHalfWidth = 0.055
  const barPitch = barHalfWidth * 2 + GAP_PX / 688

  const declarations = bars
    .map((height, index) => {
      const x = (index - (bars.length - 1) / 2) * barPitch
      return `
        vec2 spectrumCenter${index} = mix(vec2(${x.toFixed(2)}, 0.0), vec2(0.0), pMerge);
        vec2 spectrumSize${index} = mix(vec2(${barHalfWidth.toFixed(3)}, ${height.toFixed(2)}), vec2(0.58, 0.42), pMerge);
        float dShape${index} = sdRoundedBox(
          st - spectrumCenter${index},
          spectrumSize${index},
          mix(0.045, 0.045, pMerge)
        );
      `
    })
    .join('')

  const union = unionChain(bars.map((_height, index) => `dShape${index}`), liquid)

  return {
    glsl: `${declarations}\nfloat dShapes = ${union};`,
    targetPositions: bars.map((_height, index) => {
      const x = (index - (bars.length - 1) / 2) * barPitch
      return [x, 0] as const
    }),
  }
}

/**
 * `waveTiles` — five gently-tilted rounded-rectangle tiles, ported
 * verbatim from legacy's `waveTiles` layout branch, including its exact
 * five-tile position/angle table.
 */
export function waveTilesLayout(options: LayoutOptions = {}): LayoutShape {
  const liquid = options.liquid ?? true

  const cards: Array<[number, number, number]> = [
    [-0.68, -0.1, -0.14],
    [-0.34, 0.08, -0.07],
    [0, 0.16, 0],
    [0.34, 0.08, 0.07],
    [0.68, -0.1, 0.14],
  ]

  const declarations = cards
    .map(
      ([x, y, angle], index) => `
        vec2 waveCenter${index} = mix(vec2(${x}, ${y}), vec2(0.0), pMerge);
        vec2 wavePoint${index} = rotate2d(${angle.toFixed(4)}) * (st - waveCenter${index});
        vec2 waveSize${index} = mix(vec2(0.16, 0.30), vec2(0.58, 0.42), pMerge);
        float dShape${index} = sdRoundedBox(wavePoint${index}, waveSize${index}, 0.05);
      `,
    )
    .join('')

  const union = unionChain(cards.map((_card, index) => `dShape${index}`), liquid)

  return {
    glsl: `${declarations}\nfloat dShapes = ${union};`,
    targetPositions: cards.map(([x, y]) => [x, y] as const),
  }
}

/** Six tilted cards, matching the original card deck geometry. */
export function deckLayout(options: LayoutOptions = {}): LayoutShape {
  const cards = Array.from({ length: 6 }, (_, i) => [(i - 2.5) * (0.18 + 24 / 688), 0, i === 0 ? 0 : 0.18])
  const glsl = cards.map(([x, y, angle], i) => `
    vec2 deckCenter${i} = mix(vec2(${x.toFixed(2)}, ${y.toFixed(2)}), vec2(0.0), pMerge);
    vec2 deckPoint${i} = rotate2d(${angle.toFixed(2)} * (1.0 - pMerge)) * (st - deckCenter${i});
    vec2 deckSize${i} = mix(vec2(0.0900, 0.245), vec2(0.58, 0.42), pMerge);
    float dShape${i} = sdRoundedBox(deckPoint${i}, deckSize${i}, mix(0.035, 0.045, pMerge));
  `).join('')
  return { glsl: glsl + `\nfloat dShapes = ${unionChain(cards.map((_, i) => `dShape${i}`), options.liquid ?? true)};`, targetPositions: cards.map(([x, y]) => [x, y]) }
}

const LAYOUT_GENERATORS: Record<LayoutName, (options: LayoutOptions) => LayoutShape> = {
  shelf: shelfLayout,
  deck: deckLayout,
  fan: fanLayout,
  circles: circlesLayout,
  symbols: symbolsLayout,
  arches: archesLayout,
  petals: petalsLayout,
  filmStrip: filmStripLayout,
  spectrum: spectrumLayout,
  waveTiles: waveTilesLayout,
}

/** Which sdf.ts chunks (beyond smin/sdRoundedBox, always included) each
 *  layout's GLSL calls — read by shader.ts to compose exactly what's
 *  needed. Kept as a plain lookup table, not a property each layout
 *  function reports about itself, so shader.ts can decide what to compile
 *  before calling the (potentially expensive-to-construct) layout GLSL. */
export const LAYOUT_SDF_DEPENDENCIES: Record<LayoutName, LayoutSdfDependencies> = {
  shelf: {},
  deck: { rotate: true },
  fan: { rotate: true },
  circles: {},
  symbols: {}, // uses an inline mat2(...) rotation, not rotate2d() — see symbolsLayout's own doc comment
  arches: { arch: true },
  petals: { rotate: true, ellipse: true },
  filmStrip: { rotate: true },
  spectrum: {},
  waveTiles: { rotate: true },
}

/** Dispatches to the named layout generator — shader.ts calls this rather
 *  than importing every layout function individually, so adding a new
 *  layout later means one new entry here (plus one in
 *  LAYOUT_SDF_DEPENDENCIES), never a change to shader.ts's own logic. */
/**
 * Points each piece's statements at that piece's own progress, for
 * spec §08's `order` ('sequence' | 'alternate'): every statement that
 * DECLARES a piece-numbered value (`dShape2`, `fanCenter2`, `dThread2`…)
 * reads `pMerge2` instead of the shared `pMerge`. Every layout already
 * numbers its per-piece values this way (shelf and symbols were brought
 * into line for it), so ordering needs no per-layout code. Statements
 * about no single piece keep the shared `pMerge`.
 */
export function perPieceProgress(glsl: string): string {
  return glsl
    .split(';')
    .map((statement) => {
      const declared = /^\s*(?:float|vec2|vec3|vec4|mat2)\s+[A-Za-z_]+?(\d+)\s*=/.exec(statement)
      return declared ? statement.replace(/\bpMerge\b/g, `pMerge${declared[1]}`) : statement
    })
    .join(';')
}

export function buildLayoutGLSL(name: LayoutName, options: LayoutOptions = {}): LayoutShape {
  return LAYOUT_GENERATORS[name](options)
}
