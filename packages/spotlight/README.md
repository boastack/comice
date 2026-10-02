# @comice/spotlight

One item emphasised, its peers receding.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/spotlight
```

## Use

Target: one item in a group.

```js
import { comice, hover } from 'comice'
import { spotlight } from '@comice/spotlight'

comice('.project')
  .use(spotlight({ peers: { selector: '.project' } }))
  .driver(hover())
```

## Options

| Option | Type | |
|---|---|---|
| `peers` | `{ selector, blur, dim }` \| `false` | The other items, and how far they recede. |
| `lift` | number | How far the focused item rises. |
| `reveal` | string | Selector for extra content shown on focus. |

With `prefers-reduced-motion` the emphasis changes without animating.

## License

MIT © Olawale Balo
