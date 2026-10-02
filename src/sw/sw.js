// The service worker. Keeps the app shell (the page, its script and stylesheet, the icons) in a cache, so the app
// opens with no connection. Data never passes through here: it lives in IndexedDB (db/db.ts) and reaches the
// server by sync. The build (vite.config.ts) puts VERSION and FILES above this text and writes it to /sw.js.
//
// A new build installs beside the running one and takes over once every window of the app has closed.
const CACHE = `shell-${VERSION}`

self.addEventListener('install', (event) => {
  // 'reload' skips the HTTP cache, so the files are this build's.
  const requests = FILES.map((file) => new Request(file, { cache: 'reload' }))
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(requests)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== CACHE).map((k) => caches.delete(k))))
      // So the first visit is cached without a reload.
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  // Supabase, Strava and intervals.icu are other origins; /api/ is the token server.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  // Every page is the one app: /?week=…, /?workout=…, /strava/callback.
  const cached = request.mode === 'navigate' ? '/' : request
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(cached, { ignoreVary: true }))
      .then((hit) => hit ?? fetch(request)),
  )
})
