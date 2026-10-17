/** Connected opaque islands, in top-left normalized coordinates.
 * Optional mask metadata for consumers that join arbitrary SVG components. */
export function maskComponents(image: ImageData, threshold = 96): Array<[number, number]> {
  const { width, height, data } = image
  const visited = new Uint8Array(width * height), queue = new Int32Array(width * height)
  const islands: Array<{ area: number; x: number; y: number }> = []
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || data[start * 4 + 3]! <= threshold) continue
    let head = 0, tail = 1, sumX = 0, sumY = 0
    queue[0] = start; visited[start] = 1
    while (head < tail) {
      const index = queue[head++]!, x = index % width, y = Math.floor(index / width)
      sumX += x + .5; sumY += y + .5
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const next = ny * width + nx
        if (!visited[next] && data[next * 4 + 3]! > threshold) { visited[next] = 1; queue[tail++] = next }
      }
    }
    if (tail >= Math.max(2, width * height * .0001)) islands.push({ area: tail, x: sumX / tail / width, y: sumY / tail / height })
  }
  // Bound metadata/shader cost for a noisy silhouette. The silhouette itself
  // still contains every island; this only limits automatic connections.
  const points = islands.sort((a, b) => b.area - a.area).slice(0, 32).map((v): [number, number] => [v.x, v.y])
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (points.length < 3) return points
  const route = [points.shift()!]
  while (points.length) {
    const last = route[route.length - 1]!
    let nearest = 0, distance = Infinity
    points.forEach((p, i) => { const d = (p[0] - last[0]) ** 2 + (p[1] - last[1]) ** 2; if (d < distance) { nearest = i; distance = d } })
    route.push(points.splice(nearest, 1)[0]!)
  }
  return route
}
