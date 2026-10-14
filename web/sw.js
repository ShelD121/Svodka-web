/* Кэш для работы с плохой связью: оболочка и карты — из кэша, новости — сначала из сети. */
const VERSION = 'svodka-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png',
  'fonts/unbounded.ttf', 'fonts/golos_text.ttf', 'data/base.json', 'data/conflicts.json', 'data/gazetteer.json', 'data/wars/wars.json'];
const LIVE = ['data/news.json', 'data/front.json', 'data/timeline.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const path = url.pathname.split('/').slice(-2).join('/');
  const live = LIVE.some(p => url.pathname.endsWith(p));
  if (live) {
    // сеть, при неудаче — последняя сохранённая копия
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone(); caches.open(VERSION).then(c => c.put(url.pathname, copy)); return r;
    }).catch(() => caches.match(url.pathname)));
    return;
  }
  // оболочка: из кэша, параллельно обновляем
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
  void path;
});
