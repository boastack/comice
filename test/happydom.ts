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
beforeEach(() => {
  resetSourceQuality()
  resetPackageQuality()
})
