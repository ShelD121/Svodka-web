#!/usr/bin/env python3
"""Готовит подложки исторических границ для вкладки «Войны»: app/src/main/assets/wars/*.json.

Источники (скачиваются отдельно, в репозитории не хранятся):
  --basemaps DIR   geojson-файлы world_1800.geojson и world_1938.geojson из
                   github.com/aourednik/historical-basemaps (лицензия GPL-3.0)
  --admin1 FILE    ne_10m_admin_1_states_provinces.geojson из Natural Earth (общественное достояние)

Формат: {"regions": [{"n": "USSR", "r": [[lon*1000, lat*1000, ...], ...]}]} — только внешние контуры.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from build_timeline import simplify, bbox

OUT = os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "assets", "wars")
EUROPE = (-12.0, 30.0, 52.0, 72.0)


def polygons(geometry):
    if not geometry:
        return []
    return [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]


def overlaps(b, box):
    return not (b[2] < box[0] or b[0] > box[2] or b[3] < box[1] or b[1] > box[3])


def build(features, name_of, keep_box, fine_box, fine, coarse, out_name, rename=None):
    regions = {}
    for feature in features:
        name = name_of(feature["properties"])
        if not name or name == "None":
            continue
        for poly in polygons(feature.get("geometry")):
            ring = poly[0]
            b = bbox(ring)
            if keep_box and not overlaps(b, keep_box):
                continue
            detailed = overlaps(b, fine_box)
            size = (b[2] - b[0]) * (b[3] - b[1])
            if size < (0.01 if detailed else 0.6):
                continue
            r = simplify(ring, fine if detailed else coarse)
            if len(r) < 4:
                continue
            flat = []
            for p in r:
                flat += [round(p[0] * 1000), round(max(-85.0, min(85.0, p[1])) * 1000)]
            target = rename(name.strip(), b) if rename else name.strip()
            regions.setdefault(target, []).append(flat)
    data = {"regions": [{"n": n, "r": rings} for n, rings in sorted(regions.items())]}
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, out_name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    points = sum(len(r) // 2 for rings in regions.values() for r in rings)
    print(out_name, "regions:", len(regions), "points:", points, "bytes:", os.path.getsize(path))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--basemaps", required=True)
    parser.add_argument("--admin1", required=True)
    args = parser.parse_args()

    world = json.load(open(os.path.join(args.basemaps, "world_1938.geojson"), encoding="utf-8"))
    # Гренландия и Исландия в исходнике записаны как часть Дании, а их судьба в войну была другой
    split = lambda name, b: "Greenland and Iceland" if name == "Denmark" and b[2] < -5 else name
    build(world["features"], lambda p: p.get("NAME"), None, EUROPE, 0.035, 0.15, "base_1938.json", split)

    old = json.load(open(os.path.join(args.basemaps, "world_1800.geojson"), encoding="utf-8"))
    build(old["features"], lambda p: p.get("NAME"), (-12.0, 34.0, 62.0, 72.0), EUROPE, 0.035, 0.1, "base_1800.json")

    admin = json.load(open(args.admin1, encoding="utf-8"))
    caucasus = [f for f in admin["features"] if f["properties"].get("admin") in ("Russia", "Georgia", "Azerbaijan")]
    box = (41.0, 41.0, 49.5, 46.5)
    build(caucasus, lambda p: p.get("name"), box, box, 0.006, 0.006, "base_caucasus.json")


if __name__ == "__main__":
    main()
