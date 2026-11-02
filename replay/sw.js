/* ChroniumX replay service worker.
 * Runs on the isolated replay origin and answers every request a replayed page makes —
 * its document, scripts, lazy chunks, CSS, images, fonts and captured API JSON — from the
 * scrape stored in Cache Storage, so the page's own code runs as it did on the live site. */
const VERSION = 3;
const META_CACHE = "replay-meta";
const META_KEY = "/replay/__meta";
let meta = null;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function getMeta() {
  if (meta) return meta;
  const hit = await (await caches.open(META_CACHE)).match(META_KEY);
  meta = hit ? await hit.json() : null;
  return meta;
}

self.addEventListener("message", (event) => {
  // The host page announces which scrape is active before it navigates.
  if (event.data && event.data.type === "replay-meta") meta = event.data.meta;
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // The replay shell itself always comes from the server.
  if (url.origin === self.location.origin && url.pathname.startsWith("/replay/") && !url.pathname.startsWith("/replay/run/")) return;
  event.respondWith(handle(event.request, url, event.clientId));
});

// Tells the replayed page (which relays to the Preview tab) about requests the scrape couldn't answer.
async function reportMiss(clientId, method, target) {
  try {
    const client = clientId && (await self.clients.get(clientId));
    if (client) client.postMessage({ type: "replay-miss", url: target, method });
  } catch {}
}

const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store" };

async function handle(request, url, clientId) {
  const m = await getMeta();
  if (!m) return new Response("Replay not loaded", { status: 404 });
  const cache = await caches.open(`replay-${m.key}`);

  if (url.origin === self.location.origin && url.pathname.startsWith("/replay/run/")) {
    const page = await cache.match(url.pathname);
    return page || new Response("Replay page missing", { status: 404 });
  }

  // Apps sometimes build URLs from location.origin; map those back onto the scraped site.
  let target = url.href.split("#")[0];
  if (url.origin === self.location.origin) {
    target = m.origin + url.pathname + url.search;
  } else if (url.hostname.endsWith(`.${self.location.hostname}`)) {
    // Apps derive API hosts from their own hostname (apis.<host>); map those back onto the real domain.
    const sub = url.hostname.slice(0, -(self.location.hostname.length + 1));
    const siteHost = new URL(m.origin).hostname.replace(/^www\./, "");
    target = `https://${sub}.${siteHost}${url.pathname}${url.search}`;
  }

  let hit = await cache.match(target, { ignoreVary: true });
  if (!hit && request.method === "GET") hit = await cache.match(target, { ignoreSearch: true, ignoreVary: true });
  if (hit) {
    const headers = new Headers(hit.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(hit.body, { status: 200, headers });
  }

  reportMiss(clientId, request.method, target);
  // Not in the scrape: let plain GETs for public assets through, answer everything else with an empty 404.
  if (request.method === "GET" && new URL(target).origin !== m.origin) {
    try {
      // Fetch the real address (not the replay alias); no-cors so third-party scripts and images still load.
      return await fetch(target === url.href ? request : new Request(target, { mode: "no-cors", credentials: "omit" }));
    } catch {}
  }
  const isJson = /\/api\//.test(target) || /json/.test(request.headers.get("accept") || "");
  return new Response(isJson ? "{}" : "", { status: 404, headers: { ...CORS, "content-type": isJson ? "application/json" : "text/plain" } });
}
