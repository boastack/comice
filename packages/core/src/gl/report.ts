/**
 * comice/core/gl/report
 * ─────────────────────────────────────────────────────────────────────────────
 * The `ready` / `error` lifecycle events (spec §04) for GPU plugins, with one
 * set of messages instead of each plugin wording its own.
 *
 * Every GPU failure here already degraded quietly (rule 04: the media still
 * shows) — and that was the problem: an effect that silently didn't appear
 * left a developer no way to tell why. These say why.
 */

import type { ComiceInstance } from '../types.js'
import type { Plane } from './plane.js'

export type GLReporter = {
  /** No WebGL2 context could be created. */
  noContext(): void
  /** The plugin's shader didn't compile or link on this device. */
  noProgram(): void
  /** Call after each draw: reports `ready` the first time every plane has a
   *  texture, or `error` the first time one couldn't be uploaded. */
  afterDraw(...planes: ReadonlyArray<Plane | null>): void
}

/**
 * `onUnusable` runs when an upload fails after setup (the cross-origin
 * case): the plugin's chance to hand its element back. Without it the
 * media stayed `visibility: hidden` behind a canvas with nothing to draw —
 * the media DISAPPEARED, breaking rule 04 (seen in Chromium with a real
 * cross-origin image). Media plugins pass their mount's release().
 */
export function createGLReporter(instance: ComiceInstance, plugin: string, onUnusable?: () => void): GLReporter {
  let readySent = false
  let errorSent = false

  function fail(message: string): void {
    if (errorSent) return
    errorSent = true
    instance.fail(plugin, new Error(message))
  }

  return {
    noContext(): void {
      fail(`[comice] ${plugin}(): WebGL2 is unavailable in this browser, so the effect can't run. The original media is shown unchanged.`)
    },
    noProgram(): void {
      fail(`[comice] ${plugin}(): its shader failed to compile on this device, so the effect can't run. The original media is shown unchanged.`)
    },
    afterDraw(...planes): void {
      const failed = planes.find((plane) => plane?.error)
      if (failed) {
        if (!errorSent) onUnusable?.()
        fail(`[comice] ${plugin}(): ${failed.error!.message}`)
        return
      }
      if (readySent || planes.some((plane) => !plane?.texture)) return
      readySent = true
      instance.ready(plugin)
    },
  }
}
