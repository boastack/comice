// The examples import `comice` from here (see example.html's import map).
// Everything is core's own; comice() also records each handle it returns,
// so the runner can drive an example without editing its code.
export * from '../../packages/core/dist/index.js'
import { comice as core } from '../../packages/core/dist/index.js'

window.__handles = []
window.__events = []
export function comice(target) {
  const handle = core(target)
  window.__handles.push(handle)
  // From the start: `ready` can come on the microtask after .use().
  for (const type of ['ready', 'error']) {
    handle.on(type, (_s, event) => window.__events.push({ type, plugin: event.plugin, message: event.error?.message }))
  }
  return handle
}
