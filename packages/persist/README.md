# @comice/persist

Media surviving navigation. Playback continues, the transition belongs to the page rather than the browser reloading it.

```js
import { comice } from 'comice'
import { persist } from '@comice/persist'

// On the listing page:
comice('#thumbnail').use(persist({ match: 'project-hero', transition: 'shared' }))

// On the detail page, after navigation:
comice('#detail-video').use(persist({ match: 'project-hero', transition: 'shared' }))
```

The same `match` key on both pages is what pairs the two elements. When the second page's `persist()` call runs, it finds the first page's real, live element still in memory and moves it into the second page's position — the exact DOM node, not a clone, so a playing `<video>`'s `currentTime` and any WebGL context another plugin attached to it both survive intact.

## Scope: SPA navigation, not a real page reload

This only works across a **client-side route change** (React Router, Next.js client navigation, Vue Router, etc.) — a router that patches the DOM in place rather than reloading the page. A genuine cross-document navigation (a real HTTP request) destroys the JS heap in every browser, no exceptions; nothing can keep a `<video>` playing or a WebGL context alive across that. If `native` support exists and `transition: 'shared'` is used, the [View Transitions API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API) can still provide a smooth *visual* morph across a real page load — but that's a snapshot crossfade, not literal continuous playback. See `src/index.ts`'s own header comment for the full reasoning.

## Options

| Option | Type | Default | |
|---|---|---|---|
| `match` | `string` | required | Pairs elements across routes. |
| `transition` | `'shared' \| 'blend' \| 'curtain' \| 'iris'` | `'shared'` | All four are the same handoff mechanism with a different visual treatment. |
| `native` | `'auto' \| boolean` | `'auto'` | Use the View Transitions API where it suffices. `'auto'` uses it only for `'shared'` (native's own plain cross-fade); `blend`/`curtain`/`iris` are bespoke clip-path work this plugin computes itself. |
| `duration` | `number` | `400` | Manual (non-native) handoff animation length, ms. |

## `releasePersist(match)`

If a route change happens and you know the next page will **not** have a matching `persist()` call (the user navigated somewhere unrelated), call `releasePersist('project-hero')` to free the held reference immediately rather than leaving it until the next `persist({ match: 'project-hero' })` call anywhere supersedes it. Optional — a stale entry is harmless, just held in memory slightly longer.

## Try it

`packages/persist/demo/index.html` is a real, two-"route" (same-document) demo — open it after `pnpm build` and click a thumbnail to watch the actual DOM node grow into the detail hero. Serve the repo root with any static server (`python3 -m http.server`, `pnpm harness` from the root once the `tools/browser-glsl-harness` branch lands) and open `packages/persist/demo/index.html`.

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
