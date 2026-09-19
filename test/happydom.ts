/**
 * Bun test preload: installs a happy-dom global environment before any test
 * file runs, so DOM-touching modules (scheduler.ts's IntersectionObserver
 * and document usage, and future driver tests) work under `bun test`
 * without every test file wiring this up itself.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
