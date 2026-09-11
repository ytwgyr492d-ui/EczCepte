"use strict";
/**
 * Service Worker — sadece uygulama kabuğunu (HTML/CSS/JS/ikon) önbellekler.
 * API istekleri (Overpass, Nominatim, CollectAPI) BİLEREK burada
 * önbelleklenmez: nöbetçi eczane bilgisinin çevrimdışıyken "güncelmiş gibi"
 * gösterilmesini engellemek app.js içindeki localStorage tabanlı, zaman
 * damgalı ve "stale" etiketli mekanizmaya bırakılmıştır (bkz. bölüm 11 ve 13).
 */
const CACHE_NAME = "nobetci-cepte-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./data.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

const API_HOST_FRAGMENTS = ["overpass", "nominatim.openstreetmap.org", "collectapi.com", "unpkg.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch((e) => console.warn("[sw] shell cache başarısız (yine de devam):", e))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  const isApiCall = API_HOST_FRAGMENTS.some((h) => url.includes(h));
  if (isApiCall || event.request.method !== "GET") {
    return; // canlı veriye dokunma — her zaman ağdan iste
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkRes) => {
          if (networkRes && networkRes.ok) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkRes;
        })
        .catch(() => cached); // çevrimdışı: kabuk dosyası varsa onu göster
      return cached || fetchPromise;
    })
  );
});
