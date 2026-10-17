# @comice/spotlight

One item emphasised, its peers receding.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/spotlight
```

## Use

Target: one item in a group. Every matched item gets its own spotlight, and the rest of the group recedes around whichever one is active.

```js
import { comice, hover } from 'comice'
import { spotlight } from '@comice/spotlight'

comice('.project')
  .use(spotlight({
    peers: { selector: '.project', blur: 4, dim: 0.4 },
    reveal: '.meta',
  }))
  .driver(hover())
```

## Options

| Option | Type | |
|---|---|---|
| `peers` | `{ selector, blur, dim }` \| string \| `false` | The other items, and how far they recede (blur in px, default 4; opacity, default 0.4). A string is shorthand for `{ selector }`. |
| `lift` | number | How far the focused item rises. Default 0.04 (a 4% scale). |
| `reveal` | string | Selector for captions inside the item, shown on focus. They stay real DOM, so they're selectable and reachable by keyboard and touch. |
| `expand` | number | For items in a flex row: the flex-grow the active item reaches, so it widens and its neighbours make room. `expand: 2.5` on items with `flex: 1`. Off by default. |

With `prefers-reduced-motion` the emphasis changes without animating.

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
