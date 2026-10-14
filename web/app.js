'use strict';
/* Сводка — веб-версия. Без библиотек: карта рисуется на canvas по своим векторным данным. */

// ───────────────────────── утилиты ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const store = {
  get(k, d) { try { const v = localStorage.getItem('svodka.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('svodka.' + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
};
const my = lat => Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, lat)) * Math.PI / 360)) * 180 / Math.PI;
const getJSON = (url, opts) => fetch(url, opts).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
const DAY_MS = 86400000;
const toDay = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / DAY_MS);
const fmtDate = d => new Date(d * DAY_MS).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtShort = d => new Date(d * DAY_MS).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
function fmtTime(date) {
  const now = new Date();
  const same = date.toDateString() === now.toDateString();
  const t = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return same ? t : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ' · ' + t;
}
function ago(date) {
  const m = Math.round((Date.now() - date) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return m + ' мин назад';
  const hh = Math.round(m / 60);
  return hh < 24 ? hh + ' ч назад' : fmtTime(date);
}
const km2 = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)).toLocaleString('ru-RU') + ' км²';

// ───────────────────────── геометрия ─────────────────────────
/** Плоский массив [lon*1000, lat*1000, ...] → {a: [X, Y, ...] в проекции, b: рамка}. */
function prep(flat, scale = 1000) {
  const a = new Float32Array(flat.length);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i] / scale, y = my(flat[i + 1] / scale);
    a[i] = x; a[i + 1] = y;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { a, b: [x0, y0, x1, y1] };
}
function ringArea(flat) {
  const R = 6371.0088; let s = 0;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const x1 = flat[i] / 1000, y1 = flat[i + 1] / 1000, x2 = flat[i + 2] / 1000, y2 = flat[i + 3] / 1000;
    s += (x2 - x1) * Math.PI / 180 * (2 + Math.sin(y1 * Math.PI / 180) + Math.sin(y2 * Math.PI / 180));
  }
  return Math.abs(s * R * R / 2);
}
/** Кадр линии фронта: полигоны → кольца для отрисовки и площадь. */
function prepFront(polys) {
  const rings = []; let area = 0;
  for (const poly of polys) {
    poly.forEach((r, i) => { rings.push(prep(r)); area += i === 0 ? ringArea(r) : -ringArea(r); });
  }
  return { rings, area };
}

// ───────────────────────── движок карты ─────────────────────────
function viewBox(v, w, h) { return [v.cx - w / 2 / v.s, v.cy - h / 2 / v.s, v.cx + w / 2 / v.s, v.cy + h / 2 / v.s]; }
function visible(b, box) { return !(b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]); }
function trace(ctx, rings, v, w, h, close = true) {
  const box = viewBox(v, w, h);
  for (const r of rings) {
    if (!visible(r.b, box)) continue;
    const a = r.a;
    for (let i = 0; i < a.length; i += 2) {
      const x = (a[i] - v.cx) * v.s + w / 2, y = (v.cy - a[i + 1]) * v.s + h / 2;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    if (close) ctx.closePath();
  }
}
function pathOf(rings, v, w, h, close = true) {
  const p = new Path2D(); trace(p, rings, v, w, h, close); return p;
}
const scratch = { c: null };
function layerCanvas(w, h, dpr) {
  if (!scratch.c) scratch.c = document.createElement('canvas');
  const c = scratch.c;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, w, h);
  return x;
}

class MapView {
  constructor(canvas, view, opts = {}) {
    this.c = canvas; this.v = { ...view }; this.opts = opts; this.render = () => {};
    this.minS = opts.minS ?? 2; this.maxS = opts.maxS ?? 6000; this.raf = 0;
    if (opts.interactive !== false) this.bind();
  }
  size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = this.c.clientWidth, h = this.c.clientHeight;
    if (this.c.width !== Math.round(w * dpr) || this.c.height !== Math.round(h * dpr)) { this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr); }
    return { w, h, dpr };
  }
  draw() {
    const { w, h, dpr } = this.size(); if (!w || !h) return;
    const ctx = this.c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render(ctx, this.v, w, h, dpr);
  }
  request() { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.draw()); }
  screen(lon, lat) { const w = this.c.clientWidth, h = this.c.clientHeight; return [(lon - this.v.cx) * this.v.s + w / 2, (this.v.cy - my(lat)) * this.v.s + h / 2]; }
  clamp() { this.v.cy = Math.max(my(-75), Math.min(my(82), this.v.cy)); this.v.cx = Math.max(-180, Math.min(180, this.v.cx)); }
  zoomAt(f, px, py) {
    const w = this.c.clientWidth, h = this.c.clientHeight, v = this.v;
    const ns = Math.max(this.minS, Math.min(this.maxS, v.s * f));
    const gx = v.cx + (px - w / 2) / v.s, gy = v.cy - (py - h / 2) / v.s;
    v.s = ns; v.cx = gx - (px - w / 2) / ns; v.cy = gy + (py - h / 2) / ns; this.clamp(); this.request();
  }
  go(lon, lat, s, offsetY = 0) { this.v.cx = lon; this.v.s = s; this.v.cy = my(lat) - offsetY / s; this.clamp(); this.request(); }
  bind() {
    const c = this.c, ptrs = new Map(); let moved = 0, pinch = 0;
    c.addEventListener('wheel', e => { e.preventDefault(); const r = c.getBoundingClientRect(); this.zoomAt(Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ptrs.size === 1) moved = 0; pinch = 0; });
    c.addEventListener('pointermove', e => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 1) { moved += Math.abs(dx) + Math.abs(dy); this.v.cx -= dx / this.v.s; this.v.cy += dy / this.v.s; this.clamp(); this.request(); }
      else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), r = c.getBoundingClientRect(); moved = 99;
        if (pinch) this.zoomAt(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); pinch = d;
      }
    });
    const up = e => {
      if (!ptrs.has(e.pointerId)) return; ptrs.delete(e.pointerId); pinch = 0;
      if (e.type === 'pointerup' && moved < 8 && this.opts.onTap) { const r = c.getBoundingClientRect(); this.opts.onTap(e.clientX - r.left, e.clientY - r.top); }
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  }
}
function zoomButtons(map) {
  const z = document.createElement('div'); z.className = 'zoom';
  z.innerHTML = '<button aria-label="Приблизить">+</button><button aria-label="Отдалить">−</button>';
  const [a, b] = z.children;
  a.onclick = () => map.zoomAt(1.7, map.c.clientWidth / 2, map.c.clientHeight / 2);
  b.onclick = () => map.zoomAt(1 / 1.7, map.c.clientWidth / 2, map.c.clientHeight / 2);
  return z;
}

// ───────────────────────── данные ─────────────────────────
const D = {
  base: null, conflicts: null, gaz: null, news: null, front: null, timeline: null, wars: null,
  sources: [], items: [], customItems: [], status: {}, generated: null, sample: false,
};
const S = {
  tab: store.get('tab', 'feed'),
  filter: store.get('filter', { side: null, place: false, cats: ['combat', 'politics', 'other'] }),
  wfilter: store.get('wfilter', { conflict: null, cats: ['combat', 'politics', 'other'] }),
  disabled: new Set(store.get('disabled', [])),
  custom: store.get('custom', []),
  warnCustom: store.get('warnCustom', true),
  installHidden: store.get('installHidden', false),
  region: 'ua', mapMode: 'now', period: 91, selected: null,
};
const SIDES = { ru: 'Официально РФ', ua: 'Официально Украина', ind: 'Независимые', tg: 'Telegram', custom: 'Мои источники' };
const SIDE_SHORT = { ru: 'РФ', ua: 'Украина', ind: 'Независимые', tg: 'Telegram', custom: 'Мои' };
const CATS = { combat: 'Бои', politics: 'Политика', other: 'Другое' };

function prepBase(b) {
  return {
    countries: b.countries.map(r => prep(r)),
    admin1: b.admin1.map(r => prep(r)),
    rivers: b.rivers.map(r => prep(r)),
    cities: b.cities.map(([n, x, y, k]) => ({ n, x, y: my(y), k })),
  };
}
function prepConflicts(c) {
  const sides = Object.fromEntries(c.sides.map(s => [s.k, s]));
  return {
    asof: c.asof, regions: c.regions, sides,
    list: c.conflicts.map(x => ({ id: x.id, n: x.n, short: x.short || x.n, re: new RegExp(x.re, 'g') })),
    zones: c.zones.map(z => ({ color: sides[z.s].c, ring: prep(z.r) })),
  };
}
function classify(text) {
  let best = null, n = 0;
  for (const c of D.conflicts.list) {
    const k = (text.match(c.re) || []).length;
    if (k > n || (k === n && k > 0 && c.id === 'svo')) { best = c.id; n = k; }
  }
  return best;
}
const NL = '(?<![а-яёА-ЯЁ])', NR = '(?![а-яёА-ЯЁ])';
const COMBAT = new RegExp('удар|обстрел|атак|штурм|' + NL + 'бо[йияюеё]|боев|сбит|сбил|уничтож|беспилотник|БПЛА|дрон|ракет|ПВО|наступлени|продвину|освобо|занял|взят|потер|ранен|погиб|взрыв|артиллер|авиаудар|окружени|контрнаступ|позици|фронт|диверс|ликвидир|перехват|мин[аыу]' + NR + '|танк|снаряд', 'gi');
const POLITICS = new RegExp('переговор|санкци|заявил|заявля|президент|Путин|Зеленск|Трамп|Кремл|Песков|' + NL + 'МИД' + NR + '|министр|' + NL + 'ООН' + NR + '|НАТО|Евросоюз|' + NL + 'ЕС' + NR + '|саммит|встреч|соглашени|перемири|мирн|выбор|закон|парламент|Госдум|Рад[аеуы]' + NR + '|посол|дипломат|резолюци|поставк|Белый дом|Конгресс|Нетаньяху|Хаменеи|Лавров|Рубио|Вэнс|меморандум|договор|премьер|канцлер|Макрон|Мерц|Стармер|Эрдоган|Си Цзиньпин|посредни|обмен пленн', 'gi');
function topic(text) {
  const c = (text.match(COMBAT) || []).length, p = (text.match(POLITICS) || []).length;
  return c === 0 && p === 0 ? 'other' : p > c ? 'politics' : 'combat';
}
/** Привязка текста к месту — та же логика, что на сервере и в Android-приложении. */
function makeGazetteer(g) {
  const L = "[а-яёіїєґ'’]", B = "(?<![А-Яа-яЁёІіЇїЄєҐґ'’«„\"-])", E = '(?![А-Яа-яЁёІіЇїЄєҐґ])';
  const stem = w => { const s = w.replace(/[аяоеьйыиії]+$/, ''); return s.length >= 4 ? s : w; };
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = n => B + n.split(' ').map(w => reEsc(stem(w)) + L + '{0,3}').join('\\s+') + E + '(?!\\s+(?:област|народн|республик))';
  const places = g.places.map(o => ({ p: { n: o.n, lat: o.lat, lon: o.lon, a: false }, rank: o.rank, re: new RegExp([o.n].concat(o.alt ? [o.alt] : []).map(nameRe).join('|')) }));
  const dirs = places.filter(x => !/[ -]/.test(x.p.n)).map(x => {
    let s = stem(x.p.n); s = s.endsWith('ск') ? s.slice(0, -2) : s.endsWith('к') ? s.slice(0, -1) : s;
    return { p: { ...x.p, a: true }, re: new RegExp(B + reEsc(s) + L + '{0,1}сь?к' + L + '{2,4}\\s+напр') };
  });
  const regions = g.regions.filter(o => o.n.split(' ').length === 2).map(o => {
    const [adj, noun] = o.n.split(' ');
    return { p: { n: o.n, lat: o.lat, lon: o.lon, a: true }, re: new RegExp(B + reEsc(adj.slice(0, -2)) + L + '{2,3}\\s+' + (noun === 'край' ? 'кра' : 'област')) };
  }).concat((g.countries || []).map(o => ({ p: { n: o.n, lat: o.lat, lon: o.lon, a: true }, re: new RegExp(B + '(?:' + o.re + ')') })));
  return text => {
    let best = null, pos = 1e9;
    for (const x of places) {
      const m = x.re.exec(text); if (!m) continue;
      if (!best || x.rank > best.rank || (x.rank === best.rank && m.index < pos)) { best = x; pos = m.index; }
    }
    if (best) return best.p;
    for (const x of dirs) if (x.re.test(text)) return x.p;
    let hit = null, hp = 1e9;
    for (const x of regions) { const m = x.re.exec(text); if (m && m.index < hp) { hit = x.p; hp = m.index; } }
    return hit;
  };
}

function allSources() {
  return D.sources.concat(S.custom.map(c => ({ ...c, side: 'custom', custom: true })));
}
function rebuildItems() {
  const byId = Object.fromEntries(allSources().map(s => [s.id, s]));
  const items = (D.news?.items || []).concat(D.customItems)
    .filter(i => byId[i.s] && !S.disabled.has(i.s))
    .map(i => ({ ...i, src: byId[i.s], date: new Date(i.t) }));
  const seen = new Set();
  D.items = items.sort((a, b) => b.date - a.date).filter(i => !seen.has(i.id) && seen.add(i.id));
}
const feedItems = () => D.items.filter(i => (i.c === 'svo' || i.c == null) && (!S.filter.side || i.src.side === S.filter.side) && (!S.filter.place || i.p) && S.filter.cats.includes(i.k));
const worldItems = () => D.items.filter(i => i.c && i.c !== 'svo' && (!S.wfilter.conflict || i.c === S.wfilter.conflict) && S.wfilter.cats.includes(i.k));

async function loadNews() {
  try {
    const n = await getJSON('data/news.json?v=' + Date.now(), { cache: 'no-store' });
    D.news = n; D.sources = n.sources; D.status = { ...n.status }; D.generated = new Date(n.generated); D.sample = !!n.sample;
  } catch (e) { if (!D.news) D.loadError = 'Не удалось загрузить новости. Проверьте подключение.'; }
  try {
    const f = await getJSON('data/front.json?v=' + Date.now(), { cache: 'no-store' });
    D.front = { d: toDay(f.d), ...prepFront(f.p) };
  } catch (e) { /* останется прежний снимок */ }
  rebuildItems();
}

// ───────────────────────── свои источники (через публичный прокси) ─────────────────────────
const PROXIES = [u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u), u => 'https://corsproxy.io/?url=' + encodeURIComponent(u)];
async function fetchText(url) {
  let last;
  for (const p of PROXIES) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(p(url), { signal: ctrl.signal }); clearTimeout(t);
      if (r.ok) return await r.text();
      last = new Error('HTTP ' + r.status);
    } catch (e) { last = e; }
  }
  throw last || new Error('нет связи');
}
function textOf(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
  return clone.textContent.split('\n').map(s => s.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function makeItem(src, id, text, date, url) {
  let c = classify(text);
  let p = D.gaz(text);
  if (p && c) { const inSvo = p.lat >= 43 && p.lat <= 57.5 && p.lon >= 21 && p.lon <= 48; if ((c === 'svo') !== inSvo) p = null; }
  return { id, s: src.id, x: text.slice(0, 1500), t: (date && !isNaN(date) ? date : new Date()).toISOString(), u: url, p, c, k: topic(text) };
}
async function loadCustom(src) {
  const raw = await fetchText(src.kind === 'tg' ? 'https://t.me/s/' + src.addr : src.addr);
  const out = []; let title = null;
  if (src.kind === 'tg') {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    title = doc.querySelector('.tgme_channel_info_header_title')?.textContent.trim() || null;
    for (const m of doc.querySelectorAll('.tgme_widget_message[data-post]')) {
      const body = m.querySelector('.tgme_widget_message_text'); if (!body) continue;
      const text = textOf(body); if (!text) continue;
      const post = m.getAttribute('data-post');
      out.push(makeItem(src, 'tg:' + post, text, new Date(m.querySelector('time[datetime]')?.getAttribute('datetime')), 'https://t.me/' + post));
    }
    if (!out.length && !title) throw new Error('канал не найден или закрыт');
  } else {
    const doc = new DOMParser().parseFromString(raw, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('это не RSS-лента');
    for (const it of doc.getElementsByTagName('item')) {
      const get = n => { const e = Array.from(it.children).find(x => x.localName === n); return e ? e.textContent.trim() : ''; };
      const t = get('title'); if (!t) continue;
      const tmp = document.createElement('div'); tmp.innerHTML = get('description'); const desc = tmp.textContent.trim();
      const text = desc && !desc.startsWith(t) && desc.length <= 500 ? t + '\n\n' + desc : t;
      out.push(makeItem(src, src.id + ':' + (get('link') || t), text, new Date(get('pubDate') || get('date')), get('link')));
    }
  }
  return { items: out, title };
}
async function loadAllCustom() {
  if (!S.custom.length) { D.customItems = []; return; }
  await ensureGaz();
  const results = await Promise.all(S.custom.filter(s => !S.disabled.has(s.id)).map(s => loadCustom(s).then(r => ({ s, r })).catch(e => ({ s, e }))));
  D.customItems = [];
  for (const { s, r, e } of results) {
    if (e) { D.status[s.id] = e.message || 'ошибка'; continue; }
    D.status[s.id] = null; D.customItems.push(...r.items);
    if (r.title && r.title !== s.n) { s.n = r.title; store.set('custom', S.custom); }
  }
  rebuildItems();
}
async function ensureGaz() { if (!D.gaz) D.gaz = makeGazetteer(await getJSON('data/gazetteer.json')); }
function parseSource(input) {
  const text = input.trim();
  if (!text) return { error: 'Вставьте ссылку на канал или RSS.' };
  if (/t\.me\/(\+|joinchat)/i.test(text)) return { error: 'Это ссылка-приглашение в закрытый канал. Читать можно только открытые каналы.' };
  const tg = (text.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})/i) || text.match(/^@([A-Za-z0-9_]{4,})$/) || [])[1];
  const all = allSources();
  if (tg) {
    if (all.some(s => s.kind === 'tg' && s.addr.toLowerCase() === tg.toLowerCase())) return { error: 'Этот канал уже есть в списке.' };
    return { source: { id: 'u_tg_' + tg.toLowerCase(), n: '@' + tg, a: tg.slice(0, 2).toUpperCase(), kind: 'tg', addr: tg } };
  }
  try {
    const u = new URL(text); if (!/^https?:$/.test(u.protocol)) throw 0;
    if (all.some(s => s.addr === text)) return { error: 'Этот адрес уже есть в списке.' };
    const host = u.host.replace(/^www\./, '');
    return { source: { id: 'u_rss_' + Math.abs([...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)), n: host, a: host.slice(0, 2).toUpperCase(), kind: 'rss', addr: text } };
  } catch (e) {
    return { error: 'Не похоже на ссылку. Пример: t.me/rybar, @rybar или https://сайт/rss.' };
  }
}

// ───────────────────────── слои карты ─────────────────────────
function drawBase(ctx, v, w, h, base) {
  ctx.fillStyle = css('--sea'); ctx.fillRect(0, 0, w, h);
  if (!base) return;
  ctx.beginPath(); trace(ctx, base.countries, v, w, h);
  ctx.fillStyle = css('--land'); ctx.fill('evenodd');
  ctx.lineJoin = 'round';
  if (v.s > 14) { ctx.beginPath(); trace(ctx, base.admin1, v, w, h); ctx.strokeStyle = css('--admin'); ctx.lineWidth = 0.8; ctx.stroke(); }
  if (v.s > 7) { ctx.beginPath(); trace(ctx, base.rivers, v, w, h, false); ctx.strokeStyle = css('--river'); ctx.lineWidth = Math.min(2.5, Math.max(1, v.s / 60)); ctx.stroke(); }
  ctx.beginPath(); trace(ctx, base.countries, v, w, h); ctx.strokeStyle = css('--border'); ctx.lineWidth = 0.9; ctx.stroke();
}
function drawLabels(ctx, v, w, h, base) {
  if (!base) return;
  const maxK = v.s < 6 ? 1 : v.s < 14 ? 3 : v.s < 30 ? 5 : v.s < 60 ? 6 : v.s < 120 ? 8 : 10;
  const box = viewBox(v, w, h), boxes = [];
  ctx.font = '500 11.5px "Golos Text", system-ui, sans-serif'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3; ctx.strokeStyle = css('--halo'); ctx.fillStyle = css('--label');
  for (const c of base.cities) {
    if (c.k > maxK) break;
    if (c.x < box[0] || c.x > box[2] || c.y < box[1] || c.y > box[3]) continue;
    const x = (c.x - v.cx) * v.s + w / 2, y = (v.cy - c.y) * v.s + h / 2;
    const tw = ctx.measureText(c.n).width, b = [x - 4, y - 8, x + 8 + tw, y + 8];
    if (boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) continue;
    boxes.push(b);
    ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill();
    ctx.strokeText(c.n, x + 6, y); ctx.fillText(c.n, x + 6, y);
  }
}
function drawZones(ctx, v, w, h, dpr) {
  if (!D.conflicts) return;
  const box = viewBox(v, w, h), zs = D.conflicts.zones.filter(z => visible(z.ring.b, box));
  if (!zs.length) return;
  const x = layerCanvas(w, h, dpr);
  for (const z of zs) { x.beginPath(); trace(x, [z.ring], v, w, h); x.fillStyle = z.color; x.fill(); }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.45; ctx.drawImage(scratch.c, 0, 0); ctx.restore();
  ctx.lineWidth = 1.2;
  for (const z of zs) { ctx.beginPath(); trace(ctx, [z.ring], v, w, h); ctx.strokeStyle = z.color; ctx.stroke(); }
}
function drawFront(ctx, v, w, h, dpr, cur, old) {
  if (!cur) return;
  ctx.beginPath(); trace(ctx, cur.rings, v, w, h); ctx.fillStyle = css('--ctrl'); ctx.fill('evenodd');
  if (old) {
    for (const [a, b, color] of [[cur, old, css('--gain')], [old, cur, css('--lost')]]) {
      const x = layerCanvas(w, h, dpr);
      x.beginPath(); trace(x, a.rings, v, w, h); x.fillStyle = color; x.fill('evenodd');
      x.globalCompositeOperation = 'destination-out'; x.beginPath(); trace(x, b.rings, v, w, h); x.fillStyle = '#000'; x.fill('evenodd');
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.9; ctx.drawImage(scratch.c, 0, 0); ctx.restore();
    }
  }
  ctx.beginPath(); trace(ctx, cur.rings, v, w, h); ctx.strokeStyle = css('--ctrl-line'); ctx.lineWidth = 1.2; ctx.stroke();
}
function drawPin(ctx, x, y, sel, approx, count) {
  const r = sel ? 9 : 6.5;
  if (approx) { ctx.beginPath(); ctx.arc(x, y, r + 9, 0, 7); ctx.setLineDash([3, 3]); ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]); }
  ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 7); ctx.fillStyle = css('--halo'); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = sel ? css('--accent') : css('--fg'); ctx.fill();
  if (count > 1) { ctx.fillStyle = css('--bg'); ctx.font = '700 10px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(count, x, y + .5); ctx.textAlign = 'left'; }
}
const placeKey = p => p.lat.toFixed(2) + ',' + p.lon.toFixed(2);

/** Мини-карта в сообщении: статичная картинка. */
function renderMini(canvas, p) {
  const m = new MapView(canvas, { cx: p.lon, cy: my(p.lat), s: p.a ? 60 : 120 }, { interactive: false });
  m.render = (ctx, v, w, h, dpr) => {
    drawBase(ctx, v, w, h, D.base); drawZones(ctx, v, w, h, dpr); drawFront(ctx, v, w, h, dpr, D.front);
    drawLabels(ctx, v, w, h, D.base);
    drawPin(ctx, w / 2, h / 2, true, p.a, 1);
  };
  m.draw();
}
const miniObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    miniObserver.unobserve(e.target);
    const it = D.items.find(i => i.id === e.target.dataset.mini);
    if (it?.p) renderMini(e.target, it.p);
  }
}, { rootMargin: '200px' }) : null;

// ───────────────────────── лента ─────────────────────────
function postHTML(i, withMap, showConflict) {
  const p = i.p, conflict = showConflict ? D.conflicts?.list.find(c => c.id === i.c)?.short : null;
  const tags = [SIDES[i.src.side], conflict, i.c ? CATS[i.k] : null].filter(Boolean).join(' · ');
  return `<article class="post"><div class="ava s-${i.src.side}">${esc(i.src.a)}</div><div style="min-width:0">
    <div class="head"><span class="who">${esc(i.src.n)}</span><span class="time">${esc(fmtTime(i.date))}</span></div>
    <div class="tags s-${i.src.side}">${esc(tags)}</div>
    <p class="text clamp" data-expand>${esc(i.x)}</p>
    ${p && withMap ? `<button class="mapcard" data-go="${esc(i.id)}" aria-label="Показать на карте: ${esc(p.n)}"><canvas data-mini="${esc(i.id)}"></canvas><span class="place">${esc(p.n)}${p.a ? ' <small>≈ примерно</small>' : ''}</span></button>` : ''}
    <div class="foot">${i.u ? `<a href="${esc(i.u)}" target="_blank" rel="noopener">Источник ↗</a>` : ''}${!p ? '<span>без привязки к месту</span>' : ''}</div>
  </div></article>`;
}
function chip(label, on, attrs = '', dot = '') {
  return `<button class="chip" aria-pressed="${!!on}" ${attrs}>${dot ? `<i class="dot ${dot}"></i>` : ''}${esc(label)}</button>`;
}
function renderFeed(world) {
  const el = $(world ? '#s-world' : '#s-feed'), f = world ? S.wfilter : S.filter;
  const items = world ? worldItems() : feedItems();
  let row1;
  if (world) {
    row1 = chip('Все', !f.conflict, 'data-conflict=""') + (D.conflicts?.list.filter(c => c.id !== 'svo') || []).map(c => {
      const n = D.items.filter(i => i.c === c.id).length;
      return chip(n ? `${c.short} · ${n}` : c.short, f.conflict === c.id, `data-conflict="${c.id}"`);
    }).join('');
  } else {
    row1 = chip('Все', !f.side && !f.place, 'data-side=""') + Object.keys(SIDES).filter(s => s !== 'custom' || S.custom.length)
      .map(s => chip(SIDE_SHORT[s], f.side === s, `data-side="${s}"`, 's-' + s)).join('') + chip('С местом', f.place, 'data-place');
  }
  const row2 = '<span class="lbl">Темы:</span>' + Object.keys(CATS).map(k => chip(CATS[k], f.cats.includes(k), `data-cat="${k}"`)).join('');
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone && !S.installHidden;
  const stamp = D.generated ? (D.sample ? 'Пример данных: сборщик новостей ещё не запускался' : 'Новости собраны ' + ago(D.generated)) : '';
  let empty = 'По этому фильтру сообщений нет.';
  if (!D.news) empty = D.loadError || 'Загружаю новости…';
  else if (world) empty = 'Новостей по этому фильтру нет. Про другие конфликты пишут общие ленты: ТАСС, РИА, Интерфакс, Би-би-си, DW.';
  el.innerHTML = `
    <header class="top"><div class="brand">${world ? 'Мир' : 'Сводка<i>live</i>'}</div>
      <button class="chip" data-act="sources">Источники</button><button class="chip" data-act="refresh">Обновить</button></header>
    ${stamp ? `<div class="stamp">${esc(stamp)}</div>` : ''}
    ${isIOS && !world ? `<div class="banner"><div><b>Поставьте на экран «Домой».</b> В Safari нажмите «Поделиться» внизу экрана, затем «На экран „Домой“» — откроется как обычное приложение.</div><button data-act="hideinstall" aria-label="Скрыть">×</button></div>` : ''}
    <div class="chips">${row1}</div><div class="chips" style="padding-bottom:12px">${row2}</div>
    <div class="scroll">${items.length ? items.slice(0, 250).map(i => postHTML(i, true, world)).join('') : `<div class="empty">${esc(empty)}</div>`}</div>`;
  if (miniObserver) $$('canvas[data-mini]', el).forEach(c => miniObserver.observe(c));
  else $$('canvas[data-mini]', el).forEach(c => { const it = D.items.find(i => i.id === c.dataset.mini); if (it?.p) renderMini(c, it.p); });
}
function feedClick(e, world) {
  const t = e.target.closest('button, [data-expand]'); if (!t) return;
  const f = world ? S.wfilter : S.filter, save = () => { store.set(world ? 'wfilter' : 'filter', f); renderFeed(world); };
  if (t.dataset.act === 'sources') return go('sources');
  if (t.dataset.act === 'refresh') return refresh();
  if (t.dataset.act === 'hideinstall') { S.installHidden = true; store.set('installHidden', true); return renderFeed(world); }
  if (t.dataset.expand !== undefined) return t.classList.toggle('clamp');
  if (t.dataset.go) { const it = D.items.find(i => i.id === t.dataset.go); if (it) showOnMap(it.p); return; }
  if ('side' in t.dataset) { f.side = t.dataset.side ? (f.side === t.dataset.side ? null : t.dataset.side) : null; if (!t.dataset.side) f.place = false; return save(); }
  if ('place' in t.dataset) { f.place = !f.place; return save(); }
  if ('conflict' in t.dataset) { f.conflict = t.dataset.conflict && f.conflict !== t.dataset.conflict ? t.dataset.conflict : null; return save(); }
  if (t.dataset.cat) { const k = t.dataset.cat; f.cats = f.cats.includes(k) ? f.cats.filter(x => x !== k) : f.cats.concat(k); if (!f.cats.length) f.cats = [k]; return save(); }
}

// ───────────────────────── карта ─────────────────────────
let MAP = null;
const PERIODS = [[30, '1 мес'], [91, '3 мес'], [182, '6 мес'], [365, '12 мес']];
function nearestFrame(day) {
  const fr = D.timeline?.frames; if (!fr) return null;
  let best = fr[0]; for (const f of fr) if (Math.abs(f.d - day) < Math.abs(best.d - day)) best = f;
  return best;
}
function pins() {
  const m = new Map();
  for (const i of D.items) if (i.p) { const k = placeKey(i.p); const o = m.get(k) || { p: i.p, n: 0, k }; o.n++; m.set(k, o); }
  return [...m.values()];
}
function initMap() {
  const el = $('#s-map');
  el.innerHTML = `<div class="mapwrap"><canvas></canvas>
    <div class="mapui"><div class="seg" id="mmode"><button data-m="now" aria-pressed="true">Сейчас</button><button data-m="adv" aria-pressed="false">Продвижение</button></div>
      <div class="chips" id="mregions"></div><div id="madv"></div><div id="mlegend"></div></div>
    <div class="credit" id="mcredit"></div><div class="sheet" id="msheet" hidden></div></div>`;
  MAP = new MapView($('canvas', el), { cx: 35.8, cy: my(48.4), s: 70 }, { onTap: (x, y) => {
    let best = null, bd = 26;
    for (const p of pins()) { const [px, py] = MAP.screen(p.p.lon, p.p.lat); const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = p; } }
    selectPlace(best ? best.k : null);
  } });
  $('.mapwrap', el).append(zoomButtons(MAP));
  MAP.render = (ctx, v, w, h, dpr) => {
    drawBase(ctx, v, w, h, D.base);
    drawZones(ctx, v, w, h, dpr);
    const old = S.mapMode === 'adv' && D.front ? nearestFrame(D.front.d - S.period) : null;
    drawFront(ctx, v, w, h, dpr, D.front, old);
    drawLabels(ctx, v, w, h, D.base);
    const ps = pins().sort((a, b) => (a.k === S.selected) - (b.k === S.selected));
    for (const p of ps) { const [x, y] = MAP.screen(p.p.lon, p.p.lat); if (x > -20 && y > -20 && x < w + 20 && y < h + 20) drawPin(ctx, x, y, p.k === S.selected, p.p.a, p.n); }
  };
  el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.m) { S.mapMode = b.dataset.m; if (S.mapMode === 'adv') await ensureTimeline(); return renderMapUI(); }
    if (b.dataset.p) { S.period = +b.dataset.p; return renderMapUI(); }
    if (b.dataset.region) { const r = D.conflicts.regions.find(x => x.id === b.dataset.region); S.region = r.id; MAP.go(r.lon, r.lat, zToS(r.z)); return renderMapUI(); }
    if (b.dataset.close !== undefined) return selectPlace(null);
    if (b.closest('#msheet') && b.closest('[data-expand]')) return;
  });
  $('#msheet').addEventListener('click', e => { const t = e.target.closest('[data-expand]'); if (t) t.classList.toggle('clamp'); });
}
/** Масштаб из «зума» Android-версии (тайловый уровень) в пиксели на градус. */
const zToS = z => 256 * Math.pow(2, z) / 360;
function renderMapUI() {
  if (!MAP) return;
  $$('#mmode button').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === S.mapMode));
  $('#mregions').innerHTML = (D.conflicts?.regions || []).map(r => chip(r.n, r.id === S.region, `data-region="${r.id}"`)).join('');
  const adv = $('#madv');
  if (S.mapMode === 'adv' && D.front) {
    const old = nearestFrame(D.front.d - S.period);
    adv.innerHTML = `<div class="card"><div class="chips" style="padding:0">${PERIODS.map(([d, l]) => chip(l, S.period === d, `data-p="${d}"`)).join('')}</div>
      ${old ? `<div class="big">${km2(D.front.area - old.area)}</div><div class="small">${fmtShort(old.d)} → ${fmtShort(D.front.d)}, чистое изменение</div>` : '<div class="small">Загружаю историю…</div>'}
      <div class="legend"><span><i class="sw" style="background:var(--gain)"></i>перешло под контроль РФ</span><span><i class="sw" style="background:var(--lost)"></i>вышло из-под контроля РФ</span></div></div>`;
  } else adv.innerHTML = '';
  const r = D.conflicts?.regions.find(x => x.id === S.region);
  const sides = (r?.sides || []).map(k => D.conflicts.sides[k]).filter(Boolean);
  $('#mlegend').innerHTML = sides.length ? `<div class="card legend">${sides.map(s => `<span><i class="sw" style="background:${s.c};opacity:.75"></i>${esc(s.n)}</span>`).join('')}<span>Примерно, на ${esc(fmtShort(toDay(D.conflicts.asof)))}</span></div>` : '';
  $('#mcredit').textContent = 'Контроль территории: DeepState' + (D.front ? ', ' + fmtShort(D.front.d) : '') + '; в других странах — схема';
  MAP.request();
}
function selectPlace(key) {
  S.selected = key; const sh = $('#msheet');
  if (!key) { sh.hidden = true; MAP.request(); return; }
  const items = D.items.filter(i => i.p && placeKey(i.p) === key), p = items[0].p;
  sh.innerHTML = `<div class="sheethead"><span>${esc(p.n)}${p.a ? ' · ≈' : ''} · ${items.length}</span><button class="x" data-close aria-label="Закрыть">×</button></div>` + items.map(i => postHTML(i, false, true)).join('');
  sh.hidden = false; sh.scrollTop = 0; MAP.request();
}
function showOnMap(p) {
  go('map');
  const s = p.a ? 90 : 160;
  MAP.go(p.lon, p.lat, s, MAP.c.clientHeight * 0.18);
  selectPlace(placeKey(p));
}
async function ensureTimeline() {
  if (D.timeline) return;
  const t = await getJSON('data/timeline.json');
  D.timeline = { frames: t.frames.map(f => ({ d: toDay(f.d), ...prepFront(f.p) })) };
}

// ───────────────────────── таймлапс ─────────────────────────
const TL = { map: null, first: 0, last: 0, i: 0, playing: false, speed: 1, change: true, timer: 0 };
function tlFrames() {
  const fr = D.timeline.frames.slice();
  if (D.front && (!fr.length || D.front.d - fr[fr.length - 1].d >= 1)) fr.push(D.front);
  return fr;
}
async function initTimelapse() {
  const el = $('#s-timelapse');
  el.innerHTML = '<div class="mapwrap"><canvas></canvas><div class="panel"><div class="small">Загружаю кадры…</div></div></div>';
  TL.map = new MapView($('canvas', el), { cx: 35.8, cy: my(48.4), s: 70 });
  TL.map.go(35.8, 48.4, 70, TL.map.c.clientHeight * 0.2);
  await ensureTimeline();
  const fr = tlFrames(); TL.last = fr.length - 1; TL.first = 0; TL.i = 0;
  TL.map.render = (ctx, v, w, h, dpr) => {
    const f = tlFrames(), cur = f[TL.i], old = TL.change && TL.i !== TL.first ? f[TL.first] : null;
    drawBase(ctx, v, w, h, D.base); drawFront(ctx, v, w, h, dpr, cur, old); drawLabels(ctx, v, w, h, D.base);
  };
  const panel = $('.panel', el);
  panel.innerHTML = `
    <div class="row between"><span class="big" id="tdate"></span><span class="small" id="tdelta"></span></div>
    <input type="range" id="tcur" min="0" step="1" aria-label="Дата">
    <div class="row"><button class="chip primary" id="tplay">Пуск</button>${[0.5, 1, 2, 4, 8].map(s => chip(s < 1 ? '×0,5' : '×' + s, s === TL.speed, `data-speed="${s}"`)).join('')}</div>
    <div class="row between"><span class="small" id="trange"></span>${chip('Изменения', TL.change, 'id="tchange"')}</div>
    <div class="range2"><div class="track"></div><div class="fill" id="tfill"></div><input type="range" id="ta" min="0" step="1" aria-label="Начало периода"><input type="range" id="tb" min="0" step="1" aria-label="Конец периода"></div>
    <div class="small">Жёлтым — что перешло под контроль РФ с начала периода, зелёным — что вышло из-под него. Данные DeepState.</div>`;
  for (const id of ['tcur', 'ta', 'tb']) $('#' + id).max = TL.last;
  $('#ta').value = 0; $('#tb').value = TL.last;
  $('#tcur').oninput = e => { stopPlay(); TL.i = +e.target.value; tlUpdate(); };
  $('#ta').oninput = e => { let a = +e.target.value; if (a >= TL.last) a = TL.last - 1; TL.first = a; TL.last = Math.max(+$('#tb').value, a + 1); e.target.value = a; TL.i = Math.max(TL.i, a); tlUpdate(); };
  $('#tb').oninput = e => { let b = +e.target.value; if (b <= TL.first) b = TL.first + 1; TL.last = b; e.target.value = b; TL.i = Math.min(TL.i, b); tlUpdate(); };
  $('#tplay').onclick = () => { if (TL.playing) return stopPlay(); if (TL.i >= TL.last) TL.i = TL.first; TL.playing = true; tick(); tlUpdate(); };
  $('#tchange').onclick = () => { TL.change = !TL.change; tlUpdate(); };
  panel.addEventListener('click', e => { const b = e.target.closest('[data-speed]'); if (b) { TL.speed = +b.dataset.speed; $$('[data-speed]', panel).forEach(x => x.setAttribute('aria-pressed', x === b)); } });
  el.querySelector('.mapwrap').append(zoomButtons(TL.map));
  tlUpdate();
}
function tick() {
  clearTimeout(TL.timer);
  if (!TL.playing) return;
  TL.timer = setTimeout(() => { if (TL.i >= TL.last) { stopPlay(); return; } TL.i++; tlUpdate(); tick(); }, 280 / TL.speed);
}
function stopPlay() { TL.playing = false; clearTimeout(TL.timer); tlUpdate(); }
function tlUpdate() {
  const f = tlFrames(), cur = f[TL.i], first = f[TL.first], lastF = f[TL.last];
  $('#tdate').textContent = fmtShort(cur.d);
  $('#tdelta').textContent = km2(cur.area - first.area) + ' с ' + fmtShort(first.d);
  $('#trange').textContent = 'Период: ' + fmtShort(first.d) + ' — ' + fmtShort(lastF.d);
  const c = $('#tcur'); c.min = TL.first; c.max = TL.last; c.value = TL.i;
  $('#tplay').textContent = TL.playing ? 'Пауза' : 'Пуск';
  $('#tchange').setAttribute('aria-pressed', TL.change);
  const max = f.length - 1, fill = $('#tfill');
  fill.style.left = (TL.first / max * 100) + '%'; fill.style.width = ((TL.last - TL.first) / max * 100) + '%';
  TL.map.request();
}

// ───────────────────────── войны ─────────────────────────
const WAR = { war: null, model: null, map: null, day: 0, playing: false, speed: 1, raf: 0 };
const modelCache = {};
async function loadModel(name) {
  if (modelCache[name]) return modelCache[name];
  const m = await getJSON('data/wars/model_' + name + '.json');
  const base = await getJSON('data/wars/' + m.base + '.json');
  const SAMPLES = 96;
  const resample = flat => {
    const n = flat.length / 2, x = [], y = [], L = [0];
    for (let i = 0; i < n; i++) { y.push(flat[i * 2]); x.push(flat[i * 2 + 1]); }
    for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]));
    const total = L[n - 1] || 1, out = new Float32Array(SAMPLES * 2); let j = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const t = total * i / (SAMPLES - 1);
      while (j < n - 2 && L[j + 1] < t) j++;
      const u = Math.max(0, Math.min(1, (t - L[j]) / ((L[j + 1] - L[j]) || 1)));
      out[i * 2] = x[j] + (x[j + 1] - x[j]) * u; out[i * 2 + 1] = y[j] + (y[j + 1] - y[j]) * u;
    }
    return out;
  };
  const model = {
    sides: m.sides, colors: Object.fromEntries(m.sides.map(s => [s.k, s.c])),
    rules: Object.fromEntries(Object.entries(m.rules).map(([k, v]) => [k, v.map(([d, s]) => [toDay(d), s]).sort((a, b) => a[0] - b[0])])),
    fronts: m.fronts.map(f => ({ ...f, targets: new Set(f.targets), until: f.until ? toDay(f.until) : null, days: f.keys.map(k => toDay(k[0])), lines: f.keys.map(k => resample(k[1])) })),
    regions: base.regions.map(r => ({ n: r.n, rings: r.r.map(x => prep(x)) })),
  };
  return (modelCache[name] = model);
}
function sideOf(model, region, day) {
  let s = null; for (const [d, v] of model.rules[region] || []) { if (d <= day) s = v; else break; } return s;
}
function lineAt(f, day) {
  if (day < f.days[0] || (f.until != null && day >= f.until)) return null;
  let i = -1; for (let k = 0; k < f.days.length; k++) if (f.days[k] <= day) i = k;
  if (i >= f.days.length - 1) return f.lines[f.lines.length - 1];
  const t = Math.max(0, Math.min(1, (day - f.days[i]) / Math.max(1, f.days[i + 1] - f.days[i])));
  const a = f.lines[i], b = f.lines[i + 1], out = new Float32Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}
function halfPath(pts, kind, v, w, h) {
  const p = new Path2D(), F = 1e5, P = [];
  for (let i = 0; i < pts.length; i += 2) P.push([(pts[i] - v.cx) * v.s + w / 2, (v.cy - my(pts[i + 1])) * v.s + h / 2]);
  P.forEach(([x, y], i) => i ? p.lineTo(x, y) : p.moveTo(x, y));
  const [fx, fy] = P[0], [lx, ly] = P[P.length - 1];
  if (kind === 'W') { p.lineTo(lx, F); p.lineTo(-F, F); p.lineTo(-F, -F); p.lineTo(fx, -F); }
  else if (kind === 'E') { p.lineTo(lx, F); p.lineTo(F, F); p.lineTo(F, -F); p.lineTo(fx, -F); }
  else if (kind === 'S') { p.lineTo(F, ly); p.lineTo(F, F); p.lineTo(-F, F); p.lineTo(-F, fy); }
  else if (kind === 'N') { p.lineTo(F, ly); p.lineTo(F, -F); p.lineTo(-F, -F); p.lineTo(-F, fy); }
  p.closePath();
  const line = new Path2D(); P.forEach(([x, y], i) => i ? line.lineTo(x, y) : line.moveTo(x, y)); if (kind === 'POLY') line.closePath();
  return { half: p, line };
}
function drawWar(ctx, v, w, h, dpr) {
  const war = WAR.war, model = WAR.model;
  drawBase(ctx, v, w, h, D.base);
  if (!model) return;
  const day = toDay(war.start) + WAR.day, box = viewBox(v, w, h);
  const paths = {}, sides = {};
  for (const r of model.regions) {
    sides[r.n] = sideOf(model, r.n, Math.floor(day));
    if (r.rings.some(x => visible(x.b, box))) paths[r.n] = pathOf(r.rings, v, w, h);
  }
  // заливка в отдельном слое, затем целиком полупрозрачно — как на карте СВО
  const x = layerCanvas(w, h, dpr);
  for (const [n, p] of Object.entries(paths)) { const c = model.colors[sides[n]]; if (c) { x.fillStyle = c; x.fill(p, 'evenodd'); } }
  const fronts = [];
  for (const f of model.fronts) {
    const pts = lineAt(f, day); if (!pts) continue;
    const { half, line } = halfPath(pts, f.half, v, w, h);
    const regs = f.regions.filter(n => paths[n] && f.targets.has(sides[n])).map(n => paths[n]);
    for (const rp of regs) {
      x.save(); x.clip(half); x.fillStyle = model.colors[f.a]; x.fill(rp, 'evenodd'); x.restore();
      if (f.b) { const out = new Path2D(); out.rect(-1e5, -1e5, 2e5, 2e5); out.addPath(half); x.save(); x.clip(out, 'evenodd'); x.fillStyle = model.colors[f.b]; x.fill(rp, 'evenodd'); x.restore(); }
    }
    fronts.push({ line, regs });
  }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.6; ctx.drawImage(scratch.c, 0, 0); ctx.restore();
  ctx.strokeStyle = css('--bg'); ctx.globalAlpha = 0.7; ctx.lineWidth = 0.9;
  for (const p of Object.values(paths)) ctx.stroke(p);
  ctx.globalAlpha = 1;
  for (const f of fronts) {
    if (!f.regs.length) continue;
    const clip = new Path2D(); f.regs.forEach(r => clip.addPath(r));
    ctx.save(); ctx.clip(clip, 'evenodd'); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = css('--halo'); ctx.lineWidth = 5.5; ctx.stroke(f.line);
    ctx.strokeStyle = css('--fg'); ctx.lineWidth = 2.6; ctx.stroke(f.line);
    ctx.restore();
  }
  drawLabels(ctx, v, w, h, null);
  // маршрут (1812)
  const route = routeAt(war.route, toDay(war.start), WAR.day);
  if (route.length > 1) {
    ctx.beginPath(); route.forEach(([lo, la], i) => { const [sx, sy] = WAR.map.screen(lo, la); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.setLineDash([10, 7]); ctx.strokeStyle = css('--accent'); ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]);
    const [ex, ey] = WAR.map.screen(...route[route.length - 1]); drawPin(ctx, ex, ey, true, false, 1);
  }
  // события
  const past = war.events.filter(e => toDay(e.d) <= day), cur = past[past.length - 1];
  for (const e of past) { if (e === cur) continue; const [sx, sy] = WAR.map.screen(e.lon, e.lat); ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7); ctx.fillStyle = css('--halo'); ctx.fill(); ctx.beginPath(); ctx.arc(sx, sy, 3.2, 0, 7); ctx.fillStyle = css('--fg'); ctx.fill(); }
  if (cur) {
    const [sx, sy] = WAR.map.screen(cur.lon, cur.lat); drawPin(ctx, sx, sy, true, false, 1);
    ctx.font = '700 13px "Golos Text", system-ui'; const tw = ctx.measureText(cur.title).width, hh = 26, pad = 8;
    let left = Math.max(4, Math.min(w - tw - 2 * pad - 4, sx - tw / 2 - pad)); const top = sy - 14 - hh;
    ctx.fillStyle = css('--halo'); ctx.beginPath(); ctx.roundRect ? ctx.roundRect(left, top, tw + 2 * pad, hh, hh / 2) : ctx.rect(left, top, tw + 2 * pad, hh); ctx.fill();
    ctx.fillStyle = css('--fg'); ctx.textBaseline = 'middle'; ctx.fillText(cur.title, left + pad, top + hh / 2 + 1);
  }
}
function routeAt(stops, start, day) {
  if (!stops.length) return [];
  const off = stops.map(s => toDay(s.d) - start); if (day < off[0]) return [];
  const out = [];
  for (let i = 0; i < stops.length; i++) {
    if (off[i] <= day) out.push([stops[i].lon, stops[i].lat]);
    else { const span = off[i] - off[i - 1], t = span <= 0 ? 1 : (day - off[i - 1]) / span; out.push([stops[i - 1].lon + (stops[i].lon - stops[i - 1].lon) * t, stops[i - 1].lat + (stops[i].lat - stops[i - 1].lat) * t]); break; }
  }
  return out;
}
async function renderWars() {
  const el = $('#s-wars');
  if (!D.wars) D.wars = await getJSON('data/wars/wars.json');
  if (!WAR.war) {
    cancelAnimationFrame(WAR.raf); WAR.playing = false;
    el.innerHTML = `<header class="top"><div class="brand">Войны</div></header><div class="stamp" style="font-family:var(--body);font-size:13px">Территории сторон, линии фронта и ключевые события с прокруткой времени.</div>
      <div class="scroll"><div class="list">${D.wars.map(w => `<button class="war" data-war="${w.id}"><span class="years">${esc(w.years)}</span><b>${esc(w.title)}</b><span class="small">${esc(w.summary)}</span><span class="small">Событий: ${w.events.length}</span></button>`).join('')}</div></div>`;
    return;
  }
  const war = WAR.war, total = toDay(war.end) - toDay(war.start);
  el.innerHTML = `<div class="mapwrap"><canvas></canvas><div class="mapui"><div class="chips"><button class="chip" data-back>‹ Войны</button><button class="chip" aria-pressed="true">${esc(war.title)}</button></div></div>
    <div class="panel"><div class="chips" id="wlegend" style="padding:0"></div>
      <div class="big" id="wdate"></div><div><div class="event-title" id="wtitle"></div><div class="small" id="wtext"></div></div>
      <input type="range" id="wday" min="0" max="${total}" step="1" value="${Math.round(WAR.day)}" aria-label="Дата">
      <div class="row"><button class="chip" data-step="-1">‹</button><button class="chip primary" id="wplay">Пуск</button><button class="chip" data-step="1">›</button>${[0.5, 1, 2, 4].map(s => chip(s < 1 ? '×0,5' : '×' + s, s === WAR.speed, `data-wspeed="${s}"`)).join('')}</div>
      <div class="small">${esc(war.note)}</div></div></div>`;
  WAR.map = new MapView($('canvas', el), { cx: war.lon, cy: my(war.lat), s: zToS(war.zoom) });
  WAR.map.go(war.lon, war.lat, zToS(war.zoom), WAR.map.c.clientHeight * 0.22);   // место войны — над нижней панелью
  WAR.map.render = drawWar;
  WAR.model = await loadModel(war.model);
  $('#wlegend').innerHTML = WAR.model.sides.map(s => `<span class="small" style="display:flex;align-items:center;gap:5px;color:var(--fg);white-space:nowrap"><i class="sw" style="background:${s.c}"></i>${esc(s.n)}</span>`).join('');
  $('#wday').oninput = e => { WAR.playing = false; WAR.day = +e.target.value; warUpdate(); };
  $('#wplay').onclick = () => { if (!WAR.playing && WAR.day >= total) WAR.day = 0; WAR.playing = !WAR.playing; if (WAR.playing) warLoop(); warUpdate(); };
  warUpdate();
}
function warUpdate() {
  const war = WAR.war, start = toDay(war.start), day = start + Math.floor(WAR.day);
  const cur = war.events.filter(e => toDay(e.d) <= day).pop();
  $('#wdate').textContent = fmtDate(day);
  $('#wtitle').textContent = cur ? cur.title : '';
  $('#wtext').textContent = cur ? fmtDate(toDay(cur.d)) + ' · ' + cur.text : 'Нажмите «Пуск» или потяните ползунок.';
  $('#wday').value = Math.round(WAR.day);
  $('#wplay').textContent = WAR.playing ? 'Пауза' : 'Пуск';
  WAR.map.request();
}
function warLoop() {
  const total = toDay(WAR.war.end) - toDay(WAR.war.start); let prev = performance.now();
  const step = now => {
    if (!WAR.playing) return;
    WAR.day = Math.min(total, WAR.day + (now - prev) / 1000 * (total / 60) * WAR.speed); prev = now;
    if (WAR.day >= total) WAR.playing = false;
    warUpdate(); if (WAR.playing) WAR.raf = requestAnimationFrame(step);
  };
  WAR.raf = requestAnimationFrame(step);
}
function warsClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.war) { WAR.war = D.wars.find(w => w.id === b.dataset.war); WAR.day = 0; WAR.model = null; return renderWars(); }
  if (b.dataset.back !== undefined) { WAR.playing = false; WAR.war = null; return renderWars(); }
  if (b.dataset.wspeed) { WAR.speed = +b.dataset.wspeed; $$('[data-wspeed]').forEach(x => x.setAttribute('aria-pressed', x === b)); return; }
  if (b.dataset.step) {
    const war = WAR.war, start = toDay(war.start), day = start + Math.floor(WAR.day), dir = +b.dataset.step; WAR.playing = false;
    const cur = war.events.filter(x => toDay(x.d) <= day).pop();
    const target = dir > 0 ? war.events.find(x => toDay(x.d) > day) : war.events.filter(x => toDay(x.d) < (cur ? toDay(cur.d) : start)).pop();
    WAR.day = target ? toDay(target.d) - start : dir > 0 ? toDay(war.end) - start : 0;
    return warUpdate();
  }
}

// ───────────────────────── источники ─────────────────────────
function renderSources() {
  const el = $('#s-sources'), all = allSources();
  const group = side => {
    const list = all.filter(s => s.side === side); if (!list.length) return '';
    return `<div class="group"><h2 class="s-${side}"><i class="dot"></i>${SIDES[side]}</h2><div class="rows">${list.map(s => {
      const on = !S.disabled.has(s.id), err = D.status[s.id], n = D.items.filter(i => i.s === s.id).length;
      const addr = s.kind === 'tg' ? 'Telegram · t.me/' + s.addr : 'RSS · ' + s.addr.replace(/^https?:\/\//, '');
      return `<div class="row-src"><div><b>${esc(s.n)}</b><small>${esc(addr)}</small>${on && err ? `<span class="err">не загрузился: ${esc(err)}</span>` : on && D.news ? `<small>сообщений: ${n}</small>` : ''}</div>
        ${s.custom ? `<button class="remove" data-remove="${esc(s.id)}">Удалить</button>` : ''}<button class="toggle" role="switch" aria-checked="${on}" aria-label="${esc(s.n)}" data-toggle="${esc(s.id)}"></button></div>`;
    }).join('')}</div></div>`;
  };
  el.innerHTML = `<header class="top"><button class="chip" data-back>‹ Лента</button></header>
    <div class="scroll"><div class="list">
      <div class="brand">Источники</div>
      <div class="note">Каждое сообщение подписано источником и стороной. Отключённые источники не показываются.</div>
      <form class="addbox" id="addform"><b>Добавить свой источник</b>
        <span class="note">Ссылка на открытый Telegram-канал (t.me/канал или @канал) или адрес RSS-ленты. Свои источники читаются прямо с телефона через публичный прокси и иногда могут не загружаться.</span>
        <input id="addinput" placeholder="t.me/канал" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url">
        <span class="err" id="adderr" hidden></span><div><button class="chip primary" type="submit">Добавить</button></div></form>
      ${Object.keys(SIDES).map(group).join('')}
    </div></div>`;
  $('#addform').onsubmit = e => { e.preventDefault(); addSource($('#addinput').value); };
}
function addSource(input) {
  const { source, error } = parseSource(input), err = $('#adderr');
  err.hidden = !error; err.textContent = error || '';
  if (!source) return;
  const finish = hide => {
    if (hide) { S.warnCustom = false; store.set('warnCustom', false); }
    S.custom.push(source); store.set('custom', S.custom);
    renderSources();
    loadAllCustom().then(() => { renderSources(); renderFeed(false); renderFeed(true); });
  };
  if (!S.warnCustom) return finish(false);
  const d = $('#dialog');
  d.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgt"><h3 id="dlgt">Новости не только про СВО</h3>
    <div>Из своего источника приложение берёт все сообщения подряд, без отбора по теме. В ленту могут попасть новости, не связанные с СВО и другими конфликтами.</div>
    <label><input type="checkbox" id="dlgno"> Больше не показывать</label>
    <div class="btns"><button class="chip" id="dlgcancel">Отмена</button><button class="chip primary" id="dlgok">Добавить</button></div></div>`;
  d.hidden = false;
  $('#dlgcancel').onclick = () => { d.hidden = true; };
  $('#dlgok').onclick = () => { d.hidden = true; finish($('#dlgno').checked); };
}
function sourcesClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.back !== undefined) return go('feed');
  if (b.dataset.toggle) { const id = b.dataset.toggle; S.disabled.has(id) ? S.disabled.delete(id) : S.disabled.add(id); store.set('disabled', [...S.disabled]); rebuildItems(); renderSources(); return; }
  if (b.dataset.remove) { S.custom = S.custom.filter(s => s.id !== b.dataset.remove); store.set('custom', S.custom); D.customItems = D.customItems.filter(i => i.s !== b.dataset.remove); rebuildItems(); renderSources(); }
}

// ───────────────────────── навигация и запуск ─────────────────────────
const TABS = ['feed', 'world', 'map', 'timelapse', 'wars', 'sources'];
function go(tab) {
  S.tab = tab; store.set('tab', tab === 'sources' ? 'feed' : tab);
  for (const t of TABS) $('#s-' + t).hidden = t !== tab;
  $$('#nav button').forEach(b => b.dataset.t === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (tab === 'feed') renderFeed(false);
  if (tab === 'world') renderFeed(true);
  if (tab === 'map') { if (!MAP) initMap(); renderMapUI(); }
  if (tab === 'timelapse' && !TL.map) initTimelapse(); else if (tab === 'timelapse') TL.map.request();
  if (tab === 'wars') { if (!WAR.war || !WAR.map) renderWars(); else WAR.map.request(); }
  if (tab === 'sources') renderSources();
}
async function refresh() {
  $$('[data-act="refresh"]').forEach(b => { b.textContent = 'Обновляю…'; });
  await Promise.all([loadNews(), loadAllCustom()]);
  if (S.tab === 'feed' || S.tab === 'world') renderFeed(S.tab === 'world');
  if (MAP) renderMapUI();
}
async function start() {
  $('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(b.dataset.t); });
  $('#s-feed').addEventListener('click', e => feedClick(e, false));
  $('#s-world').addEventListener('click', e => feedClick(e, true));
  $('#s-wars').addEventListener('click', warsClick);
  $('#s-sources').addEventListener('click', sourcesClick);
  const startTab = location.hash.slice(1);
  go(TABS.includes(startTab) ? startTab : S.tab);
  const [base, conflicts] = await Promise.all([getJSON('data/base.json'), getJSON('data/conflicts.json')]);
  D.base = prepBase(base); D.conflicts = prepConflicts(conflicts);
  await loadNews();
  go(S.tab);
  loadAllCustom().then(() => { if (S.tab === 'feed' || S.tab === 'world') renderFeed(S.tab === 'world'); });
  const redraw = () => { [MAP, TL.map, WAR.map].forEach(m => m && m.request()); };
  window.addEventListener('resize', redraw);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { redraw(); if (S.tab === 'feed' || S.tab === 'world') renderFeed(S.tab === 'world'); });
  if (document.fonts?.ready) document.fonts.ready.then(redraw);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 10 * 60 * 1000);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();
