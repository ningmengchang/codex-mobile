const APP_SHELL = ['/', '/styles.css?v=89', '/app.js?v=115', '/js/dom.js', '/js/http.js', '/js/format.js', '/js/state.js', '/js/chat-core.js', '/js/chat-view.js', '/js/turn-state.js', '/js/mermaid-renderer.js', '/js/keyboard.js', '/js/loading.js', '/js/dingtalk.js', '/js/debug.js', '/js/skill-market.js', '/js/image-input.js', '/vendor/marked.esm.js', '/vendor/purify.js', '/manifest.webmanifest', '/icon.svg'];
const CACHE = 'codex-mobile-v119';
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL))));
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/'))));
});
