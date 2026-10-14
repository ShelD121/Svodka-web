#!/usr/bin/env python3
"""Конфликты мира для вкладки «Мир» и общей карты: app/src/main/assets/conflicts.json.

Что внутри:
  conflicts  конфликты: название и регулярное выражение, по которому новость относится к конфликту;
  regions    куда переходить на карте и чьи цвета показывать в легенде;
  sides      стороны и их цвета;
  zones      зоны контроля: контуры [lon*1000, lat*1000, ...] и сторона.

Зоны собраны вручную на октябрь 2026 года: часть — из областей Natural Earth целиком,
часть нарисована по опорным точкам. Это приблизительная схема, а не карта фронта.

Запуск:  python3 tools/build_conflicts.py --ne DIR [--preview OUT.png]
  DIR — каталог с ne_10m_admin_0_countries.geojson и ne_10m_admin_1_states_provinces.geojson
"""
import argparse, json, math, os, sys

sys.path.insert(0, os.path.dirname(__file__))
from build_timeline import simplify, bbox

OUT = os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "assets", "conflicts.json")
AS_OF = "2026-10-14"

SVO_RE = (r"Украин|украинск|ВСУ|ЗСУ|ВС РФ|СВО|спецопераци|Донбасс|ДНР|ЛНР|Зеленск|Киев|Харьков|Запорож|Херсон|"
          r"Курск|Белгород|Брянск|Донецк|Луганск|Одесс|Днепр|Сумы|Сумск|Крым|Севастопол|Покровск|Купянск|"
          r"Константиновк|Мирноград|Волчанск|Гуляйпол|Генштаб ВСУ|Сырск|Умеров|Буданов|Уиткофф|"
          r"мирн[а-яё]* (план|переговор|соглашени)|прекращени[а-яё]* огня на Украин")

CONFLICTS = [
    {"id": "svo", "n": "СВО", "re": SVO_RE},
    {"id": "iran", "n": "Война с Ираном", "short": "Иран",
     "re": r"Иран|иранск|Тегеран|КСИР|Ормуз|Хаменеи|Пезешкиан|Аракчи|Исфахан|Натанз|Бушер|Бендер-Аббас"},
    {"id": "gaza", "n": "Израиль и Газа", "short": "Газа",
     "re": r"Газ[аеуы](?![а-яё])|ХАМАС|Хамас|Нетаньяху|ЦАХАЛ|палестин|Палестин|Рафах|Хан-Юнис|Западн[а-яё]+ берег|Израил|израильск"},
    {"id": "lebanon", "n": "Ливан", "short": "Ливан",
     "re": r"Ливан|ливанск|Хезболл|Бейрут|Литани|Набати"},
    {"id": "yemen", "n": "Йемен и Красное море", "short": "Йемен",
     "re": r"Йемен|йеменск|хусит|Хусит|Ходейд|Красн[а-яё]+ мор|Баб-эль-Мандеб|Ансар Алла"},
    {"id": "syria", "n": "Сирия", "short": "Сирия",
     "re": r"Сири[яиюей]|сирийск|Дамаск|Шараа|Алеппо|Идлиб|Сувейд|Латаки"},
    {"id": "sudan", "n": "Судан", "short": "Судан",
     "re": r"Судан|суданск|Хартум|Дарфур|Кордофан|Фашер|Обейд|Силы быстрого реагирования|(?<![А-Яа-яЁё])СБР(?![А-Яа-яЁё])|Бурхан|Дагало|Хемедти"},
    {"id": "congo", "n": "Восток ДР Конго", "short": "Конго",
     "re": r"Конго|(?<![А-Яа-яЁё])ДРК(?![А-Яа-яЁё])|M23|М23|Гома|Букаву|Увир|Киву"},
    {"id": "myanmar", "n": "Мьянма", "short": "Мьянма",
     "re": r"Мьянм|мьянманск|Араканск|Рахайн|Ракхайн|Нейпьидо|Мин Аун Хлайн|Качин"},
]

SIDES = [
    {"k": "iran", "n": "Иран", "c": "#2F9E44"},
    {"k": "isr", "n": "Израиль и США", "c": "#3B82F6"},
    {"k": "hamas", "n": "Под контролем ХАМАС", "c": "#94D82D"},
    {"k": "hou", "n": "Хуситы", "c": "#E8590C"},
    {"k": "yemgov", "n": "Правительство Йемена и союзники", "c": "#4DABF7"},
    {"k": "saf", "n": "Армия Судана", "c": "#3B82F6"},
    {"k": "rsf", "n": "Силы быстрого реагирования", "c": "#F59F00"},
    {"k": "mixed", "n": "Спорные районы и другие силы", "c": "#ADB5BD"},
    {"k": "m23", "n": "M23 / AFC", "c": "#E03131"},
    {"k": "junta", "n": "Военное правительство", "c": "#5C7CFA"},
    {"k": "rebels", "n": "Повстанцы и сопротивление", "c": "#E8590C"},
]

REGIONS = [
    {"id": "ua", "n": "Украина", "lat": 48.4, "lon": 35.8, "z": 6.6, "sides": []},
    {"id": "me", "n": "Ближний Восток", "lat": 30.5, "lon": 45.0, "z": 4.7, "sides": ["iran", "isr", "hamas", "hou", "yemgov"]},
    {"id": "levant", "n": "Газа и Ливан", "lat": 32.4, "lon": 35.3, "z": 8.0, "sides": ["isr", "hamas"]},
    {"id": "yemen", "n": "Йемен", "lat": 15.6, "lon": 46.5, "z": 6.0, "sides": ["hou", "yemgov"]},
    {"id": "sudan", "n": "Судан", "lat": 14.5, "lon": 30.0, "z": 5.4, "sides": ["saf", "rsf", "mixed"]},
    {"id": "congo", "n": "Конго", "lat": -1.9, "lon": 29.0, "z": 8.0, "sides": ["m23"]},
    {"id": "myanmar", "n": "Мьянма", "lat": 20.5, "lon": 96.2, "z": 5.4, "sides": ["junta", "rebels", "mixed"]},
]


def ll(*values):
    """(lat, lon, lat, lon, ...) → [[lon, lat], ...]"""
    return [[values[i + 1], values[i]] for i in range(0, len(values), 2)]


# Сектор Газа: контур и восточная часть, которую контролирует Израиль (около 60%, «жёлтая линия»)
GAZA = ll(31.596, 34.490, 31.585, 34.535, 31.555, 34.567, 31.520, 34.540, 31.470, 34.495, 31.400, 34.405,
          31.330, 34.370, 31.250, 34.310, 31.225, 34.283, 31.320, 34.218, 31.400, 34.300, 31.470, 34.370,
          31.530, 34.430)
GAZA_ISR = ll(31.596, 34.490, 31.585, 34.535, 31.555, 34.567, 31.520, 34.540, 31.470, 34.495, 31.400, 34.405,
              31.330, 34.370, 31.250, 34.310, 31.225, 34.283, 31.320, 34.218, 31.310, 34.240, 31.350, 34.330,
              31.400, 34.370, 31.450, 34.420, 31.500, 34.465, 31.550, 34.480, 31.585, 34.495)
# Юг Ливана: полоса вдоль границы, которую занимает армия Израиля (около 600 км²)
LEBANON_ISR = ll(33.085, 35.105, 33.170, 35.180, 33.215, 35.300, 33.240, 35.450, 33.330, 35.530, 33.360, 35.620,
                 33.330, 35.720, 33.280, 35.600, 33.100, 35.470, 33.070, 35.300)
# Восток ДР Конго: районы под контролем M23 вокруг Гомы и Букаву
M23 = ll(-0.65, 29.12, -0.70, 29.55, -1.10, 29.62, -1.38, 29.60, -1.60, 29.40, -1.70, 29.27, -2.10, 29.25,
         -2.40, 29.00, -2.50, 28.90, -2.75, 29.00, -3.00, 29.13, -3.05, 28.95, -2.80, 28.70, -2.30, 28.55,
         -1.80, 28.50, -1.30, 28.60, -0.90, 28.85)

ADMIN0 = {"Iran": "iran", "Israel": "isr"}
ADMIN1 = {
    "Yemen": {
        "hou": ["Sana'a", "Amanat Al Asimah", "Sa`dah", "Amran", "Hajjah", "Al Hudaydah", "Dhamar", "Ibb",
                "Raymah", "Al Mahwit", "Al Bayda'", "Al Jawf"],
        "yemgov": ["Abyan", "Al Dali'", "Al Mahrah", "Hadramawt", "Lahij", "Ma'rib", "Shabwah", "Ta`izz", "`Adan"],
    },
    "Sudan": {
        "rsf": ["North Darfur", "Southern Darfur", "Western Darfur", "Central Darfur", "Eastern Darfur"],
        "mixed": ["South Kordufan"],
        "saf": ["North Kordufan", "Northern", "River Nile", "Red Sea", "Kassala", "Gedarif", "Khartoum", "Gezira",
                "Sennar", "White Nile", "Blue Nile"],
    },
    "Myanmar": {
        "rebels": ["Rakhine", "Chin"],
        "mixed": ["Kachin", "Shan", "Kayah", "Kayin", "Sagaing"],
        "junta": ["Ayeyarwady", "Bago", "Magway", "Mandalay", "Mon", "Tanintharyi", "Yangon"],
    },
}


def polygons(geometry):
    if not geometry:
        return []
    return [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]


def encode(ring, tol):
    r = simplify(ring, tol) if tol else ring
    flat = []
    for p in r:
        flat += [round(p[0] * 1000), round(p[1] * 1000)]
    return flat


def zones_from(features, name_of, wanted, tol, min_size):
    out = []
    for f in features:
        side = wanted.get(name_of(f["properties"]))
        if not side:
            continue
        for poly in polygons(f.get("geometry")):
            b = bbox(poly[0])
            if (b[2] - b[0]) * (b[3] - b[1]) < min_size:
                continue
            flat = encode(poly[0], tol)
            if len(flat) >= 8:
                out.append({"s": side, "r": flat})
    return out


def build(ne):
    admin0 = json.load(open(os.path.join(ne, "ne_10m_admin_0_countries.geojson"), encoding="utf-8"))
    admin1 = json.load(open(os.path.join(ne, "ne_10m_admin_1_states_provinces.geojson"), encoding="utf-8"))
    zones = []
    zones += zones_from(admin0["features"], lambda p: p.get("ADMIN"), ADMIN0, 0.02, 0.01)
    for country, sides in ADMIN1.items():
        wanted = {name: side for side, names in sides.items() for name in names}
        features = [f for f in admin1["features"] if f["properties"].get("admin") == country]
        found = {f["properties"].get("name") for f in features}
        missing = sorted(set(wanted) - found)
        if missing:
            raise SystemExit("%s: нет регионов %s" % (country, missing))
        zones += zones_from(features, lambda p: p.get("name"), wanted, 0.015, 0.002)
    # нарисованные вручную: порядок важен, позже — поверх
    zones.append({"s": "hamas", "r": encode(GAZA + [GAZA[0]], 0)})
    zones.append({"s": "isr", "r": encode(GAZA_ISR + [GAZA_ISR[0]], 0)})
    zones.append({"s": "isr", "r": encode(LEBANON_ISR + [LEBANON_ISR[0]], 0)})
    zones.append({"s": "m23", "r": encode(M23 + [M23[0]], 0)})
    data = {"asof": AS_OF, "conflicts": CONFLICTS, "regions": REGIONS, "sides": SIDES, "zones": zones}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("zones:", len(zones), "points:", sum(len(z["r"]) // 2 for z in zones), "bytes:", os.path.getsize(OUT))
    return data


def preview(data, path):
    from PIL import Image, ImageDraw
    colors = {s["k"]: s["c"] for s in data["sides"]}
    boxes = [(30, 10, 64, 42), (34.1, 31.1, 36.0, 33.6), (21, 8, 39, 23), (28.2, -3.3, 29.9, -0.4), (91, 9, 102, 29)]
    tiles = []
    for lon0, lat0, lon1, lat1 in boxes:
        my = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
        w = 420
        s = w / (lon1 - lon0)
        k = s * 180 / math.pi
        h = int((my(lat1) - my(lat0)) * k)
        img = Image.new("RGB", (w, h), "#10141c")
        d = ImageDraw.Draw(img)
        for z in data["zones"]:
            r = z["r"]
            pts = [((r[i] / 1000 - lon0) * s, (my(lat1) - my(r[i + 1] / 1000)) * k) for i in range(0, len(r), 2)]
            d.polygon(pts, fill=colors[z["s"]], outline="#000000")
        tiles.append(img)
    W = sum(t.width for t in tiles)
    H = max(t.height for t in tiles)
    out = Image.new("RGB", (W, H), "#000")
    x = 0
    for t in tiles:
        out.paste(t, (x, 0))
        x += t.width
    out.save(path)
    print("preview:", path, out.size)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ne", required=True)
    parser.add_argument("--preview")
    args = parser.parse_args()
    result = build(args.ne)
    if args.preview:
        preview(result, args.preview)
