#!/usr/bin/env bash
# Downloads the upstream source data the texture/vector build steps consume.
# Everything lands in tools/cache/ which is not part of the app bundle.
set -u
cd "$(dirname "$0")/.."
CACHE=tools/cache
NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
EO=https://eoimages.gsfc.nasa.gov/images/imagerecords/73000

get() { # url dest
  [ -s "$2" ] && { echo "  cached  $(basename "$2")"; return; }
  curl -sSfL --retry 3 --max-time 900 -o "$2.part" "$1" && mv "$2.part" "$2" \
    && echo "  ok      $(basename "$2") $(du -h "$2" | cut -f1)" \
    || echo "  FAILED  $1"
}

echo "imagery"
get "$EO/73909/world.topo.bathy.200412.3x5400x2700.jpg" "$CACHE/blue-marble-5400.jpg"
get "$EO/73909/world.topo.bathy.200412.3x21600x10800.jpg" "$CACHE/blue-marble-21600.jpg"
get "$EO/73934/gebco_08_rev_elev_21600x10800.png"       "$CACHE/gebco-elev.png"

echo "natural earth 1:50m"
for f in coastline land lakes rivers_lake_centerlines admin_0_boundary_lines_land admin_0_countries populated_places_simple; do
  get "$NE/ne_50m_$f.geojson" "$CACHE/ne/ne_50m_$f.geojson" &
done
wait

echo "natural earth 1:10m"
for f in coastline land lakes rivers_lake_centerlines admin_0_boundary_lines_land populated_places_simple; do
  get "$NE/ne_10m_$f.geojson" "$CACHE/ne/ne_10m_$f.geojson" &
done
wait
echo "done"
