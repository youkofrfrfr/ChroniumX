import { fileText } from "./preview.js";

/*
 * Live replay: runs a scraped page's own HTML, CSS and JavaScript together on an isolated
 * origin. A service worker there serves every request from the scrape, so the app's code
 * builds the page just like on the real site, while it can never reach this app's data.
 */

/** The origin replays run on. It must differ from the app's origin so page code stays isolated. */
export function replayOrigin(configured) {
  if (configured) {
    try {
      const o = new URL(configured).origin;
      return o !== location.origin ? o : null;
    } catch {
      return null;
    }
  }
  // replay.localhost resolves to this machine and is the same *site* as localhost (so the service
  // worker isn't treated as third-party) but a different *origin* (so page code stays isolated).
  const { protocol, hostname, port } = location;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return `${protocol}//replay.localhost${port ? `:${port}` : ""}`;
  return null;
}

// Its own real origin (allow-same-origin) is needed for the service worker; that origin differs from
// this app's, so the page still can't touch the app. No top navigation or popups.
export const REPLAY_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals";

const MIME = { js: "application/javascript", css: "text/css", json: "application/json", map: "application/json", html: "text/html; charset=utf-8", text: "text/plain" };

function originalUrl(f) {
  const raw = String(f.sourceUrl || "").replace(/^[A-Z]+ (?=https?:)/, "");
  if (!/^https?:\/\//i.test(raw) || raw.includes("#")) return null; // recovered sources, inline blocks, screenshots
  return raw;
}

function hashKey(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function replayShellUrl(origin) {
  return `${origin}/replay/host.html?parent=${encodeURIComponent(location.origin)}`;
}

/** Prepares the page document: original server HTML (or saved edits), anchored to the real URL. */
function runDocument(page) {
  const u = new URL(page.sourceUrl.split("#")[0]);
  let html = fileText(page);
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "").replace(/\sintegrity\s*=\s*(["'])[^"']*\1/gi, "");
  // <base> makes every relative URL resolve to the real site (which the service worker serves);
  // the path is restored so the app's router sees the route it expects.
  // It also reports script errors and how much the page has drawn back to the Preview tab.
  const report = `(function(){var P=${JSON.stringify(location.origin)},n=0;function s(m){try{parent.postMessage(m,P)}catch(e){}}
window.addEventListener("error",function(e){if(n++<40)s({type:"replay-log",level:"error",message:String(e.message||(e.target&&(e.target.src||e.target.href))||"error")})},true);
window.addEventListener("unhandledrejection",function(e){if(n++<40)s({type:"replay-log",level:"error",message:"Unhandled: "+String(e.reason&&e.reason.message||e.reason)})});
var miss=0;if(navigator.serviceWorker){navigator.serviceWorker.addEventListener("message",function(e){var d=e.data||{};if(d.type==="replay-miss"&&miss++<60)s({type:"replay-log",level:"miss",message:"Not in scrape: "+d.method+" "+d.url})});try{navigator.serviceWorker.startMessages()}catch(e){}}
[1500,4000,9000].forEach(function(t){setTimeout(function(){var b=document.body;s({type:"replay-drawn",text:b?(b.innerText||"").length:0,nodes:document.getElementsByTagName("*").length,t:t})},t)});})();`;
  // Browsers refuse cross-origin worker scripts, so workers pointing at the real site start from a
  // same-origin blob stub that loads the real script (served by the replay service worker).
  const workers = `(function(){function wrap(N){var O=window[N];if(!O)return;window[N]=function(url,opts){try{var a=new URL(url,document.baseURI);if(a.origin!==location.origin&&a.protocol!=="blob:"&&a.protocol!=="data:"){var mod=opts&&opts.type==="module";var src=mod?"import "+JSON.stringify(a.href)+";":"importScripts("+JSON.stringify(a.href)+");";url=URL.createObjectURL(new Blob([src],{type:"text/javascript"}))}}catch(e){}return new O(url,opts)};window[N].prototype=O.prototype}wrap("Worker");wrap("SharedWorker")})();`;
  const boot = `<base href="${u.href.replace(/"/g, "&quot;")}"><script>try{history.replaceState(history.state,"",location.origin+${JSON.stringify(u.pathname + u.search)})}catch(e){}${workers}${report}</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${boot}`) : `${boot}${html}`;
}

/**
 * Starts a live replay of `page` inside `frame`. Returns a cancel function.
 * onStatus(text) reports progress; onError(message) reports failures.
 */
export function startReplay({ frame, win, origin, slug, meta, files, page, onStatus, onError, onLog = () => {} }) {
  const target = () => (frame ? frame.contentWindow : win);
  const all = Object.values(files);
  const edits = all.filter((f) => typeof f.edited === "string").map((f) => `${f.path}:${f.editedAt || 0}`).join("|");
  const key = `${slug}-${hashKey(`${meta && meta.createdAt}|${all.length}|${edits}`)}`;
  const siteOrigin = new URL(page.sourceUrl).origin;
  const runPath = `/replay/run/${key}/${page.path}`;
  let cancelled = false;

  const queue = [];
  for (const f of all) {
    const url = originalUrl(f);
    if (!url || f.kind === "screenshot") continue;
    queue.push(f.encoding === "base64" ? { url, body: f.content, encoding: "base64", contentType: f.contentType } : { url, body: fileText(f), contentType: MIME[f.type] || "text/plain" });
  }
  let sent = 0;
  const send = (msg) => target() && target().postMessage(msg, origin);
  const sendBatch = () => {
    if (sent >= queue.length) return send({ type: "replay-done" });
    // Batches by size so huge bundles don't stall the frame.
    const batch = [];
    let bytes = 0;
    while (sent < queue.length && (batch.length < 200 && bytes < 12_000_000)) {
      const f = queue[sent++];
      batch.push(f);
      bytes += f.body.length;
    }
    send({ type: "replay-files", files: batch, done: sent, total: queue.length });
    onStatus(`Loading scrape into live replay… ${Math.round((sent / queue.length) * 100)}%`);
  };
  const run = () => {
    onStatus(`Live: the page's own HTML, CSS and JavaScript running on ${origin} with captured code and data`);
    send({ type: "replay-run", runPath, html: runDocument(page) });
  };

  const onMessage = (event) => {
    if (cancelled || event.origin !== origin || event.source !== target()) return;
    const m = event.data || {};
    if (m.type === "replay-ready") send({ type: "replay-begin", meta: { key, origin: siteOrigin } });
    else if (m.type === "replay-cached") run();
    else if (m.type === "replay-send" || m.type === "replay-ack") sendBatch();
    else if (m.type === "replay-stored") run();
    else if (m.type === "replay-error") onError(m.message);
    else if (m.type === "replay-hello") onStatus("Starting live replay… registering the replay service worker");
    else if (m.type === "replay-log") onLog(m);
    else if (m.type === "replay-drawn") onLog({ level: "info", message: `drawn after ${m.t} ms: ${m.nodes} elements, ${m.text} chars of text`, drawn: m });
  };
  window.addEventListener("message", onMessage);

  if (frame) {
    frame.removeAttribute("srcdoc");
    frame.setAttribute("sandbox", REPLAY_SANDBOX);
    frame.src = replayShellUrl(origin);
  }
  onStatus("Starting live replay…");

  return () => {
    cancelled = true;
    window.removeEventListener("message", onMessage);
  };
}
