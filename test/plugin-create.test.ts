/**
 * test/plugin-create — every plugin can copy itself (spec §04)
 * ─────────────────────────────────────────────────────────────────────────────
 * comice('.card').use(spotlight()) gives each matched element its own
 * instance via the plugin's create(). A plugin instance holds one element's
 * state, so a copy must be a fresh object, configured the same.
 */

import { describe, expect, it } from 'bun:test'
import type { ComicePlugin } from 'comice'
import { ascii } from '../packages/ascii/src/index.js'
import { aura } from '../packages/aura/src/index.js'
import { color } from '../packages/color/src/index.js'
import { dissolve } from '../packages/dissolve/src/index.js'
import { distort } from '../packages/distort/src/index.js'
import { layout } from '../packages/layout/src/index.js'
import { morph } from '../packages/morph/src/index.js'
import { mosaic } from '../packages/mosaic/src/index.js'
import { particles } from '../packages/particles/src/index.js'
import { persist } from '../packages/persist/src/index.js'
import { rail } from '../packages/rail/src/index.js'
import { reveal } from '../packages/reveal/src/index.js'
import { seed } from '../packages/seed/src/index.js'
import { spotlight } from '../packages/spotlight/src/index.js'
import { type } from '../packages/type/src/index.js'

const img = () => document.createElement('img')

const plugins: Array<[string, () => ComicePlugin]> = [
  ['ascii', () => ascii()],
  ['aura', () => aura()],
  ['color', () => color()],
  ['dissolve', () => dissolve({ from: img(), to: img() })],
  ['distort', () => distort()],
  ['layout', () => layout({ mode: 'crop' })],
  ['morph', () => morph({ operation: 'merge' })],
  ['mosaic', () => mosaic({ fill: 'images', sources: [img()] })],
  ['particles', () => particles({ from: { text: 'HELLO' } })],
  ['persist', () => persist({ match: 'hero' })],
  ['rail', () => rail({ mode: 'strip' })],
  ['reveal', () => reveal()],
  ['seed', () => seed()],
  ['spotlight', () => spotlight()],
  ['type', () => type({ mode: 'melt' })],
]

describe('create(): a fresh, identically configured copy', () => {
  it.each(plugins)('%s', (name, make) => {
    const plugin = make()
    const copy = plugin.create!()
    expect(copy).not.toBe(plugin)
    expect(copy.name).toBe(name)
    expect(copy.create).toBeDefined() // copies copy too
  })
})
