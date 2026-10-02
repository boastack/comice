# @comice/type

Media and live text meeting, and text behaving like media.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/type
```

## Use

Target: a text element.

```js
import { comice, click } from 'comice'
import { type } from '@comice/type'

comice('h1')
  .use(type({ mode: 'melt' }))
  .driver(click({ toggle: true }))
```

## Options

| Option | Type | |
|---|---|---|
| `mode` | `'fill'` `'behind'` `'knockout'` `'melt'` | Media inside, behind or cut out of the text, or text that melts. |
| `media` | string | Selector for the media, for fill / behind / knockout. |
| `melt` | object | Blur and contrast settings for `'melt'`. |

With `prefers-reduced-motion`, melt jumps to its end state instead of blurring through.

## License

MIT © Olawale Balo
