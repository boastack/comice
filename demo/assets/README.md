# Shared showcase assets

Both `/demo/` and `/demo/morph/` use this directory.

- `video/bg.mp4` and `video/canvas.mp4`: shared demo footage.
- `audio/fela.mp3`: optional soundtrack.
- `images/`: original SVG image assets, also used by browser regression checks.
- `libs/`: preserved original asset helpers; the current morph showcase uses its
  own runtime and soundtrack module under `demo/morph/`.

Video and audio files stay ignored by Git and are excluded from the published
packages. Supply them at these paths when setting up another checkout or hosting
the showcases. The morph-specific silhouettes, fonts and icon remain in
`demo/morph/assets/`.

The retired prototype pages are no longer needed. Regression math is captured in
`harness/morph/fixtures/prototype-reference.json`, separate from the live demos.
