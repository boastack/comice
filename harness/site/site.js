/**
 * harness/site/site.js
 * ─────────────────────────────────────────────────────────────────────────────
 * A realistic, dense multi-plugin page — comice "used in anger" rather than
 * tested in isolation. Every section stacks real plugins on real elements,
 * driven by real drivers (scroll/hover/pointer/click), against real (in-
 * browser-generated) media. Unlike harness/run.js (which loads each plugin
 * ALONE to verify its own shader compiles), this file's whole point is
 * exercising COMBINATIONS: two GL-shader plugins on one element (hero:
 * distort + color), a plugin composing across a real SPA-style route toggle
 * (persist), many rail-driven instances animating at once, all coexisting
 * on one page with one shared scheduler and one shared GL context budget.
 *
 * Logs every real error/warning to the on-page #status-log (not just the
 * console) so a Playwright pass reading the page's own DOM can assert on
 * what actually happened, the same "real browser diagnostics, not just did
 * it throw" discipline harness/gl-probe.js already established.
 */

import { comice } from 'comice'
import { scroll, hover, pointer, click } from 'comice/drivers'
import { distort } from '@comice/distort'
import { color } from '@comice/color'
import { spotlight } from '@comice/spotlight'
import { rail } from '@comice/rail'
import { mosaic } from '@comice/mosaic'
import { ascii } from '@comice/ascii'
import { seed } from '@comice/seed'
import { dissolve } from '@comice/dissolve'
import { persist } from '@comice/persist'
import { particles } from '@comice/particles'
import { type } from '@comice/type'
import { layout } from '@comice/layout'
import { aura } from '@comice/aura'

const statusLog = document.getElementById('status-log')

function log(message, cls = 'info') {
  const line = document.createElement('div')
  line.className = cls
  line.textContent = message
  statusLog.appendChild(line)
  statusLog.scrollTop = statusLog.scrollHeight
}

window.addEventListener('error', (e) => log(`[window error] ${e.message}`, 'fail'))
window.addEventListener('unhandledrejection', (e) => log(`[unhandled rejection] ${e.reason}`, 'fail'))

// ── Real, in-browser-generated media (same technique harness/media.js uses) ──

function drawGradientImage(w, h, colors, shapes = true) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const grad = ctx.createLinearGradient(0, 0, w, h)
  colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  if (shapes) {
    const radial = ctx.createRadialGradient(w * 0.5, h * 0.4, 10, w * 0.5, h * 0.4, w * 0.4)
    radial.addColorStop(0, 'rgba(255,240,220,0.85)')
    radial.addColorStop(1, 'rgba(255,240,220,0)')
    ctx.fillStyle = radial
    ctx.fillRect(0, 0, w, h)
  }
  const img = new Image()
  img.src = canvas.toDataURL('image/png')
  img.width = w
  img.height = h
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img)
    img.onerror = reject
  })
}

const PALETTES = [
  ['#2b1a3a', '#6a3fae', '#e8a33d'],
  ['#0a1a2f', '#1f6f8b', '#ffd68a'],
  ['#2f0a1a', '#8b1f3f', '#ffb38a'],
  ['#0a2f1a', '#1f8b4f', '#d6ff8a'],
  ['#2f2a0a', '#8b6f1f', '#fff08a'],
  ['#1a0a2f', '#4f1f8b', '#c08aff'],
]

async function boot() {
  log('Generating real in-browser media for every section…')
  const heroImg = document.getElementById('hero-img')
  heroImg.src = (await drawGradientImage(1600, 900, PALETTES[0])).src

  // ── Hero: TWO GL-shader plugins stacked on the SAME element (distort +
  //    color), plus spotlight (pure CSS) — the deliberate stress case.
  try {
    const heroHandle = comice(heroImg)
      .use(distort({ effect: 'bulge', radius: 220, strength: 0.4 }))
      .use(color({ effects: ['duotone', 'grain'], duotone: { shadow: [0.05, 0.02, 0.1], highlight: [1, 0.9, 0.7] } }))
      .use(spotlight({ lift: 0.02 }))
      .driver(pointer({ radius: 260 }))
    log('hero: distort + color + spotlight, stacked on one element — mounted OK', 'ok')
    window.__heroHandle = heroHandle
  } catch (err) {
    log(`hero stack threw: ${err.message}`, 'fail')
  }

  // aura samples the hero and pushes color into the header's own CSS variable.
  try {
    comice(heroImg).use(aura({ sample: 'palette', colors: 3, sampleIntervalMs: 300 }))
    log('aura: sampling hero into --aura-color — mounted OK', 'ok')
  } catch (err) {
    log(`aura threw: ${err.message}`, 'fail')
  }

  // ── Project grid: rail (coverflow) + per-card mosaic/ascii hover swap + seed ──
  const railTrack = document.getElementById('rail-track')
  const cardData = []
  for (let i = 0; i < 6; i++) {
    const wrap = document.createElement('div')
    const card = document.createElement('div')
    card.className = 'project-card'
    const img = document.createElement('img')
    img.dataset.match = `project-${i}`
    const caption = document.createElement('p')
    caption.textContent = `Project ${String(i + 1).padStart(2, '0')}`
    card.appendChild(img)
    card.appendChild(caption)
    wrap.appendChild(card)
    railTrack.appendChild(wrap)
    cardData.push({ wrap, card, img, index: i })
  }

  await Promise.all(
    cardData.map(async ({ img }, i) => {
      img.src = (await drawGradientImage(640, 480, PALETTES[i % PALETTES.length])).src
    }),
  )

  try {
    comice(railTrack).use(rail({ mode: 'coverflow', snap: true }))
    log('rail: coverflow over 6 project cards — mounted OK', 'ok')
  } catch (err) {
    log(`rail threw: ${err.message}`, 'fail')
  }

  cardData.forEach(({ card, img, index }) => {
    try {
      // seed: placeholder + priority hint on every grid image.
      comice(img).use(seed({ priority: index < 2 }))
    } catch (err) {
      log(`seed on card ${index} threw: ${err.message}`, 'fail')
    }

    try {
      // Hover swaps the card between mosaic and ascii reconstruction —
      // two DIFFERENT GL-shader plugins mounted/torn down repeatedly on
      // the SAME element as the user moves the mouse across the grid,
      // exercising real setup()/teardown() churn under real hover events.
      let currentHandle = null
      const hoverDriver = hover({ intent: 40 })
      card.addEventListener('pointerenter', () => {
        try {
          currentHandle?.destroy()
          currentHandle = comice(img).use(index % 2 === 0 ? mosaic({ fill: 'dither', cell: 10 }) : ascii({ cell: 8 }))
        } catch (err) {
          log(`hover-swap effect on card ${index} threw: ${err.message}`, 'fail')
        }
      })
      card.addEventListener('pointerleave', () => {
        try {
          currentHandle?.destroy()
          currentHandle = null
        } catch (err) {
          log(`hover-swap teardown on card ${index} threw: ${err.message}`, 'fail')
        }
      })
    } catch (err) {
      log(`hover-swap wiring on card ${index} threw: ${err.message}`, 'fail')
    }

    // Click -> persist handoff into the detail route.
    card.addEventListener('click', () => navigateToDetail(index))
  })

  // ── Before/after: dissolve, scrubbed by real scroll ──
  try {
    const compareStage = document.getElementById('compare-stage')
    const from = await drawGradientImage(1200, 700, PALETTES[1])
    const to = await drawGradientImage(1200, 700, PALETTES[2])
    const dissolveHandle = comice(compareStage)
      .use(dissolve({ transition: 'noise', from, to, noise: { scale: 4, softness: 0.1 } }))
      .driver(scroll({ threshold: 0 }))
    log('dissolve: noise transition, scroll-driven — mounted OK', 'ok')
    window.__dissolveHandle = dissolveHandle
  } catch (err) {
    log(`dissolve section threw: ${err.message}`, 'fail')
  }

  // ── particles: scroll-driven cloud, image -> text ──
  try {
    const particlesTarget = document.getElementById('particles-target')
    const portrait = await drawGradientImage(500, 500, PALETTES[3])
    comice(particlesTarget)
      .use(particles({ mode: 'cloud', from: portrait, to: { text: 'MERIDIAN' }, count: 6000, motion: { fluid: true } }))
      .driver(scroll({ threshold: 0 }))
    log('particles: cloud, scroll-driven image->text — mounted OK', 'ok')
  } catch (err) {
    log(`particles section threw: ${err.message}`, 'fail')
  }

  // ── type (melt) + layout (wrap) in the about section ──
  try {
    comice(document.getElementById('type-heading')).use(type({ mode: 'melt' })).driver(click({ toggle: true }))
    log('type: melt mode on the about heading — mounted OK', 'ok')
  } catch (err) {
    log(`type threw: ${err.message}`, 'fail')
  }

  try {
    const portraitImg = document.getElementById('layout-portrait')
    portraitImg.src = (await drawGradientImage(400, 500, PALETTES[4])).src
    comice(portraitImg).use(layout({ mode: 'wrap', shape: 'ellipse', float: 'left' }))
    log('layout: wrap around the about-section portrait — mounted OK', 'ok')
  } catch (err) {
    log(`layout threw: ${err.message}`, 'fail')
  }

  log(`Boot complete. ${document.querySelectorAll('canvas').length} canvas element(s) currently on the page.`, 'ok')
}

// ── persist: real click-driven "SPA route" handoff from a grid card into the detail hero ──
let activePersistHandle = null

function navigateToDetail(index) {
  try {
    const listing = document.getElementById('route-listing')
    const detail = document.getElementById('route-detail')
    const cardImg = document.querySelectorAll('.project-card img')[index]
    const match = cardImg.dataset.match

    activePersistHandle?.destroy()
    activePersistHandle = comice(cardImg).use(persist({ match, transition: 'shared', native: 'auto' }))

    listing.classList.add('hidden')
    detail.classList.add('active')
    document.getElementById('detail-title').textContent = `Project ${String(index + 1).padStart(2, '0')}`

    activePersistHandle.destroy() // simulates the router unmounting the listing route

    const detailHero = document.getElementById('detail-hero')
    detailHero.dataset.match = match
    activePersistHandle = comice(detailHero).use(persist({ match, transition: 'shared', native: 'auto' }))
    log(`persist: handoff for project ${index} — mounted OK`, 'ok')
  } catch (err) {
    log(`persist handoff for project ${index} threw: ${err.message}`, 'fail')
  }
}

document.getElementById('back-to-listing').addEventListener('click', () => {
  activePersistHandle?.destroy()
  document.getElementById('route-detail').classList.remove('active')
  document.getElementById('route-listing').classList.remove('hidden')
})

boot().catch((err) => log(`boot() itself threw: ${err.message}`, 'fail'))
