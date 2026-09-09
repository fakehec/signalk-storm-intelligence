'use strict'

// Best-effort storm-cell detection from an AEMET reflectivity grid.
//
// IMPORTANT — provenance and limits. The AEMET regional product is a *rendered*
// palette image, so these cells are reconstructed from reflectivity that has
// been quantised to the 12..72 dBZ legend steps, not from native gridded data.
// Per radar-provider-specification.md §7 this is a documented, clearly-labelled
// best-effort: it is adequate to flag and track strong convective cells
// (squall-line / thunderstorm awareness), not a precision reflectivity source.
// Every emitted cell carries `properties.reconstructed = true` and the peak dBZ.
//
// Algorithm: threshold the dBZ grid at a convective level, group the retained
// pixels into 8-connected components, drop components below a minimum area, and
// emit each as a GeoJSON polygon (convex hull of the component, in EPSG:4326)
// with a 0..5 severity derived from the component's peak reflectivity. The
// runtime storm engine adds tracking, motion, CPA and warning state across frames.

const { NODATA, pxToLonLat } = require('./aemet-raster')

const DEFAULTS = Object.freeze({ thresholdDbz: 35, minPixels: 4 })

// Peak reflectivity (dBZ, legend steps) -> 0..5 severity. 42 dBZ -> 3 (warn),
// 48 -> 4 (alarm), 54+ -> 5; below 30 dBZ -> 0.
function dbzToSeverity (dbz) {
  const s = Math.round((dbz - 24) / 6)
  return s < 0 ? 0 : s > 5 ? 5 : s
}

// Andrew's monotone-chain convex hull over integer pixel points. Returns the
// hull vertices in order (no repeated closing point); may be < 3 for collinear
// or tiny inputs, in which case the caller falls back to a bounding box.
function convexHull (points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop(); upper.pop()
  return lower.concat(upper)
}

// Build a closed EPSG:4326 polygon ring from pixel-space vertices. Falls back to
// the component's pixel bounding box when the hull is degenerate (< 3 vertices).
function ringFromComponent (hull, bbox) {
  let verts = hull
  if (verts.length < 3) {
    const [minx, miny, maxx, maxy] = bbox
    verts = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy]]
  }
  const ring = verts.map(([x, y]) => {
    const [lon, lat] = pxToLonLat(x, y)
    return [lon, lat]
  })
  ring.push(ring[0]) // close the ring
  return ring
}

// Detect cells in a decoded reflectivity grid { width, height, dbz: Int8Array }.
// Returns an array of GeoJSON Feature (Polygon) objects in EPSG:4326.
function detectCells (raster, opts = {}) {
  const { width, height, dbz } = raster
  const thresholdDbz = Number.isFinite(opts.thresholdDbz) ? opts.thresholdDbz : DEFAULTS.thresholdDbz
  const minPixels = Number.isFinite(opts.minPixels) ? opts.minPixels : DEFAULTS.minPixels
  const time = opts.time || null

  const over = (i) => dbz[i] !== NODATA && dbz[i] >= thresholdDbz
  const seen = new Uint8Array(width * height)
  const features = []
  const stack = []

  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !over(start)) continue
    // Flood-fill this 8-connected component.
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    const pixels = []
    let maxDbz = -Infinity
    let minx = width, miny = height, maxx = -1, maxy = -1
    while (stack.length) {
      const i = stack.pop()
      const x = i % width
      const y = (i - x) / width
      pixels.push([x, y])
      if (dbz[i] > maxDbz) maxDbz = dbz[i]
      if (x < minx) minx = x; if (x > maxx) maxx = x
      if (y < miny) miny = y; if (y > maxy) maxy = y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const ni = ny * width + nx
          if (!seen[ni] && over(ni)) { seen[ni] = 1; stack.push(ni) }
        }
      }
    }
    if (pixels.length < minPixels) continue

    const ring = ringFromComponent(convexHull(pixels), [minx, miny, maxx, maxy])
    const severity = dbzToSeverity(maxDbz)
    const [clon, clat] = pxToLonLat((minx + maxx) / 2, (miny + maxy) / 2)
    features.push({
      type: 'Feature',
      id: `aemet-${Math.round(clon * 1000)}_${Math.round(clat * 1000)}_${maxDbz}`,
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        severity,
        maxDbz,
        areaKm2: pixels.length, // ~1 km/px, so pixel count ~ km^2
        thresholdDbz,
        reconstructed: true, // rendered-product provenance (spec §7)
        source: 'aemet',
        time
      }
    })
  }
  return features
}

module.exports = { detectCells, dbzToSeverity, convexHull, DEFAULTS }
