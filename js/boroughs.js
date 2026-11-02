import * as THREE from 'three/webgpu';
import { SURROUNDING_POLYGONS, ISLAND_BOUNDS } from './city-config.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// The low-detail land around the detailed city: the rest of Santa Fe north and west of it, Santo Tomé across the
// Salado, Alto Verde and the islands across the Setúbal (js/nyc-geodata.js GEO.boroughs.surroundings, traced from
// OpenStreetMap's water). Flat ground at street level with an earth bank down to the water. (The New York engine built
// its boroughs, harbour islands and bridges here.)

const LAND_Y = 0.0;
const BANK_DEPTH = ISLAND_BOUNDS.waterLevel - 0.6;

function pointInPolygon(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function landTop(pts) {
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2); // shape y = -z -> world z
  geo.translate(0, LAND_Y, 0);
  return geo;
}

function bankWall(pts) {
  const pos = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    pos.push(a.x, LAND_Y, a.z, b.x, LAND_Y, b.z, b.x, BANK_DEPTH, b.z);
    pos.push(a.x, LAND_Y, a.z, b.x, BANK_DEPTH, b.z, a.x, BANK_DEPTH, a.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function landAt(x, z) {
  for (const pts of SURROUNDING_POLYGONS) if (pointInPolygon(pts, x, z)) return { pts };
  return null;
}
const ridgeHeightAt = () => 0;

function buildBoroughs(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'Surroundings';
  const landMat = new THREE.MeshStandardNodeMaterial({ color: 0x6f7a5a, roughness: 0.95 });
  const bankMat = new THREE.MeshStandardNodeMaterial({ color: 0x5b5246, roughness: 1.0, side: THREE.DoubleSide });
  const rings = SURROUNDING_POLYGONS.filter((p) => p.length >= 3);
  if (rings.length) {
    const land = new THREE.Mesh(mergeGeometries(rings.map(landTop), false), landMat);
    land.name = 'SurroundingLand';
    land.receiveShadow = true;
    const bank = new THREE.Mesh(mergeGeometries(rings.map(bankWall), false), bankMat);
    bank.name = 'SurroundingBanks';
    group.add(land, bank);
  }
  scene.add(group);
  console.info(`[boroughs] ${rings.length} surrounding land pieces built in ${(performance.now() - t0).toFixed(0)} ms`);
  return { group, ridgeHeightAt, landAt, colliders: [], update: null };
}

export { buildBoroughs, ridgeHeightAt, landAt as boroughLandAt };
