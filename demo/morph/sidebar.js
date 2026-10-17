import { currentDemo, configure } from './runtime.js'
const sidebar = document.querySelector('#inspector'), content = sidebar.querySelector('.inspector-content'), toggle = document.querySelector('#settings-toggle')
let entry = currentDemo(), timer, pending, previousFocus
const ranges = {
  liquid: ['Liquid', 0, 1, .01, .5], liquidSheen: ['Join sheen', 0, 1, .01, .45],
  'join.width': ['Width', 0, 200, .5, 6, 'px'], 'join.pinch': ['Pinch', 0, 1, .01, .35], 'join.sag': ['Sag', 0, 80, .5, 0, 'px'], 'join.fillet': ['Fillet', 0, 80, .5, 8, 'px'], 'join.thin': ['Thinning', .01, 2, .01, .4], 'join.dissolve': ['Dissolve', 0, 20, .1, 2.9, 'px'],
  'outline.width': ['Width', 0, 40, .5, 1.5, 'px'], 'outline.opacity': ['Intensity', 0, 1, .01, 1],
  'glass.width': ['Edge width', 0, 100, 1, 24, 'px'], 'glass.refraction': ['Refraction', 0, 100, 1, 12, 'px'], 'glass.fringe': ['Colour fringe', 0, 10, .1, 1.5, 'px'], 'glass.sheen': ['Sheen', 0, 1, .01, .12], 'glass.rim': ['Directional light', 0, 1, .01, 0],
  'interaction.radius': ['Reach', 1, 600, 1, 160, 'px'], 'interaction.softness': ['Softness', 0, 100, 1, 18, 'px'], 'interaction.wake': ['Wake', 0, 20, .1, 3, 'px'], 'interaction.decay': ['Wake retention', 0, .99, .01, .94],
  'cursorFollow.offset': ['Follow distance', 0, .2, .001, .035], 'cursorFollow.zoom': ['Zoom', .8, 1.2, .01, .95],
  'bend.y': ['Arch', 0, .15, .001, .028], 'bend.x': ['Pinch', 0, .15, .001, .014],
  'maskRasterization.fill': ['Shape fill', .05, 1, .01, 1], 'maskRasterization.alphaThreshold': ['Alpha threshold', 0, 255, 1, 96], 'maskRasterization.maxDistance': ['Distance range', 1, 4096, 1, 96, 'px'],
}
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
function options() { return entry?.draft ?? entry?.options ?? {} }
function value(path, fallback) { const [group, key] = path.split('.'); return key ? options()[group]?.[key] ?? fallback : options()[group] ?? fallback }
function number(path) {
  const [label, min, max, step, fallback, unit = ''] = ranges[path]
  const v = value(path, path === 'outline.opacity' && value('outline.style','stroke') === 'sheen' ? .45 : fallback), fill = Math.max(0, Math.min(100, (v - min) / (max - min) * 100))
  return `<div class="parameter"><div class="parameter-label"><label for="range-${path}">${label}</label><div class="value-box"><input data-number="${path}" type="number" min="${min}" max="${max}" step="${step}" value="${v}" aria-label="${label} value">${unit ? `<span>${unit}</span>` : ''}</div></div><input id="range-${path}" class="fine-slider" data-range="${path}" type="range" min="${min}" max="${max}" step="${step}" value="${v}" style="--fill:${fill}%" aria-label="${label}"></div>`
}
function select(path, label, choices, fallback) {
  return `<label class="select-row">${label}<select data-select="${path}" aria-label="${label}">${choices.map(([id, name]) => `<option value="${id}"${value(path, fallback) === id ? ' selected' : ''}>${name}</option>`).join('')}</select></label>`
}
function switchControl(path, label, checked, extra = '') {
  return `<label class="switch-row"><span>${label}</span><input type="checkbox" data-switch="${path}" aria-label="${label}"${checked ? ' checked' : ''} ${extra}><span class="switch-track" aria-hidden="true"></span></label>`
}
// From and To are strings (an SVG, a URL, a clip-path) or, for a text
// target, an object. Shown as text; an object round-trips as JSON.
const shapeText = shape => shape === undefined ? '' : typeof shape === 'string' ? shape : JSON.stringify(shape)
const parseShape = text => { const t = text.trim(); return !t ? undefined : t.startsWith('{') ? JSON.parse(t) : t }
function shapes() {
  const draft = entry.shapeDraft ?? {}
  const field = (key, label, hint) => `<label class="shape-field">${label}<textarea data-shape="${key}" aria-label="${label}" placeholder="SVG markup, a URL or a CSS clip-path${hint}">${esc(draft[key] ?? shapeText(options()[key]))}</textarea></label><div class="upload-row"><span>.svg file</span><label class="upload">Upload SVG<input type="file" data-upload="${key}" accept=".svg,image/svg+xml" aria-label="Upload ${label} SVG"></label></div>`
  return `${field('from', 'From', ' · empty uses the media frame')}${field('to', 'To', ' · empty uses the media frame')}<button class="apply apply-shapes" type="button" data-apply-shapes>Apply shapes</button>`
}
function group(id, title, body, enabled = true) {
  const open = entry?.expanded?.has(id) ?? ['motion', 'join'].includes(id)
  return `<details data-group="${id}"${open ? ' open' : ''}><summary>${title}<span aria-hidden="true">⌄</span></summary>${['motion', 'maskRasterization', 'shapes'].includes(id) ? '' : switchControl(`${id}.enabled`, `Enable ${title.toLowerCase()}`, !!options()[id])}<fieldset${enabled ? '' : ' disabled'}>${body}</fieldset></details>`
}
function render() {
  toggle.setAttribute('aria-expanded', String(!sidebar.hidden))
  const expanded = new Set([...content.querySelectorAll('details[open]')].map(el => el.dataset.group))
  if (entry && content.dataset.entry === entry.id && content.querySelector('details')) entry.expanded = expanded
  content.dataset.entry = entry?.id ?? ''
  sidebar.querySelector('.active-demo').textContent = entry?.label ?? ''
  sidebar.querySelector('[data-reset]').disabled = !entry?.defaults
  if (!entry?.options) { content.innerHTML = '<p class="inspector-note">Scroll into the demo to load its settings.</p>'; return }
  const slab = value('join.style', 'metaball') === 'slab'
  const width = path => `${switchControl(`${path}.auto`, 'Automatic width', value(path, undefined) === undefined)}${value(path,undefined) === undefined ? '' : number(path)}`
  content.innerHTML = group('motion', 'Motion', `<label class="select-row">Input<select data-driver aria-label="Animation input">${[['scroll','Scroll'],['hover','Hover'],['click','Click'],['drag','Drag'],['audio','Audio']].map(([id,label]) => `<option value="${id}"${entry.driver === id ? ' selected' : ''}>${label}</option>`).join('')}</select></label>${select('direction','Direction',[['forward','Forward'],['reverse','Reverse']],'forward')}${number('liquid')}${number('liquidSheen')}`)
    + group('join', 'Joining', `${select('join.style','Join style',[['metaball','Midpoint drops'],['slab','Tapered threads']],'metaball')}${width('join.width')}${slab ? ['join.pinch','join.sag','join.fillet','join.thin','join.dissolve'].map(number).join('') : ''}<label class="text-parameter">Connection points<textarea data-json="join.points" aria-label="Connection points" placeholder="Auto · or [[0.2,0.5],[0.8,0.5]]">${esc(value('join.points',undefined) ? JSON.stringify(value('join.points',undefined)) : '')}</textarea></label>`, !!options().join)
    + group('outline', 'Outline', `${select('outline.style','Edge style',[['stroke','Stroke'],['sheen','Soft sheen']],'stroke')}${width('outline.width')}${number('outline.opacity')}<label class="color-row">Colour<input type="color" data-color="outline.color" value="${esc(value('outline.color','#ffffff'))}" aria-label="Outline colour"><span>${esc(value('outline.color','#ffffff'))}</span></label>`, !!options().outline)
    + group('glass', 'Glass', ['glass.width','glass.refraction','glass.fringe','glass.sheen','glass.rim'].map(number).join(''), !!options().glass)
    + group('interaction', 'Pointer', ['interaction.radius','interaction.softness','interaction.wake','interaction.decay'].map(number).join(''), !!options().interaction)
    + group('cursorFollow', 'Cursor follow', ['cursorFollow.offset','cursorFollow.zoom'].map(number).join(''), !!options().cursorFollow)
    + group('bend', 'Bend', ['bend.y','bend.x'].map(number).join(''), !!options().bend)
    + group('maskRasterization', 'Raster quality', `${select('maskRasterization.precision','Precision',[['half','Half float'],['byte','Byte']],'half')}${switchControl('maskRasterization.bounded','Preserve frame boundary',value('maskRasterization.bounded',true))}${number('maskRasterization.fill')}${number('maskRasterization.alphaThreshold')}${switchControl('maskRasterization.maxDistance.auto','Automatic distance range',value('maskRasterization.maxDistance',undefined) === undefined)}<fieldset${value('maskRasterization.maxDistance',undefined) === undefined ? ' disabled' : ''}>${number('maskRasterization.maxDistance')}</fieldset><label class="text-parameter">Resolution<textarea data-json="maskRasterization.resolution" aria-label="Raster resolution" placeholder="Auto · or [1024,576]">${esc(value('maskRasterization.resolution',undefined) ? JSON.stringify(value('maskRasterization.resolution',undefined)) : '')}</textarea></label>`)
    + group('shapes', 'Shapes', shapes())
}
// A shape that can't be loaded (a bad URL, invalid SVG) fails after
// configure() returns: bring the demo's own error into Settings.
function reportLoad(target) {
  const status = target.panel.querySelector('.status')
  const started = Date.now()
  const poll = setInterval(() => {
    if (status.hasAttribute('data-error')) { sidebar.querySelector('.inspector-error').textContent = status.textContent; clearInterval(poll) }
    else if (status.textContent === 'Live' || Date.now() - started > 5000) clearInterval(poll)
  }, 100)
}
function applyShapes() {
  clearTimeout(timer)
  pending = null
  const next = structuredClone(entry.draft ?? entry.options)
  try {
    const draft = entry.shapeDraft ?? {}
    for (const key of ['from', 'to']) {
      const shape = parseShape(draft[key] ?? shapeText(next[key]))
      if (shape === undefined) delete next[key]; else next[key] = shape
    }
    configure(entry, next, entry.driver)
    delete entry.draft; delete entry.shapeDraft
    sidebar.querySelector('.inspector-error').textContent = ''
    render()
    reportLoad(entry)
  } catch (error) { sidebar.querySelector('.inspector-error').textContent = error.message }
}
function flush() {
  clearTimeout(timer)
  if (!pending) return
  const target = pending; pending = null
  try { configure(target, target.draft ?? target.options, target.driver); delete target.draft; sidebar.querySelector('.inspector-error').textContent = '' }
  catch (error) { sidebar.querySelector('.inspector-error').textContent = error.message }
}
function change(path, next, immediate = false) {
  if (!entry?.options) return
  entry.draft ??= structuredClone(entry.options)
  const [group, key, mode] = path.split('.')
  if (key === 'enabled') {
    entry.savedGroups ??= {}
    if (!next) { entry.savedGroups[group] = entry.draft[group]; entry.draft[group] = false }
    else entry.draft[group] = entry.savedGroups[group] || {}
  } else if (key) {
    if (!entry.draft[group] || entry.draft[group] === true) entry.draft[group] = {}
    if (mode === 'auto') { if (next) delete entry.draft[group][key]; else entry.draft[group][key] = ranges[`${group}.${key}`][4] }
    else if (next === undefined) delete entry.draft[group][key]
    else entry.draft[group][key] = next
  } else entry.draft[group] = next
  pending = entry; clearTimeout(timer)
  if (immediate) flush(); else timer = setTimeout(flush, 160)
}
content.addEventListener('input', event => {
  const el = event.target, path = el.dataset.range ?? el.dataset.number
  if (!path || !el.validity.valid) return
  const v = Number(el.value), [,min,max] = ranges[path]
  for (const input of content.querySelectorAll('[data-range], [data-number]')) if ((input.dataset.range ?? input.dataset.number) === path) {
    if (input !== el) input.value = v
    input.style.setProperty('--fill', `${Math.max(0,Math.min(100,(v-min)/(max-min)*100))}%`)
  }
  change(path,v)
})
content.addEventListener('click', event => { if (event.target.closest('[data-apply-shapes]')) applyShapes() })
content.addEventListener('input', event => {
  const key = event.target.dataset.shape
  if (key) (entry.shapeDraft ??= {})[key] = event.target.value
})
content.addEventListener('change', async event => {
  const el = event.target
  if (el.dataset.upload) {
    const file = el.files[0]
    if (!file) return
    ;(entry.shapeDraft ??= {})[el.dataset.upload] = await file.text()
    applyShapes()
    return
  }
  try {
    if (el.dataset.driver !== undefined) { entry.driver = el.value; pending = entry; flush() }
    else if (el.dataset.switch) change(el.dataset.switch,el.checked,true)
    else if (el.dataset.select) change(el.dataset.select,el.value,true)
    else if (el.dataset.color) change(el.dataset.color,el.value,true)
    else if (el.dataset.json) {
      const v = el.value.trim() ? JSON.parse(el.value) : undefined
      if (el.dataset.json.endsWith('resolution') && v !== undefined && (!Array.isArray(v) || v.length !== 2 || v.some(n => !Number.isInteger(n) || n < 1 || n > 4096))) throw Error('Resolution must be two integers between 1 and 4096.')
      change(el.dataset.json,v,true)
    } else { flush(); return }
    const selector = el.dataset.switch ? `[data-switch="${el.dataset.switch}"]` : el.dataset.select ? `[data-select="${el.dataset.select}"]` : null
    render(); if (selector) content.querySelector(selector)?.focus()
  } catch (error) { sidebar.querySelector('.inspector-error').textContent = error.message }
})
function close() { flush(); sidebar.hidden = true; toggle.setAttribute('aria-expanded','false'); previousFocus?.focus() }
toggle.addEventListener('click', () => {
  if (!sidebar.hidden) { close(); return }
  previousFocus = toggle
  sidebar.hidden = false; render()
  sidebar.querySelector('[data-close]').focus()
})
sidebar.querySelector('[data-close]').addEventListener('click',close)
addEventListener('keydown',event=>{ if(event.key === 'Escape' && !sidebar.hidden) {event.preventDefault();close()} })
sidebar.querySelector('[data-reset]').addEventListener('click',()=>{clearTimeout(timer); pending=null; delete entry.draft; delete entry.shapeDraft; entry.savedGroups={}; entry.driver='scroll'; configure(entry,entry.defaults);render()})
document.addEventListener('comice:demo-active', event => {
  if (entry && entry !== event.detail) { entry.expanded = new Set([...content.querySelectorAll('details[open]')].map(el=>el.dataset.group)); flush() }
  entry = event.detail
  document.querySelector('#jump').value = entry.id
  render()
})
render()
