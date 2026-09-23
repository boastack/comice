/**
 * harness/media.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates real, decoded <img>/<video> elements entirely in-browser via
 * canvas drawing — no external image files to download or commit, matching
 * the project's own "zero dependencies" ethos. Every plugin in the harness
 * gets real, varied pixel content (not a flat color) so shader bugs that
 * only show up against actual gradients/edges/faces-ish content are
 * visible, not hidden behind a uniform fill.
 */

/** A warm portrait-ish gradient with a soft "subject" blob roughly centered
 *  — varied enough for luminance-driven effects (ascii, mosaic, dither) to
 *  show real structure instead of one flat value. */
function drawPortraitLike(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, '#2b1a3a')
  grad.addColorStop(0.5, '#6a3fae')
  grad.addColorStop(1, '#e8a33d')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  // A soft radial "subject" — bright center, falling off toward the edges.
  const radial = ctx.createRadialGradient(w * 0.5, h * 0.45, 10, w * 0.5, h * 0.45, w * 0.4)
  radial.addColorStop(0, 'rgba(255,240,220,0.9)')
  radial.addColorStop(1, 'rgba(255,240,220,0)')
  ctx.fillStyle = radial
  ctx.fillRect(0, 0, w, h)

  // A few hard-edged shapes so edge-detection/aberration effects have
  // real contrast to bite into.
  ctx.fillStyle = 'rgba(20,20,30,0.6)'
  ctx.beginPath()
  ctx.arc(w * 0.25, h * 0.7, w * 0.08, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(w * 0.65, h * 0.15, w * 0.15, h * 0.15)
}

/** A distinct second image (cooler palette, different composition) for
 *  A->B plugins (dissolve, particles) so the transition is visibly a real
 *  transition, not two near-identical frames. */
function drawSkylineLike(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#0a1a2f')
  grad.addColorStop(1, '#1f6f8b')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  ctx.fillStyle = 'rgba(255,220,150,0.9)'
  const sunY = h * 0.55
  ctx.beginPath()
  ctx.arc(w * 0.7, sunY, w * 0.12, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(5,10,20,0.85)'
  let x = 0
  let i = 0
  while (x < w) {
    const bw = 20 + ((i * 37) % 40)
    const bh = h * (0.25 + ((i * 53) % 40) / 100)
    ctx.fillRect(x, h - bh, bw, bh)
    x += bw + 4
    i++
  }
}

function canvasToImage(draw, w = 512, h = 512) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  draw(ctx, w, h)
  const img = new Image()
  img.src = canvas.toDataURL('image/png')
  img.width = w
  img.height = h
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img)
    img.onerror = reject
  })
}

/** Draws a slowly animated gradient onto a canvas, captured as a
 *  MediaStream and piped into a <video> element via captureStream() — a
 *  real, always-decoding <video> with no external file dependency, for
 *  plugins whose card explicitly supports video sources. */
function makeSyntheticVideo(w = 512, h = 512) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  let t = 0

  function draw() {
    t += 0.01
    const hue = (t * 40) % 360
    ctx.fillStyle = `hsl(${hue}, 60%, 35%)`
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = `hsl(${(hue + 120) % 360}, 70%, 55%)`
    ctx.beginPath()
    ctx.arc(w * (0.5 + 0.3 * Math.sin(t)), h * (0.5 + 0.3 * Math.cos(t * 1.3)), w * 0.15, 0, Math.PI * 2)
    ctx.fill()
    requestAnimationFrame(draw)
  }
  draw()

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.loop = true
  const stream = canvas.captureStream(30)
  video.srcObject = stream
  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      video.play().then(() => resolve(video)).catch(() => resolve(video))
    }
  })
}

export async function loadHarnessMedia() {
  const [portrait, skyline, video] = await Promise.all([
    canvasToImage(drawPortraitLike),
    canvasToImage(drawSkylineLike),
    makeSyntheticVideo(),
  ])
  return { portrait, skyline, video }
}
