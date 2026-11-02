# Slop Santa Fe

A Santa Fe (Argentina) simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL, remixed from
[Slop New York](https://github.com/mrdoob/slop-newyork). Explore the city from Bv. Pellegrini and Bv. Gálvez down to
the port and the Riacho Santa Fe, on foot, by car, by bicycle, or by helicopter.

## How the port works

The engine was written for Manhattan, so Santa Fe is described in its terms: the north–south calles are its
"avenues", the east–west calles its "streets", the detailed city its "island". Streets off the straight grid (the
centro's slightly tilted calles, the Costanera, the diagonals) drive on the street-centreline graph. New York's set
pieces (boroughs, bridges, Central Park, Midtown landmarks, subway) are switched off.

Rebuild the data (Node 22+):

```sh
bash tools/overpass.sh tools/data/osm_santafe.json tools/data/q_santafe.overpassql   # OpenStreetMap extract
node --max-old-space-size=8192 tools/build-geodata.mjs                                 # streets, blocks, parks, water
# Google Open Buildings v3 footprints for the Santa Fe bbox (1.5 GB stream, kept out of git):
curl -sL https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_4_gzip/95b_buildings.csv.gz \
  | zcat | awk -F, 'NR==1 || ($1>-31.70 && $1<-31.58 && $2>-60.76 && $2<-60.66)' > tools/data/cache/gob_santafe.csv
# Optional, measured heights: Open Buildings 2.5D Temporal rasters (~1 GB, see tools/sample-heights.py), sampled per footprint
.venv/bin/python tools/sample-heights.py      # needs numpy, tifffile, imagecodecs, zarr
node --max-old-space-size=8192 tools/build-buildings.mjs
node --max-old-space-size=8192 tools/build-trees.mjs
node --test tests/
```

Building heights are **measured** for almost every building: sampled from Google's Open Buildings 2.5D Temporal model
(2023, ~4 m resolution, so small houses and slender towers are approximate). The few it misses take an OpenStreetMap
height tag, or failing that an **estimate** by district and footprint size. Most street trees are **estimated** too (a tree every ~9 m along the
curbs), since OpenStreetMap maps few of them.

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL); building footprints
from [Google Open Buildings](https://sites.research.google/open-buildings/) v3 and heights from Open Buildings 2.5D
Temporal (both CC BY 4.0 / ODbL). Third-party data
and dependencies retain their respective licenses.
