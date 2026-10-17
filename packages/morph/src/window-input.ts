/**
 * The page's own pointer and scroll speed, for cursorFollow and bend.
 *
 * Both effects want the whole window's input, not the element's: media that follows the
 * cursor anywhere on the page, a shape that flexes with how fast the page is scrolling.
 * The legacy pages fed their shaders exactly this, so it is built in here and the effect
 * works with no wiring. Anything that drives a channel itself (a `.map()`, `setParam`)
 * takes that channel over, and this stops writing to it.
 *
 * The smoothing is legacy's, in per-60fps-frame terms so it holds at any refresh rate:
 * the pointer eases .05 of the way each frame; scroll speed (px/s over 2000, clamped to
 * -1..1) eases .08 of the way and the raw speed decays .9 a frame once scrolling stops.
 */

export type WindowInput = {
  /** Eased pointer position over the window, -1..1 on each axis (y up). 0 until it moves. */
  readonly mouseX: number
  readonly mouseY: number
  /** Eased scroll speed, -1..1. 0 at rest. */
  readonly velocity: number
  /** Advances the easing by one frame of `deltaMs`. */
  tick(deltaMs: number): void
  /** Drops the scroll speed to rest. For an effect that was not ticking (off screen, in a
   *  hidden tab): the page's speed has long since decayed, and the stale value would bend
   *  the shape the moment it came back into view. The pointer keeps its place. */
  settle(): void
  destroy(): void
}

const POINTER_EASE = 0.05
const SPEED_EASE = 0.08
const SPEED_DECAY = 0.9
const SPEED_RANGE = 2000

export function trackWindowInput(options: { pointer: boolean; scroll: boolean }): WindowInput {
  let targetX = 0
  let targetY = 0
  let x = 0
  let y = 0
  let raw = 0
  let speed = 0
  let lastY = typeof scrollY === 'number' ? scrollY : 0
  let lastAt = 0
  const cleanups: Array<() => void> = []

  // Only where there is a hover-capable pointer: on touch, "the cursor" is wherever the
  // last tap landed, and media drifting toward it would be wrong.
  const hover = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches
  if (options.pointer && hover) {
    const onMove = (event: PointerEvent) => {
      targetX = (event.clientX / innerWidth) * 2 - 1
      targetY = -((event.clientY / innerHeight) * 2 - 1)
    }
    addEventListener('pointermove', onMove, { passive: true })
    cleanups.push(() => removeEventListener('pointermove', onMove))
  }

  if (options.scroll) {
    const onScroll = () => {
      const now = performance.now()
      const dt = (now - lastAt) / 1000
      lastAt = now
      const current = scrollY
      // The first event, or one after a pause, has no meaningful interval to divide by.
      if (dt > 0.001 && dt < 0.5) raw = (current - lastY) / dt
      lastY = current
    }
    addEventListener('scroll', onScroll, { passive: true })
    cleanups.push(() => removeEventListener('scroll', onScroll))
  }

  return {
    get mouseX() { return x },
    get mouseY() { return y },
    get velocity() { return speed },
    tick(deltaMs: number): void {
      const frames = Math.max(0, Math.min(deltaMs, 50)) * 0.06
      x += (targetX - x) * (1 - Math.pow(1 - POINTER_EASE, frames))
      y += (targetY - y) * (1 - Math.pow(1 - POINTER_EASE, frames))
      speed += (Math.max(-1, Math.min(1, raw / SPEED_RANGE)) - speed) * (1 - Math.pow(1 - SPEED_EASE, frames))
      // Exact rest lets the renderer skip identical image frames after a move.
      if (Math.abs(targetX - x) < 1e-5) x = targetX
      if (Math.abs(targetY - y) < 1e-5) y = targetY
      raw *= Math.pow(SPEED_DECAY, frames)
      // Settle exactly instead of easing forever toward zero.
      if (Math.abs(raw) < 1) raw = 0
      if (Math.abs(speed) < 1e-4 && raw === 0) speed = 0
    },
    settle(): void {
      raw = 0
      speed = 0
    },
    destroy(): void {
      cleanups.splice(0).forEach((cleanup) => cleanup())
    },
  }
}
