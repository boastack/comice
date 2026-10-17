import { examples } from './examples.js'
import { registerDemo } from './runtime.js'

const collection = document.querySelector('#collection')
window.__demos = []
const optionsFor = async (demo) => {
  const options = structuredClone(demo.options)
  if (demo.mask) options.to = demo.mask
  return options
}
for (const [index, demo] of examples.entries()) {
  const section = document.createElement('section')
  section.id = demo.id
  section.className = 'scroll-section'
  section.innerHTML = `<div class="sticky"><header class="copy"><span class="number">${String(index + 1).padStart(2, '0')} / ${examples.length}</span><h2>${demo.title}</h2><p class="note">${demo.note}</p></header><div class="frame${demo.square ? ' square' : ''}"></div></div>`
  const frame = section.querySelector('.frame')
  const media = document.createElement(demo.image ? 'img' : 'video')
  media.id = `${demo.id}-media`
  media.className = 'media'
  media.setAttribute('aria-label', demo.title)
  if (demo.image) { media.alt = demo.title; media.loading = 'lazy' }
  else { media.muted = true; media.loop = true; media.playsInline = true; media.preload = 'none' }
  media.src = demo.src
  frame.append(media)
  if (demo.word) {
    // A counter in the middle of the stage that melts into a word; runtime.js drives both.
    const word = document.createElement('div')
    word.className = 'word'
    word.innerHTML = `<span class="word-count">${demo.word.from}</span><span class="word-value">${demo.word.count}</span>`
    frame.append(word)
  }
  collection.append(section)
  const panel = document.createElement('div')
  panel.className = 'code'
  panel.innerHTML = `<pre hidden><code></code></pre><p class="status" role="status">Scroll into view to load.</p>`
  section.querySelector('.sticky').append(panel)
  const entry = registerDemo({ id: demo.id, label: demo.title, demo, section, frame, media, panel, getOptions: () => optionsFor(demo) })
  window.__demos.push(entry)
  const option = document.createElement('option')
  option.value = demo.id; option.textContent = `${String(index + 1).padStart(2, '0')} · ${demo.title}`
  document.querySelector('#jump').append(option)
}
