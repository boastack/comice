/**
 * test/morph-sdf.test — packages/morph/src/sdf.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Same string-shape-only testing rationale as test/gl-noise.test.ts: this
 * environment has no GLSL compiler, so these tests verify signatures,
 * dependency ordering, and brace/paren balance — not that the shaders
 * actually compile.
 */

import { describe, expect, it } from 'bun:test'
import {
  composeSdfGLSL,
  ROTATE2D_GLSL,
  SD_ARCH_GLSL,
  SD_ELLIPSE_APPROX_GLSL,
  SD_ROUNDED_BOX_GLSL,
  SMIN_GLSL,
} from '../harness/morph/legacy-engine/sdf.js'

function countChar(source: string, char: string): number {
  return source.split(char).length - 1
}

function bracesAndParensBalance(source: string): boolean {
  return countChar(source, '{') === countChar(source, '}') && countChar(source, '(') === countChar(source, ')')
}

describe('SMIN_GLSL', () => {
  it('declares float smin(float a, float b, float k)', () => {
    expect(SMIN_GLSL).toContain('float smin(float a, float b, float k)')
  })
  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(SMIN_GLSL)).toBe(true)
  })
})

describe('SD_ROUNDED_BOX_GLSL', () => {
  it('declares float sdRoundedBox(vec2 p, vec2 b, float r)', () => {
    expect(SD_ROUNDED_BOX_GLSL).toContain('float sdRoundedBox(vec2 p, vec2 b, float r)')
  })
  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(SD_ROUNDED_BOX_GLSL)).toBe(true)
  })
})

describe('ROTATE2D_GLSL', () => {
  it('declares mat2 rotate2d(float angle)', () => {
    expect(ROTATE2D_GLSL).toContain('mat2 rotate2d(float angle)')
  })
  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(ROTATE2D_GLSL)).toBe(true)
  })
})

describe('SD_ELLIPSE_APPROX_GLSL', () => {
  it('declares float sdEllipseApprox(vec2 p, vec2 radius)', () => {
    expect(SD_ELLIPSE_APPROX_GLSL).toContain('float sdEllipseApprox(vec2 p, vec2 radius)')
  })
  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(SD_ELLIPSE_APPROX_GLSL)).toBe(true)
  })
})

describe('SD_ARCH_GLSL', () => {
  it('declares float sdArch(vec2 p, vec2 size)', () => {
    expect(SD_ARCH_GLSL).toContain('float sdArch(vec2 p, vec2 size)')
  })
  it('calls sdRoundedBox (its stated dependency)', () => {
    expect(SD_ARCH_GLSL).toContain('sdRoundedBox(')
  })
  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(SD_ARCH_GLSL)).toBe(true)
  })
})

describe('composeSdfGLSL', () => {
  it('always includes smin and sdRoundedBox even with every optional flag false', () => {
    const source = composeSdfGLSL({ arch: false, rotate: false, ellipse: false })
    expect(source).toContain('float smin(')
    expect(source).toContain('float sdRoundedBox(')
    expect(source).not.toContain('mat2 rotate2d')
    expect(source).not.toContain('sdEllipseApprox')
    expect(source).not.toContain('sdArch')
  })

  it('defaults to including everything', () => {
    const source = composeSdfGLSL()
    expect(source).toContain('float smin(')
    expect(source).toContain('float sdRoundedBox(')
    expect(source).toContain('mat2 rotate2d(')
    expect(source).toContain('float sdEllipseApprox(')
    expect(source).toContain('float sdArch(')
  })

  it('places sdRoundedBox before sdArch (dependency order)', () => {
    const source = composeSdfGLSL({ arch: true })
    expect(source.indexOf('float sdRoundedBox(')).toBeLessThan(source.indexOf('float sdArch('))
  })

  it('individually toggles rotate/ellipse/arch independently', () => {
    const rotateOnly = composeSdfGLSL({ arch: false, rotate: true, ellipse: false })
    expect(rotateOnly).toContain('rotate2d')
    expect(rotateOnly).not.toContain('sdEllipseApprox')
    expect(rotateOnly).not.toContain('sdArch')

    const ellipseOnly = composeSdfGLSL({ arch: false, rotate: false, ellipse: true })
    expect(ellipseOnly).not.toContain('rotate2d')
    expect(ellipseOnly).toContain('sdEllipseApprox')
    expect(ellipseOnly).not.toContain('sdArch')
  })

  it('produces a single string with balanced braces and parens across the whole composition', () => {
    expect(bracesAndParensBalance(composeSdfGLSL())).toBe(true)
  })

  it('is idempotent in content across calls', () => {
    expect(composeSdfGLSL()).toBe(composeSdfGLSL())
  })
})
