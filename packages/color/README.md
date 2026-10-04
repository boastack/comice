# @comice/color

Grading, stylisation and physical post-processing for media.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/color
```

## Use

Target: an `<img>` or `<video>`.

```js
import { comice } from 'comice'
import { color } from '@comice/color'

comice('.hero img').use(color({ effects: ['duotone', 'grain'] }))
```

## Options

| Option | Type | |
|---|---|---|
| `effects` | `'duotone'` `'lut'` `'grain'` `'bloom'` `'aberration'` | Any combination, applied in a fixed film-like order. |
| `lut` | string | URL of a `.cube` file, for `'lut'`. |
| `interpolate` | `'oklch'` \| `'rgb'` | Colour space for blends. Default `'oklch'`. |
| `duotone`, `grain`, `bloom`, `aberration` | object | Per-effect settings. |
| `shift` | number | Hue rotation in turns (0.5 turns every hue to its opposite), keeping lightness. Default 0. |

Mappable: `shift`, `grainAmount`, `grainSeed`, `bloomIntensity`, `bloomThreshold`, `aberrationAmount`, e.g. `.map('high').to(c, 'shift')` from `audio()`.

Does no work while off screen or in a hidden tab, and steps down resolution on devices that can't keep up. Without WebGL2 the original media shows, unchanged.

## License

MIT © Olawale Balo
