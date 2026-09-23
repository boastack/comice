/**
 * comice/core/gl
 * ─────────────────────────────────────────────────────────────────────────────
 * T1 (ROADMAP.md §4): the WebGL2 texture-on-plane foundation. Own bundle
 * entry (see tsup.config.ts) — importing core's main entry must not force
 * WebGL2 context creation on a page that never uses it, same discipline as
 * drivers/audio.ts staying out of the main bundle.
 */
export { createGLContext, hasGLContext, effectiveDPR, type GLContext } from './context.js'
export { createPlane, drawPlane, type Plane, type PlaneSource } from './plane.js'
export { waitForMediaReady } from './ready.js'
export { getResidencyPool, type ResidencyPool } from './residency.js'
export {
  createCursorMask,
  createRasterizedMask,
  createDerivedMask,
  bindMaskUniforms,
  MASK_SAMPLE_GLSL,
  IDENTITY_UV_TRANSFORM,
  type MaskField,
  type MaskFalloff,
  type UVTransform,
  type CursorMask,
  type CursorMaskOptions,
  type RasterizedMask,
  type RasterizedMaskSource,
  type RasterizeOptions,
  type DerivedMask,
  type DerivedMaskKind,
  type DerivedMaskOptions,
} from './mask.js'
export { createFeedbackBuffer, type FeedbackBuffer } from './feedback.js'
export {
  SIMPLEX_NOISE_GLSL,
  CURL_NOISE_GLSL,
  DISPLACEMENT_SAMPLER_GLSL,
  composeNoiseGLSL,
} from './noise.js'
