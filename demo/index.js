import { highlight } from './morph/snippet.js'

const examples = {
  scroll: { call: "scroll({ subject: '#scene', range: 'contain' })", description: 'Tie progress to a section’s position in the viewport. Scrolling back reverses the morph.' },
  hover: { call: 'hover({ duration: 600 })', description: 'Morph on pointer entry and return on exit. Direction changes continue from the current progress.' },
  pointer: { call: 'pointer({ radius: 200 })', description: 'Control the effect with pointer proximity, or map pointer position and velocity to individual parameters.' },
  drag: { call: 'drag({ inertia: 0.94 })', description: 'Scrub progress with a drag, then let inertia carry the motion after release.' },
  click: { call: 'click({ toggle: true, duration: 600 })', description: 'Toggle between states with a click. Each transition starts from the current progress.' },
  time: { call: 'time({ duration: 2000, loop: true })', description: 'Run for a set duration using elapsed milliseconds from the shared frame clock. Enable looping to repeat.' },
  audio: { call: "audio({ source: '#track' })", description: 'Use a playing audio element. Drive progress from its energy, or map frequency bands to separate parameters.' },
}
const tabs = [...document.querySelectorAll('[data-driver]')]
const panel = document.querySelector('#driver-panel')
const code = document.querySelector('#driver-code')
const description = document.querySelector('#driver-description')
const copy = document.querySelector('#copy-code')
const status = document.querySelector('#copy-status')
let resetCopy

function select(driver) {
  if (!Object.hasOwn(examples, driver)) return
  const example = examples[driver]
  for (const tab of tabs) {
    const selected = tab.dataset.driver === driver
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
  panel.setAttribute('aria-labelledby', `tab-${driver}`)
  const imports = driver === 'audio'
    ? "import { comice } from 'comice'\nimport { audio } from 'comice/drivers/audio'"
    : `import { comice, ${driver} } from 'comice'`
  code.innerHTML = highlight(`${imports}\nimport { morph } from '@comice/morph'\n\nconst shape = morph({ to: 'circle(40%)' })\n\nconst handle = comice('#media')\n  .use(shape)\n  .driver(${example.call})\n\n// On component disposal:\n// handle.destroy()`)
  description.textContent = example.description
  clearTimeout(resetCopy)
  copy.innerHTML = 'Copy <span aria-hidden="true">↗</span>'
  status.textContent = ''
}
for (const tab of tabs) {
  tab.addEventListener('click', () => select(tab.dataset.driver))
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab)
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (next === null) return
    event.preventDefault()
    select(tabs[next].dataset.driver)
    tabs[next].focus()
  })
}
copy.addEventListener('click', async () => {
  const value = code.textContent
  try {
    await navigator.clipboard.writeText(value)
    // Do not apply stale feedback if the example changed during the write.
    if (value !== code.textContent) return
    copy.textContent = 'Copied ✓'
    status.textContent = 'Example code copied.'
    clearTimeout(resetCopy)
    resetCopy = setTimeout(() => { copy.innerHTML = 'Copy <span aria-hidden="true">↗</span>' }, 2000)
  } catch {
    status.textContent = 'Copy is unavailable. Select the example text to copy it.'
    copy.textContent = 'Select code to copy'
  }
})

select('scroll')
