/* Service worker: deja la app usable sin conexión.
   El vocabulario se sirve de la caché pero se refresca por detrás, para que un
   `build_dataset.py` nuevo se note en la siguiente apertura sin obligar a
   reinstalar nada. */

// publicar.py sustituye esto por la fecha de publicación. Es lo que hace que
// el navegador vea un service worker distinto y detecte que hay versión nueva:
// si este archivo no cambia, el celular se queda con el código viejo aunque
// app.js sí haya cambiado.
var BUILD = "20260810-201331";

var CACHE = "pinyin-" + BUILD;
var ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./vendor/hanzi-writer.min.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./data/vocabulario.json"
];
// Los trazos (1,8 MB en 756 archivos) y las imágenes NO se precargan: se van
// guardando en caché a medida que se usan, desde el manejador de fetch.

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
          .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      var net = fetch(e.request).then(function (res) {
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () { return hit; });

      return hit || net;
    })
  );
});
