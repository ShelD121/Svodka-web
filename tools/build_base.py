#!/usr/bin/env python3
"""Подложка карты для сайта: web/data/base.json. Запускается вручную, результат хранится в репозитории.

  --ne DIR  каталог с файлами Natural Earth 10m: admin_0_countries, admin_1_states_provinces,
            populated_places, rivers_lake_centerlines

Формат: countries — контуры стран (мир, упрощённо); admin1 — области в районе СВО, подробно;
rivers — крупные реки района СВО; cities — подписи [имя, lon, lat, ранг] (ранг 0 — самые крупные).
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from build_timeline import simplify, bbox

OUT = os.path.join(os.path.dirname(__file__), "..", "web", "data", "base.json")
DETAIL = (20.0, 41.0, 50.0, 57.5)


def polys(g):
    if not g:
        return []
    return [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]


def enc(ring, tol):
    r = simplify(ring, tol)
    out = []
    for p in r:
        out += [round(p[0] * 1000), round(max(-85, min(85, p[1])) * 1000)]
    return out


def inside(b, box):
    return not (b[2] < box[0] or b[0] > box[2] or b[3] < box[1] or b[1] > box[3])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ne", required=True)
    a = ap.parse_args()
    load = lambda n: json.load(open(os.path.join(a.ne, n), encoding="utf-8"))

    countries = []
    for f in load("ne_10m_admin_0_countries.geojson")["features"]:
        for p in polys(f["geometry"]):
            b = bbox(p[0])
            area = (b[2] - b[0]) * (b[3] - b[1])
            fine = inside(b, DETAIL)
            if area < (0.002 if fine else 0.15):
                continue
            r = enc(p[0], 0.01 if fine else 0.06)
            if len(r) >= 8:
                countries.append(r)

    admin1 = []
    for f in load("ne_10m_admin_1_states_provinces.geojson")["features"]:
        if f["properties"].get("admin") not in ("Ukraine", "Russia", "Belarus", "Moldova"):
            continue
        for p in polys(f["geometry"]):
            b = bbox(p[0])
            if not inside(b, DETAIL) or (b[2] - b[0]) * (b[3] - b[1]) < 0.002:
                continue
            r = enc(p[0], 0.01)
            if len(r) >= 8:
                admin1.append(r)

    rivers = []
    for f in load("ne_10m_rivers_lake_centerlines.geojson")["features"]:
        g = f["geometry"]
        if not g or (f["properties"].get("scalerank") or 9) > 5:
            continue
        lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for l in lines:
            if len(l) > 1 and inside(bbox(l), (-20.0, -10.0, 110.0, 60.0)):
                r = enc(l, 0.02)
                if len(r) >= 4:
                    rivers.append(r)

    cities = []
    seen = set()
    for f in load("ne_10m_populated_places.geojson")["features"]:
        p = f["properties"]
        name = p.get("NAME_RU") or p.get("NAME")
        rank = p.get("SCALERANK", 10)
        x, y = f["geometry"]["coordinates"][:2]
        detail = DETAIL[0] < x < DETAIL[2] and DETAIL[1] < y < DETAIL[3]
        if not name or (rank > 3 and not detail) or (rank > 8):
            continue
        key = (name, round(x), round(y))
        if key in seen:
            continue
        seen.add(key)
        cities.append([name, round(x, 3), round(y, 3), rank])
    gz = json.load(open(os.path.join(os.path.dirname(__file__), "..", "web", "data", "gazetteer.json"), encoding="utf-8"))
    have = {c[0] for c in cities}
    for p in gz["places"]:
        if p["n"] not in have:
            cities.append([p["n"], p["lon"], p["lat"], 9 if p["rank"] == 9 else 10])
    cities.sort(key=lambda c: c[3])

    data = {"countries": countries, "admin1": admin1, "rivers": rivers, "cities": cities}
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    pts = lambda L: sum(len(r) // 2 for r in L)
    print("countries", len(countries), pts(countries), "admin1", len(admin1), pts(admin1), "rivers", len(rivers),
          "cities", len(cities), "bytes", os.path.getsize(OUT))


if __name__ == "__main__":
    main()
