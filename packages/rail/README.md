# @comice/rail

Media collections you move through, with physics that feel physical.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/rail
```

## Use

Target: a container whose children are the items.

```js
import { comice } from 'comice'
import { rail } from '@comice/rail'

comice('#gallery').use(rail({ mode: 'coverflow' }))

// rail handles its own drag, keyboard and inertia — no driver needed.
```

## Options

| Option | Type | |
|---|---|---|
| `mode` | `'canvas'` `'strip'` `'compare'` `'stack'` `'marquee'` `'arc'` `'coverflow'` | **Required.** |
| `inertia` | number | Momentum decay after release. Default 0.92. |
| `snap` | boolean | Settle on the nearest item. Default `true`. |
| `keyboard` | boolean | Arrow keys, roving focus, live announcements. Default `true`. |
| `onActive` | `(index) => void` | Called when the centred item changes. |
| `items` | string | Selector for the items. Default: direct children. |

With `prefers-reduced-motion`, a release stops where it is instead of coasting.

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
