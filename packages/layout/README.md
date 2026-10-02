# @comice/layout

The page reacting to the media, rather than the media sitting inside the page.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/layout
```

## Use

Target: an `<img>` or `<video>` inside flowing text.

```js
import { comice } from 'comice'
import { layout } from '@comice/layout'

comice('.article img').use(layout({ mode: 'wrap', shape: 'ellipse' }))
```

## Options

| Option | Type | |
|---|---|---|
| `mode` | `'wrap'` \| `'avoid'` \| `'anchor'` | **Required.** |
| `shape` | `'rect'` \| `'ellipse'` | Shape text wraps around. Default `'ellipse'`. |
| `float` | `'left'` \| `'right'` | Default `'left'`. |
| `margin` | number | Gap in px. Default 16. |
| `target`, `edge`, `offset` |  | For `'anchor'`: the element to pin, which edge, and the gap. |

Uses CSS `shape-outside`, so the text stays real, selectable text.

## License

MIT © Olawale Balo
