// tools/build-geodata.mjs — writes js/nyc-geodata.js (see geo-base.mjs for the frame and the data sources)
// usage: node --max-old-space-size=8192 tools/build-geodata.mjs [out.js]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { geo, toWorld, rdp, rdpRing, ringArea, bbox, log, centroid } from './geo-base.mjs';
import { pieces, STREETS, AVENUES } from './geo-streets.mjs';
import { blocks, innerRing, roads, PLAZAS, CUT_Z, STRIP, SIDEWALK } from './geo-blocks.mjs';
import { parkShapes, piers, bridges, nj, islands, manhattanSouth, manhattanNorth } from './geo-extra.mjs';
import { buildRoadGraph } from './geo-roadgraph.mjs';

const OUT = process.argv[2] || fileURLToPath(new URL('../js/nyc-geodata.js', import.meta.url));
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);
const inDetail = (z) => z > CUT_Z - 250;

// --- Broadway: New York's diagonal; Santa Fe has none ---------------------------------------------------------------
const broadway = [];

// --- Roads (at-grade centreline pieces merged into polylines per street & width), for maps & the road graph ---------
function mergeRoads() {
  const byKey = new Map();
  for (const p of pieces) {
    if (p.level !== '13' || !['1', '2'].includes(p.rw)) continue;
    if (/DRIVEWAY|PEDESTRIAN|ALLEY|CONNECTOR/.test(p.name)) continue;
    if (!inDetail(Math.min(p.z0, p.z1))) continue;
    const key = `${p.name}|${Math.round(p.w)}|${p.dir}|${p.lanes}|${p.rw}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push([[p.x0, p.z0], [p.x1, p.z1]]);
  }
  const out = [];
  for (const [key, segs] of byKey) {
    const [name, w, dir, lanes, rw] = key.split('|');
    // chain pieces end to start
    const ends = new Map();
    const k = (p) => `${q(p[0])},${q(p[1])}`;
    for (const s of segs) ends.set(k(s[0]), s);
    const used = new Set();
    for (const s of segs) {
      if (used.has(s)) continue;
      // walk back to the first piece of this chain
      let first = s;
      const seen = new Set([s]);
      for (;;) {
        const prev = segs.find((t) => !seen.has(t) && !used.has(t) && k(t[1]) === k(first[0]));
        if (!prev) break;
        seen.add(prev);
        first = prev;
      }
      const line = [first[0]];
      let cur = first;
      while (cur && !used.has(cur)) {
        used.add(cur);
        line.push(cur[1]);
        cur = ends.get(k(cur[1]));
      }
      out.push({ name, w: +w, dir, lanes: +lanes, hw: rw === '2', pts: rdp(line, 0.8) });
    }
  }
  return out;
}
const roadLines = mergeRoads();
log(`${roadLines.length} road polylines (${roadLines.reduce((t, r) => t + r.pts.length, 0)} pts)`);

// --- Central Park: none in Santa Fe (an empty park far outside the city keeps the engine's park tests false) --------
const cp = { bounds: { minX: -1e6, maxX: -1e6 + 1, minZ: -1e6, maxZ: -1e6 + 1 }, outline: [], water: [], lawns: [], drives: [], paths: [], sites: [] };

// --- Landmarks: real footprints (grid-aligned bounding boxes) of named buildings, churches & monuments from OSM ------
function elemRing(e) {
  if (e.type === 'way') return (e.geometry || []).map((g) => toWorld(g.lon, g.lat));
  let best = [];
  for (const m of e.members || []) if (m.role === 'outer' && m.geometry && m.geometry.length > best.length) best = m.geometry.map((g) => toWorld(g.lon, g.lat));
  return best;
}
const landmarks = {};
for (const e of geo.osm.elements) {
  const t = e.tags || {};
  if (!t.name || !(t.building || t.historic || t.amenity === 'place_of_worship')) continue;
  const r = elemRing(e);
  if (r.length < 4) continue;
  const [cx, cz] = centroid(r);
  if (cx < geo.DETAIL.x0 || cx > geo.DETAIL.x1 || cz < geo.DETAIL.z0 || cz > geo.DETAIL.z1) continue;
  const b = bbox(r);
  const area = Math.abs(ringArea(r));
  if (area < 150) continue;
  const prev = landmarks[t.name];
  if (prev && prev.area >= area) continue;
  const levels = parseFloat(t['building:levels']);
  const h = t.height ? parseFloat(t.height) : levels > 0 ? levels * 3.2 : null;
  landmarks[t.name] = { x: q((b.x0 + b.x1) / 2), z: q((b.z0 + b.z1) / 2), w: q(b.x1 - b.x0), d: q(b.z1 - b.z0), h, area: Math.round(area), ring: flat(rdpRing(r.slice(0, -1), 0.4)) };
}
log(`${Object.keys(landmarks).length} landmark footprints`);

// --- Assemble -----------------------------------------------------------------------------------------------------------
const streetsOut = STREETS.filter((s) => inDetail(s.z)).map((s) => ({ n: s.n, z: s.z, name: s.name, names: s.names, segs: s.segs.map(([a, b, d, w]) => [q(a), q(b), d, q(w)]) }));
const avenuesOut = AVENUES.map((a) => ({
  id: a.id, label: a.label, x: a.x,
  segs: a.segs.filter((s) => s.z1 > CUT_Z - 200).map((s) => ({ z0: Math.max(s.z0, CUT_Z - 200), z1: s.z1, dir: s.dir, w: s.w, lanes: s.lanes, names: s.names }))
})).filter((a) => a.segs.length);

// --- Points of note, from the OSM features carrying these names (centroids; bridges: their two ends) -----------------
function osmCentroid(re, kinds) {
  let best = null;
  for (const e of geo.osm.elements) {
    const t = e.tags || {};
    if (!t.name || !re.test(t.name) || !kinds.some((k) => t[k])) continue;
    const r = elemRing(e);
    if (r.length < 3) continue;
    const area = Math.abs(ringArea(r));
    if (!best || area > best.area) best = { area, c: centroid(r) };
  }
  return best ? best.c.map(q) : null;
}
function osmBridgeEnds(re) {
  const pts = [];
  for (const e of geo.osm.elements) {
    const t = e.tags || {};
    if (e.type !== 'way' || !t.highway || !t.bridge || !re.test(t.name || '')) continue;
    for (const g of e.geometry || []) pts.push(toWorld(g.lon, g.lat));
  }
  if (pts.length < 2) return null;
  // the two points farthest apart
  let best = [pts[0], pts[1]], bd = 0;
  for (const a of pts) for (const b of pts) { const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (d > bd) { bd = d; best = [a, b]; } }
  return best.sort((a, b) => a[0] - b[0]).map((p) => p.map(q));
}
const points = {
  plaza25DeMayo: osmCentroid(/^Plaza 25 de Mayo$/, ['leisure']),
  casaDeGobierno: osmCentroid(/Casa de Gobierno/, ['building', 'amenity', 'historic']),
  catedral: osmCentroid(/Catedral/, ['building', 'amenity', 'historic']),
  sanFrancisco: osmCentroid(/San Francisco/, ['building', 'amenity', 'historic'])
};
const colgante = osmBridgeEnds(/Colgante/);
if (colgante) { points.puenteColganteWest = colgante[0]; points.puenteColganteEast = colgante[1]; }
for (const k of Object.keys(points)) if (!points[k]) delete points[k];
log(`points: ${Object.entries(points).map(([k, v]) => `${k} (${v.map(Math.round)})`).join(', ')}`);

const GEO = {
  version: 1,
  frame: { bearingDeg: q((geo.THETA * 180) / Math.PI * 10) / 10, origin: 'San Martín & Av. General López (centreline)', units: 'm', cutZ: CUT_Z, strip: STRIP, sidewalk: SIDEWALK, detail: geo.DETAIL },
  manhattan: flat(manhattanSouth),
  upperManhattan: flat(manhattanNorth),
  innerShore: flat(innerRing),
  islands: Object.fromEntries(Object.entries(islands).map(([k, r]) => [k, flat(r)])),
  // Low-detail land around the detailed city (the rest of Santa Fe, Santo Tomé, the islands across the Setúbal)
  boroughs: { surroundings: geo.surroundings.map(flat) },
  // Water bodies (Setúbal lagoon, Riacho Santa Fe, the port docks, the Salado): outer rings
  water: geo.waterAreas.map((w) => ({ name: w.name, rings: w.outer.map((r) => flat(rdpRing(r, 2))) })),
  streets: streetsOut,
  avenues: avenuesOut,
  broadway: flat(broadway),
  plazas: PLAZAS.map((p) => ({ name: p.name, a: p.a.map(q), b: p.b.map(q), w: p.w })),
  roads: roadLines.map((r) => [r.name, r.w ? q(r.w) : 0, r.dir || '', r.lanes || 0, r.hw ? 1 : 0, flat(r.pts)]),
  // Street centreline graph for the detailed city (geo-roadgraph.mjs): nodes [x, z, ...],
  // links [node a, node b, name index, curb-to-curb width, travel lanes, direction (1: a -> b, -1: b -> a, 0: both),
  // inner shape points [x, z, ...]]
  roadGraph: buildRoadGraph(),
  // [outline, lot rects, park share, park name, rectangular, frontage frames [[θ, px, pz, lot rects in the frame], ...] | 0]
  blocks: blocks.map((b) => [flat(b.poly), b.rects.map((r) => r.map(q)), b.park || 0, b.parkName || '', b.rect ? 1 : 0,
    b.frames ? b.frames.map(([th, px, pz, rs]) => [Math.round(th * 1e4) / 1e4, q(px), q(pz), rs.map((r) => r.map(q))]) : 0]),
  parks: parkShapes.map((p) => ({ name: p.name, cat: p.cat, acres: p.acres, rings: p.rings.map(flat) })),
  centralPark: cp,
  piers: piers.map((p) => ({ name: p.name, cx: q(p.cx), cz: q(p.cz), len: q(p.len), wid: q(p.wid), ang: Math.round(p.ang * 1e4) / 1e4, ring: flat(p.ring) })),
  bridges: Object.fromEntries(Object.entries(bridges).map(([k, b]) => [k, { a: b.a.map(q), mid: b.mid.map(q), dir: [Math.round(b.ux * 1e5) / 1e5, Math.round(b.uz * 1e5) / 1e5] }])),
  landmarks,
  points
};

const json = JSON.stringify(GEO);
const header = `// js/nyc-geodata.js — GENERATED by tools/build-geodata.mjs, do not edit by hand.
// Real Santa Fe (Argentina) geography in the simulation's world frame: 1 unit = 1 m, x = grid east, z = grid south,
// origin at the centreline intersection of San Martín & Av. General López, axes turned ${GEO.frame.bearingDeg}° from true north.
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Sources: © OpenStreetMap contributors (ODbL).
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
