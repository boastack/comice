# Shared showcase assets

Both `/demo/` and `/demo/morph/` use this directory.

- `images/`: shared SVG silhouettes, favicon, and the supplied `a.jpg` / `b.jpg` photographs.
- `fonts/`: local Geist and Geist Mono files, their shared `fonts.css`, and Open Font License.
- `video/a.mp4` and `video/b.mp4`: shared demo footage.
- `audio/fela.mp3`: optional soundtrack.
- `libs/soundtrack.js` and `libs/soundtrack.css`: one shared soundtrack implementation and control style. The module exports the audio element, `start()`, and `toggle()` for playback controls and audio drivers.

The Morph folder contains only its HTML, CSS, JavaScript, and usage guide.
All fonts, SVGs, images, media, and reusable soundtrack code live here.

Video and audio files are committed with the showcase and included in the static
demo deployment. They are excluded from the published npm packages.

The retired prototype pages are no longer needed. Regression math is captured in
`harness/morph/fixtures/prototype-reference.json`, separate from the live demos.
