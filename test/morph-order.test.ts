/**
 * test/morph-order — spec §08's morph `order` option
 * ─────────────────────────────────────────────────────────────────────────────
 * "order: 'sequence' | 'alternate' — alternate deals either side of a seed
 * origin. Default 'sequence'." It didn't exist: every piece moved at once,
 * driven by one shared pMerge. Now each piece has its own progress window.
 */

import { describe, expect, it } from 'bun:test'
import { LAYOUT_SDF_DEPENDENCIES, perPieceProgress, type LayoutName } from '../packages/morph/src/layouts.js'
import { compileMorphProgram, orderRanks, type MorphShaderOptions } from '../packages/morph/src/shader.js'
import { createFakeGLContext } from './fake-webgl2.js'

function fragmentSource(options: MorphShaderOptions): string {
  const canvas = document.createElement('canvas')
  const context = createFakeGLContext(canvas)
  const sources: string[] = []
  const shaderSource = context.gl.shaderSource.bind(context.gl)
  context.gl.shaderSource = (shader: WebGLShader, source: string) => {
    sources.push(source)
    shaderSource(shader, source)
  }
  compileMorphProgram(context.gl, options)
  return sources.find((s) => s.includes('u_progress')) ?? ''
}

describe('orderRanks', () => {
  it("'sequence' deals in index order", () => {
    expect(orderRanks(5, 'sequence')).toEqual([0, 1, 2, 3, 4])
  })

  it("'alternate' deals from the centre outward, left before right", () => {
    // piece 2 (centre) first, then 1, 3, then 0, 4
    expect(orderRanks(5, 'alternate')).toEqual([3, 1, 0, 2, 4])
    // even count: the two middle pieces first, left one leading
    expect(orderRanks(4, 'alternate')).toEqual([2, 0, 1, 3])
  })
})

describe('perPieceProgress', () => {
  it("points each piece's statements at that piece's progress, leaving shared ones alone", () => {
    const glsl = `
      float shared = mix(0.0, 1.0, pMerge);
      vec2 fanCenter2 = mix(vec2(1.0), vec2(0.0), pMerge);
      float dShape2 = sdRoundedBox(st - fanCenter2, vec2(0.1), mix(0.02, 0.04, pMerge));`
    const out = perPieceProgress(glsl)
    expect(out).toContain('float shared = mix(0.0, 1.0, pMerge);')
    expect(out).toContain('vec2 fanCenter2 = mix(vec2(1.0), vec2(0.0), pMerge2);')
    expect(out).toContain('mix(0.02, 0.04, pMerge2)')
  })
})

describe('the generated shader', () => {
  it('declares one staggered progress window per piece; the last finishes at p = 1', () => {
    const source = fragmentSource({ operation: 'merge', layout: 'shelf', count: 3 })
    expect(source).toContain('float pMerge0 = smoothstep(0.10, 0.90, clamp((p - 0.000000) / 0.700000, 0.0, 1.0));')
    expect(source).toContain('float pMerge1 = smoothstep(0.10, 0.90, clamp((p - 0.150000) / 0.700000, 0.0, 1.0));')
    expect(source).toContain('float pMerge2 = smoothstep(0.10, 0.90, clamp((p - 0.300000) / 0.700000, 0.0, 1.0));')
  })

  it("'alternate' gives the centre piece the earliest window", () => {
    const source = fragmentSource({ operation: 'merge', layout: 'shelf', count: 3, order: 'alternate' })
    expect(source).toContain('float pMerge1 = smoothstep(0.10, 0.90, clamp((p - 0.000000)')
    expect(source).toContain('float pMerge0 = smoothstep(0.10, 0.90, clamp((p - 0.150000)')
  })

  it('breakout reverses each window after staggering in time, so the first-ranked piece still moves first', () => {
    const source = fragmentSource({ operation: 'breakout', layout: 'shelf', count: 3 })
    expect(source).toContain('float pMerge0 = smoothstep(0.10, 0.90, 1.0 - clamp((p - 0.000000) / 0.700000, 0.0, 1.0));')
  })

  it('threads follow their own piece', () => {
    const source = fragmentSource({ operation: 'breakout', layout: 'fan', thread: {} })
    expect(source).toMatch(/float dThread0 = sdThread\([\s\S]*?1\.0 - pMerge0\s*\)/)
  })

  it.each(Object.keys(LAYOUT_SDF_DEPENDENCIES) as LayoutName[])('%s: every piece shape reads its own progress, none the shared one', (layout) => {
    const source = fragmentSource({ operation: 'merge', layout, count: 4 })
    const pieceStatements = source.split(';').filter((s) => /^\s*(?:float|vec2)\s+[A-Za-z_]+?\d+\s*=/.test(s) && !/pMerge\d+ = smoothstep/.test(s))
    expect(pieceStatements.length).toBeGreaterThan(0)
    for (const statement of pieceStatements) expect(statement).not.toMatch(/\bpMerge\b/)
    // and something actually moves per piece
    expect(source).toMatch(/pMerge1\b/)
  })

  it('mask has no pieces, so no per-piece progress', () => {
    const source = fragmentSource({ operation: 'mask' })
    expect(source).not.toMatch(/pMerge0/)
  })
})
