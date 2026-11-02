// tools/build-buildings.mjs — writes js/building-geodata.js and js/building-geodata.bin.gz (the NYB1 format js/
// building-geodata.js decodes) from Google Open Buildings v3 footprints, in the frame of tools/geo-base.mjs.
//
// usage: node --max-old-space-size=8192 tools/build-buildings.mjs [footprints.csv]
//
// Footprints: Google Open Buildings v3 (CC BY-4.0 / ODbL), S2 tile 95b filtered to the Santa Fe bbox; the snapshot
// stays outside the repository (tools/data/cache/, gitignored):
//   curl -sL https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_4_gzip/95b_buildings.csv.gz \
//     | zcat | awk -F, 'NR==1 || ($1>-31.70 && $1<-31.58 && $2>-60.76 && $2<-60.66)' > tools/data/cache/gob_santafe.csv
//
// Heights: measured where tools/sample-heights.py has sampled Google Open Buildings 2.5D Temporal (2023, ~4 m
// effective resolution; the 80th percentile of the height pixels inside each footprint). Otherwise an OpenStreetMap
// `height` / `building:levels` covering the footprint's centre, and failing both an ESTIMATED height (a
// deterministic draw by district and footprint size).
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { geo, toWorld, rdpRing, ringArea, log } from './geo-base.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = process.argv[2] || `${ROOT}tools/data/cache/gob_santafe.csv`;
const MIN_CONFIDENCE = 0.7; // below this Open Buildings is mostly sheds, cars and roof clutter
const FLOOR = 3.0;

// --- The detailed city (point in polygon, with a 32 m cell index) --------------------------------------------------
function pointInRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xa, za] = ring[i], [xb, zb] = ring[j];
    if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
  }
  return inside;
}
const city = geo.manhattan;

// --- OSM heights: buildings with height / building:levels --------------------------------------------------------
const osmHeights = [];
for (const e of geo.osm.elements) {
  const t = e.tags || {};
  if (!t.building || e.type !== 'way' || !e.geometry) continue;
  const levels = parseFloat(t['building:levels']);
  const h = parseFloat(t.height) > 0 ? parseFloat(t.height) : levels > 0 ? levels * FLOOR + 1 : 0;
  if (!h) continue;
  const ring = e.geometry.map((g) => toWorld(g.lon, g.lat));
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  osmHeights.push({ ring, h, x0, x1, z0, z1 });
}
const OSM_CELL = 64;
const osmIndex = new Map();
for (const b of osmHeights) {
  for (let i = Math.floor(b.x0 / OSM_CELL); i <= Math.floor(b.x1 / OSM_CELL); i++) {
    for (let j = Math.floor(b.z0 / OSM_CELL); j <= Math.floor(b.z1 / OSM_CELL); j++) {
      const k = i * 100000 + j;
      if (!osmIndex.has(k)) osmIndex.set(k, []);
      osmIndex.get(k).push(b);
    }
  }
}
const osmHeightAt = (x, z) => {
  for (const b of osmIndex.get(Math.floor(x / OSM_CELL) * 100000 + Math.floor(z / OSM_CELL)) || []) {
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && pointInRing(b.ring, x, z)) return b.h;
  }
  return 0;
};
log(`${osmHeights.length} OSM buildings with a height or level count`);

// --- Estimated heights ------------------------------------------------------------------------------------------
// Deterministic [0, 1) draws from the footprint's position
function rand(x, z, salt) {
  const h = crypto.createHash('md5').update(`${Math.round(x * 2)},${Math.round(z * 2)},${salt}`).digest();
  return h.readUInt32LE(0) / 2 ** 32;
}
// Districts (world frame): the microcentro around the peatonal and the plaza, the boulevards (Pellegrini / Gálvez),
// the Costanera & Candioti towers by the Setúbal, and the low-rise rest
function district(x, z) {
  if (x > -500 && x < 400 && z > -1100 && z < 450) return 'centro';
  if (Math.abs(z + 2450) < 130 && x > -1300 && x < 2100) return 'boulevard';
  if (x > 1000 && z < -1500) return 'costanera';
  return 'barrio';
}
function estimateFloors(x, z, area) {
  const d = district(x, z);
  const r = rand(x, z, 'floors');
  const tall = rand(x, z, 'tower');
  if (area < 45) return 1;
  if (d === 'centro') {
    if (area > 220 && tall < 0.22) return 8 + Math.floor(rand(x, z, 't') * 9); // 8-16
    return r < 0.25 ? 2 : r < 0.55 ? 3 : r < 0.8 ? 4 : r < 0.93 ? 6 : 7;
  }
  if (d === 'boulevard' || d === 'costanera') {
    if (area > 200 && tall < 0.22) return 9 + Math.floor(rand(x, z, 't') * 13); // 9-21
    return r < 0.35 ? 1 : r < 0.65 ? 2 : r < 0.85 ? 3 : 5;
  }
  if (area > 350 && tall < 0.03) return 6 + Math.floor(rand(x, z, 't') * 7); // the odd mid-rise
  return area < 90 ? 1 : r < 0.6 ? 1 : r < 0.9 ? 2 : 3;
}

// --- Footprints -------------------------------------------------------------------------------------------------
function parseWktPolygon(wkt) {
  const m = /^POLYGON\s*\(\((.*)\)\)$/.exec(wkt.trim());
  if (!m) return null; // multipolygons & holes are rare in Open Buildings: skipped
  if (m[1].includes('),(') || m[1].includes('), (')) return null;
  return m[1].split(',').map((p) => p.trim().split(/\s+/).map(Number));
}
function quantize(ring) {
  // 0.5 m grid, no repeats, no closing point, outer ring with positive shoelace area in (x, z)
  const pts = [];
  for (const [x, z] of ring) {
    const p = [Math.round(x * 2), Math.round(z * 2)];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3 || Math.abs(ringArea(pts)) < 4) return null; // under 1 m² on the half-metre grid
  if (ringArea(pts) < 0) pts.reverse();
  return pts;
}

const lines = fs.readFileSync(SOURCE, 'utf8').split('\n');
// Measured heights (tools/sample-heights.py): one `height,pixels` line per footprint row, if it has been run
const HEIGHTS = `${ROOT}tools/data/cache/gob_heights.csv`;
const measured = fs.existsSync(HEIGHTS) ? fs.readFileSync(HEIGHTS, 'utf8').split('\n') : null;
if (measured && measured.length !== lines.length) throw new Error(`${HEIGHTS} does not match ${SOURCE}; rerun tools/sample-heights.py`);
const MIN_PIXELS = 6; // footprints under ~6 m² of 1 m pixels: too small to trust the ~4 m model
const compare = [];
const head = lines[0].split(',');
const col = (n) => head.indexOf(n);
const [cLat, cLon, cArea, cConf] = [col('latitude'), col('longitude'), col('area_in_meters'), col('confidence')];
const buildings = [];
let lowConfidence = 0, outside = 0, bad = 0, fromOsm = 0, fromMeasured = 0;
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  const q = line.indexOf('"');
  const fields = line.slice(0, q).split(',');
  const wkt = line.slice(q + 1, line.indexOf('"', q + 1));
  if (parseFloat(fields[cConf]) < MIN_CONFIDENCE) { lowConfidence++; continue; }
  const [cx, cz] = toWorld(parseFloat(fields[cLon]), parseFloat(fields[cLat]));
  if (cx < geo.DETAIL.x0 || cx > geo.DETAIL.x1 || cz < geo.DETAIL.z0 || cz > geo.DETAIL.z1 || !pointInRing(city, cx, cz)) { outside++; continue; }
  const ll = parseWktPolygon(wkt);
  if (!ll) { bad++; continue; }
  let ring = ll.map(([lon, lat]) => toWorld(lon, lat));
  ring.pop(); // WKT repeats the first point
  if (ring.length > 4) ring = rdpRing(ring, 0.4);
  const pts = quantize(ring);
  if (!pts) { bad++; continue; }
  const area = parseFloat(fields[cArea]);
  const osmH = osmHeightAt(cx, cz);
  const [mh, mpx, m95] = measured ? measured[i].split(',').map(Number) : [0, 0, 0];
  const measuredH = mpx >= MIN_PIXELS && mh > 0 ? Math.max(2.8, mh) : 0;
  if (measuredH) fromMeasured++;
  else if (osmH) fromOsm++;
  if (osmH && measuredH) compare.push([osmH, measuredH, m95]);
  // The measured height is sampled on this exact footprint, so it wins; OSM tags are matched by centre point only
  // (a low annex can pick up its tower's tag) and fill in where the model saw nothing
  const height = measuredH || osmH || estimateFloors(cx, cz, area) * FLOOR + 1;
  // Morton order puts nearby buildings together for better delta compression
  const mx = Math.max(0, Math.round(cx) + 4096), mz = Math.max(0, Math.round(cz) + 16384);
  let order = 0;
  for (let b = 0; b < 16; b++) order += (((mx >> b) & 1) * 2 ** (2 * b)) + (((mz >> b) & 1) * 2 ** (2 * b + 1));
  buildings.push({ order, height: Math.max(1, Math.round(height)), polygons: [[pts]] });
}
buildings.sort((a, b) => a.order - b.order);
if (compare.length) {
  const err = compare.map(([o, m]) => Math.abs(o - m)).sort((a, b) => a - b);
  log(`measured vs OSM heights (${compare.length} buildings): median |error| ${err[err.length >> 1].toFixed(1)} m, p90 ${err[Math.floor(err.length * 0.9)].toFixed(1)} m`);
}
log(`${buildings.length} buildings (${fromMeasured} measured by Open Buildings 2.5D, ${fromOsm} more from OSM tags, the rest estimated); skipped ${lowConfidence} low-confidence, ${outside} outside the detailed city, ${bad} degenerate`);
const hs = buildings.map((b) => b.height).sort((a, b) => a - b);
log(`heights: median ${hs[hs.length >> 1]} m, p90 ${hs[Math.floor(hs.length * 0.9)]} m, max ${hs[hs.length - 1]} m, ${hs.filter((h) => h >= 25).length} at 25 m or more`);

// --- NYB1 packing (same layout as the decoder in js/building-geodata.js) -----------------------------------------
function packNYB1(list) {
  const meta = [], xs = [], zs = [];
  const uint = (arr, v) => { while (v > 127) { arr.push((v & 127) | 128); v = Math.floor(v / 128); } arr.push(v); };
  const sint = (arr, v) => uint(arr, v >= 0 ? v * 2 : -v * 2 - 1);
  uint(meta, list.length);
  let x = 0, z = 0;
  for (const b of list) {
    uint(meta, b.height);
    uint(meta, 0); // construction decade: unknown
    uint(meta, b.polygons.length);
    for (const poly of b.polygons) {
      uint(meta, poly.length);
      for (const ring of poly) {
        uint(meta, ring.length);
        for (const [px, pz] of ring) { sint(xs, px - x); sint(zs, pz - z); x = px; z = pz; }
      }
    }
  }
  const header = Buffer.alloc(12);
  header.write('NYB1', 0, 'ascii');
  header.writeUInt32LE(meta.length, 4);
  header.writeUInt32LE(xs.length, 8);
  return Buffer.concat([header, Buffer.from(meta), Buffer.from(xs), Buffer.from(zs)]);
}
const packed = packNYB1(buildings);
const asset = 'building-geodata.bin.gz';
fs.writeFileSync(`${ROOT}js/${asset}`, zlib.gzipSync(packed, { level: 9, mtime: 0 }));
const digest = crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex');

// The decoder module: the NYC one with a new header
const moduleFile = `${ROOT}js/building-geodata.js`;
const decoder = fs.readFileSync(moduleFile, 'utf8').replace(/^(\/\/.*\n)+/, '');
fs.writeFileSync(moduleFile, `// Generated by tools/build-buildings.mjs; do not edit.
// Google Open Buildings v3 footprints (CC BY-4.0 / ODbL), S2 tile 95b, confidence >= ${MIN_CONFIDENCE}
// Snapshot SHA-256: ${digest}
// ${buildings.length.toLocaleString('en-US')} buildings. Coordinates: 0.5 m; roof heights: 1 m (${fromMeasured.toLocaleString('en-US')} measured by Open Buildings
// 2.5D Temporal 2023, CC BY-4.0 / ODbL; ${fromOsm} from OSM tags; the rest estimated); construction years: unknown (0).
${decoder}`);
log(`wrote js/${asset} (${(fs.statSync(`${ROOT}js/${asset}`).size / 1024).toFixed(0)} KB) and js/building-geodata.js`);
