/**
 * @comice/reveal/effects
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions: progress (0..1) -> inline CSS to apply to the target
 * element. Zero DOM here — each function only computes strings, applying
 * them is index.ts's job. Kept pure and unit-testable in isolation, same
 * discipline core's mapping.ts follows.
 *
 * Per the v0.1 scope decision: `mask` is deliberately NOT implemented here.
 * It needs the shared mask field (spec section 07), which requires the GPU
 * pipeline — not built yet. reveal was chosen as the first plugin
 * specifically because it can ship entirely as CSS and geometry with no
 * shaders; shipping `mask` now would mean either faking it with a DOM clip
 * (a different, throwaway implementation from the real GPU mask field
 * every other plugin will consume later) or blocking this plugin on work
 * that belongs to a different phase. Section 18's own v0.3 build order
 * agrees: reveal gains masks once dissolve/distort have proven the mask
 * field as real consumers.
 */

export type RevealEffect = 'wipe' | 'scale' | 'blur' | 'blinds' | 'slats' | 'curtain' | 'expand'

export type EffectStyle = {
  clipPath?: string
  transform?: string
  filter?: string
  opacity?: string
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** Repeating-band clip-path shared by blinds/slats: `count` evenly spaced
 *  bands along one axis, each opening from its own center outward as
 *  `progress` advances. `axis: 'x'` gives vertical bands (slats), `axis:
 *  'y'` gives horizontal bands (blinds). */
function bandedClipPath(progress: number, count: number, axis: 'x' | 'y'): string {
  const bandSize = 100 / count
  const openPct = clamp01(progress) * bandSize
  const inset = (bandSize - openPct) / 2
  const polygons: string[] = []
  for (let i = 0; i < count; i++) {
    const start = i * bandSize + inset
    const end = (i + 1) * bandSize - inset
    if (axis === 'y') {
      polygons.push(`0% ${start}%, 100% ${start}%, 100% ${end}%, 0% ${end}%`)
    } else {
      polygons.push(`${start}% 0%, ${end}% 0%, ${end}% 100%, ${start}% 100%`)
    }
  }
  return `polygon(evenodd, ${polygons.map((p) => `${p}`).join(', ')})`
}

export function wipe(progress: number, direction: 'left' | 'right' | 'up' | 'down' = 'left'): EffectStyle {
  const p = clamp01(progress) * 100
  switch (direction) {
    case 'left':
      return { clipPath: `inset(0 ${100 - p}% 0 0)` }
    case 'right':
      return { clipPath: `inset(0 0 0 ${100 - p}%)` }
    case 'up':
      return { clipPath: `inset(${100 - p}% 0 0 0)` }
    case 'down':
      return { clipPath: `inset(0 0 ${100 - p}% 0)` }
  }
}

export function scale(progress: number, from = 0.85): EffectStyle {
  const p = clamp01(progress)
  const s = from + (1 - from) * p
  return { transform: `scale(${s})`, opacity: `${p}` }
}

export function blur(progress: number, from = 16): EffectStyle {
  const p = clamp01(progress)
  const px = from * (1 - p)
  return { filter: `blur(${px}px)`, opacity: `${p}` }
}

export function blinds(progress: number, count = 8): EffectStyle {
  return { clipPath: bandedClipPath(progress, count, 'y') }
}

export function slats(progress: number, count = 8): EffectStyle {
  return { clipPath: bandedClipPath(progress, count, 'x') }
}

/** Two panels parting from the center, revealing what's underneath —
 *  distinct from wipe (one edge sweeping across) by opening from the
 *  middle outward in both directions at once. */
export function curtain(progress: number): EffectStyle {
  const p = clamp01(progress) * 50
  return { clipPath: `inset(0 ${50 - p}% 0 ${50 - p}%)` }
}

export function expand(progress: number, from = 0.4): EffectStyle {
  const p = clamp01(progress)
  const s = from + (1 - from) * p
  const insetPct = (1 - p) * 50
  return {
    transform: `scale(${s})`,
    clipPath: `inset(${insetPct}% round 4px)`,
    opacity: `${p}`,
  }
}

// Each entry called with only `progress` — every effect's second parameter
// (direction/from/count) is an authoring-time choice, not something
// computeEffectStyle ever varies at call time, so the map only needs to
// promise the one-argument call every effect function already accepts.
const EFFECTS: Record<RevealEffect, (progress: number) => EffectStyle> = {
  wipe: (p) => wipe(p),
  scale: (p) => scale(p),
  blur: (p) => blur(p),
  blinds: (p) => blinds(p),
  slats: (p) => slats(p),
  curtain: (p) => curtain(p),
  expand: (p) => expand(p),
}

export function computeEffectStyle(effect: RevealEffect, progress: number): EffectStyle {
  return EFFECTS[effect](progress)
}
