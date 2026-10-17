// Demo formatting only. Copied snippets have no dependency on this module.
// Plain JavaScript, not JSON: unquoted keys, single quotes, spaced braces.
const quote = text => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`
const literal = value => Array.isArray(value) ? `[${value.map(literal).join(', ')}]`
  : value && typeof value === 'object' ? `{ ${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)}: ${literal(v)}`).join(', ')} }`
  : typeof value === 'string' ? quote(value) : String(value)
export function formatOptions(options) {
  const compact = { ...options }
  if (compact.cursorFollow === true) delete compact.cursorFollow
  if (compact.liquid === .5) delete compact.liquid
  if (compact.liquidSheen === .45) delete compact.liquidSheen
  if (compact.interaction === false) delete compact.interaction
  if (compact.join === false) delete compact.join
  if (compact.join && typeof compact.join === 'object' && Object.keys(compact.join).length === 1 && compact.join.style === 'metaball') compact.join = true
  for (const key of ['outline', 'glass']) {
    if (compact[key] === false) { delete compact[key]; continue }
    if (!compact[key]) continue
    const value = { ...compact[key] }
    const defaults = key === 'glass' ? { width: 24, refraction: 12, fringe: 1.5, sheen: .12 } : { style: 'stroke', color: '#ffffff', width: 1.5, opacity: value.style === 'sheen' ? .45 : 1 }
    // Sheen's default width is proportional to height, not 1.5px.
    if (value.style === 'sheen') delete defaults.width
    for (const [name, fallback] of Object.entries(defaults)) if (value[name] === fallback) delete value[name]
    compact[key] = value
  }
  const keys = ['from', 'to', ...Object.keys(compact).filter(key => key !== 'from' && key !== 'to')]
  return `{
${keys.filter(key => compact[key] !== undefined).map(key => `  ${key}: ${literal(compact[key])},`).join('\n')}
}`
}

// Syntax colours for the code card. Display only: copying uses the text.
const escapeHtml = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const TOKEN = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|([A-Za-z_$][\w$]*)(?=\s*:)|\b(import|from|const|let|return|new|await)\b|\b(true|false|null|undefined)\b|(-?\b\d+(?:\.\d+)?|-?\.\d+)|([A-Za-z_$][\w$]*)(?=\s*\()|([{}()[\],.:;=>])/g
export function highlight(code) {
  let html = '', last = 0
  for (const match of code.matchAll(TOKEN)) {
    html += escapeHtml(code.slice(last, match.index))
    const [text, string, key, keyword, literal, number, call, punctuation] = match
    const kind = string ? 'str' : keyword ? 'kw' : literal ? 'lit' : number ? 'num' : call ? 'fn' : key ? 'key' : punctuation ? 'punc' : ''
    html += `<span class="tk-${kind}">${escapeHtml(text)}</span>`
    last = match.index + text.length
  }
  return html + escapeHtml(code.slice(last))
}
