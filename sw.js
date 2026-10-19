/* My Hangar service worker: offline app shell, cached cut-out model, and photos from IndexedDB.
   VERSION is replaced by build.py on every build, so a new deploy installs fresh files. */
const VERSION = "85a9f5bd088f";
const SHELL = "hangar-shell-" + VERSION;
const BIG = "hangar-model-v1";            // the cut-out model and runtime (57 MB); only changes if the files change
const SHELL_FILES = ["./", "index.html", "platform.js", "manifest.webmanifest", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "vendor/anthropic-sdk.mjs", "vendor/fflate.mjs", "vendor/jspdf.umd.min.js", "vendor/ort-wasm-simd-threaded.mjs", "vendor/ort.wasm.bundle.min.mjs", "fonts/Inter-ExtraBold.ttf", "fonts/Inter-Regular.ttf", "fonts/Inter-SemiBold.ttf", "fonts/inter-latin-ext.woff2", "fonts/inter-latin.woff2"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("hangar-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* Photos live in the app's IndexedDB ("photos" store); pages ask for them as _blob/<id>. */
function photo(id) {
  return new Promise((res) => {
    const r = indexedDB.open("my-hangar", 1);
    r.onsuccess = () => {
      try {
        const g = r.result.transaction("photos", "readonly").objectStore("photos").get(id);
        g.onsuccess = () => res(g.result || null);
        g.onerror = () => res(null);
      } catch { res(null); }
    };
    r.onerror = () => res(null);
  });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  const m = /\/_blob\/([0-9a-f]{32})$/.exec(url.pathname);
  if (m) {
    e.respondWith(photo(m[1]).then((p) => p
      ? new Response(p.blob, { headers: { "Content-Type": p.type, "Cache-Control": "no-store" } })
      : new Response("", { status: 404 })));
    return;
  }
  if (/\/bg\/[mr]\d\d\.wasm$/.test(url.pathname)) {           // cut-out model: cache on first use, keep
    e.respondWith(caches.open(BIG).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (e.request.mode === "navigate") {                         // the page: newest when online, cached when not
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put("./", copy)); return r; })
      .catch(() => caches.match("./").then((r) => r || caches.match("index.html"))));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
