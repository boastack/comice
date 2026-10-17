import { comice, scroll, hover, click, drag, prefersReducedMotion } from 'comice'
import { morph } from '@comice/morph'
import { getSharedScheduler } from 'comice/scheduler'
import { type } from '@comice/type'
import { audio } from 'comice/drivers/audio'
import { soundtrack } from '../assets/libs/soundtrack.js'
import { formatOptions, highlight } from './snippet.js'

// Each demo's panel keeps its generated code (hidden) and its status line,
// which shows only on an error. The code itself opens from one toolbar
// button beside Settings and always shows the demo on screen.
function mountCodeCard(entry) {
  const header = entry.section.querySelector('.copy')
  ;(header ?? entry.media.closest('.frame').parentElement).append(entry.panel)
}
const codeToggle = document.querySelector('#code-toggle')
const codeCard = document.querySelector('#code-card')
const codeOpen = () => !codeCard.hidden
function showCode() {
  if (!active) return
  codeCard.querySelector('.code-title').textContent = active.label
  codeCard.querySelector('code').innerHTML = highlight(active.panel.querySelector('code').textContent)
}
function setCode(open) {
  codeCard.hidden = !open
  codeToggle.setAttribute('aria-expanded', String(open))
  codeToggle.setAttribute('aria-label', open ? 'Hide code' : 'Show code')
  if (!open) return
  showCode()
  // One floating panel at a time: the inspector closes for the code.
  const inspector = document.querySelector('#inspector')
  if (!inspector.hidden) inspector.querySelector('[data-close]').click()
}
codeToggle.addEventListener('click', () => setCode(!codeOpen()))
document.querySelector('#settings-toggle').addEventListener('click', () => setCode(false))
document.addEventListener('pointerdown', event => { if (codeOpen() && !codeCard.contains(event.target) && !codeToggle.contains(event.target)) setCode(false) })
document.addEventListener('keydown', event => { if (event.key === 'Escape' && codeOpen()) { setCode(false); codeToggle.focus() } })
document.addEventListener('comice:demo-active', () => { if (codeOpen()) showCode() })
{
  const copy = codeCard.querySelector('.copy-button')
  const feedback = copy.querySelector('.copy-feedback')
  let timer
  copy.addEventListener('click', async () => {
    clearTimeout(timer)
    try { await navigator.clipboard.writeText(codeCard.querySelector('code').textContent); feedback.textContent = 'Copied' }
    catch { feedback.textContent = 'Select code to copy' }
    timer = setTimeout(() => (feedback.textContent = ''), 2000)
  })
}
// The code button sits just left of Settings, whose width depends on its label.
const settingsWidth = () => document.documentElement.style.setProperty('--settings-w', `${document.querySelector('#settings-toggle').offsetWidth}px`)
settingsWidth()
addEventListener('resize', settingsWidth)
document.fonts?.ready.then(settingsWidth)

export const entries = []
let active, paused = false, tracking = false
const drivers = {
  scroll: entry => scroll({ subject: entry.section, range: 'contain', smooth: .3 }),
  hover: () => hover({ duration: 600 }),
  click: () => click({ toggle: true, duration: 600 }),
  drag: () => drag({ inertia: .94 }),
}
// The audio input. `normalize` levels each signal against the track's own quietest
// and loudest moments, so nothing here is tuned to one song, and a short attack with
// a longer release keeps a hit punchy and the fall fluid. The bass drives progress,
// the treble flexes the bend.
const AUDIO_OPTIONS = { normalize: true, attack: 40, release: 320 }
const AUDIO_MAPS = [
  ['bass', 'progress'],
  ['high', 'velocity', { output: [0, .9] }],
]
const driverCode = entry => entry.driver === 'scroll' ? `scroll({ subject: '#${entry.section.id}', range: 'contain', smooth: .3 })` : entry.driver === 'hover' ? 'hover({ duration: 600 })' : entry.driver === 'click' ? 'click({ toggle: true, duration: 600 })' : entry.driver === 'audio' ? `audio({ source: '#soundtrack', ${formatOptions(AUDIO_OPTIONS).replace(/^\{\s*|\s*\}$/g, '').replace(/\s*\n\s*/g, ' ')} })` : 'drag({ inertia: .94 })'
function writeCode(entry) {
  if (!entry.options) return
  entry.panel.querySelector('code').textContent = `${entry.driver === 'audio' ? `import { comice } from 'comice'\nimport { audio } from 'comice/drivers/audio'` : `import { comice, ${entry.driver} } from 'comice'`}\nimport { morph } from '@comice/morph'\n\n${entry.driver === 'drag' ? `document.querySelector('#${entry.media.id}').parentElement.style.touchAction = 'pan-y'\n\n` : ''}const effect = morph(${formatOptions(entry.options)})\nconst handle = comice('#${entry.media.id}').use(effect)\n  .driver(${driverCode(entry)})${entry.driver === 'audio' ? AUDIO_MAPS.map(([signal, param, map]) => `\n  .map('${signal}').to(effect, '${param}'${map ? `, ${formatOptions(map)}` : ''})`).join('') : ''}`
  if (entry === active && codeOpen()) showCode()
}
function status(entry, text, error = false) {
  const el = entry.panel.querySelector('.status')
  el.textContent = text; el.toggleAttribute('data-error', error)
}
function release(entry) {
  ++entry.generation
  entry.abort?.abort(); entry.abort = null
  entry.media.pause?.()
  unmountWord(entry)
  entry.handle?.destroy(); entry.handle = null; entry.effect = null
  entry.live = false; entry.mounting = false
}
async function mount(entry) {
  release(entry)
  entry.live = false; entry.failed = false; entry.mounting = true
  const generation = entry.generation
  const abort = new AbortController(); entry.abort = abort
  try {
    if (!entry.options) {
      const options = await entry.getOptions()
      if (generation !== entry.generation) return
      entry.options = options; entry.defaults = structuredClone(options)
      writeCode(entry)
      if (active === entry) document.dispatchEvent(new CustomEvent('comice:demo-active', { detail: entry }))
    }
    if (!entry.visible || generation !== entry.generation) return
    status(entry, 'Loading…')
    if (entry.media instanceof HTMLImageElement) await entry.media.decode()
    else if (entry.media.readyState < 2) {
      entry.media.preload = 'auto'
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { clean(); reject(Error('Video loading timed out. Check the media URL and reload.')) }, 15000)
        const clean = () => { clearTimeout(timer); entry.media.removeEventListener('loadeddata', ready); entry.media.removeEventListener('error', fail); abort.signal.removeEventListener('abort', cancel) }
        const ready = () => { clean(); resolve() }
        const fail = () => { clean(); reject(Error('This video could not be loaded.')) }
        const cancel = () => { clean(); reject(new DOMException('Mount cancelled.', 'AbortError')) }
        entry.media.addEventListener('loadeddata', ready, { once: true }); entry.media.addEventListener('error', fail, { once: true }); abort.signal.addEventListener('abort', cancel, { once: true })
        if (entry.media.error) fail()
        else if (abort.signal.aborted) cancel()
        else entry.media.load()
      })
    }
    if (!entry.visible || generation !== entry.generation) return
    const effect = morph(entry.options), handle = comice(entry.media).use(effect)
    entry.effect = effect; entry.handle = handle
    handle.on('ready', () => { if (generation === entry.generation) { entry.live = true; status(entry, 'Live') } })
    handle.on('error', (_, event) => { if (generation === entry.generation) { entry.failed = true; status(entry, event.error.message, true) } })
    entry.media.parentElement.style.touchAction = entry.driver === 'drag' ? 'pan-y' : ''
    if (entry.driver === 'audio') {
      // The music has to be playing for anything to move; choosing this input is the gesture that lets it start.
      if (!(await soundtrack.start()) && generation === entry.generation) status(entry, 'Press the sound button to start the music.')
      if (generation !== entry.generation) return
      handle.driver(audio({ source: soundtrack.element, ...AUDIO_OPTIONS }))
      for (const [signal, param, map] of AUDIO_MAPS) handle.map(signal).to(effect, param, map)
    } else handle.driver(drivers[entry.driver](entry))
    mountWord(entry)
    writeCode(entry)
    if (entry.media instanceof HTMLVideoElement && !paused && !prefersReducedMotion()) await entry.media.play().catch(() => {})
  } catch (error) { if (generation === entry.generation && error.name !== 'AbortError') { entry.failed = true; status(entry, error.message, true) } }
  finally { if (generation === entry.generation) entry.mounting = false }
}
// What is on screen mounts at once. What is merely near it (within the observer's margin) is
// warmed one demo at a time, nearest first, and only once everything already mounting has
// painted, so a demo ahead of the viewport never makes the one in it wait for its shader and
// its shape. Mounted demos then stay a couple of seconds after leaving, so a hard scroll back
// and forth does not tear them down and rebuild them under the user's eyes.
const KEEP_MS = 2500
const onScreen = entry => { const rect = entry.section.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight }
const ahead = new Set()
let warming = 0
function warm() {
  warming = 0
  for (const entry of [...ahead]) if (!entry.visible || entry.handle || entry.mounting || entry.failed) ahead.delete(entry)
  if (!ahead.size) return
  // Still loading something (a demo is mounted but has not painted): wait.
  if (entries.some(entry => entry.mounting || (entry.handle && !entry.live && !entry.failed))) { warming = setTimeout(warm, 150); return }
  const middle = innerHeight / 2
  const distance = entry => { const rect = entry.section.getBoundingClientRect(); return Math.abs((rect.top + rect.bottom) / 2 - middle) }
  const next = [...ahead].sort((a, b) => distance(a) - distance(b))[0]
  ahead.delete(next)
  mount(next)
  warming = setTimeout(warm, 150)
}
function promote() {
  for (const entry of ahead) if (onScreen(entry)) { ahead.delete(entry); if (entry.visible && !entry.handle && !entry.mounting && !entry.failed) mount(entry) }
}
const observer = new IntersectionObserver(observations => {
  for (const observation of observations) {
    const entry = entries.find(item => item.section === observation.target)
    entry.visible = observation.isIntersecting
    clearTimeout(entry.releaseTimer)
    if (entry.visible) {
      if (entry.handle || entry.mounting || entry.failed) continue
      if (onScreen(entry)) mount(entry)
      else { ahead.add(entry); if (!warming) warm() }
    } else {
      ahead.delete(entry)
      entry.releaseTimer = setTimeout(() => {
        if (entry.visible) return
        release(entry); status(entry, 'Scroll into view to load.')
      }, KEEP_MS)
    }
  }
  trackActive()
}, { rootMargin: '80% 0px' })
export function activate(entry) {
  if (!entry || entry === active) return
  active = entry
  document.dispatchEvent(new CustomEvent('comice:demo-active', { detail: entry }))
}
function trackActive() {
  promote()
  const middle = innerHeight * .5
  const closest = entries.reduce((result, entry) => {
    const rect = entry.section.getBoundingClientRect()
    const distance = rect.top > middle ? rect.top - middle : rect.bottom < middle ? middle - rect.bottom : 0
    return !result || distance < result.distance ? { entry, distance } : result
  }, null)
  activate(closest?.entry)
}
export function registerDemo(config) {
  const entry = { ...config, handle: null, effect: null, options: config.options ? structuredClone(config.options) : null, defaults: config.options ? structuredClone(config.options) : null, driver: 'scroll', visible: false, generation: 0, abort: null }
  entries.push(entry)
  mountCodeCard(entry)
  writeCode(entry)
  observer.observe(entry.section)
  if (!active) activate(entry)
  return entry
}
export function configure(entry, options, driver = entry.driver) {
  // Validate before replacing a working configuration. Async SVG failures retain media.
  morph(options)
  entry.options = structuredClone(options); entry.driver = driver
  writeCode(entry)
  if (entry.visible) mount(entry)
}
export function currentDemo() { return active }

// The cursor and the scroll speed need no wiring here: each morph follows the page's pointer
// (cursorFollow) and scroll speed (bend) by itself, eased as the legacy pages did.
// A demo with `word: { from, count, to }` carries live text in its stage. It
// counts from `from` up to `count` with the scroll, like a loader, then melts
// into `to` (a blank, so it melts away) over the last stretch, using @comice/type's own melt scrubbed by the
// same progress that drives the shape. Two stacked elements keep the plugin's
// melt (which reacts to any text change) away from the counting.
const COUNT_END = .6
const MELT = [.6, .98]
// The look of the melt, after Viscose's: a near-binary threshold (gain 400) with a
// third of a pixel of blur after it, so the ink edge is crisp but never stepped, on
// a blur wide enough to fuse the digits, pushed around by liquid turbulence (`wobble`) so they pool into one wavy
// blob that shrinks away, like ink in water. Linear, so the fusing and the draining
// each get their share of the scroll.
const MELT_LOOK = { blur: 17, threshold: [.33, 400], soften: .35, wobble: 36, curve: 'linear' }
// Touch screens get a light tick for every ten percent, and a firmer one at 100%
// (where the browser supports it; phones only, never with reduced motion).
const haptics = typeof navigator.vibrate === 'function' && matchMedia('(pointer: coarse)').matches
function mountWord(entry) {
  entry.lastWordProgress = undefined
  entry.wordStart = performance.now()
  const element = entry.frame.querySelector('.word-value')
  if (!element || !entry.demo.word) return
  element.textContent = entry.demo.word.count
  entry.word = type({ mode: 'melt', melt: MELT_LOOK })
  entry.wordHandle = comice(element).use(entry.word)
  // The change starts a timed melt; the next microtask hands it to the scroll.
  element.textContent = entry.demo.word.to
  queueMicrotask(() => { if (entry.word) updateWord(entry) })
}
// How far the counter has got. It follows the input's progress, except for audio,
// which drives the shape from the music and has no single progress to follow: there
// the counter runs by itself, once, from the moment the input starts.
const AUTO_MS = 3000
const wordProgress = entry => entry.driver === 'audio'
  ? Math.min(1, (performance.now() - (entry.wordStart ?? 0)) / AUTO_MS)
  : entry.handle?.progress ?? 0
const meltAt = entry => Math.max(0, Math.min(1, (wordProgress(entry) - MELT[0]) / (MELT[1] - MELT[0])))
function updateWord(entry) {
  const word = entry.frame.querySelector('.word')
  const progress = wordProgress(entry)
  if (progress === entry.lastWordProgress) return
  entry.lastWordProgress = progress
  const melting = progress >= COUNT_END
  word.dataset.phase = melting ? 'melt' : 'count'
  if (!melting) {
    const { from, count } = entry.demo.word
    const text = `${Math.round(Math.max(0, Math.min(1, progress / COUNT_END)) * (parseFloat(count) - parseFloat(from)) + parseFloat(from))}%`
    const counter = word.querySelector('.word-count')
    if (counter.textContent !== text) {
      counter.textContent = text
      if (haptics && !prefersReducedMotion() && parseInt(text) % 10 === 0) navigator.vibrate(parseInt(text) === 100 ? 18 : 6)
    }
  }
  entry.word?.params.setParam('progress', meltAt(entry))
  word.style.setProperty('--melt', meltAt(entry).toFixed(3))
}
function unmountWord(entry) {
  entry.wordHandle?.destroy(); entry.wordHandle = null; entry.word = null
  const word = entry.frame.querySelector('.word')
  if (word && entry.demo.word) {
    word.dataset.phase = 'count'
    word.querySelector('.word-count').textContent = entry.demo.word.from
    word.querySelector('.word-value').textContent = entry.demo.word.count
  }
}
// The dial shares the engine's clock, and unchanged progress does no DOM or melt work.
getSharedScheduler().add(() => {
  for (const entry of entries) if (entry.word && entry.effect && entry.visible) updateWord(entry)
}, () => !document.hidden && entries.some(entry => entry.word && entry.effect && entry.visible))
addEventListener('scroll', () => {
  if (tracking) return
  tracking = true
  requestAnimationFrame(() => { tracking = false; trackActive() })
}, { passive: true })
addEventListener('resize', trackActive)
document.querySelector('#jump').addEventListener('change', event => {
  const entry = entries.find(item => item.id === event.target.value)
  if (entry) { activate(entry); entry.section.scrollIntoView() }
})
document.querySelector('#pause').addEventListener('click', event => {
  paused = !paused; event.target.textContent = paused ? 'Play videos' : 'Pause videos'
  for (const entry of entries) if (entry.media instanceof HTMLVideoElement) {
    if (paused) entry.media.pause()
    else if (entry.visible && !prefersReducedMotion()) entry.media.play().catch(() => {})
  }
})
document.addEventListener('visibilitychange', () => {
  for (const entry of entries) if (entry.media instanceof HTMLVideoElement) {
    if (document.hidden) entry.media.pause()
    else if (entry.visible && !paused && !prefersReducedMotion()) entry.media.play().catch(() => {})
  }
})
addEventListener('pagehide', () => {
  observer.disconnect(); clearTimeout(warming); warming = 0; ahead.clear()
  for (const entry of entries) { clearTimeout(entry.releaseTimer); release(entry) }
})
// Back/forward cache restores this document without running its modules again.
addEventListener('pageshow', event => {
  if (!event.persisted) return
  for (const entry of entries) { entry.visible = false; entry.failed = false; observer.observe(entry.section) }
  trackActive()
})
