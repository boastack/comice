# @comice/aura

Media colour escaping its frame.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/aura
```

## Use

Target: an `<img>` or `<video>`.

```js
import { comice } from 'comice'
import { aura } from '@comice/aura'

comice('.hero img').use(aura({ sample: 'palette', colors: 3 }))

// The sampled colours land on the element as CSS variables:
// --aura-color (edges) or --aura-color-0..N (palette)
```

## Options

| Option | Type | |
|---|---|---|
| `sample` | `'edges'` \| `'palette'` | What to read from the media. Default `'edges'`. |
| `colors` | number | Palette size for `'palette'`. Default 5. |
| `contrast` | number \| `false` | Minimum contrast against the page background. Default 4.5. |
| `glow` | boolean | Soft glow behind the media. Default `true`. |
| `cssVariables` | boolean | Write the colours as CSS variables. Default `true`. |
| `onSample` | `(colors) => void` | Called with every new sample. |
| `sampleIntervalMs` | number | How often to sample. Default 200. |

Reads the media without changing how it looks. Does no work while off screen. Without WebGL2 no colours are produced and nothing else changes.

## License

MIT © Olawale Balo
