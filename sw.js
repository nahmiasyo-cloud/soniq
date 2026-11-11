/* SONIQ service worker: keeps the app working without internet.
   The app's own files are saved at install. Sound samples and fonts from other sites are saved
   the first time they load, so every sound you have played once also works offline.
   Pages: network first (so updates arrive), then the saved copy. */
const VERSION = 'soniq-v2';
const SHELL = VERSION + '-shell', RUNTIME = 'soniq-runtime';
const PRECACHE = [
 "./",
 "index.html",
 "manifest.webmanifest",
 "favicon.png",
 "icon-180.png",
 "icon-192.png",
 "icon-512.png",
 "icons/icon-bass.svg",
 "icons/icon-clock.svg",
 "icons/icon-guitar.svg",
 "icons/icon-headphones.svg",
 "icons/icon-intervals.svg",
 "icons/icon-jam-wave.svg",
 "icons/icon-loop.svg",
 "icons/icon-magnifier.svg",
 "icons/icon-map-fretboard.svg",
 "icons/icon-metronome.svg",
 "icons/icon-microphone.svg",
 "icons/icon-music-note.svg",
 "icons/icon-piano.svg",
 "icons/icon-play.svg",
 "icons/icon-practice-target.svg",
 "icons/icon-question-mark.svg",
 "icons/icon-scale-steps.svg",
 "icons/icon-settings-gear.svg",
 "icons/icon-stop.svg",
 "icons/icon-tuner.svg",
 "brand/inlay-01.webp",
 "brand/inlay-02.webp",
 "brand/inlay-03.webp",
 "brand/inlay-04.webp",
 "brand/inlay-05.webp",
 "brand/inlay-06.webp",
 "brand/layers-mobile.webp",
 "brand/layers-wide.webp",
 "brand/soniq-icon.webp",
 "brand/soniq-logo.webp",
 "brand/waves-mobile.webp",
 "brand/waves-wide.webp"
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.endsWith('-shell') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// samples (versioned on unpkg) and font files never change: the saved copy is enough
const IMMUTABLE = /^https:\/\/(unpkg\.com|fonts\.gstatic\.com)\//;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    // the page itself: try the network, fall back to the saved app (shared links keep their ?query)
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(SHELL).then(c => c.put('index.html', copy)); return res;
    }).catch(() => caches.match('index.html', { ignoreSearch: true }).then(r => r || caches.match('./'))));
    return;
  }
  if (IMMUTABLE.test(req.url)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(RUNTIME).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (url.origin === location.origin || url.hostname === 'fonts.googleapis.com') {
    // the app's own files and the font stylesheet: answer from the saved copy at once, refresh it in the background
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(url.origin === location.origin ? SHELL : RUNTIME).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
  }
  // everything else (YouTube and other sites) goes straight to the network
});
