/**
 * test/gl-noise.test — packages/core/src/gl/noise.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * noise.ts exports GLSL SOURCE STRINGS, not TypeScript logic that touches a
 * WebGL2RenderingContext — there is no GPU object to fake here, unlike
 * context.ts/plane.ts/residency.ts/mask.ts/feedback.ts. This environment has
 * no GLSL compiler and no real GPU (no headless-gl, no system browser
 * reachable from `bun test` — see ROADMAP.md's honest note on this), so
 * these tests cannot verify the shaders actually COMPILE. What they verify
 * instead: every exported chunk declares the exact function signature its
 * doc comment promises, composeNoiseGLSL() concatenates in the correct
 * dependency order (simplex before curl, since curl calls simplexNoise),
 * the options flags work, and braces/parens balance (a cheap, real signal
 * against "a copy-paste edit broke the source" even without a compiler).
 */

import { describe, expect, it } from 'bun:test'
import {
  composeNoiseGLSL,
  CURL_NOISE_GLSL,
  DISPLACEMENT_SAMPLER_GLSL,
  SIMPLEX_NOISE_GLSL,
} from '../packages/core/src/gl/noise.js'

function countChar(source: string, char: string): number {
  return source.split(char).length - 1
}

function bracesAndParensBalance(source: string): boolean {
  return countChar(source, '{') === countChar(source, '}') && countChar(source, '(') === countChar(source, ')')
}

describe('SIMPLEX_NOISE_GLSL', () => {
  it('declares float simplexNoise(vec3 v)', () => {
    expect(SIMPLEX_NOISE_GLSL).toContain('float simplexNoise(vec3 v)')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(SIMPLEX_NOISE_GLSL)).toBe(true)
  })

  it('does not reference curlNoise or displacementOffset (no reverse dependency)', () => {
    expect(SIMPLEX_NOISE_GLSL).not.toContain('curlNoise')
    expect(SIMPLEX_NOISE_GLSL).not.toContain('displacementOffset')
  })
})

describe('CURL_NOISE_GLSL', () => {
  it('declares vec3 curlNoise(vec3 p)', () => {
    expect(CURL_NOISE_GLSL).toContain('vec3 curlNoise(vec3 p)')
  })

  it('calls simplexNoise (its stated dependency)', () => {
    expect(CURL_NOISE_GLSL).toContain('simplexNoise(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(CURL_NOISE_GLSL)).toBe(true)
  })
})

describe('DISPLACEMENT_SAMPLER_GLSL', () => {
  it('declares both displacementOffset overloads', () => {
    expect(DISPLACEMENT_SAMPLER_GLSL).toContain('vec2 displacementOffset(vec2 uv, sampler2D map, float strength)')
    expect(DISPLACEMENT_SAMPLER_GLSL).toContain('vec2 displacementOffset(vec2 uv, float time, float strength)')
  })

  it('the procedural overload calls simplexNoise (its stated dependency)', () => {
    expect(DISPLACEMENT_SAMPLER_GLSL).toContain('simplexNoise(')
  })

  it('has balanced braces and parens', () => {
    expect(bracesAndParensBalance(DISPLACEMENT_SAMPLER_GLSL)).toBe(true)
  })
})

describe('composeNoiseGLSL', () => {
  it('defaults to including simplex, curl and displacement, in dependency order', () => {
    const source = composeNoiseGLSL()
    expect(source.indexOf('float simplexNoise')).toBeGreaterThanOrEqual(0)
    expect(source.indexOf('vec3 curlNoise')).toBeGreaterThan(source.indexOf('float simplexNoise'))
    expect(source.indexOf('displacementOffset')).toBeGreaterThan(source.indexOf('vec3 curlNoise'))
  })

  it('always includes simplex even when both other flags are false', () => {
    const source = composeNoiseGLSL({ curl: false, displacement: false })
    expect(source).toContain('float simplexNoise')
    expect(source).not.toContain('curlNoise')
    expect(source).not.toContain('displacementOffset')
  })

  it('curl: false, displacement: true — displacement without curl (independent flags)', () => {
    const source = composeNoiseGLSL({ curl: false, displacement: true })
    expect(source).toContain('float simplexNoise')
    expect(source).not.toContain('vec3 curlNoise')
    expect(source).toContain('displacementOffset')
  })

  it('curl: true, displacement: false — curl without displacement', () => {
    const source = composeNoiseGLSL({ curl: true, displacement: false })
    expect(source).toContain('vec3 curlNoise')
    expect(source).not.toContain('displacementOffset')
  })

  it('produces a single string with balanced braces and parens across the whole composition', () => {
    const source = composeNoiseGLSL()
    expect(bracesAndParensBalance(source)).toBe(true)
  })

  it('is idempotent in content across calls (no hidden per-call state)', () => {
    expect(composeNoiseGLSL()).toBe(composeNoiseGLSL())
  })
})
