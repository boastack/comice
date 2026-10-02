/**
 * test/morph-layouts.test — packages/morph/src/layouts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Same string-shape-only rationale as test/morph-sdf.test.ts — no GLSL
 * compiler in this environment. Verifies each layout generates a
 * `dShapes` union expression, respects the count/liquid options, and stays
 * structurally sane (balanced braces/parens, expected shape count), PLUS
 * (new) each layout's `targetPositions` array — the plain-number start
 * positions thread.ts's GLSL generation in shader.ts consumes.
 */

import { describe, expect, it } from 'bun:test'
import {
  archesLayout,
  buildLayoutGLSL,
  circlesLayout,
  fanLayout,
  filmStripLayout,
  LAYOUT_SDF_DEPENDENCIES,
  petalsLayout,
  shelfLayout,
  spectrumLayout,
  symbolsLayout,
  waveTilesLayout,
  type LayoutName,
} from '../packages/morph/src/layouts.js'

function countChar(source: string, char: string): number {
  return source.split(char).length - 1
}

function bracesAndParensBalance(source: string): boolean {
  return countChar(source, '{') === countChar(source, '}') && countChar(source, '(') === countChar(source, ')')
}

function countDShapeDeclarations(source: string): number {
  const matches = source.match(/float dShape\d+ =/g)
  return matches ? matches.length : 0
}

describe('shelfLayout', () => {
  it('defaults to 3 targets when no count is given', () => {
    const shape = shelfLayout()
    expect(countDShapeDeclarations(shape.glsl)).toBe(3)
  })

  it('respects an explicit count within range', () => {
    expect(countDShapeDeclarations(shelfLayout({ count: 5 }).glsl)).toBe(5)
  })

  it('clamps count below 2 up to 2', () => {
    expect(countDShapeDeclarations(shelfLayout({ count: 0 }).glsl)).toBe(2)
    expect(countDShapeDeclarations(shelfLayout({ count: 1 }).glsl)).toBe(2)
  })

  it('clamps count above 7 down to 7', () => {
    expect(countDShapeDeclarations(shelfLayout({ count: 20 }).glsl)).toBe(7)
  })

  it('ends in a float dShapes = ...; union expression', () => {
    expect(shelfLayout().glsl).toMatch(/float dShapes = .+;/)
  })

  it('uses smin() for the union when liquid is true (default)', () => {
    expect(shelfLayout().glsl).toContain('smin(')
  })

  it('uses min() instead of smin() when liquid is false', () => {
    const shape = shelfLayout({ liquid: false })
    expect(shape.glsl).not.toContain('smin(')
    expect(shape.glsl).toContain('min(')
  })

  it('a single-target (count clamped to 2) union chains exactly one combine call', () => {
    const shape = shelfLayout({ count: 2 })
    const sminCount = (shape.glsl.match(/smin\(/g) || []).length
    expect(sminCount).toBe(1)
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(shelfLayout().glsl)).toBe(true)
  })

  it('reports one targetPositions entry per target, count matching the GLSL', () => {
    const shape = shelfLayout({ count: 5 })
    expect(shape.targetPositions.length).toBe(5)
  })

  it('targetPositions are symmetric about x=0 and all at y=0 (a horizontal shelf)', () => {
    const shape = shelfLayout({ count: 4 })
    for (const [, y] of shape.targetPositions) expect(y).toBe(0)
    const xs = shape.targetPositions.map(([x]) => x)
    expect(xs[0]).toBeCloseTo(-xs[xs.length - 1], 10)
  })
})

describe('fanLayout', () => {
  it('always produces exactly 7 targets (legacy\'s fixed radialFan arrangement)', () => {
    expect(countDShapeDeclarations(fanLayout().glsl)).toBe(7)
  })

  it('count option is accepted without throwing (currently a no-op for fan)', () => {
    expect(() => fanLayout({ count: 5 })).not.toThrow()
    expect(countDShapeDeclarations(fanLayout({ count: 5 }).glsl)).toBe(7)
  })

  it('uses rotate2d for each target (fan is a rotated layout)', () => {
    const shape = fanLayout()
    expect((shape.glsl.match(/rotate2d\(/g) || []).length).toBe(7)
  })

  it('ends in a float dShapes = ...; union expression', () => {
    expect(fanLayout().glsl).toMatch(/float dShapes = .+;/)
  })

  it('uses smin() when liquid is true, min() when false', () => {
    expect(fanLayout({ liquid: true }).glsl).toContain('smin(')
    expect(fanLayout({ liquid: false }).glsl).not.toContain('smin(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(fanLayout().glsl)).toBe(true)
  })

  it('reports exactly 7 targetPositions, matching legacy\'s hand-tuned table', () => {
    const shape = fanLayout()
    expect(shape.targetPositions).toEqual([
      [-0.54, -0.1],
      [-0.43, 0.1],
      [-0.25, 0.25],
      [0.0, 0.3],
      [0.25, 0.25],
      [0.43, 0.1],
      [0.54, -0.1],
    ])
  })
})

describe('circlesLayout', () => {
  it('always produces exactly 5 targets (legacy\'s fixed circles arrangement)', () => {
    expect(countDShapeDeclarations(circlesLayout().glsl)).toBe(5)
  })

  it('uses length() distance, not sdRoundedBox — a plain circle SDF', () => {
    const shape = circlesLayout()
    expect(shape.glsl).toContain('length(st -')
    expect(shape.glsl).not.toContain('sdRoundedBox')
  })

  it('ends in a float dShapes = ...; union expression', () => {
    expect(circlesLayout().glsl).toMatch(/float dShapes = .+;/)
  })

  it('uses smin() when liquid is true, min() when false', () => {
    expect(circlesLayout({ liquid: true }).glsl).toContain('smin(')
    expect(circlesLayout({ liquid: false }).glsl).not.toContain('smin(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(circlesLayout().glsl)).toBe(true)
  })

  it('reports exactly 5 targetPositions', () => {
    expect(circlesLayout().targetPositions.length).toBe(5)
  })
})

describe('symbolsLayout', () => {
  it('produces exactly 4 shapes (square, triangle, circle, cross)', () => {
    expect(countDShapeDeclarations(symbolsLayout().glsl)).toBe(4)
  })

  it('includes an inline triangle SDF (max() of edge distances, no sdTriangle primitive)', () => {
    const shape = symbolsLayout()
    expect(shape.glsl).toContain('triangleBottom')
    expect(shape.glsl).toContain('triangleSides')
    expect(shape.glsl).toContain('max(triangleBottom1, triangleSides1)') // numbered by piece, for `order`
  })

  it('includes an inline 45-degree rotation matrix for the cross, not a rotate2d() call', () => {
    const shape = symbolsLayout()
    expect(shape.glsl).toContain('mat2(0.7071068, -0.7071068, 0.7071068, 0.7071068)')
    expect(shape.glsl).not.toContain('rotate2d(')
  })

  it('uses sdRoundedBox for the square and both cross bars', () => {
    const shape = symbolsLayout()
    expect((shape.glsl.match(/sdRoundedBox\(/g) || []).length).toBe(3)
  })

  it('ends in a float dShapes = ...; union expression chaining all 4 shapes', () => {
    const shape = symbolsLayout()
    expect(shape.glsl).toMatch(/float dShapes = .+;/)
    // 4 shapes -> 3 combine calls in the chain.
    const combineCount = (shape.glsl.match(/smin\(|(?<!s)min\(/g) || []).length
    expect(combineCount).toBeGreaterThanOrEqual(3)
  })

  it('uses smin() when liquid is true, min() when false', () => {
    expect(symbolsLayout({ liquid: true }).glsl).toContain('smin(')
    expect(symbolsLayout({ liquid: false }).glsl).not.toContain('smin(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(symbolsLayout().glsl)).toBe(true)
  })

  it('reports 4 targetPositions, one per shape, matching the GLSL centers', () => {
    const shape = symbolsLayout()
    expect(shape.targetPositions).toEqual([
      [-0.66, 0.0],
      [-0.22, 0.0],
      [0.22, 0.0],
      [0.66, 0.0],
    ])
  })
})

describe('archesLayout', () => {
  it('always produces exactly 3 targets (legacy\'s fixed arches arrangement)', () => {
    expect(countDShapeDeclarations(archesLayout().glsl)).toBe(3)
  })

  it('uses sdArch for each target', () => {
    const shape = archesLayout()
    expect((shape.glsl.match(/sdArch\(/g) || []).length).toBe(3)
  })

  it('ends in a float dShapes = ...; union expression', () => {
    expect(archesLayout().glsl).toMatch(/float dShapes = .+;/)
  })

  it('uses smin() when liquid is true, min() when false', () => {
    expect(archesLayout({ liquid: true }).glsl).toContain('smin(')
    expect(archesLayout({ liquid: false }).glsl).not.toContain('smin(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(archesLayout().glsl)).toBe(true)
  })

  it('reports 3 targetPositions symmetric about the origin', () => {
    const shape = archesLayout()
    expect(shape.targetPositions.length).toBe(3)
    expect(shape.targetPositions[1]).toEqual([0, 0])
    expect(shape.targetPositions[0][0]).toBeCloseTo(-shape.targetPositions[2][0], 10)
  })
})

describe('petalsLayout', () => {
  it('always produces exactly 5 targets', () => {
    expect(countDShapeDeclarations(petalsLayout().glsl)).toBe(5)
  })

  it('uses sdEllipseApprox and rotate2d for each target', () => {
    const shape = petalsLayout()
    expect((shape.glsl.match(/sdEllipseApprox\(/g) || []).length).toBe(5)
    expect((shape.glsl.match(/rotate2d\(/g) || []).length).toBe(5)
  })

  it('ends in a float dShapes = ...; union expression', () => {
    expect(petalsLayout().glsl).toMatch(/float dShapes = .+;/)
  })

  it('uses smin() when liquid is true, min() when false', () => {
    expect(petalsLayout({ liquid: true }).glsl).toContain('smin(')
    expect(petalsLayout({ liquid: false }).glsl).not.toContain('smin(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(petalsLayout().glsl)).toBe(true)
  })

  it('reports 5 targetPositions on a circle of radius 0.2', () => {
    const shape = petalsLayout()
    expect(shape.targetPositions.length).toBe(5)
    for (const [x, y] of shape.targetPositions) {
      expect(Math.sqrt(x * x + y * y)).toBeCloseTo(0.2, 5)
    }
  })
})

describe('filmStripLayout', () => {
  it('always produces exactly 5 targets', () => {
    expect(countDShapeDeclarations(filmStripLayout().glsl)).toBe(5)
  })

  it('uses sdRoundedBox and rotate2d for each target', () => {
    const shape = filmStripLayout()
    expect((shape.glsl.match(/sdRoundedBox\(/g) || []).length).toBe(5)
    expect((shape.glsl.match(/rotate2d\(/g) || []).length).toBe(5)
  })

  it('ends in a float dShapes = ...; union expression', () => {
    expect(filmStripLayout().glsl).toMatch(/float dShapes = .+;/)
  })

  it('uses smin() when liquid is true, min() when false', () => {
    expect(filmStripLayout({ liquid: true }).glsl).toContain('smin(')
    expect(filmStripLayout({ liquid: false }).glsl).not.toContain('smin(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(filmStripLayout().glsl)).toBe(true)
  })

  it('reports 5 targetPositions', () => {
    expect(filmStripLayout().targetPositions.length).toBe(5)
  })
})

describe('spectrumLayout', () => {
  it('always produces exactly 9 targets (legacy\'s fixed nine-bar table)', () => {
    expect(countDShapeDeclarations(spectrumLayout().glsl)).toBe(9)
  })

  it('uses sdRoundedBox for each bar, no rotation', () => {
    const shape = spectrumLayout()
    expect((shape.glsl.match(/sdRoundedBox\(/g) || []).length).toBe(9)
    expect(shape.glsl).not.toContain('rotate2d(')
  })

  it('ends in a float dShapes = ...; union expression', () => {
    expect(spectrumLayout().glsl).toMatch(/float dShapes = .+;/)
  })

  it('uses smin() when liquid is true, min() when false', () => {
    expect(spectrumLayout({ liquid: true }).glsl).toContain('smin(')
    expect(spectrumLayout({ liquid: false }).glsl).not.toContain('smin(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(spectrumLayout().glsl)).toBe(true)
  })

  it('reports 9 targetPositions, all at y=0', () => {
    const shape = spectrumLayout()
    expect(shape.targetPositions.length).toBe(9)
    for (const [, y] of shape.targetPositions) expect(y).toBe(0)
  })
})

describe('waveTilesLayout', () => {
  it('always produces exactly 5 targets', () => {
    expect(countDShapeDeclarations(waveTilesLayout().glsl)).toBe(5)
  })

  it('uses sdRoundedBox and rotate2d for each target', () => {
    const shape = waveTilesLayout()
    expect((shape.glsl.match(/sdRoundedBox\(/g) || []).length).toBe(5)
    expect((shape.glsl.match(/rotate2d\(/g) || []).length).toBe(5)
  })

  it('ends in a float dShapes = ...; union expression', () => {
    expect(waveTilesLayout().glsl).toMatch(/float dShapes = .+;/)
  })

  it('uses smin() when liquid is true, min() when false', () => {
    expect(waveTilesLayout({ liquid: true }).glsl).toContain('smin(')
    expect(waveTilesLayout({ liquid: false }).glsl).not.toContain('smin(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(waveTilesLayout().glsl)).toBe(true)
  })

  it('reports 5 targetPositions', () => {
    expect(waveTilesLayout().targetPositions.length).toBe(5)
  })
})

describe('buildLayoutGLSL', () => {
  it('dispatches "shelf" to shelfLayout', () => {
    expect(buildLayoutGLSL('shelf', { count: 4 })).toEqual(shelfLayout({ count: 4 }))
  })

  it('dispatches "fan" to fanLayout', () => {
    expect(buildLayoutGLSL('fan', {})).toEqual(fanLayout({}))
  })

  it('dispatches every other layout name to its matching generator', () => {
    expect(buildLayoutGLSL('circles', {})).toEqual(circlesLayout({}))
    expect(buildLayoutGLSL('symbols', {})).toEqual(symbolsLayout({}))
    expect(buildLayoutGLSL('arches', {})).toEqual(archesLayout({}))
    expect(buildLayoutGLSL('petals', {})).toEqual(petalsLayout({}))
    expect(buildLayoutGLSL('filmStrip', {})).toEqual(filmStripLayout({}))
    expect(buildLayoutGLSL('spectrum', {})).toEqual(spectrumLayout({}))
    expect(buildLayoutGLSL('waveTiles', {})).toEqual(waveTilesLayout({}))
  })
})

describe('LAYOUT_SDF_DEPENDENCIES', () => {
  const allLayouts: LayoutName[] = [
    'shelf',
    'fan',
    'circles',
    'symbols',
    'arches',
    'petals',
    'filmStrip',
    'spectrum',
    'waveTiles',
  ]

  it('has an entry for every LayoutName', () => {
    for (const name of allLayouts) {
      expect(LAYOUT_SDF_DEPENDENCIES[name]).toBeDefined()
    }
  })

  it('flags rotate: true only for layouts that actually call rotate2d()', () => {
    const rotatingLayouts: LayoutName[] = ['fan', 'petals', 'filmStrip', 'waveTiles']
    for (const name of allLayouts) {
      const shape = buildLayoutGLSL(name)
      const usesRotate2d = shape.glsl.includes('rotate2d(')
      expect(LAYOUT_SDF_DEPENDENCIES[name].rotate === true).toBe(rotatingLayouts.includes(name))
      expect(usesRotate2d).toBe(rotatingLayouts.includes(name))
    }
  })

  it('flags ellipse: true only for petals (the one layout using sdEllipseApprox)', () => {
    for (const name of allLayouts) {
      const usesEllipse = buildLayoutGLSL(name).glsl.includes('sdEllipseApprox(')
      expect(LAYOUT_SDF_DEPENDENCIES[name].ellipse === true).toBe(usesEllipse)
    }
  })

  it('flags arch: true only for arches (the one layout using sdArch)', () => {
    for (const name of allLayouts) {
      const usesArch = buildLayoutGLSL(name).glsl.includes('sdArch(')
      expect(LAYOUT_SDF_DEPENDENCIES[name].arch === true).toBe(usesArch)
    }
  })
})
