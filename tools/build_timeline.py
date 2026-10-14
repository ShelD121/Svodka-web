#!/usr/bin/env python3
"""Собирает кадры таймлапса линии фронта в app/src/main/assets/timeline.json.

Формат: {"source": "...", "frames": [{"d": "2024-07-08", "p": [[[lon*1000, lat*1000, ...], <дырки>...], ...]}]}
Каждый кадр — территория под контролем РФ в зоне боевых действий по данным DeepState.

Режимы:
  --mirror DIR   взять ежедневные файлы deepstatemap_data_YYYYMMDD.geojson из каталога
                 (зеркало github.com/werowe/deepstate-map-data, данные с июля 2024)
  --api          взять полную историю с deepstatemap.live (с февраля 2022).
                 Если сайт недоступен, существующий файл остаётся без изменений.
"""
import argparse, collections, datetime, glob, json, os, re, sys, time, urllib.request

STEP_DAYS = 10
OUT = os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "assets", "timeline.json")
API = "https://deepstatemap.live/api/history"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def simplify(pts, tol):
    """Дуглас — Пекер без рекурсии."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = pts[a][0], pts[a][1]
        dx, dy = pts[b][0] - ax, pts[b][1] - ay
        length = dx * dx + dy * dy
        worst, index = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i][0] - ax, pts[i][1] - ay
            if length == 0:
                d = px * px + py * py
            else:
                t = max(0.0, min(1.0, (px * dx + py * dy) / length))
                d = (px - t * dx) ** 2 + (py - t * dy) ** 2
            if d > worst:
                worst, index = d, i
        if worst > tol * tol:
            keep[index] = True
            stack.append((a, index))
            stack.append((index, b))
    return [p for p, k in zip(pts, keep) if k]


def bbox(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def in_war_zone(ring):
    """То же правило, что в приложении (FrontRepository.inWarZone)."""
    x0, y0, x1, y1 = bbox(ring)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2          # по центру: полигон может слегка выходить за рамку
    inside = 22.0 <= cx <= 40.5 and 44.0 <= cy <= 53.0
    transnistria = x0 >= 28.4 and x1 <= 30.3 and y0 >= 45.7 and y1 <= 48.3
    return inside and not transnistria


def encode(polygons):
    """polygons: список полигонов, каждый — список колец [[lon, lat], ...]."""
    out = []
    for rings in polygons:
        if not rings or not in_war_zone(rings[0]):
            continue
        enc = []
        for i, ring in enumerate(rings):
            x0, y0, x1, y1 = bbox(ring)
            if (x1 - x0) * (y1 - y0) < 0.0004:      # мельче ~2x2 км — не видно на карте
                if i == 0:
                    break
                continue
            r = simplify(ring, 0.004)
            if len(r) < 4:
                if i == 0:
                    break
                continue
            flat = []
            for p in r:
                flat += [round(p[0] * 1000), round(p[1] * 1000)]
            enc.append(flat)
        if enc:
            out.append(enc)
    return out


def geometry_polygons(geometry):
    if not geometry:
        return []
    if geometry.get("type") == "Polygon":
        return [geometry["coordinates"]]
    if geometry.get("type") == "MultiPolygon":
        return geometry["coordinates"]
    if geometry.get("type") == "GeometryCollection":
        out = []
        for part in geometry.get("geometries", []):
            out += geometry_polygons(part)
        return out
    return []


CONTROLLED_NAME = re.compile(r"окупован|occupied|ордло|cadr|крим|crimea", re.I)


def is_controlled(props):
    """Ранние снимки размечены иначе (ОРДЛО — чёрным), поэтому смотрим и на цвет, и на подпись."""
    name = (props or {}).get("name") or ""
    return is_reddish(feature_color(props)) or bool(CONTROLLED_NAME.search(name))


def feature_color(props):
    fill = (props or {}).get("fill") or ""
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", fill):
        m = re.search(r"poly-([0-9a-fA-F]{6})", (props or {}).get("styleUrl") or "")
        fill = "#" + m.group(1) if m else ""
    return fill.lower()


def is_reddish(color):
    if not color:
        return False
    r, g, b = int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)
    return r > g + 40 and r > b + 20


def from_mirror(directory):
    files = sorted(glob.glob(os.path.join(directory, "deepstatemap_data_*.geojson")))
    frames, last = [], None
    for path in files:
        day = datetime.datetime.strptime(os.path.basename(path)[18:26], "%Y%m%d").date()
        if last and (day - last).days < STEP_DAYS and path != files[-1]:
            continue
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        polygons = []
        for feature in data.get("features", []):
            polygons += geometry_polygons(feature.get("geometry"))
        p = encode(polygons)
        if p:
            frames.append({"d": day.isoformat(), "p": p})
            last = day
    return frames


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def from_api():
    ids = sorted(int(item["id"]) for item in get(API + "/public"))
    print("history entries:", len(ids), file=sys.stderr)
    day = datetime.date(2022, 2, 24)
    today = datetime.date.today()
    chosen = []
    while day <= today:
        target = time.mktime(day.timetuple())
        best = min(ids, key=lambda i: abs(i - target))
        if best not in chosen:
            chosen.append(best)
        day += datetime.timedelta(days=STEP_DAYS)
    if ids[-1] not in chosen:
        chosen.append(ids[-1])
    frames, colors = [], collections.Counter()
    for n, snapshot in enumerate(chosen):
        try:
            data = get("%s/%d/geojson" % (API, snapshot))
        except Exception as error:                      # один пропущенный кадр не критичен
            print("skip", snapshot, error, file=sys.stderr)
            continue
        polygons = []
        for feature in data.get("features", []):
            color = feature_color(feature.get("properties"))
            if n == len(chosen) - 1:
                colors[color] += 1
            if is_controlled(feature.get("properties")):
                polygons += geometry_polygons(feature.get("geometry"))
        p = encode(polygons)
        if p:
            frames.append({"d": datetime.date.fromtimestamp(snapshot).isoformat(), "p": p})
        time.sleep(0.25)
    print("colors in the latest snapshot:", dict(colors), file=sys.stderr)
    return frames


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mirror")
    parser.add_argument("--api", action="store_true")
    parser.add_argument("--out", default=OUT)
    args = parser.parse_args()
    if args.api:
        try:
            frames = from_api()
        except Exception as error:
            print("DeepState API is not reachable, keeping the bundled timeline:", error, file=sys.stderr)
            return
        if len(frames) < 30:
            print("too few frames from the API (%d), keeping the bundled timeline" % len(frames), file=sys.stderr)
            return
        source = "deepstatemap.live"
    elif args.mirror:
        frames = from_mirror(args.mirror)
        source = "github.com/werowe/deepstate-map-data"
    else:
        parser.error("нужен --mirror DIR или --api")
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"source": source, "frames": frames}, f, ensure_ascii=False, separators=(",", ":"))
    points = sum(len(r) // 2 for fr in frames for poly in fr["p"] for r in poly)
    print("frames: %d, %s .. %s, points: %d, bytes: %d" % (
        len(frames), frames[0]["d"], frames[-1]["d"], points, os.path.getsize(args.out)), file=sys.stderr)


if __name__ == "__main__":
    main()
