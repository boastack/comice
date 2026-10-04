/**
 * test/particles-shader — packages/particles/src/shader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Both modes render in Chromium (verified with screenshots); these pin the
 * GLSL that matters and the GL wiring, against test/fake-webgl2.ts.
 */

import { describe, expect, it } from 'bun:test'
import { compileParticlesProgram, createSourceTexture, destroyParticlesProgram, drawParticles, uploadParticleBuffers, uploadSourceTexture, type ParticlesMode } from '../packages/particles/src/shader.js'
import { createFakeGLContext } from './fake-webgl2.js'

const MODES: ParticlesMode[] = ['cloud', 'shatter']

function compiled(mode: ParticlesMode) {
  const context = createFakeGLContext(document.createElement('canvas'))
  const sources: string[] = []
  const shaderSource = context.gl.shaderSource.bind(context.gl)
  context.gl.shaderSource = (shader: WebGLShader, source: string) => {
    sources.push(source)
    shaderSource(shader, source)
  }
  const program = compileParticlesProgram(context.gl, mode)
  return { context, program, vertex: sources[0]!, fragment: sources[1]! }
}

describe('compileParticlesProgram', () => {
  it.each(MODES)('%s compiles, with every uniform', (mode) => {
    const { program } = compiled(mode)
    expect(program).not.toBeNull()
    expect(Object.keys(program!.uniforms).sort()).toEqual(['cell', 'from', 'noiseAmount', 'pointSize', 'progress', 'resolution', 'scatter', 'time', 'to'])
    expect(program!.baseVertexCount).toBe(mode === 'cloud' ? 1 : 4)
  })

  it('everything in flight is scaled by sin(pi * progress): both ends land exactly', () => {
    const { vertex } = compiled('cloud')
    expect(vertex).toContain('float flight = sin(3.14159265 * u_progress);')
    expect(vertex).toContain('* reach * u_scatter * flight')
    expect(vertex).toContain('flow.xy * u_noiseAmount * flight')
  })

  it('cloud colours each point from the source textures; shatter samples its own piece', () => {
    expect(compiled('cloud').vertex).toContain('mix(textureLod(u_from, a_origin, 0.0), textureLod(u_to, a_target, 0.0), u_progress)')
    const shatter = compiled('shatter')
    expect(shatter.vertex).toContain('v_uvFrom = a_origin + a_baseVertex * u_cell;')
    expect(shatter.fragment).toContain('texture(u_from, v_uvFrom)')
    // Shares u_progress with the vertex shader: precisions must match, or
    // the link fails (it did, in Chromium).
    expect(shatter.fragment).toContain('precision highp float;')
  })

  it('returns null, never throws, when compile, createProgram or link fails', () => {
    for (const fail of ['failShaderCompile', 'failCreateProgram', 'failProgramLink'] as const) {
      const context = createFakeGLContext(document.createElement('canvas'), { [fail]: true })
      expect(compileParticlesProgram(context.gl, 'cloud')).toBeNull()
    }
  })
})

describe('buffers, textures and drawing', () => {
  it('uploads, draws (clearing first) and destroys without throwing', () => {
    for (const mode of MODES) {
      const { context, program } = compiled(mode)
      let clears = 0
      const clear = context.gl.clear.bind(context.gl)
      context.gl.clear = (mask: number) => {
        clears++
        clear(mask)
      }
      uploadParticleBuffers(context.gl, program!, new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4]))
      const texture = createSourceTexture(context.gl)!
      uploadSourceTexture(context.gl, texture, document.createElement('canvas'))
      const state = { progress: 0.5, pointSize: 3, noiseAmount: 0.03, scatter: 0.12, time: 1, cell: [0.1, 0.1] as const, resolutionWidth: 400, resolutionHeight: 300, instanceCount: 1, from: texture, to: texture }
      expect(() => drawParticles(context, program!, state)).not.toThrow()
      expect(() => drawParticles(context, program!, { ...state, instanceCount: 0 })).not.toThrow()
      expect(clears).toBe(2) // a frame with nothing to draw still clears the last one
      expect(() => destroyParticlesProgram(context.gl, program!)).not.toThrow()
    }
  })
})
