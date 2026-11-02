const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { Script } = require('node:vm');
const { gunzipSync, gzipSync } = require('node:zlib');

const compressed = readFileSync(join(__dirname, '../js/tree-geodata.bin.gz'));
const source = readFileSync(join(__dirname, '../js/tree-geodata.js'), 'utf8')
  .replace('import.meta.url', JSON.stringify('https://example.test/city/js/tree-geodata.js'))
  .replace('export const REAL_TREES', 'const REAL_TREES');
const script = new Script(`(async () => { ${source}\nreturn REAL_TREES; })()`);

function loadTrees(bytes = compressed, status = 200) {
  return script.runInNewContext({ URL, Response, DecompressionStream, Float32Array,
    fetch: async url => {
      assert.equal(url.href, 'https://example.test/city/js/tree-geodata.bin.gz');
      return new Response(bytes, { status });
    }
  });
}
const trees = loadTrees();

test('survey tree locations are unique, quantized and inside the detailed map', async () => {
  const REAL_TREES = await trees;
  assert.ok(REAL_TREES instanceof Float32Array);
  assert.equal(REAL_TREES.length, 26511 * 2);
  const geo = readFileSync(join(__dirname, '../js/nyc-geodata.js'), 'utf8');
  const ring = new Script(`${geo.replace('export const GEO', 'const GEO')}\nGEO.manhattan`).runInNewContext();
  function inside(x, z) {
    let hit = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      if ((ring[i + 1] > z) !== (ring[j + 1] > z) &&
        x < (ring[j] - ring[i]) * (z - ring[i + 1]) / (ring[j + 1] - ring[i + 1]) + ring[i]) hit = !hit;
    }
    return hit;
  }
  const seen = new Set();
  for (let i = 0; i < REAL_TREES.length; i += 2) {
    const x = REAL_TREES[i], z = REAL_TREES[i + 1];
    assert.ok(Number.isInteger(x * 2) && Number.isInteger(z * 2));
    const key = `${x},${z}`;
    assert.ok(!seen.has(key), 'Quantized locations must not create duplicate trees.');
    seen.add(key);
    // Boundary locations may move up to 0.25 m on each axis when rounded.
    assert.ok(inside(x, z) || [-0.25, 0.25].some(dx => [-0.25, 0.25].some(dz => inside(x + dx, z + dz))));
  }
});

test('tree generator filters and deduplicates locations, and signed deltas round trip', async () => {
  const { prepare, pack, streetTreeCandidates } = await import('../tools/build-trees.mjs');
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const points = prepare([[1.1, 2.1], [1.2, 2.2], [90, 80], [-10, 5], [NaN, 1]], square);
  assert.deepEqual(new Set(points.map(p => p.join(','))), new Set(['2,4', '180,160']));
  assert.throws(() => prepare([[-10, 5]], square), /No trees/);
  const bytes = pack([[-8192, 127], [16385, -16385], [0, 0], [-1, 1]]);
  assert.deepEqual(Array.from(await loadTrees(gzipSync(bytes))), [-4096, 63.5, 8192.5, -8192.5, 0, 0, -0.5, 0.5]);
  // Estimated street trees stand just inside a block's curb (here a barrio block outside the microcentro), never in
  // parks or along medians
  const X = 1000;
  const block = (park) => [[X, 0, X + 100, 0, X + 100, 80, X, 80], [], park];
  const trees = streetTreeCandidates([block(0)]);
  assert.ok(trees.length > 10);
  for (const [x, z] of trees) {
    const d = Math.min(x - X, X + 100 - x, z, 80 - z);
    assert.ok(d > 0.9 && d < 1.1);
  }
  assert.equal(streetTreeCandidates([block(1)]).length, 0);
  assert.equal(streetTreeCandidates([[[0, 0, 100, 0, 100, 8, 0, 8], [], 0]]).length, 0);
});

test('tree data reports HTTP and gzip failures', async () => {
  await assert.rejects(loadTrees(compressed, 404), /Tree data request failed: 404/);
  await assert.rejects(loadTrees(Buffer.from('not gzip')));
});

test('tree data rejects damaged headers, truncated streams and trailing bytes', async () => {
  const data = gunzipSync(compressed);
  const badVersion = Buffer.from(data);
  badVersion[3]++;
  const badOffset = Buffer.from(data);
  badOffset.writeUInt32LE(data.length, 8);
  const badCount = Buffer.from(data);
  badCount.writeUInt32LE(data.length, 4);
  const overlong = Buffer.from(data);
  overlong.fill(128, 12, 17);
  for (const invalid of [data.subarray(0, 8), badVersion, badOffset, badCount, overlong,
    data.subarray(0, data.length - 1), Buffer.concat([data, Buffer.from([0])])]) {
    await assert.rejects(loadTrees(gzipSync(invalid)), /Invalid tree data/);
  }
});
