const video = '/demo/assets/video/bg.mp4'
const film = '/demo/assets/video/canvas.mp4'
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const shape = name => `./assets/${name}.svg`

// The finish every demo shares: a clean, watery edge with a hairline of light,
// a little refraction with no colour fringe, and a gentle wake behind the
// cursor. A demo overrides only what it needs.
const finish = {
  liquid: .85,
  cursorFollow: true,
  // Bends with scroll speed, at legacy's amounts; the page feeds `velocity`.
  bend: { y: .04, x: .02 },
  // A clean edge: a hairline of light and a few pixels of glass. A wide rim
  // read as a film laid over the footage rather than its own edge.
  outline: { style: 'sheen', width: 3, opacity: .1 },
  liquidSheen: .05,
  glass: { width: 10, refraction: 2, fringe: 0, sheen: .02 },
  interaction: { radius: 180, softness: 24, wake: 3, decay: .94 },
}
// A finer finish for thin or intricate shapes, where the wide rim and strong
// refraction would smear the footage.
const fine = {
  ...finish,
  liquid: .7,
  outline: { style: 'sheen', width: 2, opacity: .1 },
  liquidSheen: .03,
  glass: { width: 6, refraction: 1.5, fringe: 0, sheen: .02 },
}
const classic = { ...finish, join: true }
const list = [
  { id: 'progress-dial', title: 'Progress Dial', note: 'A dial of tick marks fills into one smooth shape as the count completes', src: film, square: true, word: { from: '0%', count: '100%', to: '\u00a0' }, options: { ...fine, from: shape('reel'), to: shape('ellipse') } },
  { id: 'sunflower', title: 'Sunflower', note: 'Footage opens into the striped petals and sun of a sunflower', src: film, square: true, mask: './assets/masks/sunflower.svg', options: { ...fine, maskRasterization: { fill: .9 } } },
  { id: 'hero-merge', title: 'Hero Merge', note: 'Three panels flow together into one seamless frame', src: film, options: { ...classic, from: shape('shelf') } },
  ...[
    ['circles', 'Circle Breakout', 'circles', 'The frame breaks apart into a row of floating circles'],
    ['symbols', 'Game Symbols', 'symbols', 'Controller symbols peel away from one smooth frame'],
    ['arches', 'Arches', 'arches', 'The frame opens into a colonnade of elegant arches'],
    ['fan', 'Radial Fan', 'fan', 'Panels sweep outward in a radial fan'],
    ['deck', 'Card Deck', 'deck', 'A deck of cards fans out from the frame'],
    ['petals', 'Petals', 'petals', 'The frame blooms into a ring of soft petals'],
  ].map(([id, title, layout, note]) => ({ id, title, note, src: video, options: { ...classic, from: shape(layout), direction: 'reverse' } })),
  { id: 'medallion', title: 'Medallion', note: 'Footage settles into a ringed medallion of petals and calligraphy', src: video, square: true, mask: './assets/masks/medallion.svg', options: { ...fine, maskRasterization: { fill: .9 } } },
  { id: 'lotus', title: 'Lotus', note: 'The ellipse folds open into a geometric lotus', src: video, square: true, mask: './assets/masks/lotus.svg', options: { ...fine, from: shape('ellipse'), maskRasterization: { fill: .9 } } },
  { id: 'apple', title: 'Apple Contour', note: 'Footage settles inside the silhouette of a logo', src: video, mask: './assets/masks/apple.svg', options: { ...finish, maskRasterization: { fill: .78 } } },
  ...[
    ['Africa', 'The continent drawn in flowing footage'],
    ['Warrior', 'A warrior silhouette carved from live footage'],
    ['Zebra', 'A zebra in profile, painted with motion'],
    ['Vessel', 'A clay vessel shaped from liquid footage'],
    ['Giraffe', 'A giraffe stretches tall inside the frame'],
    ['Spear Dance', 'A ritual dancer caught mid movement'],
    ['Ancestral Mask', 'An ancestral mask worn by living footage'],
    ['Djembe', 'A djembe drum that carries the rhythm of the film'],
    ['Crowned Profile', 'A crowned profile lit by moving footage'],
    ['Sun Mask', 'A sun mask glowing with live footage'],
    ['Water Bearer', 'A water bearer poured from liquid footage'],
    ['African Symbols', 'Nine symbols of the continent, each carved from live footage'],
  ].map(([title, note]) => ({
    id: slug(title), title, note, src: film, square: true,
    mask: `./assets/masks/${slug(title)}.svg`,
    options: { ...finish, maskRasterization: { fill: .82 } },
  })),
]

// The order of the twelve normal demos: the two hooks first (the dial, then the
// lotus that opens out of its ellipse), then the simple idea of panels merging, then the
// layouts from plainest to most intricate, then the logo, then the two flowers. The African
// shapes follow, in their own order.
const order = ['progress-dial', 'lotus', 'hero-merge', 'circles', 'arches', 'symbols', 'fan', 'deck', 'petals', 'apple', 'sunflower', 'medallion']
const ranked = [...list].sort((a, b) => {
  const rank = id => { const at = order.indexOf(id); return at < 0 ? order.length : at }
  return rank(a.id) - rank(b.id)
})

// The footage splits the page in half: the hand for the twelve general demos,
// the tailor for the twelve African shapes.
export const examples = ranked.map((demo, index) => ({ ...demo, src: index < order.length ? video : film }))
