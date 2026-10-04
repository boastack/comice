# @comice/type

Media and live text meeting, and text behaving like media.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/type
```

## Use

Target: a text element. The text stays real DOM: selectable, styleable, indexable.

```js
import { comice } from 'comice'
import { type } from '@comice/type'

const name = document.querySelector('.project-name')
comice(name).use(type({
  mode: 'melt',
  melt: { blur: 14, threshold: [0.5, 18], hold: true },
}))

// Change the text and it melts from the old name into the new one,
// e.g. from a rail's onActive.
name.textContent = 'Basalt'
```

## Options

| Option | Type | |
|---|---|---|
| `mode` | `'fill'` `'behind'` `'knockout'` `'melt'` | Media inside, behind or cut out of the text, or text that melts word to word. Default `'fill'`. |
| `media` | string | Selector for the media, for fill / behind / knockout. |
| `melt` | object | Settings for `'melt'`, below. |

### `melt`

| Option | Type | |
|---|---|---|
| `blur` | number | Blur at the middle of the melt, px. Default 14. |
| `threshold` | `[cutoff, sharpness]` | How the blurred words weld into one shape: alpha below `cutoff` falls away, above it goes solid. Default `[0.5, 18]`. |
| `curve` | `'linear'` `'easeIn'` `'easeOut'` `'easeInOut'` or a function | Easing over the melt. Default `'easeInOut'`. |
| `hold` | boolean | Text that doesn't change stays perfectly still instead of melting into itself. Default `true`. |
| `duration` | number | How long a melt takes, ms. Default 600. |

A driver, `.set({ progress })` or `.map()` scrubs the last melt instead: 0 shows the old word, 1 the new.

During a melt, the old and new words are drawn as the element's `::before` and `::after` (hidden from screen readers), so `textContent` is always the real text. Inline markup, such as an `<em>`, shows unstyled for the length of a melt.

With `prefers-reduced-motion`, the new text simply replaces the old.

## License

MIT © Olawale Balo
