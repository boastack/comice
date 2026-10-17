/**
 * test/morph-experience: cursor parallax and scroll bend, as legacy has them.
 *
 * Legacy's index page zooms the media to 95% and follows the mouse by .035;
 * its African page follows by .018 with no zoom. Both are constants (the
 * plugin used to fade its offset to nothing at the ends and never zoom), and
 * both pages bend the shape with scroll velocity, which the plugin didn't.
 * Verified against the real legacy pages in Chromium and WebKit
 * (harness/morph/legacy-parity.mjs); these pin the source.
 */

import { describe, expect, it } from 'bun:test'
import { morph } from '../packages/morph/src/index.js'
import { compileMorphProgram, type MorphShaderOptions } from '../packages/morph/src/shape-program.js'
import { createFakeGLContext } from './fake-webgl2.js'

function fragmentSource(options: Partial<MorphShaderOptions>): string {
  const context = createFakeGLContext(document.createElement('canvas'))
  const sources: string[] = []
  const shaderSource = context.gl.shaderSource.bind(context.gl)
  context.gl.shaderSource = (shader: WebGLShader, source: string) => {
    sources.push(source)
    shaderSource(shader, source)
  }
  compileMorphProgram(context.gl, { shapeTransition: true, hasFromMask: true, ...options } as MorphShaderOptions)
  return sources.find((s) => s.includes('u_progress')) ?? ''
}

describe('cursorFollow', () => {
  it('defaults to a constant .035 offset at 95% zoom (it used to fade out with progress)', () => {
    const s = fragmentSource({})
    expect(s).toContain('vec2 uv = (v_uv - .5) * cover * mix(1.0, 0.950000, u_follow) + .5 - u_mouse * 0.035000 * u_follow;')
    expect(s).toContain('uniform float u_follow;')
    expect(s).not.toMatch(/u_mouse \* [\d.]+ \* phase/)
  })

  it("takes legacy's index page values: zoom .95, offset .035", () => {
    const s = fragmentSource({ cursorFollow: { offset: 0.035, zoom: 0.95 } })
    expect(s).toContain('* cover * mix(1.0, 0.950000, u_follow) + .5 - u_mouse * 0.035000 * u_follow;')
  })

  it('a partial object keeps the other default; false removes both', () => {
    expect(fragmentSource({ cursorFollow: { zoom: 0.9 } })).toContain('* cover * mix(1.0, 0.900000, u_follow) + .5 - u_mouse * 0.035000 * u_follow;')
    const off = fragmentSource({ cursorFollow: false })
    expect(off).toContain('vec2 uv = (v_uv - .5) * cover + .5;')
    expect(off).not.toContain('u_follow')
  })

  it('is validated at construction', () => {
    const to = 'inset(0px)'
    expect(() => morph({ to, cursorFollow: { offset: -1 } })).toThrow(/offset/)
    expect(() => morph({ to, cursorFollow: { zoom: 0 } })).toThrow(/zoom/)
    expect(() => morph({ to, cursorFollow: { zoom: 3 } })).toThrow(/zoom/)
    expect(() => morph({ to, cursorFollow: { speed: 1 } as never })).toThrow(/Unsupported cursorFollow option/)
    expect(() => morph({ to, cursorFollow: { offset: 0.035, zoom: 0.95 } })).not.toThrow()
  })
})

describe('bend', () => {
  it('is off by default: the shape is read where it is', () => {
    const s = fragmentSource({})
    expect(s).toContain('vec2 suv = v_uv;')
    expect(s).not.toContain('arch')
  })

  it('reads the shape through an arch along x and a pinch along y, scaled by velocity', () => {
    const s = fragmentSource({ bend: true })
    expect(s).toContain('float arch = sin(v_uv.x * 3.14159265);')
    expect(s).toContain('arch * bendVelocity * 0.028000')
    expect(s).toContain('pinch * bendVelocity * 0.014000 / aspect')
    // The masks and the frame are read through the bent coordinates; the media is not.
    expect(s).toContain('vec2 st = (suv - .5) * vec2(aspect, 1.0);')
    expect(s).toContain('texture(u_mask, suv)')
    expect(s).toMatch(/vec2 uv = \(v_uv - \.5\) \* cover/)
  })

  it("takes legacy's index page amounts", () => {
    const s = fragmentSource({ bend: { y: 0.04, x: 0.02 } })
    expect(s).toContain('arch * bendVelocity * 0.040000')
    expect(s).toContain('pinch * bendVelocity * 0.020000 / aspect')
  })

  it('is validated at construction', () => {
    const to = 'inset(0px)'
    expect(() => morph({ to, bend: { y: -0.1 } })).toThrow(/bend amounts/)
    expect(() => morph({ to, bend: { z: 1 } as never })).toThrow(/Unsupported bend option/)
    expect(() => morph({ to, bend: true })).not.toThrow()
    expect(() => morph({ to, bend: { x: 0.02, y: 0.04 } })).not.toThrow()
  })
})
