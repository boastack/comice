# @comice/distort

Field distortion that follows an input — bulge, lens, glass, the cursor as a force in a field.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/distort
```

## Use

Target: an `<img>` or `<video>`.

```js
import { comice, pointer } from 'comice'
import { distort } from '@comice/distort'

comice('.hero img')
  .use(distort({ effect: 'bulge', radius: 200, strength: 0.5 }))
  .driver(pointer())
```

## Options

| Option | Type | |
|---|---|---|
| `effect` | `'bulge'` `'lens'` `'ripple'` `'smear'` `'shapedLens'` `'tear'` `'liquid'` `'glass'` | Default `'bulge'`. `ripple`: rings spreading from the pointer. `smear`: pixels drag along the pointer's motion. `shapedLens`: a rounded-square magnifier. `tear`: the image rips along a line through the pointer. `liquid`: the pointer pushes the surface, which keeps moving and settles after it leaves. `glass`: refracts, with chromatic fringing. |
| `radius` | number | Field radius in px. Default 160. |
| `strength` | number | Default 0.5. |
| `refraction` | number | Chromatic split, for `'glass'`. |
| `falloff` | `'linear'` \| `'smooth'` \| `'exp'` | Default `'smooth'`. |
| `anchor` | `[x, y]` | Pins the field at a spot (0 to 1 across and down) and keeps it on, for a driver that isn't the pointer, such as `audio()`. |

Mappable: `strength`, `radius`, `refraction`, e.g. `.map('bass').to(d, 'strength', { output: [0, 0.8] })` from `audio()`.

Does no work while off screen or in a hidden tab, and steps down resolution on devices that can't keep up. Without WebGL2 the original media shows, unchanged. With `prefers-reduced-motion` the field stays off and the media shows undistorted.

## License

MIT © Olawale Balo
