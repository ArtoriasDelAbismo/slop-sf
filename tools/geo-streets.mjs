// Part 2: streets & avenues from the CSCL centerline, in the world frame
import { cscl, segLines, toWorld, log, DETAIL } from './geo-base.mjs';

// Every CSCL roadway piece as world-frame line segments with attributes
const pieces = [];
const plazaPieces = [];
for (const s of cscl) {
  const plaza = s.rw_type === '6' && s.full_street_name === 'BROADWAY';
  if (!plaza && !['1', '2', '6'].includes(s.rw_type)) continue;
  const name = s.full_street_name || '';
  const w = parseFloat(s.streetwidth || '0') * 0.3048; // curb-to-curb roadway width (ft -> m)
  const lanes = parseInt(s.number_travel_lanes || '0', 10);
  for (const ln of segLines(s)) {
    const pts = ln.map(([lon, lat]) => toWorld(lon, lat));
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 0.5) continue;
      // trafdir: FT = travel from the first point to the last, TF = the reverse, TW = both ways
      (plaza ? plazaPieces : pieces).push({ name, rw: s.rw_type, w, lanes, dir: s.trafdir, x0, z0, x1, z1, L, level: s.from_level_code === s.to_level_code ? s.from_level_code : 'ramp' });
    }
  }
}
log(`${pieces.length} centerline pieces`);

const wmedian = (vals) => {
  vals = vals.filter((v) => Number.isFinite(v[0])).sort((a, b) => a[0] - b[0]);
  const tot = vals.reduce((t, v) => t + v[1], 0);
  let acc = 0;
  for (const [v, w] of vals) {
    acc += w;
    if (acc >= tot / 2) return v;
  }
  return NaN;
};
// Union of [a, b] intervals, joining gaps narrower than `join`
function unionIntervals(iv, join = 2) {
  iv = iv.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of iv) {
    if (out.length && a <= out[out.length - 1][1] + join) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Grid lines: Santa Fe's calles run straight across the grid, east-west ("streets", numbered 1, 2, ... from the south
// like Manhattan's) and north-south ("avenues"). Grid-aligned pieces are clustered by their z (streets) or x (avenues);
// a line keeps every name it carries along its length (Bv. Pellegrini becomes Bv. Gálvez east of Rivadavia).
// ---------------------------------------------------------------------------------------------------------------------
const GRID_RW = new Set(['1']);
const inDetail = (p) => Math.max(p.x0, p.x1) > DETAIL.x0 && Math.min(p.x0, p.x1) < DETAIL.x1 && Math.max(p.z0, p.z1) > DETAIL.z0 && Math.min(p.z0, p.z1) < DETAIL.z1;
function clusterLines(ps, posOf, tol) {
  const sorted = ps.map((p) => ({ p, v: posOf(p) })).sort((a, b) => a.v - b.v);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && it.v - last.v1 <= tol) { last.items.push(it.p); last.v1 = it.v; }
    else out.push({ v0: it.v, v1: it.v, items: [it.p] });
  }
  return out.map((c) => c.items);
}
const dominantName = (ps) => {
  const byName = new Map();
  for (const p of ps) if (p.name) byName.set(p.name, (byName.get(p.name) || 0) + p.L);
  return [...byName].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};
const slug = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^(avenida|bulevar|pasaje|calle) /, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
// direction sign along the axis for a piece: +1 towards +axis, -1 towards -axis, 0 both
const dirAlong = (p, a0, a1) => (p.dir === 'FT' ? Math.sign(a1 - a0) : p.dir === 'TF' ? Math.sign(a0 - a1) : 0);
function lineSegs(near, axis, join, minLen) {
  const runs = near.map((p) => {
    const [a0, a1] = axis === 'x' ? [p.x0, p.x1] : [p.z0, p.z1];
    return { a: Math.min(a0, a1), b: Math.max(a0, a1), d: dirAlong(p, a0, a1), w: p.w, L: p.L, lanes: p.lanes, name: p.name };
  });
  const iv = unionIntervals(runs.map((r) => [r.a, r.b]), join);
  return iv.map(([a, b]) => {
    const inside = runs.filter((r) => r.a >= a - 1 && r.b <= b + 1);
    const votes = { '-1': 0, '0': 0, '1': 0 };
    for (const r of inside) votes[r.d] += r.L;
    const d = +Object.entries(votes).sort((p, q) => q[1] - p[1])[0][0];
    const w = wmedian(inside.map((r) => [r.w, r.L]));
    const lanes = wmedian(inside.map((r) => [r.lanes, r.L]));
    const secs = [];
    for (const r of inside.sort((p, q) => p.a - q.a)) {
      const last = secs[secs.length - 1];
      if (last && last[2] === r.name) last[1] = Math.max(last[1], r.b);
      else if (r.name) secs.push([r.a, r.b, r.name]);
    }
    return { a, b, d, w, lanes, names: secs.map(([s0, s1, nm]) => [Math.round(s0), Math.round(s1), nm]) };
  }).filter((s) => s.b - s.a >= minLen);
}
const gridPieces = pieces.filter((p) => GRID_RW.has(p.rw) && p.level === '13' && p.name && inDetail(p));
const ewPieces = gridPieces.filter((p) => Math.abs(p.z1 - p.z0) / p.L < 0.03); // within ~1.7° (tilted sectors go to the road graph)
const nsPieces = gridPieces.filter((p) => Math.abs(p.x1 - p.x0) / p.L < 0.03);

const STREETS = [];
for (const ps of clusterLines(ewPieces, (p) => (p.z0 + p.z1) / 2, 8)) {
  const total = ps.reduce((t, p) => t + p.L, 0);
  if (total < 250) continue;
  const z = wmedian(ps.map((p) => [(p.z0 + p.z1) / 2, p.L]));
  const near = ps.filter((p) => Math.abs((p.z0 + p.z1) / 2 - z) < 12);
  const segs = lineSegs(near, 'x', 3, 30);
  if (!segs.length) continue;
  STREETS.push({ z: Math.round(z * 10) / 10, name: dominantName(near), segs });
}
STREETS.sort((a, b) => b.z - a.z); // south (largest z) first
STREETS.forEach((s, i) => { s.n = i + 1; });
const streetsOut = STREETS.map((s) => ({
  n: s.n, z: s.z, name: s.name,
  segs: s.segs.map((g) => [Math.round(g.a * 10) / 10, Math.round(g.b * 10) / 10, g.d, Math.round(g.w * 10) / 10]),
  names: s.segs.flatMap((g) => g.names)
}));
log(`${streetsOut.length} east-west grid streets (${streetsOut.slice(0, 4).map((s) => `${s.n} ${s.name} z=${s.z}`).join(', ')}, ...)`);

const AVENUES = [];
const usedIds = new Set();
for (const ps of clusterLines(nsPieces, (p) => (p.x0 + p.x1) / 2, 8)) {
  const total = ps.reduce((t, p) => t + p.L, 0);
  if (total < 250) continue;
  const x = wmedian(ps.map((p) => [(p.x0 + p.x1) / 2, p.L]));
  const near = ps.filter((p) => Math.abs((p.x0 + p.x1) / 2 - x) < 12);
  const segs = lineSegs(near, 'z', 40, 60).map((g) => ({ z0: Math.round(g.a), z1: Math.round(g.b), dir: g.d, w: Math.round(g.w * 10) / 10, lanes: g.lanes, names: g.names }));
  if (!segs.length) continue;
  const label = dominantName(near);
  let id = slug(label) || `x${Math.round(x)}`;
  while (usedIds.has(id)) id += '_';
  usedIds.add(id);
  AVENUES.push({ id, label, x: Math.round(x * 10) / 10, segs });
}
AVENUES.sort((a, b) => a.x - b.x);
log(`${AVENUES.length} north-south grid avenues (${AVENUES.filter((a) => Math.abs(a.x) < 400).map((a) => `${a.label} x=${a.x}`).join(', ')}, ...)`);

export { pieces, plazaPieces, streetsOut as STREETS, AVENUES, wmedian, unionIntervals };

