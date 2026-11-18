// Keeps the app opening without network, and sends what is waiting when the
// network comes back, even with the app closed (where the phone allows it).
importScripts('config.js', 'outbox.js')

const CACHE = 'voce-v1'
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'outbox.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']
const OWN = new Set(SHELL.map(file => new URL(file, self.location).pathname))

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL.map(file => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

// The app's own files: the kept copy at once, refreshed behind it for the
// next opening. Everything else (GitHub) goes straight to the network.
self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin || !OWN.has(url.pathname)) {
    return
  }

  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const kept = await cache.match(request, { ignoreSearch: true })
      const fresh = fetch(request)
        .then(response => {
          if (response.ok) {
            cache.put(request, response.clone())
          }

          return response
        })
        .catch(() => kept)

      return kept ?? fresh
    }),
  )
})

self.addEventListener('sync', event => {
  if (event.tag === 'invia') {
    event.waitUntil(
      self.Outbox.flush().then(result => {
        // Still offline: failing asks the phone to try again later.
        if (result.offline) {
          throw new Error('ancora senza rete')
        }
      }),
    )
  }
})
