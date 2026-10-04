/**
 * test/mappable-params — spec §04's mapping example, its three targets:
 *
 *   .map('bass').to(distortInstance, 'strength', { output: [0, 0.8] })
 *   .map('energy').to(auraInstance, 'intensity')
 *   .map('high').to(colorInstance, 'shift')
 *
 * distort had no params, aura had no `intensity`, color had no `shift`.
 * Verified in Chromium (shift 0.5 turns blue orange-red); these pin it.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { comice } from 'comice'
import type { NamedSignalDriver, SignalValues } from 'comice'
import { aura } from '../packages/aura/src/index.js'
import { color } from '../packages/color/src/index.js'
import { buildFragmentShader, compileColorProgram, drawColor } from '../packages/color/src/shader.js'
import { distort } from '../packages/distort/src/index.js'
import { createFakeGLContext } from './fake-webgl2.js'

afterEach(() => {
  document.body.innerHTML = ''
})

function signals(): NamedSignalDriver & { fire(values: SignalValues): void } {
  let listener: ((values: Readonly<SignalValues>) => void) | null = null
  return {
    name: 'fake-audio',
    attachSignals(_target, cb) {
      listener = cb
      return () => {}
    },
    fire: (values) => listener?.(values),
  }
}

describe("distort: 'strength', 'radius', 'refraction'", () => {
  it('maps audio into strength through an output range', () => {
    const img = document.createElement('img')
    document.body.appendChild(img)
    const d = distort()
    const driver = signals()
    comice(img).use(d).driver(driver).map('bass').to(d, 'strength', { output: [0, 0.8] })
    driver.fire({ bass: 0.5 })
    expect(d.params!.getParam('strength')).toBeCloseTo(0.4)
  })

  it('reads its options back, takes new values, and ignores unknown names', () => {
    const d = distort({ radius: 120, strength: 0.3, refraction: 0.2 })
    expect(['strength', 'radius', 'refraction', 'nope'].map((n) => d.params!.getParam(n))).toEqual([0.3, 120, 0.2, 0])
    d.params!.setParam('radius', -5)
    d.params!.setParam('refraction', 0.6)
    d.params!.setParam('nope', 1)
    expect([d.params!.getParam('radius'), d.params!.getParam('refraction')]).toEqual([0, 0.6])
  })
})

describe("aura: 'intensity'", () => {
  it("sets the glow's opacity and --aura-intensity at once, clamped to 0..1", () => {
    const img = document.createElement('img')
    const wrap = document.createElement('div')
    wrap.appendChild(img)
    document.body.appendChild(wrap)
    const a = aura({ intensity: 0.5 })
    const handle = comice(img).use(a)
    const glow = img.previousElementSibling as HTMLElement
    expect(glow.style.opacity).toBe('0.5')
    expect(img.style.getPropertyValue('--aura-intensity')).toBe('0.5')
    a.params!.setParam('intensity', 2)
    expect([a.params!.getParam('intensity'), glow.style.opacity]).toEqual([1, '1'])
    a.params!.setParam('other', 0.1)
    expect(a.params!.getParam('other')).toBe(0)
    handle.destroy()
    expect(img.style.getPropertyValue('--aura-intensity')).toBe('')
  })

  it('without the glow or the variables, intensity is still kept', () => {
    const a = aura({ glow: false, cssVariables: false })
    const img = document.createElement('img')
    document.body.appendChild(img)
    comice(img).use(a)
    a.params!.setParam('intensity', 0.3)
    expect(a.params!.getParam('intensity')).toBeCloseTo(0.3)
    expect(img.style.getPropertyValue('--aura-intensity')).toBe('')
  })
})

describe("color: 'shift'", () => {
  it('is a hue rotation in OKLab, after every effect, skipped at 0', () => {
    const source = buildFragmentShader({ effects: ['grain'] })
    expect(source).toContain('if (u_shift != 0.0) {')
    expect(source.indexOf('u_shift != 0.0')).toBeGreaterThan(source.indexOf('u_grainSeed) - 0.5'))
    expect(source).toContain('lab.yz = mat2(cos(angle), sin(angle), -sin(angle), cos(angle)) * lab.yz;')
  })

  it('reaches the shader as a uniform', () => {
    const context = createFakeGLContext(document.createElement('canvas'))
    const program = compileColorProgram(context.gl, { effects: [] })!
    const set: number[] = []
    const uniform1f = context.gl.uniform1f.bind(context.gl)
    context.gl.uniform1f = (loc: WebGLUniformLocation | null, v: number) => {
      if ((loc as unknown as { __id?: string } | null)?.__id === 'u_shift') set.push(v)
      uniform1f(loc, v)
    }
    const plane = { texture: {} } as never
    drawColor(context, program, plane, null, { resolutionWidth: 1, resolutionHeight: 1, bloomThreshold: 0, bloomIntensity: 0, aberrationAmount: 0, grainAmount: 0, grainSeed: 0, shift: 0.25 })
    drawColor(context, program, plane, null, { resolutionWidth: 1, resolutionHeight: 1, bloomThreshold: 0, bloomIntensity: 0, aberrationAmount: 0, grainAmount: 0, grainSeed: 0 })
    expect(set).toEqual([0.25, 0])
  })

  it('is an option and a param', () => {
    const c = color({ shift: 0.1 })
    expect(c.params!.getParam('shift')).toBe(0.1)
    c.params!.setParam('shift', 0.5)
    expect(c.params!.getParam('shift')).toBe(0.5)
  })
})
