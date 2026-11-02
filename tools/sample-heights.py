#!/usr/bin/env python3
"""tools/sample-heights.py — measured building heights for the Open Buildings footprints.

Samples Google Open Buildings 2.5D Temporal (v1, 2023 epoch; CC BY 4.0 / ODbL) `building_height` band inside every
footprint of tools/data/cache/gob_santafe.csv and writes tools/data/cache/gob_heights.csv: one line per footprint row
(same order), `height,pixels` — a high percentile of the height pixels inside the footprint in metres, and how many
1 m pixels it saw (0: no data, the build falls back to an estimate).

usage (needs numpy, tifffile, imagecodecs, zarr):
  python3 -m venv .venv && .venv/bin/pip install numpy tifffile imagecodecs zarr
  .venv/bin/python tools/sample-heights.py

The rasters (UTM 20S, 0.5 m pixels, ~4 m effective resolution) are the 2023 tiles of S2 cell 95b5c covering the
Santa Fe bbox; download them into tools/data/cache/ob25d/ (~1 GB, gitignored):
  for t in 6KEYHZc2DNw jBr6cROQtuo FAbZxvXVeXU kkOlJ4EAPOw; do curl -so tools/data/cache/ob25d/tile_$t.tif \\
    https://storage.googleapis.com/open-buildings-temporal-data/v1/geotiffs/95b5c_2023_06_30/tile_$t.tif; done
"""
import csv, math, os, re, sys
import numpy as np
import tifffile, zarr

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CACHE = os.path.join(ROOT, 'tools', 'data', 'cache')
TILES = {  # file: (left, top) in EPSG:32720, 25000 x 25000 px at 0.5 m (from the 95_EPSG_32720 2023 manifest)
    'tile_6KEYHZc2DNw.tif': (704336.0, 6508192.0),
    'tile_jBr6cROQtuo.tif': (716836.0, 6508192.0),
    'tile_FAbZxvXVeXU.tif': (704336.0, 6495692.0),
    'tile_kkOlJ4EAPOw.tif': (716836.0, 6495692.0),
}
HEIGHT_BAND = 1
RES = 1.0  # resample to 1 m (the model's effective resolution is ~4 m)
PERCENTILE = 80  # roofs: the edges of a footprint blur into the street at ~4 m resolution, so not the median
MIN_CONFIDENCE = 0.7


def utm20s(lat, lon):
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
    e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    phi, lam, lam0 = np.radians(lat), np.radians(lon), math.radians(-63.0)
    N = a / np.sqrt(1 - e2 * np.sin(phi) ** 2); T = np.tan(phi) ** 2; C = ep2 * np.cos(phi) ** 2
    A = np.cos(phi) * (lam - lam0)
    M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
             - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * np.sin(2 * phi)
             + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * np.sin(4 * phi) - (35 * e2 ** 3 / 3072) * np.sin(6 * phi))
    x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000
    y = k0 * (M + N * np.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
                                     + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720)) + 10000000
    return x, y


def main():
    src = os.path.join(CACHE, 'gob_santafe.csv')
    rows = []
    with open(src) as fh:
        reader = csv.reader(fh)
        head = next(reader)
        iconf, igeom = head.index('confidence'), head.index('geometry')
        for r in reader:
            if float(r[iconf]) < MIN_CONFIDENCE:
                rows.append(None); continue
            m = re.match(r'^POLYGON\s*\(\((.*)\)\)$', r[igeom].strip())
            if not m or '),' in m.group(1):  # holes & multipolygons: skipped, as in build-buildings.mjs
                rows.append(None); continue
            ll = np.array([[float(v) for v in p.split()] for p in m.group(1).split(',')])
            x, y = utm20s(ll[:, 1], ll[:, 0])
            rows.append(np.stack([x, y], 1))
    ring_all = np.concatenate([r for r in rows if r is not None])
    x0, y0 = ring_all.min(0) - 10; x1, y1 = ring_all.max(0) + 10
    W, H = int((x1 - x0) / RES) + 1, int((y1 - y0) / RES) + 1
    print(f'{sum(r is not None for r in rows)} footprints; height raster {W} x {H} at {RES} m', file=sys.stderr)

    # Mosaic the tiles' height band onto the 1 m grid (taking every 2nd 0.5 m pixel), in strips to bound memory
    grid = np.full((H, W), np.nan, np.float32)
    step = int(RES / 0.5)
    for name, (left, top) in TILES.items():
        path = os.path.join(CACHE, 'ob25d', name)
        store = tifffile.imread(path, aszarr=True)
        z = zarr.open(store, mode='r')
        if isinstance(z, zarr.Group): z = z['0']
        shape = z.shape
        band_axis = 0 if shape[0] == 3 else 2
        # overlap in the tile's pixel space
        c0 = max(0, int((x0 - left) / 0.5)); c1 = min(25000, int((x1 - left) / 0.5) + 1)
        r0 = max(0, int((top - y1) / 0.5)); r1 = min(25000, int((top - y0) / 0.5) + 1)
        if c0 >= c1 or r0 >= r1: continue
        c0 -= c0 % step; r0 -= r0 % step
        for rs in range(r0, r1, 2048):
            re_ = min(r1, rs + 2048)
            blk = z[HEIGHT_BAND, rs:re_:step, c0:c1:step] if band_axis == 0 else z[rs:re_:step, c0:c1:step, HEIGHT_BAND]
            blk = np.asarray(blk, np.float32)
            blk[blk < -1] = np.nan
            gy = np.round((top - (rs + np.arange(blk.shape[0]) * step) * 0.5 - 0.25 - y0) / RES).astype(int)
            gx = np.round((left + (c0 + np.arange(blk.shape[1]) * step) * 0.5 + 0.25 - x0) / RES).astype(int)
            gy = H - 1 - gy  # row 0 at the top (north)
            ok_r = (gy >= 0) & (gy < H); ok_c = (gx >= 0) & (gx < W)
            sub = blk[np.ix_(ok_r, ok_c)]
            dst = grid[np.ix_(gy[ok_r], gx[ok_c])]
            grid[np.ix_(gy[ok_r], gx[ok_c])] = np.where(np.isnan(dst), sub, np.fmax(dst, sub))
        print(f'  {name} mosaicked', file=sys.stderr)

    out = open(os.path.join(CACHE, 'gob_heights.csv'), 'w')
    out.write('height,pixels,p95\n')
    measured = 0
    for ring in rows:
        if ring is None:
            out.write('0,0,0\n'); continue
        px = (ring[:, 0] - x0) / RES; py = H - 1 - (ring[:, 1] - y0) / RES
        ca, cb = int(math.floor(px.min())), int(math.ceil(px.max()))
        ra, rb = int(math.floor(py.min())), int(math.ceil(py.max()))
        cc, rr = np.meshgrid(np.arange(ca, cb + 1), np.arange(ra, rb + 1))
        cx, cy = cc.ravel() + 0.0, rr.ravel() + 0.0
        inside = np.zeros(cx.shape, bool)
        xs, ys = px, py
        for i in range(len(xs) - 1):
            xa, ya, xb, yb = xs[i], ys[i], xs[i + 1], ys[i + 1]
            hit = ((ya > cy) != (yb > cy)) & (cx < (xb - xa) * (cy - ya) / ((yb - ya) + 1e-12) + xa)
            inside ^= hit
        if not inside.any():  # sliver: the nearest pixel to its centre
            cx, cy, inside = np.array([round(px.mean())]), np.array([round(py.mean())]), np.array([True])
        ci, ri = cx[inside].astype(int), cy[inside].astype(int)
        ok = (ci >= 0) & (ci < W) & (ri >= 0) & (ri < H)
        v = grid[ri[ok], ci[ok]]
        v = v[~np.isnan(v)]
        if not len(v):
            out.write('0,0,0\n'); continue
        measured += 1
        out.write(f'{np.percentile(v, PERCENTILE):.1f},{len(v)},{np.percentile(v, 95):.1f}\n')
    out.close()
    print(f'{measured} footprints measured; wrote tools/data/cache/gob_heights.csv', file=sys.stderr)


if __name__ == '__main__':
    main()
