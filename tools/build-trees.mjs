// tools/build-trees.mjs — writes js/tree-geodata.js and js/tree-geodata.bin.gz (the NYT1 format js/tree-geodata.js
// decodes): tree locations in the detailed city, quantized to 0.5 m.
//
// usage: node --max-old-space-size=8192 tools/build-trees.mjs   (after tools/build-geodata.mjs)
//
// Sources: every natural=tree node OpenStreetMap maps inside the detailed city, plus ESTIMATED street trees: Santa Fe's
// calles are lined with trees (fresnos, jacarandás, lapachos...) that OSM barely maps, so a tree stands every ~9 m
// along each block's curb with a deterministic chance (lower in the microcentro). street-details.js fits them all to
// the modeled curbs.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRECISION = 0.5;
const SPACING = 9;
const CURB_INSET = 1.0;

function inside(x, z, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) hit = !hit;
  }
  return hit;
}

// Unique quantized points inside `island` ([[x, z], ...]), in Morton order (nearby trees together: small deltas)
export function prepare(points, island) {
  const keep = new Map();
  for (const [x, z] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !inside(x, z, island)) continue;
    const p = [Math.round(x / PRECISION), Math.round(z / PRECISION)];
    keep.set(`${p[0]},${p[1]}`, p);
  }
  const list = [...keep.values()];
  if (!list.length) throw new Error('No trees inside the detailed city.');
  const ox = Math.min(...list.map((p) => p[0])), oz = Math.min(...list.map((p) => p[1]));
  const bits = Math.max(...list.map((p) => Math.max(p[0] - ox, p[1] - oz))).toString(2).length;
  const morton = ([x, z]) => {
    let m = 0;
    for (let i = 0; i < bits; i++) m += (((x - ox) >> i) & 1) * 2 ** (2 * i) + (((z - oz) >> i) & 1) * 2 ** (2 * i + 1);
    return m;
  };
  return list.sort((a, b) => morton(a) - morton(b));
}

// NYT1: count and X-stream length, followed by X/Z zigzag delta varints on the 0.5 m grid
export function pack(points) {
  const xs = [], zs = [];
  const delta = (arr, v) => {
    v = v >= 0 ? v * 2 : -v * 2 - 1;
    while (v > 127) { arr.push((v & 127) | 128); v = Math.floor(v / 128); }
    arr.push(v);
  };
  let x = 0, z = 0;
  for (const [px, pz] of points) { delta(xs, px - x); delta(zs, pz - z); x = px; z = pz; }
  const header = Buffer.alloc(12);
  header.write('NYT1', 0, 'ascii');
  header.writeUInt32LE(points.length, 4);
  header.writeUInt32LE(xs.length, 8);
  return Buffer.concat([header, Buffer.from(xs), Buffer.from(zs)]);
}

// Deterministic [0, 1)
function rand(x, z, salt) {
  return crypto.createHash('md5').update(`${Math.round(x * 2)},${Math.round(z * 2)},${salt}`).digest().readUInt32LE(0) / 2 ** 32;
}
const inMicrocentro = (x, z) => x > -500 && x < 400 && z > -1100 && z < 450;

// Estimated street trees: along every non-park, non-median block's curb, CURB_INSET in from it
export function streetTreeCandidates(blocks) {
  const out = [];
  for (const [flat, , park] of blocks) {
    if (park > 0.6) continue;
    const ring = [];
    for (let i = 0; i < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    if (Math.min(x1 - x0, z1 - z0) < 12) continue; // medians & slivers
    // ring winding: the inward normal is the left or right of each edge
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    const inward = area > 0 ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < SPACING * 1.5) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const nx = -uz * inward, nz = ux * inward;
      for (let t = SPACING * 0.75; t < L - SPACING * 0.5; t += SPACING) {
        const x = ax + ux * t + nx * CURB_INSET, z = az + uz * t + nz * CURB_INSET;
        const chance = inMicrocentro(x, z) ? 0.3 : 0.62;
        if (rand(x, z, 'street-tree') < chance) out.push([x, z]);
      }
    }
  }
  return out;
}

async function main() {
  const { GEO } = await import(`${ROOT}js/nyc-geodata.js`);
  const { geo, toWorld, log } = await import('./geo-base.mjs');
  const island = [];
  for (let i = 0; i < GEO.manhattan.length; i += 2) island.push([GEO.manhattan[i], GEO.manhattan[i + 1]]);
  const osmTrees = geo.osm.elements.filter((e) => e.type === 'node' && e.tags && e.tags.natural === 'tree').map((e) => toWorld(e.lon, e.lat));
  const street = streetTreeCandidates(GEO.blocks);
  const points = prepare([...osmTrees, ...street], island);
  log(`${points.length} trees (${osmTrees.length} OSM tree nodes in the bbox, ${street.length} estimated street trees)`);
  const asset = 'tree-geodata.bin.gz';
  fs.writeFileSync(`${ROOT}js/${asset}`, zlib.gzipSync(pack(points), { level: 9, mtime: 0 }));
  const moduleFile = `${ROOT}js/tree-geodata.js`;
  const decoder = fs.readFileSync(moduleFile, 'utf8').replace(/^(\/\/.*\n)+/, '');
  fs.writeFileSync(moduleFile, `// Generated by tools/build-trees.mjs; do not edit.
// OpenStreetMap natural=tree nodes (© OpenStreetMap contributors, ODbL) plus estimated street trees along the curbs.
// ${points.length.toLocaleString('en-US')} unique tree locations, quantized to 0.5 m.
${decoder}`);
  log(`wrote js/${asset} (${(fs.statSync(`${ROOT}js/${asset}`).size / 1024).toFixed(0)} KB) and js/tree-geodata.js`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
