// Shared data loading, coordinate transforms and geometry helpers for the geodata generator.
// Sources: OpenStreetMap (streets, water, parks, landmarks). Frame: 1 unit = 1 m, x = grid east, z = grid south
// (north = -z), origin at the centreline intersection of San Martín & Av. General López (the north-east corner of
// Plaza 25 de Mayo), axes turned to the street grid's measured bearing (≈14° from true north).
//
// Inputs (tools/data/):
//   osm_santafe.json   OpenStreetMap via Overpass (q_santafe.overpassql): highways, water, parks, landmarks
//
// Run tools/build-geodata.mjs to generate js/nyc-geodata.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/', import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const log = (...a) => console.log('[geodata]', ...a);

// =====================================================================================================================
// 1. FRAME
// =====================================================================================================================
const LAT0 = -31.6573;
const LON0 = -60.7082;
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;
let THETA = (14 * Math.PI) / 180; // refined below from the north-south calles
let ORIGIN = [0, 0]; // grid (u, v) of San Martín & Av. General López, refined below

// Local tangent plane (east, north) metres
const enu = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
// Grid frame: u = grid east, v = grid south
function gridUV(lon, lat) {
  const [e, n] = enu(lon, lat);
  const c = Math.cos(THETA);
  const s = Math.sin(THETA);
  return [e * c - n * s, -(e * s + n * c)];
}
const toWorld = (lon, lat) => {
  const [u, v] = gridUV(lon, lat);
  return [u - ORIGIN[0], v - ORIGIN[1]];
};

// The detailed city (grid frame, metres from the origin): blocks, streets & buildings inside, low-detail land beyond.
// North to Bv. Pellegrini / Bv. Gálvez's far side, south to the port & Riacho Santa Fe, west past Av. Freyre, east
// to the Setúbal lagoon (the water clips it).
const DETAIL = { x0: -2400, x1: 2600, z0: -3000, z1: 2300 };

// =====================================================================================================================
// 2. GEOMETRY HELPERS
// =====================================================================================================================
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
// Ramer-Douglas-Peucker on an open polyline
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
// RDP on a closed ring (split at the two farthest-apart vertices)
function rdpRing(ring, eps) {
  let i0 = 0;
  let far = 0, i1 = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[i0][0], ring[i][1] - ring[i0][1]);
    if (d > far) { far = d; i1 = i; }
  }
  const a = rdp(ring.slice(i0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[i0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

// ---------------------------------------------------------------------------------------------------------------------
// Raster tools (for cutting piers off the shoreline and merging polygons)
// ---------------------------------------------------------------------------------------------------------------------
class Raster {
  constructor(x0, z0, x1, z1, res) {
    this.res = res;
    this.x0 = Math.floor(x0 / res) * res;
    this.z0 = Math.floor(z0 / res) * res;
    this.w = Math.ceil((x1 - this.x0) / res) + 1;
    this.h = Math.ceil((z1 - this.z0) / res) + 1;
    this.d = new Uint8Array(this.w * this.h);
  }
  // Scanline fill of a ring (even-odd) with `val`
  fillRing(ring, val = 1) {
    const { res, x0, z0, w, h, d } = this;
    const bb = bbox(ring);
    const jy0 = Math.max(0, Math.floor((bb.z0 - z0) / res));
    const jy1 = Math.min(h - 1, Math.ceil((bb.z1 - z0) / res));
    const xs = [];
    for (let j = jy0; j <= jy1; j++) {
      const z = z0 + (j + 0.5) * res;
      xs.length = 0;
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xa, za] = ring[k];
        const [xb, zb] = ring[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) d[j * w + i] = val;
      }
    }
  }
  // Squared Euclidean distance (in cells) from every cell to the nearest cell where mask(v) is true (Felzenszwalb)
  edt(isSource) {
    const { w, h, d } = this;
    const INF = 1e20;
    const f = new Float64Array(Math.max(w, h));
    const out = new Float32Array(w * h);
    const v = new Int32Array(Math.max(w, h));
    const zz = new Float64Array(Math.max(w, h) + 1);
    const dt1 = (n, get, set) => {
      for (let q = 0; q < n; q++) f[q] = get(q);
      let k = 0;
      v[0] = 0;
      zz[0] = -INF;
      zz[1] = INF;
      for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= zz[k]) {
          k--;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        zz[k] = s;
        zz[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (zz[k + 1] < q) k++;
        set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
      }
    };
    for (let i = 0; i < w * h; i++) out[i] = isSource(d[i]) ? 0 : INF;
    for (let i = 0; i < w; i++) dt1(h, (q) => out[q * w + i], (q, val) => (out[q * w + i] = val));
    for (let j = 0; j < h; j++) dt1(w, (q) => out[j * w + q], (q, val) => (out[j * w + q] = val));
    return out;
  }
  // Morphological opening of the 1-cells with a disc of radius r metres
  open(r) {
    const rc = (r / this.res) ** 2;
    const toWater = this.edt((x) => x === 0);
    const eroded = new Uint8Array(this.d.length);
    for (let i = 0; i < eroded.length; i++) eroded[i] = toWater[i] > rc ? 1 : 0;
    const save = this.d;
    this.d = eroded;
    const toEroded = this.edt((x) => x === 1);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = this.d[i] && toEroded[i] <= rc + 1e-6 ? 1 : 0;
  }
  // Morphological closing (fills inlets / gaps narrower than 2r)
  close(r) {
    const rc = (r / this.res) ** 2;
    const toLand = this.edt((x) => x === 1);
    const dil = new Uint8Array(this.d.length);
    for (let i = 0; i < dil.length; i++) dil[i] = toLand[i] <= rc ? 1 : 0;
    const save = this.d;
    this.d = dil;
    const toGap = this.edt((x) => x === 0);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = dil[i] && toGap[i] > rc ? 1 : 0;
  }
  // Keep only the 4-connected component containing the most cells
  keepLargest() {
    const { w, h, d } = this;
    const lab = new Int32Array(w * h);
    let best = 0, bestN = 0, cur = 0;
    const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (!d[s] || lab[s]) continue;
      cur++;
      let n = 0;
      stack.push(s);
      lab[s] = cur;
      while (stack.length) {
        const p = stack.pop();
        n++;
        const i = p % w, j = (p - i) / w;
        if (i > 0 && d[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack.push(p - 1); }
        if (i < w - 1 && d[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack.push(p + 1); }
        if (j > 0 && d[p - w] && !lab[p - w]) { lab[p - w] = cur; stack.push(p - w); }
        if (j < h - 1 && d[p + w] && !lab[p + w]) { lab[p + w] = cur; stack.push(p + w); }
      }
      if (n > bestN) { bestN = n; best = cur; }
    }
    for (let i = 0; i < w * h; i++) d[i] = lab[i] === best ? 1 : 0;
  }
  // Outer boundary of the (single) region as a ring of cell-corner points (Moore-neighbour style edge walk)
  traceOuter() {
    const { w, h, d, res, x0, z0 } = this;
    const at = (i, j) => (i >= 0 && j >= 0 && i < w && j < h ? d[j * w + i] : 0);
    // Directed boundary edges keep land on the left: start at the first land cell's top edge
    let si = -1, sj = -1;
    outer: for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (at(i, j)) { si = i; sj = j; break outer; }
    // Walk corners: position (cx, cz) in corner coordinates, direction index 0:+x 1:+z 2:-x 3:-z
    const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
    let cx = si, cz = sj, dir = 0; // top edge of cell (si, sj), walking +x with land below (on the right in screen, z down)
    const pts = [];
    const start = `${cx},${cz},${dir}`;
    let guard = 0;
    // For a corner walk with land on the right (z down means right = +z side when walking +x):
    // cells around corner (cx, cz): A=(cx-1,cz-1) B=(cx,cz-1) C=(cx-1,cz) D=(cx,cz)
    do {
      pts.push([x0 + cx * res, z0 + cz * res]);
      cx += DX[dir];
      cz += DZ[dir];
      // Cells ahead-left and ahead-right relative to the walking direction
      const cellAt = (dxl, dzl) => at(cx + dxl, cz + dzl);
      // Determine the cells: for each direction, the two cells in front of the corner
      let left, right;
      if (dir === 0) { left = cellAt(0, -1); right = cellAt(0, 0); }
      else if (dir === 1) { left = cellAt(0, 0); right = cellAt(-1, 0); }
      else if (dir === 2) { left = cellAt(-1, 0); right = cellAt(-1, -1); }
      else { left = cellAt(-1, -1); right = cellAt(0, -1); }
      if (left && right) dir = (dir + 3) % 4; // turn left (land ahead): keep land on the right
      else if (!left && right) { /* straight */ }
      else dir = (dir + 1) % 4; // turn right
      if (++guard > 50000000) throw new Error('trace runaway');
    } while (`${cx},${cz},${dir}` !== start);
    // Merge collinear runs, then take edge midpoints (turns the raster's stairs into 45° runs before simplifying)
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], n = pts[(i + 1) % pts.length];
      if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push(q);
    }
    return out.map((q, i) => {
      const n = out[(i + 1) % out.length];
      return [(q[0] + n[0]) / 2, (q[1] + n[1]) / 2];
    });
  }
}

// =====================================================================================================================
// 3. STREET CENTRELINE FROM OPENSTREETMAP (shaped like NYC's CSCL records, so the generators downstream stay as they
//    were): every vehicular or pedestrian street way, split at the nodes it shares with other street ways (CSCL pieces
//    run intersection to intersection), with a curb-to-curb width, travel lanes, direction of travel and level.
// =====================================================================================================================
const osm = load('osm_santafe.json');
const ROAD_RW = {
  // OSM highway -> CSCL roadway type: '1' street, '2' highway, '6' pedestrian street (blocks split, no traffic)
  motorway: '2', motorway_link: '2', trunk: '1', trunk_link: '1', primary: '1', primary_link: '1', secondary: '1',
  secondary_link: '1', tertiary: '1', tertiary_link: '1', residential: '1', unclassified: '1', living_street: '1',
  pedestrian: '6'
};
// Default curb-to-curb width (m) when OSM has no width: per lane plus a parking lane, by class
const LANE_W = 3.1;
function roadWidthM(t, lanes, oneway) {
  const w = parseFloat(t.width);
  if (w > 3 && w < 60) return w;
  const hw = t.highway.replace(/_link$/, '');
  if (hw === 'pedestrian') return 9.4;
  if (hw === 'living_street') return 6.5;
  const byClass = { motorway: 11, trunk: 11, primary: 11, secondary: 10.4, tertiary: 9.8, residential: 9.4, unclassified: 9 }[hw] || 9.4;
  return lanes ? Math.max(byClass, lanes * LANE_W + (hw === 'motorway' ? 1.5 : 2.6)) : byClass;
}
const highwayWays = osm.elements.filter((e) => e.type === 'way' && e.tags && ROAD_RW[e.tags.highway] && e.tags.area !== 'yes' && e.geometry && e.nodes);
// How many street ways (and ends) touch each node: split there
const nodeUse = new Map();
for (const w of highwayWays) {
  w.nodes.forEach((n, i) => {
    const end = i === 0 || i === w.nodes.length - 1;
    nodeUse.set(n, (nodeUse.get(n) || 0) + (end ? 2 : 1));
  });
}
const cscl = [];
for (const w of highwayWays) {
  const t = w.tags;
  const rw = ROAD_RW[t.highway];
  const lanesTag = parseInt(t.lanes, 10);
  const ow = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' || /^motorway/.test(t.highway) ? 1 : t.oneway === '-1' ? -1 : 0;
  const lanes = lanesTag > 0 ? lanesTag : ow ? (/^(primary|trunk|motorway)/.test(t.highway) ? 2 : 1) : 2;
  const wM = roadWidthM(t, lanesTag > 0 ? lanesTag : 0, ow);
  const level = t.bridge && t.bridge !== 'no' ? '14' : t.tunnel && t.tunnel !== 'no' ? '12' : '13';
  const trafdir = rw === '6' ? 'NV' : ow === 1 ? 'FT' : ow === -1 ? 'TF' : 'TW';
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    if (i < w.nodes.length - 1 && nodeUse.get(w.nodes[i]) < 2) continue;
    const coords = w.geometry.slice(start, i + 1).map((g) => [g.lon, g.lat]);
    start = i;
    if (coords.length < 2) continue;
    cscl.push({
      full_street_name: t.name || '', rw_type: rw, streetwidth: String(wM / 0.3048), number_travel_lanes: String(lanes),
      trafdir, from_level_code: level, to_level_code: level, highway: t.highway, osm_id: w.id,
      the_geom: { type: 'LineString', coordinates: coords }
    });
  }
}
function segLines(s) {
  const g = s.the_geom;
  if (!g) return [];
  return g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
}
log(`${cscl.length} street pieces from ${highwayWays.length} OSM ways`);
{
  // Bearing: length-weighted median direction (mod 90°) of the straight calles within 2.5 km of the plaza
  const angs = [];
  for (const s of cscl) {
    if (s.rw_type !== '1' || !s.full_street_name) continue;
    for (const ln of segLines(s)) {
      for (let i = 1; i < ln.length; i++) {
        const [e0, n0] = enu(...ln[i - 1]);
        const [e1, n1] = enu(...ln[i]);
        const L = Math.hypot(e1 - e0, n1 - n0);
        if (L < 40 || Math.hypot(e0, n0) > 2500) continue;
        let a = (Math.atan2(e1 - e0, n1 - n0) * 180) / Math.PI;
        a = ((a % 90) + 90) % 90;
        if (Math.abs(a - 14) < 6) angs.push([a, L]);
      }
    }
  }
  angs.sort((p, q) => p[0] - q[0]);
  const tot = angs.reduce((t, a) => t + a[1], 0);
  let acc = 0;
  for (const [a, L] of angs) {
    acc += L;
    if (acc >= tot / 2) { THETA = (a * Math.PI) / 180; break; }
  }
  // Origin: the node shared by San Martín and Av. General López
  const names = new Map();
  for (const s of cscl) {
    const ln = segLines(s)[0];
    for (const p of [ln[0], ln[ln.length - 1]]) {
      const k = `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
      if (!names.has(k)) names.set(k, { p, names: new Set() });
      names.get(k).names.add(s.full_street_name);
    }
  }
  let found = false;
  for (const { p, names: n } of names.values()) {
    if (n.has('San Martín') && n.has('Avenida General López')) { ORIGIN = gridUV(p[0], p[1]); found = true; }
  }
  if (!found) throw new Error('origin intersection (San Martín & Av. General López) not found');
  log(`bearing ${(THETA * 180 / Math.PI).toFixed(3)}°, origin (San Martín & Gral. López) at grid ${ORIGIN.map((v) => v.toFixed(1))}`);
}

// =====================================================================================================================
// 4. WATER & LAND
// =====================================================================================================================
const centroid = (r) => [r.reduce((t, p) => t + p[0], 0) / r.length, r.reduce((t, p) => t + p[1], 0) / r.length];
// Closed rings of an OSM way / multipolygon relation (outer ways chained end to end), in world coordinates
function elemRings(e, role = 'outer') {
  if (e.type === 'way') return e.geometry ? [e.geometry.map((g) => toWorld(g.lon, g.lat))] : [];
  const parts = (e.members || []).filter((m) => m.role === role && m.geometry).map((m) => m.geometry.map((g) => toWorld(g.lon, g.lat)));
  const rings = [];
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; guard < 2000 && !close(ring[0], ring[ring.length - 1]); guard++) {
      const i = parts.findIndex((p) => close(p[0], ring[ring.length - 1]) || close(p[p.length - 1], ring[ring.length - 1]));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      ring = ring.concat(close(p[0], ring[ring.length - 1]) ? p.slice(1) : p.reverse().slice(1));
    }
    if (ring.length > 3 && close(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}
const isWater = (t) => t && (t.natural === 'water' || t.waterway === 'riverbank' || t.waterway === 'dock');
const waterAreas = [];
for (const e of osm.elements) {
  if (!isWater(e.tags) || (e.type === 'way' && (!e.nodes || e.nodes[0] !== e.nodes[e.nodes.length - 1]))) continue;
  const outer = elemRings(e, 'outer');
  const inner = e.type === 'relation' ? elemRings(e, 'inner') : [];
  if (outer.length) waterAreas.push({ name: e.tags.name || '', outer, inner });
}
log(`${waterAreas.length} water areas`);

// The region rasterised for land & water: the detailed box plus a margin of surrounding land and water
const MARGIN = 2500;
const RES = 4;
const ras = new Raster(DETAIL.x0 - MARGIN, DETAIL.z0 - MARGIN, DETAIL.x1 + MARGIN, DETAIL.z1 + MARGIN, RES);
ras.d.fill(1);
for (const w of waterAreas) for (const r of w.outer) ras.fillRing(r, 0);
for (const w of waterAreas) for (const r of w.inner) ras.fillRing(r, 1); // islands inside the water
const landAll = new Uint8Array(ras.d); // land (1) / water (0) over the whole region

// The detailed city: land inside the detail box, opened to drop slivers, the largest piece
const det = new Raster(DETAIL.x0, DETAIL.z0, DETAIL.x1, DETAIL.z1, RES);
for (let j = 0; j < det.h; j++) {
  for (let i = 0; i < det.w; i++) {
    const x = det.x0 + (i + 0.5) * RES, z = det.z0 + (j + 0.5) * RES;
    const ii = Math.floor((x - ras.x0) / RES), jj = Math.floor((z - ras.z0) / RES);
    det.d[j * det.w + i] = landAll[jj * ras.w + ii];
  }
}
// keep a 1-cell water rim so the trace closes inside the box
for (let i = 0; i < det.w; i++) { det.d[i] = 0; det.d[(det.h - 1) * det.w + i] = 0; }
for (let j = 0; j < det.h; j++) { det.d[j * det.w] = 0; det.d[j * det.w + det.w - 1] = 0; }
det.open(8);
det.keepLargest();
let manhattan = rdpRing(det.traceOuter(), 2);
if (ringArea(manhattan) > 0) manhattan.reverse(); // negative shoelace area in (x, z), like the NYC island ring
log(`detailed city ring: ${manhattan.length} pts, ${(Math.abs(ringArea(manhattan)) / 1e6).toFixed(2)} km²`);

// Low-detail surroundings: every land piece of the region outside the detailed city, as rings (the "boroughs")
const outside = new Raster(ras.x0, ras.z0, ras.x0 + (ras.w - 1) * RES, ras.z0 + (ras.h - 1) * RES, RES);
outside.d.set(landAll);
{
  // minus the detailed city (the surroundings wrap around it, open to the water)
  const cut = new Raster(outside.x0, outside.z0, outside.x0 + (outside.w - 1) * RES, outside.z0 + (outside.h - 1) * RES, RES);
  cut.fillRing(manhattan, 1);
  for (let k = 0; k < cut.d.length; k++) if (cut.d[k]) outside.d[k] = 0;
}
const surroundings = [];
{
  // label 4-connected land pieces, trace each one of at least 0.05 km²
  const { w, h, d } = outside;
  const lab = new Int32Array(w * h);
  let cur = 0;
  const stack = [];
  const comps = [];
  for (let s = 0; s < w * h; s++) {
    if (!d[s] || lab[s]) continue;
    cur++;
    let n = 0;
    stack.push(s);
    lab[s] = cur;
    while (stack.length) {
      const p = stack.pop();
      n++;
      const i = p % w, j = (p - i) / w;
      if (i > 0 && d[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack.push(p - 1); }
      if (i < w - 1 && d[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack.push(p + 1); }
      if (j > 0 && d[p - w] && !lab[p - w]) { lab[p - w] = cur; stack.push(p - w); }
      if (j < h - 1 && d[p + w] && !lab[p + w]) { lab[p + w] = cur; stack.push(p + w); }
    }
    comps.push({ id: cur, n });
  }
  for (const c of comps) {
    if (c.n * RES * RES < 50000) continue;
    const one = new Raster(outside.x0, outside.z0, outside.x0 + (w - 1) * RES, outside.z0 + (h - 1) * RES, RES);
    for (let k = 0; k < w * h; k++) one.d[k] = lab[k] === c.id ? 1 : 0;
    let r = rdpRing(one.traceOuter(), 6);
    if (ringArea(r) > 0) r.reverse();
    surroundings.push(r);
  }
  surroundings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  log(`surroundings: ${surroundings.length} land pieces (${surroundings.map((r) => (Math.abs(ringArea(r)) / 1e6).toFixed(2)).join(', ')} km²)`);
}

// NYC-only inputs, empty here (kept so the generators downstream run unchanged)
const islands = {};
const boroughs = {};
const coastChains = [];
const pierPolys = [];
const geo = { THETA, ORIGIN, manhattan, islands, boroughs, coastChains, pierPolys, mnRing: manhattan, surroundings, waterAreas, DETAIL, osm };
export { geo, toWorld, gridUV, rdp, rdpRing, ringArea, bbox, Raster, load, log, segLines, cscl, centroid, elemRings, DETAIL };
