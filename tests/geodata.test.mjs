import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('geodata builds with default paths in a checkout containing spaces and non-ASCII characters', { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Santa Fé 東京 '));
  try {
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.mkdirSync(path.join(dir, 'js'));
    fs.copyFileSync(path.join(root, 'js/city-config.js'), path.join(dir, 'js/city-config.js'));
    for (const name of fs.readdirSync(path.join(root, 'tools'))) {
      if (name.endsWith('.mjs')) fs.copyFileSync(path.join(root, 'tools', name), path.join(dir, 'tools', name));
    }
    fs.symlinkSync(path.join(root, 'tools/data'), path.join(dir, 'tools/data'), 'dir');
    const env = { ...process.env };
    delete env.GEO_DATA;
    const result = spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(dir, 'tools/build-geodata.mjs')], {
      encoding: 'utf8', env, timeout: 180000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { GEO } = await import(pathToFileURL(path.join(dir, 'js/nyc-geodata.js')).href);
    assert.ok(GEO.roadGraph.links.length > 0);
    assert.ok(GEO.blocks.length > 0);
    const { blockAt } = await import(pathToFileURL(path.join(dir, 'js/city-config.js')).href);
    assert.equal(blockAt(0, -650), null, 'the Peatonal San Martín splits the blocks either side of it');
    assert.ok(blockAt(12, -650) && blockAt(-12, -650), 'the blocks either side of the peatonal remain intact');
    assert.notEqual(blockAt(12, -650), blockAt(-12, -650));
    assert.equal(blockAt(-67, 61).parkName, 'Plaza 25 de Mayo', 'Plaza 25 de Mayo is a park block');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
