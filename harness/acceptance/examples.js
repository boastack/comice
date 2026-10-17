// Every runnable code example in comice.html, as written there.
//
// Each run() starts with a "given:" line supplying whatever the spec's
// snippet assumes already exists (an image, a callback); everything after
// it is the spec's code, unchanged. example.html shows run's own source,
// so what you read is what ran.

import { comice, scroll, hover, pointer } from 'comice'
import { audio } from 'comice/drivers/audio'
import { spotlight } from '@comice/spotlight'
import { morph } from '@comice/morph'
import { reveal } from '@comice/reveal'
import { dissolve } from '@comice/dissolve'
import { rail } from '@comice/rail'
import { distort } from '@comice/distort'
import { aura } from '@comice/aura'
import { type } from '@comice/type'
import { particles } from '@comice/particles'
import { color } from '@comice/color'

/** A decoded <img> of one of the generated assets. */
async function img(name) {
  const image = new Image()
  image.src = `assets/${name}.png`
  await image.decode()
  return image
}

const media = (name, attrs = '') => `<img src="assets/${name}.png" ${attrs} style="width:100%;height:100%;object-fit:cover;display:block">`
const tall = '<div class="spacer" style="height:110vh"></div>'

export const examples = {
  0: {
    title: '§04 Every interactive plugin exposes the same shape',
    html: `<div class="row">${['A', 'B', 'C'].map((n) => `<div class="project tile">${n}</div>`).join('')}</div>`,
    run() {
      // given: three .project tiles
      const card = comice('.project').use(spotlight({ peers: '.project' }))

      card.state              // 'idle' | 'entering' | 'active' | 'leaving'
      card.on('active', () => {})
      card.on('leaving', () => {})
      card.transition('active')   // force a state, same rules apply
    },
  },

  1: {
    title: '§04 Zero dependencies, this is the whole setup',
    html: `<div class="row">${['One', 'Two', 'Three'].map((n) => `<div class="card tile">${n}</div>`).join('')}</div>
      ${tall}<div class="box">${media('photo-a', 'class="hero"')}</div>${tall}`,
    run() {
      // given: .card tiles, and an <img class="hero"> below the fold
      comice('.card').use(spotlight()).driver(hover({ intent: 80 }))
      comice('.hero').use(morph({ to: '/demo/assets/images/fan.svg', join: true })).driver(scroll({ threshold: 0.5 }))
    },
  },

  4: {
    title: '§08 morph — footage collapsing into a logo',
    html: `<div class="box">${media('photo-a', 'id="film"')}</div>${tall}`,
    run() {
      // given: an <img id="film">; the spec's path is cut short ('M12 2L2 7…'), this is its closed first layer
      comice('#film').use(morph({
        to: { type: 'shape', path: 'M12 2L2 7l10 5 10-5-10-5z', viewBox: [0, 0, 24, 24] },
        liquid: 0.7
      })).driver(scroll())
    },
  },

  '5a': {
    title: '§08 reveal — a grid opening in blinds',
    html: `${tall}<div class="grid">${['photo-a', 'photo-b', 'founder', 'photo-b', 'photo-a', 'founder'].map((n) => `<figure>${media(n)}</figure>`).join('')}</div>${tall}`,
    run() {
      // given: a .grid of <figure>s below the fold
      comice('.grid figure').use(reveal({
        effect: 'blinds', stagger: { each: 0.06, grid: 'auto' }
      }))
    },
  },

  '5b': {
    title: '§08 reveal — the cursor as a mask field',
    html: `<div class="box">${media('photo-a', 'class="image"')}</div>`,
    run() {
      // given: an <img class="image">
      comice('.image').use(reveal({
        effect: 'mask',
        mask: { type: 'cursor', radius: 200, softness: 0.4 }
      })).driver(pointer())
    },
  },

  '5c': {
    title: '§08 reveal — another image as the mask',
    html: `<div class="box">${media('photo-b', 'class="image"')}</div>`,
    async run() {
      // given: anotherImage, a logo on transparency
      const anotherImage = await img('logo')
      comice('.image').use(reveal({ effect: 'mask', mask: anotherImage }))
    },
  },

  '6a': {
    title: '§08 dissolve — a scroll-driven gallery',
    html: `<div class="box" id="gallery"></div>${tall}${tall}`,
    async run() {
      // given: images, three decoded <img>s
      const images = await Promise.all(['photo-a', 'photo-b', 'founder'].map(img))
      comice('#gallery').use(dissolve({
        transition: 'displace', to: images, map: '/wave.png'
      })).driver(scroll())
    },
  },

  '6b': {
    title: '§08 dissolve — noise drives the threshold',
    html: `<div class="box hero"></div>`,
    async run() {
      // given: imageA and imageB, decoded <img>s
      const [imageA, imageB] = await Promise.all([img('photo-a'), img('photo-b')])
      comice('.hero').use(dissolve({
        transition: 'noise', from: imageA, to: imageB,
        noise: { scale: 2, intensity: 1, softness: 0.2 }
      }))
    },
  },

  7: {
    title: '§08 rail — a coverflow carousel',
    html: `<div id="rail" class="rail">${['photo-a', 'photo-b', 'founder', 'photo-a', 'photo-b'].map((n) => `<div class="slide">${media(n)}</div>`).join('')}</div><p id="meta">—</p>`,
    run() {
      // given: updateMeta, showing the active slide
      const updateMeta = (i) => (document.getElementById('meta').textContent = `Slide ${i + 1}`)
      comice('#rail').use(rail({
        mode: 'coverflow', inertia: 0.94, snap: true,
        onActive: i => updateMeta(i)
      }))
    },
  },

  8: {
    title: '§08 spotlight — a work grid',
    html: `<div class="row">${['North', 'Basalt', 'Aurora'].map((n, i) => `<div class="project tile">${media(['photo-a', 'photo-b', 'founder'][i])}<div class="meta">${n}</div></div>`).join('')}</div>`,
    run() {
      // given: .project tiles with a .meta caption each
      comice('.project').use(spotlight({
        peers: { selector: '.project', blur: 4, dim: 0.4 },
        reveal: '.meta'
      })).driver(hover())
    },
  },

  9: {
    title: '§08 distort — glass following the pointer',
    html: `<div class="box">${media('photo-b', 'class="image"')}</div>`,
    run() {
      // given: an <img class="image">
      comice('.image').use(distort({ effect: 'glass' })).driver(pointer())
    },
  },

  10: {
    title: '§08 aura — the reel colouring the page',
    html: `<div class="box">${media('photo-a', 'id="reel"')}</div><button class="pill" style="background:var(--aura-color-0, #444)">Watch</button>`,
    run() {
      // given: #reel (an image here; real video comes with the real samples)
      comice('#reel').use(aura({ sample: 'palette', colors: 5, contrast: 4.5 }))
      // (the button reads --aura-color-0, which aura writes on #reel; pass it on)
      setInterval(() => document.querySelector('.pill').style.background = getComputedStyle(document.getElementById('reel')).getPropertyValue('--aura-color-0') || '#444', 300)
    },
  },

  11: {
    title: '§08 type — names melting into each other',
    html: `<h1 class="project-name">Aurora</h1>`,
    run() {
      // given: an <h1 class="project-name">; the runner changes its text
      comice('.project-name').use(type({
        mode: 'melt', melt: { blur: 14, threshold: [0.5, 18], hold: true }
      }))
    },
  },

  '13a': {
    title: '§08 particles — a portrait into the wordmark',
    html: `<div class="box" id="stage"></div>${tall}${tall}`,
    run() {
      // given: #stage; '/founder.jpg' is served by serve.ts
      comice('#stage').use(particles({
        mode: 'cloud', from: { image: '/founder.jpg' }, to: { text: 'COMICE' },
        count: 120000, motion: { noise: 0.3 }
      })).driver(scroll())
    },
  },

  '13b': {
    title: '§08 particles — image to particles and back',
    html: `<div class="box" id="hero"></div>${tall}${tall}`,
    async run() {
      // given: imageA and imageB, decoded <img>s
      const [imageA, imageB] = await Promise.all([img('photo-a'), img('photo-b')])
      comice('#hero').use(particles({
        mode: 'shatter', from: imageA, to: imageB
      })).driver(scroll())
    },
  },

  14: {
    title: '§04 Signals into parameters (one element per effect)',
    html: `<audio id="track" src="assets/track.wav" loop></audio><button id="play" class="pill">Play</button>
      <div class="row">${['a', 'b', 'c'].map((n) => `<div class="tile">${media('photo-b', `class="hero hero-${n}"`)}</div>`).join('')}</div>`,
    run() {
      // given: #track, and three .hero images. The spec stacks distort, aura and color
      // on one element; one GPU effect per element (README) puts each on its own.
      document.getElementById('play').onclick = () => document.getElementById('track').play()
      const distortInstance = distort(), auraInstance = aura(), colorInstance = color()
      comice('.hero-a').use(distortInstance).driver(audio({ source: '#track' }))
        .map('bass').to(distortInstance, 'strength', { output: [0, 0.8] })
      comice('.hero-b').use(auraInstance).driver(audio({ source: '#track' }))
        .map('energy').to(auraInstance, 'intensity')
      comice('.hero-c').use(colorInstance).driver(audio({ source: '#track' }))
        .map('high').to(colorInstance, 'shift')
    },
  },
}

/** Blocks in comice.html this page doesn't run, and why. */
export const notRun = {
  2: 'MaskField and sampleMask() — a type and a GLSL signature, not a runnable example (core implements both).',
  3: '@comice/vision — not built yet.',
  12: '@comice/vision and @comice/spatial — not built yet.',
  15: '@comice/react — not built yet.',
  16: 'Studio export and comice().load() — not built yet.',
  17: 'The repository layout.',
}
