// Part 4: parks (OpenStreetMap leisure=park) onto the blocks. Santa Fe has none of New York's piers, East River
// bridges, New Jersey shore or harbour islands: those outputs stay empty, and the detailed city is the whole "island".
import { geo, toWorld, rdpRing, ringArea, bbox, log, centroid, elemRings } from './geo-base.mjs';
import { blocks, blockRaster as R, blockLabels as lab, CUT_Z } from './geo-blocks.mjs';

// ---------------------------------------------------------------------------------------------------------------------
// Parks
// ---------------------------------------------------------------------------------------------------------------------
const SQM_PER_ACRE = 4046.86;
const parks = [];
for (const e of geo.osm.elements) {
  const t = e.tags || {};
  if (t.leisure !== 'park' && t.leisure !== 'garden') continue;
  if (e.type === 'way' && (!e.nodes || e.nodes[0] !== e.nodes[e.nodes.length - 1])) continue;
  const rings = elemRings(e, 'outer');
  if (!rings.length) continue;
  const area = rings.reduce((s, r) => s + Math.abs(ringArea(r)), 0);
  const name = t.name || '';
  const cat = /^Plaza\b/i.test(name) ? 'Plaza' : t.leisure === 'garden' ? 'Garden' : 'Park';
  parks.push({ name, cat, acres: area / SQM_PER_ACRE, rings });
}
log(`${parks.length} OSM parks & gardens`);

// Coverage of every block by park land: scanline-fill each park ring over the block raster
const W = R.w, H = R.h;
for (const b of blocks) {
  const r = b.rects[0];
  const [cx, cz] = r ? [(r[0] + r[1]) / 2, (r[2] + r[3]) / 2] : centroid(b.poly);
  const i = Math.floor((cx - R.x0) / R.res), j = Math.floor((cz - R.z0) / R.res);
  b._lab = i >= 0 && j >= 0 && i < W && j < H ? lab[j * W + i] : 0;
}
const byLab = new Map(blocks.map((b) => [b._lab, b]));
const parkOf = new Map(); // block -> { name, cells }
for (const pk of parks) {
  if (pk.acres < 0.25) continue;
  for (const ring of pk.rings) {
    const bb = bbox(ring);
    const j0 = Math.max(0, Math.floor((bb.z0 - R.z0) / R.res)), j1 = Math.min(H - 1, Math.ceil((bb.z1 - R.z0) / R.res));
    const counts = new Map();
    const xs = [];
    for (let j = j0; j <= j1; j++) {
      const z = R.z0 + (j + 0.5) * R.res;
      xs.length = 0;
      for (let a = 0, k = ring.length - 1; a < ring.length; k = a++) {
        const [xa, za] = ring[k], [xb, zb] = ring[a];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - R.x0) / R.res - 0.5)), i1 = Math.min(W - 1, Math.floor((xs[n + 1] - R.x0) / R.res - 0.5));
        for (let i = i0; i <= i1; i++) {
          const L = lab[j * W + i];
          if (L) counts.set(L, (counts.get(L) || 0) + 1);
        }
      }
    }
    for (const [L, n] of counts) {
      const b = byLab.get(L);
      if (!b) continue;
      b.parkCells = (b.parkCells || 0) + n;
      const prev = parkOf.get(b);
      if (!prev || n > prev.cells) parkOf.set(b, { name: pk.name, cells: n });
    }
  }
}
for (const b of blocks) {
  b.park = b.parkCells ? Math.min(1, Math.round((b.parkCells / b.area) * 100) / 100) : 0;
  const po = parkOf.get(b);
  if (po && b.park > 0.25) b.parkName = po.name;
  delete b.parkCells;
}
log(`blocks in parks (>60%): ${blocks.filter((b) => b.park > 0.6).length}; named parks used: ${new Set(blocks.filter((b) => b.park > 0.6).map((b) => b.parkName)).size}`);

// Park outlines worth drawing on their own (the city-grid park builder & the maps), inside the detailed city
const PARK_KEEP = parks.filter((p) => p.acres >= 0.6 && p.rings.some((r) => centroid(r)[1] > CUT_Z - 200));
const parkShapes = PARK_KEEP.map((p) => ({
  name: p.name, cat: p.cat, acres: Math.round(p.acres * 10) / 10,
  rings: p.rings.filter((r) => Math.abs(ringArea(r)) > 300).map((r) => { const s = rdpRing(r, 0.8); if (ringArea(s) > 0) s.reverse(); return s; })
})).filter((p) => p.rings.length);
log(`${parkShapes.length} park outlines kept`);

// NYC-only features: none in Santa Fe
const piers = [];
const bridges = {};
const nj = [];
const islands = {};
const manhattanSouth = geo.manhattan; // the whole detailed city
const manhattanNorth = [];

export { parks, parkShapes, piers, bridges, nj, islands, manhattanSouth, manhattanNorth };
