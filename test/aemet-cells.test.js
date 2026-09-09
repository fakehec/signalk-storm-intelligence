'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { GEOREF, NODATA } = require('../lib/aemet-raster')
const { detectCells, dbzToSeverity, convexHull } = require('../lib/aemet-cells')

function emptyGrid () {
  return { width: GEOREF.width, height: GEOREF.height, dbz: new Int8Array(GEOREF.width * GEOREF.height).fill(NODATA) }
}
// Fill an axis-aligned block [x0,x0+w) x [y0,y0+h) with a dBZ value.
function fillBlock (g, x0, y0, w, h, dbz) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g.dbz[y * g.width + x] = dbz
  return g
}
function inBalearics (lon, lat) { return lon > -1 && lon < 6 && lat > 36 && lat < 42 }

test('dbzToSeverity maps legend steps onto the 0..5 warn/alarm scale', () => {
  assert.equal(dbzToSeverity(24), 0)
  assert.equal(dbzToSeverity(30), 1)
  assert.equal(dbzToSeverity(42), 3) // warn
  assert.equal(dbzToSeverity(48), 4) // alarm
  assert.equal(dbzToSeverity(54), 5)
  assert.equal(dbzToSeverity(72), 5) // clamped
})

test('convexHull returns the 4 corners of a filled square', () => {
  const pts = []
  for (let x = 0; x <= 3; x++) for (let y = 0; y <= 3; y++) pts.push([x, y])
  const hull = convexHull(pts)
  assert.equal(hull.length, 4)
  for (const corner of [[0, 0], [3, 0], [3, 3], [0, 3]]) {
    assert.ok(hull.some(([x, y]) => x === corner[0] && y === corner[1]), `has corner ${corner}`)
  }
})

test('detectCells: empty grid yields no cells', () => {
  assert.deepEqual(detectCells(emptyGrid()), [])
})

test('detectCells: one convective blob -> one cell with correct severity and geometry', () => {
  const g = fillBlock(emptyGrid(), 200, 100, 3, 3, 48) // 9 px of 48 dBZ
  const cells = detectCells(g, { thresholdDbz: 35, minPixels: 4 })
  assert.equal(cells.length, 1)
  const c = cells[0]
  assert.equal(c.type, 'Feature')
  assert.equal(c.geometry.type, 'Polygon')
  assert.equal(c.properties.severity, 4)
  assert.equal(c.properties.maxDbz, 48)
  assert.equal(c.properties.areaKm2, 9)
  assert.equal(c.properties.reconstructed, true)
  const ring = c.geometry.coordinates[0]
  assert.ok(ring.length >= 4 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1], 'closed ring')
  for (const [lon, lat] of ring) assert.ok(inBalearics(lon, lat), `vertex in area: ${lon},${lat}`)
})

test('detectCells: below-threshold reflectivity produces nothing', () => {
  const g = fillBlock(emptyGrid(), 200, 100, 5, 5, 30) // 30 dBZ < 35
  assert.deepEqual(detectCells(g, { thresholdDbz: 35, minPixels: 4 }), [])
})

test('detectCells: blobs smaller than minPixels are dropped', () => {
  const g = fillBlock(emptyGrid(), 200, 100, 1, 2, 54) // 2 px
  assert.deepEqual(detectCells(g, { thresholdDbz: 35, minPixels: 4 }), [])
})

test('detectCells: separated blobs become separate cells; severity from peak dBZ', () => {
  const g = emptyGrid()
  fillBlock(g, 150, 150, 3, 3, 42) // cell A, peak 42 -> sev 3
  fillBlock(g, 300, 300, 3, 3, 36) // cell B
  g.dbz[301 * g.width + 301] = 54 // inject a 54 dBZ core into cell B
  const cells = detectCells(g, { thresholdDbz: 35, minPixels: 4 })
  assert.equal(cells.length, 2)
  const sevs = cells.map(c => c.properties.severity).sort()
  assert.deepEqual(sevs, [3, 5]) // A=3, B peaks at 54 -> 5
})

test('detectCells: threshold is inclusive and honoured', () => {
  const g = fillBlock(emptyGrid(), 200, 100, 3, 3, 36)
  assert.equal(detectCells(g, { thresholdDbz: 36, minPixels: 4 }).length, 1)
  assert.equal(detectCells(g, { thresholdDbz: 42, minPixels: 4 }).length, 0)
})
