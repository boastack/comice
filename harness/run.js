/**
 * harness/run.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Instantiates every plugin that owns real GLSL (morph, dissolve, distort,
 * color, mosaic, ascii, particles, aura) against real media in a real
 * WebGL2 context, using comice's actual public API exactly as a consumer
 * would (`comice(target).use(plugin(options))`) — not the fake-GL test
 * doubles the unit test suite uses. Each card reports pass/fail based on
 * gl-probe.js's real browser-compiler diagnostics, not just "did the JS
 * throw."
 *
 * Deliberately NOT a build step or bundler — plain ESM + an import map
 * (index.html) pointed at each package's real `dist/` output, served by
 * any static file server. `pnpm build` must be run first so `dist/` is
 * current.
 */

import { comice } from 'comice'
import { pointer } from 'comice/drivers'
import { installGLProbe } from './gl-probe.js'
import { loadHarnessMedia } from './media.js'

const statusEl = document.getElementById('status')
const grid = document.getElementById('grid')

function setStatus(text, cls) {
  statusEl.textContent = text
  statusEl.className = cls
}

function makeCard(title, configLabel) {
  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML = `
    <h2>${title} <span class="badge pending" data-role="badge">pending</span></h2>
    <p class="config">${configLabel}</p>
    <div class="stage" data-role="stage"></div>
    <pre class="config" data-role="log" style="white-space:pre-wrap;margin-top:8px"></pre>
  `
  grid.appendChild(card)
  return {
    stage: card.querySelector('[data-role="stage"]'),
    badge: card.querySelector('[data-role="badge"]'),
    log: card.querySelector('[data-role="log"]'),
  }
}

function report(ui, errors) {
  if (errors.length === 0) {
    ui.badge.textContent = 'compiled ✓'
    ui.badge.className = 'badge ok'
  } else {
    ui.badge.textContent = `${errors.length} error(s)`
    ui.badge.className = 'badge fail'
    ui.log.textContent = errors.map((e) => `[${e.type}]\n${e.log}`).join('\n\n')
  }
}

function makeMediaClone(sourceImg) {
  // Each plugin needs its own <img> element (a plugin hides/replaces its
  // target) — clone from the same decoded source so every card gets
  // identical real pixel content without re-decoding per card.
  const img = document.createElement('img')
  img.src = sourceImg.src
  img.width = sourceImg.width
  img.height = sourceImg.height
  return img
}

async function run() {
  setStatus('Generating test media (canvas-drawn, no external files)…', 'pending')
  const media = await loadHarnessMedia()

  setStatus('Instantiating every GLSL-touching plugin against real WebGL2…', 'pending')
  const probe = installGLProbe()
  const instances = []

  function mount(title, configLabel, setup) {
    const ui = makeCard(title, configLabel)
    probe.drain() // clear anything from a previous card before this one starts
    try {
      const handle = setup(ui.stage)
      instances.push(handle)
      // One rAF so setup()'s own renderFrame() has actually run and any
      // compile it triggers has happened before we read the probe.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          report(ui, probe.drain())
        })
      })
    } catch (err) {
      ui.badge.textContent = 'threw'
      ui.badge.className = 'badge fail'
      ui.log.textContent = String(err && err.stack || err)
    }
  }

  // ── morph — all five operations ─────────────────────────────────────
  const { morph } = await import('@comice/morph')
  const morphOps = [
    ['merge', { from: '/demo/assets/images/shelf.svg', to: 'inset(0 round 24px)', join: true }],
    ['breakout', { to: '/demo/assets/images/fan.svg', join: true }],
    ['distribute', { to: '/demo/assets/images/circles.svg' }],
    ['recompose', { from: '/demo/assets/images/shelf.svg', to: 'circle(40%)' }],
    ['mask', { to: { type: 'text', text: 'COMICE' } }],
  ]
  for (const [name, opts] of morphOps) {
    mount(`morph — ${name}`, JSON.stringify(opts), (stage) => {
      const el = makeMediaClone(media.portrait)
      stage.appendChild(el)
      const handle = comice(el).use(morph(opts))
      handle.setProgress(0.5)
      return handle
    })
  }
  // thread option, layered on distribute
  mount('morph — thread', 'distribute + thread', (stage) => {
    const el = makeMediaClone(media.portrait)
    stage.appendChild(el)
    const handle = comice(el).use(morph({ to: '/demo/assets/images/petals.svg', join: { style: 'slab', width: 8, sag: 4 } }))
    handle.setProgress(0.5)
    return handle
  })

  // ── dissolve — crossfade/noise/liquid ────────────────────────────────
  const { dissolve } = await import('@comice/dissolve')
  for (const transition of ['crossfade', 'noise', 'liquid']) {
    mount(`dissolve — ${transition}`, JSON.stringify({ transition }), (stage) => {
      const container = document.createElement('div')
      stage.appendChild(container)
      const from = makeMediaClone(media.portrait)
      const to = makeMediaClone(media.skyline)
      const handle = comice(container).use(dissolve({ transition, from, to }))
      handle.setProgress(0.5)
      return handle
    })
  }

  // ── distort — bulge/lens/glass, driven by pointer() ──────────────────
  const { distort } = await import('@comice/distort')
  for (const effect of ['bulge', 'lens', 'glass']) {
    mount(`distort — ${effect}`, JSON.stringify({ effect }), (stage) => {
      const el = makeMediaClone(media.portrait)
      stage.appendChild(el)
      const handle = comice(el).use(distort({ effect })).driver(pointer({ radius: 200 }))
      return handle
    })
  }

  // ── color — every effect together (the composable stack) ─────────────
  const { color } = await import('@comice/color')
  mount('color — duotone+grain+bloom+aberration', 'composable stack', (stage) => {
    const el = makeMediaClone(media.portrait)
    stage.appendChild(el)
    return comice(el).use(color({ effects: ['duotone', 'grain', 'bloom', 'aberration'] }))
  })

  // ── mosaic — all six fills ────────────────────────────────────────────
  const { mosaic } = await import('@comice/mosaic')
  for (const fill of ['dither', 'halftone', 'riso', 'pixelate', 'crosshatch']) {
    mount(`mosaic — ${fill}`, JSON.stringify({ fill }), (stage) => {
      const el = makeMediaClone(media.portrait)
      stage.appendChild(el)
      return comice(el).use(mosaic({ fill, cell: 14 }))
    })
  }
  mount('mosaic — images', 'fill: images, 2 tile sources', (stage) => {
    const el = makeMediaClone(media.portrait)
    stage.appendChild(el)
    return comice(el).use(mosaic({ fill: 'images', cell: 24, sources: [makeMediaClone(media.portrait), makeMediaClone(media.skyline)] }))
  })

  // ── ascii — default + custom charset ──────────────────────────────────
  const { ascii } = await import('@comice/ascii')
  mount('ascii — default charset', "' .:-=+*#%@'", (stage) => {
    const el = makeMediaClone(media.portrait)
    stage.appendChild(el)
    return comice(el).use(ascii())
  })
  mount('ascii — binary charset', "'01'", (stage) => {
    const el = makeMediaClone(media.portrait)
    stage.appendChild(el)
    return comice(el).use(ascii({ charset: '01', cell: 12 }))
  })

  // ── particles — cloud/shatter, with fluid motion ──────────────────────
  const { particles } = await import('@comice/particles')
  mount('particles — cloud', 'from -> to, count 4000', (stage) => {
    const container = document.createElement('div')
    stage.appendChild(container)
    const handle = comice(container).use(particles({ mode: 'cloud', from: media.portrait, to: media.skyline, count: 4000 }))
    handle.setProgress(0.5)
    return handle
  })
  mount('particles — shatter + fluid', 'motion.fluid, count 2000', (stage) => {
    const container = document.createElement('div')
    stage.appendChild(container)
    const handle = comice(container).use(particles({ mode: 'shatter', from: media.portrait, count: 2000, motion: { fluid: true } }))
    handle.setProgress(0.3)
    return handle
  })

  // ── aura — edges + palette (its own downsample shader) ────────────────
  const { aura } = await import('@comice/aura')
  mount('aura — sample: edges', "sample: 'edges'", (stage) => {
    const el = makeMediaClone(media.portrait)
    stage.appendChild(el)
    return comice(el).use(aura({ sample: 'edges', sampleIntervalMs: 0 }))
  })
  mount('aura — sample: palette', "sample: 'palette', colors: 5", (stage) => {
    const el = makeMediaClone(media.portrait)
    stage.appendChild(el)
    return comice(el).use(aura({ sample: 'palette', colors: 5, sampleIntervalMs: 0 }))
  })

  // Give every card's renderFrame a couple of real frames to run before
  // declaring the sweep finished (morph/distort/etc. all render on their
  // own scheduler tick, not synchronously inside setup()).
  await new Promise((resolve) => setTimeout(resolve, 500))

  const totalCards = grid.children.length
  const failed = grid.querySelectorAll('.badge.fail').length
  if (failed === 0) {
    setStatus(`✓ All ${totalCards} configurations compiled cleanly in this browser's real WebGL2 context.`, 'ok')
  } else {
    setStatus(`✗ ${failed} of ${totalCards} configurations produced a real compile/link error — see the failing card(s) below for the actual browser compiler diagnostic.`, 'fail')
  }

  window.__comiceHarnessInstances = instances // kept reachable for manual console inspection / cleanup
}

run().catch((err) => {
  setStatus('Harness itself threw before finishing — see console.', 'fail')
  console.error(err)
})
