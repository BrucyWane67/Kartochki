const CACHE='kartochki-offline-v2';
const ASSETS=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./assets/icon-192.png','./assets/icon-512.png','./assets/favicon.svg','./vendor/jszip.min.js'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('kartochki-offline-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET'||new URL(req.url).origin!==self.location.origin)return;
  event.respondWith(fetch(req).then(response=>{
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(req,copy)));}return response;
  }).catch(()=>caches.match(req).then(cached=>cached||Response.error())));
});
