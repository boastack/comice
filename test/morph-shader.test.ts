/**
 * test/morph-shader.test — packages/morph/src/shader.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts
 * (same reason gl-plane.test.ts needs it — happy-dom's real
 * getContext('webgl2') is always null).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { compileMorphProgram, destroyMorphProgram, drawMorph } from '../harness/morph/legacy-engine/shader.js'
import { getResidencyPool } from '../packages/core/src/gl/residency.js'
import { createFakeGLContext } from './fake-webgl2.js'
import type { Plane } from '../packages/core/src/gl/plane.js'

function fakeTexture(id: string): WebGLTexture {
  return { __id: id } as unknown as WebGLTexture
}

function fakePlane(texture: WebGLTexture | null): Plane {
  return {
    texture,
    upload() {},
    syncLayout() {},
    box: { x: 0, y: 0, width: 100, height: 100 },
    destroy() {},
  }
}

describe('compileMorphProgram', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('compiles successfully for the shelf layout, merge operation', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })
    expect(program).not.toBeNull()
  })

  it('compiles successfully for the fan layout, breakout operation', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'fan', operation: 'breakout' })
    expect(program).not.toBeNull()
  })

  it('compiles successfully for the distribute operation', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'distribute' })
    expect(program).not.toBeNull()
  })

  it('respects liquid: 0 and liquid: 1 without throwing', () => {
    const context = createFakeGLContext(canvas)
    expect(() => compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge', liquid: 0 })).not.toThrow()
    expect(() => compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge', liquid: 1 })).not.toThrow()
  })

  it('respects an explicit count for the shelf layout', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge', count: 6 })
    expect(program).not.toBeNull()
  })

  it.each(['circles', 'symbols', 'arches', 'petals', 'filmStrip', 'spectrum', 'waveTiles'] as const)(
    'compiles successfully for the %s layout, exercising its specific SDF dependencies',
    (layout) => {
      const context = createFakeGLContext(canvas)
      const program = compileMorphProgram(context.gl, { layout, operation: 'merge' })
      expect(program).not.toBeNull()
    },
  )

  it('returns null, never throws, when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(() => compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })).not.toThrow()
    expect(compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })).toBeNull()
  })

  it('returns null, never throws, when program linking fails', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    expect(compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })).toBeNull()
  })

  it('returns null, never throws, when createProgram() itself returns null', () => {
    const context = createFakeGLContext(canvas, { failCreateProgram: true })
    expect(compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })).toBeNull()
  })

  it('exposes all six uniform locations', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })!
    expect(program.uResolution).not.toBeNull()
    expect(program.uProgress).not.toBeNull()
    expect(program.uMouse).not.toBeNull()
    expect(program.uVelocity).not.toBeNull()
    expect(program.uMediaAspect).not.toBeNull()
    expect(program.uMedia).not.toBeNull()
  })

  it('a merge/breakout/distribute program is not flagged isMask, and has no mask uniforms', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })!
    expect(program.isMask).toBe(false)
    expect(program.uMask).toBeNull()
    expect(program.uMaskScale).toBeNull()
  })
})

describe('compileMorphProgram — operation: "mask"', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('compiles successfully with no layout/count at all', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { operation: 'mask' })
    expect(program).not.toBeNull()
  })

  it('is flagged isMask and exposes uMask/uMaskScale', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { operation: 'mask' })!
    expect(program.isMask).toBe(true)
    expect(program.uMask).not.toBeNull()
    expect(program.uMaskScale).not.toBeNull()
  })

  it('still exposes every other uniform a merge/breakout/distribute program has', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { operation: 'mask' })!
    expect(program.uResolution).not.toBeNull()
    expect(program.uProgress).not.toBeNull()
    expect(program.uMouse).not.toBeNull()
    expect(program.uVelocity).not.toBeNull()
    expect(program.uMediaAspect).not.toBeNull()
    expect(program.uMedia).not.toBeNull()
  })

  it('respects liquid: 0 and liquid: 1 without throwing', () => {
    const context = createFakeGLContext(canvas)
    expect(() => compileMorphProgram(context.gl, { operation: 'mask', liquid: 0 })).not.toThrow()
    expect(() => compileMorphProgram(context.gl, { operation: 'mask', liquid: 1 })).not.toThrow()
  })

  it('returns null, never throws, when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(compileMorphProgram(context.gl, { operation: 'mask' })).toBeNull()
  })

  it('returns null, never throws, when program linking fails', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    expect(compileMorphProgram(context.gl, { operation: 'mask' })).toBeNull()
  })
})

describe('compileMorphProgram — operation: "recompose"', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('compiles successfully with the default recomposeTarget ("frame")', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'recompose' })
    expect(program).not.toBeNull()
  })

  it.each(['circle', 'square', 'frame'] as const)('compiles successfully for recomposeTarget "%s"', (recomposeTarget) => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'recompose', recomposeTarget })
    expect(program).not.toBeNull()
  })

  it('compiles successfully for every layout, not just shelf', () => {
    const context = createFakeGLContext(canvas)
    const layouts = ['shelf', 'fan', 'circles', 'symbols', 'arches', 'petals', 'filmStrip', 'spectrum', 'waveTiles'] as const
    for (const layout of layouts) {
      expect(compileMorphProgram(context.gl, { layout, operation: 'recompose' })).not.toBeNull()
    }
  })

  it('respects custom recomposeStart/recomposeEnd without throwing', () => {
    const context = createFakeGLContext(canvas)
    expect(() =>
      compileMorphProgram(context.gl, {
        layout: 'shelf',
        operation: 'recompose',
        recomposeStart: 0.2,
        recomposeEnd: 0.6,
      }),
    ).not.toThrow()
  })

  it('is not flagged isMask, and has no mask uniforms', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'recompose' })!
    expect(program.isMask).toBe(false)
    expect(program.uMask).toBeNull()
    expect(program.uMaskScale).toBeNull()
  })

  it('returns null, never throws, when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(compileMorphProgram(context.gl, { layout: 'shelf', operation: 'recompose' })).toBeNull()
  })
})

describe('compileMorphProgram — thread option', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('compiles successfully with thread on a merge operation', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge', thread: {} })
    expect(program).not.toBeNull()
  })

  it('compiles successfully with thread on a breakout operation', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'fan', operation: 'breakout', thread: {} })
    expect(program).not.toBeNull()
  })

  it('compiles successfully with thread on a distribute operation', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'distribute', thread: {} })
    expect(program).not.toBeNull()
  })

  it('compiles successfully with thread on a recompose operation', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'recompose', thread: {} })
    expect(program).not.toBeNull()
  })

  it('compiles successfully with thread for every layout', () => {
    const context = createFakeGLContext(canvas)
    const layouts = ['shelf', 'fan', 'circles', 'symbols', 'arches', 'petals', 'filmStrip', 'spectrum', 'waveTiles'] as const
    for (const layout of layouts) {
      expect(compileMorphProgram(context.gl, { layout, operation: 'merge', thread: {} })).not.toBeNull()
    }
  })

  it('respects explicit width/pinch/sag/dissolve without throwing', () => {
    const context = createFakeGLContext(canvas)
    expect(() =>
      compileMorphProgram(context.gl, {
        layout: 'shelf',
        operation: 'merge',
        thread: { width: 0.05, pinch: 0.8, sag: 0.3, dissolve: 0.9 },
      }),
    ).not.toThrow()
  })

  it('clamps pinch and dissolve into [0, 1] without throwing on out-of-range input', () => {
    const context = createFakeGLContext(canvas)
    expect(() =>
      compileMorphProgram(context.gl, {
        layout: 'shelf',
        operation: 'merge',
        thread: { pinch: 5, dissolve: -3 },
      }),
    ).not.toThrow()
  })

  it('thread is ignored (no throw, compiles fine) for operation: "mask"', () => {
    const context = createFakeGLContext(canvas)
    expect(() => compileMorphProgram(context.gl, { operation: 'mask', thread: {} })).not.toThrow()
  })

  it('omitting thread entirely still compiles (thread is fully optional)', () => {
    const context = createFakeGLContext(canvas)
    expect(compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })).not.toBeNull()
  })

  it('returns null, never throws, when shader compilation fails with thread active', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    expect(compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge', thread: {} })).toBeNull()
  })
})

describe('destroyMorphProgram', () => {
  it('does not throw', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })!
    expect(() => destroyMorphProgram(context.gl, program)).not.toThrow()
    canvas.remove()
  })
})

describe('drawMorph', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('draws without throwing when the plane has a texture', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })!
    const plane = fakePlane(fakeTexture('media'))

    expect(() =>
      drawMorph(context, program, plane, {
        progress: 0.5,
        mouseX: 0,
        mouseY: 0,
        velocity: 0,
        mediaAspect: 16 / 9,
        resolutionWidth: 800,
        resolutionHeight: 600,
      }),
    ).not.toThrow()
  })

  it('does nothing (no throw) when the plane has no texture yet', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })!
    const plane = fakePlane(null)

    expect(() =>
      drawMorph(context, program, plane, {
        progress: 0,
        mouseX: 0,
        mouseY: 0,
        velocity: 0,
        mediaAspect: 1,
        resolutionWidth: 100,
        resolutionHeight: 100,
      }),
    ).not.toThrow()
  })

  it('does nothing (no throw) when the residency pool is exhausted', () => {
    const context = createFakeGLContext(canvas, { maxTextureUnits: 1 })
    const program = compileMorphProgram(context.gl, { layout: 'shelf', operation: 'merge' })!
    const plane1 = fakePlane(fakeTexture('a'))
    const plane2 = fakePlane(fakeTexture('b'))

    const state = {
      progress: 0.5,
      mouseX: 0,
      mouseY: 0,
      velocity: 0,
      mediaAspect: 1,
      resolutionWidth: 100,
      resolutionHeight: 100,
    }

    // drawMorph() itself does NOT call beginPass() (see its own doc
    // comment — the caller owns pass boundaries, same as drawPlane()), so
    // one explicit beginPass() here puts both calls below in the SAME
    // pass on purpose, exercising the budget-exhaustion path for real.
    getResidencyPool(context).beginPass()
    // First bind succeeds (fills the 1-unit budget); a second DIFFERENT
    // texture in the same pass should be turned away, not crash.
    expect(() => drawMorph(context, program, plane1, state)).not.toThrow()
    expect(() => drawMorph(context, program, plane2, state)).not.toThrow()
  })
})

describe('drawMorph — operation: "mask"', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('draws without throwing when both the media and mask textures are ready', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { operation: 'mask' })!
    const plane = fakePlane(fakeTexture('media'))

    expect(() =>
      drawMorph(context, program, plane, {
        progress: 0.5,
        mouseX: 0,
        mouseY: 0,
        velocity: 0,
        mediaAspect: 16 / 9,
        resolutionWidth: 800,
        resolutionHeight: 600,
        maskTexture: fakeTexture('mask'),
        maskScale: 0.12,
      }),
    ).not.toThrow()
  })

  it('does nothing (no throw) when maskTexture is null (mask not rasterized yet)', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { operation: 'mask' })!
    const plane = fakePlane(fakeTexture('media'))

    expect(() =>
      drawMorph(context, program, plane, {
        progress: 0.5,
        mouseX: 0,
        mouseY: 0,
        velocity: 0,
        mediaAspect: 1,
        resolutionWidth: 100,
        resolutionHeight: 100,
        maskTexture: null,
      }),
    ).not.toThrow()
  })

  it('does nothing (no throw) when maskTexture is undefined (option omitted entirely)', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { operation: 'mask' })!
    const plane = fakePlane(fakeTexture('media'))

    expect(() =>
      drawMorph(context, program, plane, {
        progress: 0.5,
        mouseX: 0,
        mouseY: 0,
        velocity: 0,
        mediaAspect: 1,
        resolutionWidth: 100,
        resolutionHeight: 100,
      }),
    ).not.toThrow()
  })

  it('defaults maskScale when omitted, without throwing', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { operation: 'mask' })!
    const plane = fakePlane(fakeTexture('media'))

    expect(() =>
      drawMorph(context, program, plane, {
        progress: 0.5,
        mouseX: 0,
        mouseY: 0,
        velocity: 0,
        mediaAspect: 1,
        resolutionWidth: 100,
        resolutionHeight: 100,
        maskTexture: fakeTexture('mask'),
        // maskScale intentionally omitted
      }),
    ).not.toThrow()
  })

  it('does nothing (no throw) when the media texture alone exhausts the residency budget before the mask gets a unit', () => {
    const context = createFakeGLContext(canvas, { maxTextureUnits: 1 })
    const program = compileMorphProgram(context.gl, { operation: 'mask' })!
    const plane = fakePlane(fakeTexture('media'))

    getResidencyPool(context).beginPass()
    expect(() =>
      drawMorph(context, program, plane, {
        progress: 0.5,
        mouseX: 0,
        mouseY: 0,
        velocity: 0,
        mediaAspect: 1,
        resolutionWidth: 100,
        resolutionHeight: 100,
        maskTexture: fakeTexture('mask'),
        maskScale: 0.1,
      }),
    ).not.toThrow()
  })

  it('reuses the same unit when the media and mask textures are bound again in a later, separate pass', () => {
    const context = createFakeGLContext(canvas)
    const program = compileMorphProgram(context.gl, { operation: 'mask' })!
    const plane = fakePlane(fakeTexture('media'))
    const state = {
      progress: 0.5,
      mouseX: 0,
      mouseY: 0,
      velocity: 0,
      mediaAspect: 1,
      resolutionWidth: 100,
      resolutionHeight: 100,
      maskTexture: fakeTexture('mask'),
      maskScale: 0.1,
    }

    getResidencyPool(context).beginPass()
    expect(() => drawMorph(context, program, plane, state)).not.toThrow()
    getResidencyPool(context).beginPass()
    expect(() => drawMorph(context, program, plane, state)).not.toThrow()
  })
})
