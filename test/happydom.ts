/**
 * Bun test preload: installs a happy-dom global environment before any test
 * file runs, so DOM-touching modules (scheduler.ts's IntersectionObserver
 * and document usage, and future driver tests) work under `bun test`
 * without every test file wiring this up itself.
 */
import { beforeEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

// The frame budget (core's budget.ts) is page-global by design — one frame
// clock per page. In a test process that means slow frames simulated by one
// test (a 250ms-per-frame animation, say) step quality down for whatever
// runs next, shrinking an unrelated test's canvas. Every test starts at full
// quality. Both copies of core: source (imported by core's own tests) and
// the built package (what plugin tests import as `comice`).
const { resetQuality: resetSourceQuality } = await import('../packages/core/src/budget.js')
const { resetQuality: resetPackageQuality } = await import('comice')
const { getSharedScheduler: sourceScheduler } = await import('../packages/core/src/scheduler.js')
const { getSharedScheduler: packageScheduler } = await import('comice/scheduler')
beforeEach(() => {
  sourceScheduler().stop()
  packageScheduler().stop()
  resetSourceQuality()
  resetPackageQuality()
})

// Shape bakes run on a background Worker in browsers (core's gl/mask.ts). Bun
// has a real Worker, which would land them on another thread at an arbitrary
// time; tests bake inline instead, so results arrive deterministically.
// test/gl-bake-worker.test.ts covers the worker path with a fake.
;(globalThis as { Worker?: unknown }).Worker = undefined

// happy-dom's element.animate() returns a stub whose animations never finish,
// so a crossfade (core's mountCanvas hideTarget(fadeMs)) would never complete.
// Without it, effects take the immediate path; test/gl-bake-worker.test.ts
// covers the fade with a controllable fake.
;(Element.prototype as { animate?: unknown }).animate = undefined
