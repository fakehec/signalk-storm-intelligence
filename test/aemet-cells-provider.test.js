'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { GifReader } = require('omggif')
const { AemetRadarProvider } = require('../lib/aemet-provider')
const { makeSyntheticGifWithCell } = require('./helpers/synthetic-radar')

function decodeRGBA (buffer) {
  const r = new GifReader(buffer)
  const rgba = new Uint8Array(r.width * r.height * 4)
  r.decodeAndBlitFrameRGBA(0, rgba)
  return { width: r.width, height: r.height, rgba }
}

const CELL_GIF = makeSyntheticGifWithCell(220, 240, 4, 8) // 4x4 block of 54 dBZ

function newProvider () {
  return new AemetRadarProvider({ apiKey: 'k', requestTimeoutMs: 5000, decodeRGBA, staticMasks: {} })
}

test('cellsFromRaw reconstructs a convective cell from the rendered frame', async () => {
  const cells = await newProvider().cellsFromRaw('PM', CELL_GIF)
  assert.equal(cells.length, 1)
  const c = cells[0]
  assert.equal(c.type, 'Feature')
  assert.equal(c.geometry.type, 'Polygon')
  assert.equal(c.properties.maxDbz, 54)
  assert.equal(c.properties.severity, 5)
  assert.equal(c.properties.reconstructed, true, 'labelled as reconstructed (spec §7)')
  assert.equal(c.properties.source, 'aemet')
  // Cell sits in the Balearic disk.
  const [lon, lat] = c.geometry.coordinates[0][0]
  assert.ok(lon > 1 && lon < 4 && lat > 38 && lat < 41, `near Balearics: ${lon},${lat}`)
})

test('cellsFromRaw honours the configured threshold', async () => {
  const p = new AemetRadarProvider({ apiKey: 'k', decodeRGBA, staticMasks: {}, cellThresholdDbz: 60 })
  // 54 dBZ block is below a 60 dBZ threshold -> no cells.
  assert.deepEqual(await p.cellsFromRaw('PM', CELL_GIF), [])
})

test('cellsFromRaw rejects an unknown product', async () => {
  await assert.rejects(() => newProvider().cellsFromRaw('zz', CELL_GIF), /unknown product/)
})

test('downloadRaw fetches the GIF and reports gif provenance', async () => {
  const p = newProvider()
  global.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/red/radar/regional/')) {
      return { ok: true, status: 200, async json () { return { estado: 200, datos: 'https://opendata.aemet.es/opendata/sh/x' } } }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/gif' },
      async arrayBuffer () { return CELL_GIF.buffer.slice(CELL_GIF.byteOffset, CELL_GIF.byteOffset + CELL_GIF.byteLength) }
    }
  }
  const raw = await p.downloadRaw('PM', 1788948000000)
  assert.ok(Buffer.isBuffer(raw.buffer))
  assert.equal(raw.contentType, 'image/gif')
  assert.match(raw.key, /^aemet-pm-1788948000000\.gif$/)
  assert.equal(p.rawExtension(), '.gif')
  // Round-trip: the downloaded bytes yield the same cell.
  const cells = await p.cellsFromRaw('PM', raw.buffer)
  assert.equal(cells.length, 1)
  delete global.fetch
})
