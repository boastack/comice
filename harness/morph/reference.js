// Immutable shader/mask reference captured from the retired prototype pages.
// Only the math is retained: tests no longer fetch or execute old demo pages.
let snapshot
function referenceSnapshot() {
  return snapshot ??= fetch(new URL('./fixtures/prototype-reference.json', import.meta.url)).then(response => {
    if (!response.ok) throw new Error(`Could not load prototype reference: ${response.status}`)
    return response.json()
  })
}
export async function legacyReference() {
  const { shapeFunction, mainTemplate, maskTemplate } = await referenceSnapshot()
  const buildShape = new Function('GAP_PX', `${shapeFunction}; return buildShapeShader`)(24)
  const main = new Function('config', 'shapeShader', `return ${mainTemplate}`)
  const mask = new Function(`return ${maskTemplate}`)()
  return {
    main: (config) => main(config, buildShape(config)),
    liquid: () => mask.replaceAll('uResolution', 'u_resolution').replaceAll('uProgress', 'u_progress').replaceAll('uVelocity', 'u_velocity').replaceAll('uPointer', 'u_mouse').replaceAll('uVideoAspect', 'u_mediaAspect').replaceAll('uVideo', 'u_media').replaceAll('uMask', 'u_wordmark'),
  };
}

// Runs the prototype's original mask producers without Three's renderer.
// The DataTexture stand-in records the bytes those functions hand to Three.
export async function legacyMasks() {
  const { mainMasks, distanceTransform, shapeMasks } = await referenceSnapshot()
  class DataTexture {
    constructor(data, width, height) { this.image = { data, width, height }; this.updates = 0; this.wait = new Promise((resolve) => { this.resolve = resolve }) }
    set needsUpdate(value) { if (value && ++this.updates >= 2) this.resolve() }
  }
  const THREE = { DataTexture, RGBAFormat: 1, LinearFilter: 1 }
  const main = new Function('THREE', 'emptyMaskTexture', `${mainMasks}; return {apple: createAppleLogoTexture, text: createWordmarkTexture}`)(THREE, null)
  const transform = new Function(`${distanceTransform}; return distanceTransform`)()
  const masks = new Function('THREE', 'distanceTransform', 'enqueueSdfJob', `${shapeMasks}; return {shape: createSdfTexture, text: createWordmarkSdfTexture}`)(THREE, transform, (job) => job())
  return async (demo) => {
    if (demo.id === 'apple') return main.apple().image
    const tex = demo.square ? demo.mask ? masks.shape(demo.mask) : masks.text(demo.text) : main.text(demo.text)
    await tex.wait
    return tex.image
  }
}
