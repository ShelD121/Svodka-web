#!/usr/bin/env python3
"""Сбор новостей и свежей линии фронта для сайта. Запускается на GitHub по расписанию.

Пишет web/data/news.json и web/data/front.json. Только стандартная библиотека Python.
Логика та же, что в Android-приложении: отбор по конфликтам, темы, привязка к месту.
"""
import concurrent.futures, datetime, email.utils, html, json, os, re, sys, urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(__file__))
from build_timeline import encode, geometry_polygons, is_controlled

ROOT = os.path.join(os.path.dirname(__file__), "..", "web", "data")
UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36"

# id, название, аватар, сторона, вид, адрес, общая лента (брать только сообщения по теме)
SOURCES = [
    ("mod", "Минобороны России", "МО", "ru", "tg", "mod_russia", False),
    ("tass", "ТАСС", "ТС", "ru", "rss", "https://tass.ru/rss/v2.xml", True),
    ("ria", "РИА Новости", "РИА", "ru", "rss", "https://ria.ru/export/rss2/archive/index.xml", True),
    ("interfax", "Интерфакс", "ИФ", "ru", "rss", "https://www.interfax.ru/rss.asp", True),
    ("gs", "Генштаб ВСУ", "ГШ", "ua", "tg", "GeneralStaffZSU", False),
    ("up", "Украинская правда", "УП", "ua", "rss", "https://www.pravda.com.ua/rus/rss/view_news/", True),
    ("bbc", "Русская служба Би-би-си", "BBC", "ind", "rss", "https://feeds.bbci.co.uk/russian/rss.xml", True),
    ("meduza", "Медуза", "М", "ind", "rss", "https://meduza.io/rss/all", True),
    ("dw", "DW на русском", "DW", "ind", "rss", "https://rss.dw.com/rdf/rss-ru-all", True),
    ("rybar", "Рыбарь", "Р", "tg", "tg", "rybar", False),
    ("deepstate", "DeepState", "DS", "tg", "tg", "DeepStateUA", False),
    ("wargonzo", "WarGonzo", "WG", "tg", "tg", "wargonzo", False),
]

NL = "(?<![а-яёА-ЯЁ])"
NR = "(?![а-яёА-ЯЁ])"
COMBAT = re.compile(
    "удар|обстрел|атак|штурм|" + NL + "бо[йияюеё]|боев|сбит|сбил|уничтож|беспилотник|БПЛА|дрон|ракет|ПВО|наступлени|"
    "продвину|освобо|занял|взят|потер|ранен|погиб|взрыв|артиллер|авиаудар|окружени|контрнаступ|позици|фронт|"
    "диверс|ликвидир|перехват|мин[аыу]" + NR + "|танк|снаряд", re.I)
POLITICS = re.compile(
    "переговор|санкци|заявил|заявля|президент|Путин|Зеленск|Трамп|Кремл|Песков|" + NL + "МИД" + NR + "|министр|"
    + NL + "ООН" + NR + "|НАТО|Евросоюз|" + NL + "ЕС" + NR + "|саммит|встреч|соглашени|перемири|мирн|выбор|закон|"
    "парламент|Госдум|Рад[аеуы]" + NR + "|посол|дипломат|резолюци|поставк|Белый дом|Конгресс|Нетаньяху|Хаменеи|"
    "Лавров|Рубио|Вэнс|меморандум|договор|премьер|канцлер|Макрон|Мерц|Стармер|Эрдоган|Си Цзиньпин|посредни|обмен пленн",
    re.I)


def topic(text):
    c = len(COMBAT.findall(text))
    p = len(POLITICS.findall(text))
    if c == 0 and p == 0:
        return "other"
    return "politics" if p > c else "combat"


class Conflicts:
    def __init__(self, data):
        self.list = [(c["id"], re.compile(c["re"])) for c in data["conflicts"]]

    def classify(self, text):
        best, count = None, 0
        for cid, rx in self.list:
            n = len(rx.findall(text))
            if n > count or (n == count and n > 0 and cid == "svo"):
                best, count = cid, n
        return best


class Gazetteer:
    L = "[а-яёіїєґ'’]"
    B = "(?<![А-Яа-яЁёІіЇїЄєҐґ'’«„\"-])"
    E = "(?![А-Яа-яЁёІіЇїЄєҐґ])"

    @staticmethod
    def stem(word):
        s = word.rstrip("аяоеьйыиії")
        return s if len(s) >= 4 else word

    def name_re(self, name):
        parts = [re.escape(self.stem(w)) + self.L + "{0,3}" for w in name.split(" ")]
        return self.B + r"\s+".join(parts) + self.E + r"(?!\s+(?:област|народн|республик))"

    def __init__(self, data):
        self.places = []
        for o in data["places"]:
            names = [o["n"]] + ([o["alt"]] if o.get("alt") else [])
            place = {"n": o["n"], "lat": o["lat"], "lon": o["lon"], "a": False}
            self.places.append((place, o["rank"], re.compile("|".join(self.name_re(n) for n in names))))
        self.directions = []
        for place, rank, _ in self.places:
            if " " in place["n"] or "-" in place["n"]:
                continue
            s = self.stem(place["n"])
            s = s[:-2] if s.endswith("ск") else (s[:-1] if s.endswith("к") else s)
            self.directions.append((dict(place, a=True), re.compile(self.B + re.escape(s) + self.L + "{0,1}сь?к" + self.L + r"{2,4}\s+напр")))
        self.regions = []
        for o in data["regions"]:
            w = o["n"].split(" ")
            if len(w) != 2:
                continue
            noun = "кра" if w[1] == "край" else "област"
            self.regions.append(({"n": o["n"], "lat": o["lat"], "lon": o["lon"], "a": True},
                                 re.compile(self.B + re.escape(w[0][:-2]) + self.L + r"{2,3}\s+" + noun)))
        for o in data.get("countries", []):
            self.regions.append(({"n": o["n"], "lat": o["lat"], "lon": o["lon"], "a": True}, re.compile(self.B + "(?:" + o["re"] + ")")))
        self.regions.append(({"n": "Крым", "lat": 45.3, "lon": 34.4, "a": True}, re.compile(self.B + "Крым" + self.L + "{0,2}" + self.E)))

    def locate(self, text):
        best, pos = None, 10 ** 9
        for place, rank, rx in self.places:
            m = rx.search(text)
            if not m:
                continue
            if best is None or rank > best[1] or (rank == best[1] and m.start() < pos):
                best, pos = (place, rank), m.start()
        if best:
            return best[0]
        for place, rx in self.directions:
            if rx.search(text):
                return place
        hits = [(rx.search(text).start(), place) for place, rx in self.regions if rx.search(text)]
        return min(hits, key=lambda h: h[0])[1] if hits else None


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def strip_tags(s):
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = "\n".join(line.strip() for line in s.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def local(tag):
    return tag.rsplit("}", 1)[-1]


def parse_date(value):
    if not value:
        return None
    value = value.strip()
    try:
        return email.utils.parsedate_to_datetime(value).astimezone(datetime.timezone.utc)
    except Exception:
        pass
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(datetime.timezone.utc)
    except Exception:
        return None


def parse_rss(xml):
    root = ET.fromstring(xml.encode("utf-8"))
    out = []
    for item in root.iter():
        if local(item.tag) != "item":
            continue
        fields = {}
        for child in item:
            fields.setdefault(local(child.tag), (child.text or "").strip())
        title = strip_tags(fields.get("title", ""))
        if not title:
            continue
        desc = strip_tags(fields.get("description", ""))
        text = title + "\n\n" + desc if desc and not desc.startswith(title) and len(desc) <= 500 else title
        link = fields.get("link", "") or item.get("{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about", "")
        out.append((link or title, text, parse_date(fields.get("pubDate") or fields.get("date")), link))
    return out


def parse_tg(page):
    out = []
    for block in re.split(r'(?=<div class="tgme_widget_message_wrap)', page)[1:]:
        post = re.search(r'data-post="([^"]+)"', block)
        body = re.search(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', block, re.S)
        if not post or not body:
            continue
        text = strip_tags(body.group(1))
        if not text:
            continue
        when = re.search(r'<time[^>]+datetime="([^"]+)"', block)
        out.append(("tg:" + post.group(1), text, parse_date(when.group(1)) if when else None, "https://t.me/" + post.group(1)))
    return out


def fetch(src):
    sid, name, ava, side, kind, address, general = src
    try:
        if kind == "rss":
            return sid, parse_rss(get(address)), None
        return sid, parse_tg(get("https://t.me/s/" + address)), None
    except Exception as e:
        return sid, [], str(e)[:200]


def build_news():
    conflicts = Conflicts(json.load(open(os.path.join(ROOT, "conflicts.json"), encoding="utf-8")))
    gaz = Gazetteer(json.load(open(os.path.join(ROOT, "gazetteer.json"), encoding="utf-8")))
    now = datetime.datetime.now(datetime.timezone.utc)
    items, status = [], {}
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        results = list(pool.map(fetch, SOURCES))
    by_id = {s[0]: s for s in SOURCES}
    for sid, raw, err in results:
        status[sid] = err
        general = by_id[sid][6]
        count = 0
        for key, text, when, url in raw:
            c = conflicts.classify(text)
            if c is None:
                if general:
                    continue
                c = "svo"
            place = gaz.locate(text)
            if place:
                in_svo = 43.0 <= place["lat"] <= 57.5 and 21.0 <= place["lon"] <= 48.0
                if (c == "svo") != in_svo:
                    place = None
            items.append({
                "id": sid + ":" + key if not key.startswith("tg:") else key,
                "s": sid, "x": text[:1500], "t": (when or now).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "u": url, "p": place, "c": c, "k": topic(text),
            })
            count += 1
        print("%-10s %3d %s" % (sid, count, err or ""), file=sys.stderr)
    seen, unique = set(), []
    for it in sorted(items, key=lambda i: i["t"], reverse=True):
        if it["id"] not in seen:
            seen.add(it["id"])
            unique.append(it)
    data = {
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": [{"id": s[0], "n": s[1], "a": s[2], "side": s[3], "kind": s[4], "addr": s[5]} for s in SOURCES],
        "status": status,
        "items": unique[:500],
    }
    json.dump(data, open(os.path.join(ROOT, "news.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("news:", len(unique), file=sys.stderr)


def build_front():
    try:
        data = json.loads(get("https://deepstatemap.live/api/history/last"))
    except Exception as e:
        print("front: source unavailable, keeping old file:", e, file=sys.stderr)
        return
    polygons = []
    for f in data["map"]["features"]:
        if is_controlled(f.get("properties")):
            polygons += geometry_polygons(f.get("geometry"))
    p = encode(polygons)
    if not p:
        print("front: no polygons, keeping old file", file=sys.stderr)
        return
    when = datetime.datetime.fromtimestamp(int(data["id"]), datetime.timezone.utc)
    json.dump({"d": when.strftime("%Y-%m-%d"), "p": p}, open(os.path.join(ROOT, "front.json"), "w", encoding="utf-8"),
              separators=(",", ":"))
    print("front:", when.date(), len(p), "polygons", file=sys.stderr)


if __name__ == "__main__":
    build_news()
    build_front()
