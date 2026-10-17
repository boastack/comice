// Shared showcase soundtrack: starts on the first scroll,
// wheel, touch or key press (browsers only allow sound after one of those),
// fades in, and a small EQ-bar button in the bottom corner mutes it.
const audio = new Audio(new URL('../audio/fela.mp3', import.meta.url).href)
const volume = .36
const button = document.createElement('button')
let started = false, starting = null, fade = 0

audio.id = 'soundtrack'
audio.hidden = true
audio.setAttribute('aria-hidden', 'true')
audio.loop = true
audio.preload = 'metadata'
audio.volume = 0

button.className = 'soundtrack-control'
button.type = 'button'
button.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><rect class="sound-bar" x="3" y="6" width="2.5" height="6" rx="1.25"/><rect class="sound-bar" x="7.75" y="3" width="2.5" height="12" rx="1.25"/><rect class="sound-bar" x="12.5" y="5" width="2.5" height="8" rx="1.25"/></svg>'

function state(next) {
  button.dataset.state = next
  const playing = next === 'playing'
  const label = playing ? 'Mute soundtrack' : 'Play soundtrack'
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-pressed', String(playing))
  button.title = label
}
state('ready')

function fadeIn() {
  cancelAnimationFrame(fade)
  const from = audio.volume, start = performance.now()
  const tick = now => {
    const t = Math.max(0, Math.min(1, (now - start) / 1800))
    audio.volume = from + (volume - from) * (1 - (1 - t) ** 3)
    if (t < 1) fade = requestAnimationFrame(tick)
  }
  fade = requestAnimationFrame(tick)
}

function start() {
  if (started && !audio.paused) return Promise.resolve(true)
  starting ??= (async () => {
    try {
      audio.muted = false
      await audio.play()
      started = true
      fadeIn()
      state('playing')
      return true
    } catch {
      state('ready')
      return false
    } finally {
      starting = null
    }
  })()
  return starting
}

const intents = ['wheel', 'touchstart', 'touchmove', 'keydown', 'scroll']
async function onIntent(event) {
  if (event.type === 'keydown' && !['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) return
  if (await start()) stopListening()
}
function stopListening() { intents.forEach(type => removeEventListener(type, onIntent)) }
intents.forEach(type => addEventListener(type, onIntent, { passive: true }))

async function toggle() {
  stopListening()
  if (!started || audio.paused) { await start(); return }
  audio.muted = !audio.muted
  state(audio.muted ? 'muted' : 'playing')
}
button.addEventListener('click', toggle)
document.addEventListener('visibilitychange', () => {
  if (!started) return
  if (document.hidden) audio.pause()
  else if (!audio.muted) audio.play().catch(() => state('ready'))
})
// Hide the control if the optional local track is unavailable.
audio.addEventListener('error', () => { button.hidden = true; stopListening() })

document.body.append(audio, button)

// The audio driver (runtime.js) listens to this element and may need it started.
export const soundtrack = { element: audio, start, toggle }
