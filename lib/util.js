"use strict";

const LIMITS = {
  MAX_PAGES: 100,
  MAX_ASSETS: 15000,
  MAX_DEPTH: 10,
  MAX_FILE_CHARS: 25_000_000,
  MAX_RENDER_SNAPSHOT_CHARS: 4_000_000,
  MAX_TOTAL_CHARS: Number(process.env.SCRAPE_MAX_TOTAL_CHARS) || 260_000_000,
  MAX_MEDIA_CHARS: Number(process.env.SCRAPE_MAX_MEDIA_CHARS) || 260_000_000,
  MAX_DISCOVERED_ASSETS: 30_000,
  MAX_SOURCEMAP_FILES: 12_000,
  MAX_NETWORK_CAPTURES: 2000,
  FETCH_TIMEOUT_MS: 15_000,
  RENDER_TIMEOUT_MS: 22_000,
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BINARY_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|cur|svgz?|woff2?|ttf|otf|eot|mp4|webm|ogg|ogv|mp3|wav|flac|aac|m4a|mov|avi|pdf|zip|gz|tgz|rar|7z|dmg|exe|wasm|psd|heic)(?:$|[?#])/i;

const NON_PAGE_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svgz?|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf|zip|gz|rar|7z|dmg|exe|css|js|mjs|json|map|xml|txt|rss|atom|csv|xlsx?|docx?|pptx?)(?:$|[?#])/i;

function slugFromHost(hostname) {
  const base = String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "site";
}

function safeSegment(part) {
  return String(part || "")
    .replace(/[\u0000-\u001f<>:"\\|?*]+/g, "_")
    .replace(/^\.+$/, "_");
}

function cleanPath(pathname) {
  return String(pathname || "")
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return safeSegment(decodeURIComponent(p));
      } catch {
        return safeSegment(p);
      }
    })
    .join("/");
}

function makePagePath(urlObj) {
  const pathname = urlObj.pathname || "/";
  const query = urlObj.search ? `__${urlObj.search.slice(1).replace(/[^a-z0-9=&_-]+/gi, "_").slice(0, 60)}` : "";
  if (pathname === "/") return query ? `index${query}.html` : "index.html";
  const clean = cleanPath(pathname);
  if (pathname.endsWith("/")) return `${clean}/index${query}.html`;
  const last = clean.split("/").pop() || "";
  if (/\.html?$/i.test(last)) return query ? clean.replace(/(\.html?)$/i, `${query}$1`) : clean;
  return `${clean}/index${query}.html`;
}

function makeAssetPath(urlObj, sourceOrigin) {
  let clean = cleanPath(urlObj.pathname) || "index";
  if (clean.endsWith("/")) clean += "index";
  if (urlObj.origin === sourceOrigin) return clean;
  return `external/${urlObj.host.toLowerCase()}/${clean}`;
}

function detectType(pathname) {
  const lower = String(pathname || "").toLowerCase().split(/[?#]/)[0];
  if (/\.html?$/.test(lower)) return "html";
  if (/\.(?:css|scss|sass|less)$/.test(lower)) return "css";
  if (/\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|vue|svelte|astro)$/.test(lower)) return "js";
  if (/\.map$/.test(lower)) return "map";
  if (/\.(?:json|webmanifest)$/.test(lower)) return "json";
  return "text";
}

function inferAssetType(assetPath, contentType, text) {
  const pathType = detectType(assetPath);
  if (pathType !== "text" && pathType !== "html") return pathType;

  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/css")) return "css";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "js";
  if (ct.includes("application/source-map")) return "map";
  if (ct.includes("json")) return "json";
  if (ct.includes("text/html")) return "html";

  const body = String(text || "").slice(0, 4000).trim();
  if (!body) return "text";
  if (/^\{[\s\S]*"version"\s*:\s*3[\s\S]*"(?:sources|mappings)"/.test(body)) return "map";
  if (/^[{[]/.test(body)) {
    try {
      JSON.parse(String(text));
      return "json";
    } catch {}
  }
  if (/^<!doctype html|^<html/i.test(body)) return "html";
  if (/@(?:import|media|font-face|supports|keyframes|layer)\b/.test(body) || /^[^{}()]{1,200}\{[^{}]{0,300}:[^{}]{0,300};?\s*\}/.test(body)) return "css";
  if (/\b(?:function|const|let|var|import|export|class|return)\b/.test(body) || /=>|webpackChunk|__vite/.test(body)) return "js";
  return "text";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeUrl(raw, base) {
  const value = String(raw || "").trim().replace(/&amp;/g, "&");
  if (!value || /^(?:data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(value)) return null;
  try {
    const u = new URL(value, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function collect(re, text, group = 1, into = []) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[group]) into.push(m[group]);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return into;
}

// Rewrites a framework-relative path (e.g. Next's "static/chunks/x.js") against a detected public base.
function resolveCodeRef(ref, baseUrl, hints) {
  const raw = String(ref || "").trim();
  if (!raw) return null;
  // Bundlers list deps relative to the site base ("assets/x.js" from /assets/index.js). When the
  // ref's first folder already appears in the script's path, anchor it there instead of nesting.
  if (/^[\w@-][^:]*\//.test(raw) && baseUrl) {
    try {
      const b = new URL(baseUrl);
      const first = raw.split("/")[0];
      const segs = b.pathname.split("/");
      const at = segs.lastIndexOf(first, segs.length - 2);
      if (at > 0) return normalizeUrl(raw, `${b.origin}${segs.slice(0, at).join("/")}/`);
    } catch {}
  }
  if (hints && hints.nextBase && /^static\/(?:chunks|css|media|[\w-]{6,}\/)/.test(raw)) {
    return normalizeUrl(raw, hints.nextBase);
  }
  if (hints && hints.nuxtBase && /^_nuxt\//.test(raw)) {
    return normalizeUrl(raw, hints.nuxtBase);
  }
  return normalizeUrl(raw, baseUrl);
}

function extractHtmlLinks(html, pageUrl, hints) {
  const text = String(html || "");
  const pageRefs = [];
  const assetRefs = [];

  collect(/<a\b[^>]*?\shref\s*=\s*["']([^"'#][^"']*)["']/gi, text, 1, pageRefs);
  collect(/<area\b[^>]*?\shref\s*=\s*["']([^"'#][^"']*)["']/gi, text, 1, pageRefs);
  collect(/<meta\b[^>]*http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url=([^"'>\s]+)/gi, text, 1, pageRefs);

  collect(/<link\b[^>]*?\shref\s*=\s*["']([^"']+)["']/gi, text, 1, assetRefs);
  collect(/<script\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi, text, 1, assetRefs);
  collect(/<iframe\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi, text, 1, pageRefs);

  // Import maps
  const importMapRe = /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const block of collect(importMapRe, text)) {
    try {
      const map = JSON.parse(block);
      const walk = (obj) => Object.values(obj || {}).forEach((v) => (typeof v === "string" ? assetRefs.push(v) : walk(v)));
      walk(map.imports);
      walk(map.scopes);
    } catch {}
  }

  // Code references inside inline scripts / styles are guesses (chunk names, flight data, url())
  const softRefs = extractCodeRefs(text);

  const pages = new Set();
  const assets = new Set();
  const softAssets = new Set();
  for (const ref of pageRefs) {
    const abs = normalizeUrl(ref, pageUrl);
    if (abs && !NON_PAGE_EXT_RE.test(new URL(abs).pathname)) pages.add(abs);
  }
  for (const ref of assetRefs) {
    const abs = resolveCodeRef(ref, pageUrl, hints);
    if (abs && !BINARY_EXT_RE.test(abs)) assets.add(abs);
  }
  for (const ref of softRefs) {
    const abs = resolveCodeRef(ref, pageUrl, hints);
    if (!abs || BINARY_EXT_RE.test(abs) || assets.has(abs)) continue;
    (isStrongCodeUrl(abs) ? assets : softAssets).add(abs);
  }
  return { pageLinks: [...pages], assetLinks: [...assets], softAssetLinks: [...softAssets] };
}

// Code CDNs whose absolute URLs are always real assets (lazy bundles listed in JSON resource maps).
const STRONG_CODE_URL_RE =
  /^https:\/\/(?:[a-z0-9-]+\.)*(?:fbcdn\.net|cdninstagram\.com|facebook\.com|instagram\.com|twimg\.com|tiktokcdn(?:-[a-z]+)?\.com|ttwstatic\.com|byteimg\.com|ibytedtos\.com|rbxcdn\.com|roblox\.com|discord\.com|discordapp\.com|discordapp\.net|redditstatic\.com|licdn\.com|pinimg\.com|sc-static\.net|snapchat\.com|ytimg\.com|gstatic\.com|twitchcdn\.net|jtvnw\.net|scdn\.co|spotifycdn\.com|nflxext\.com)\/.+\.(?:m?js|css)(?:\?|$)|\/rsrc\.php\/.+\.(?:js|css)(?:\?|$)/i;

function isStrongCodeUrl(url) {
  return STRONG_CODE_URL_RE.test(String(url || ""));
}

function extractCodeRefs(text) {
  let body = String(text || "");
  // JSON-in-HTML and resource maps escape slashes ("https:\/\/static.xx.fbcdn.net\/rsrc.php\/...").
  if (body.includes("\\/") || /\\u002[fF]/.test(body)) body = body.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/");
  const refs = [];
  collect(/[#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/g, body, 1, refs);
  collect(/\bfrom\s*["']([^"']+\.[a-z]{2,5}(?:\?[^"']*)?)["']/gi, body, 1, refs);
  collect(/\bimport\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/gi, body, 1, refs);
  collect(/\bimport\s*["']([^"']+)["']/gi, body, 1, refs);
  collect(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi, body, 1, refs);
  collect(/url\(\s*["']?([^"')]+\.css(?:\?[^"')]*)?)["']?\s*\)/gi, body, 1, refs);
  collect(/importScripts\(\s*["']([^"']+)["']/gi, body, 1, refs);
  collect(/new\s+(?:Shared)?Worker\(\s*(?:new\s+URL\(\s*)?["']([^"']+)["']/gi, body, 1, refs);
  collect(/["'`]((?:\.{0,2}\/|https?:\/\/)?[^"'`\s<>(){}]+\.(?:m?js|cjs|jsx|tsx?|css|json|map|webmanifest)(?:\?[^"'`\s<>]*)?)["'`]/gi, body, 1, refs);
  return refs.filter((r) => r.length < 400 && !/[\s<>{}]/.test(r) && !/^(?:application|text)\//.test(r));
}

function extractInline(html, tag) {
  const out = [];
  const re = tag === "style"
    ? /<style\b([^>]*)>([\s\S]*?)<\/style>/gi
    : /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    const attrs = m[1] || "";
    const content = String(m[2] || "").trim();
    if (!content) continue;
    if (tag === "script" && /\bsrc\s*=/.test(attrs)) continue;
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    const idMatch = attrs.match(/\bid\s*=\s*["']?([^"'\s>]+)/i);
    out.push({ attrs, content, type: typeMatch ? typeMatch[1].toLowerCase() : "", id: idMatch ? idMatch[1] : "" });
  }
  return out;
}

function detectShellHtml(html) {
  const body = String(html || "").toLowerCase();
  const scriptTags = (body.match(/<script\b/g) || []).length;
  const hasAppRoot = /id=["'](?:app|root|__next|__nuxt|svelte|___gatsby|q-app|\w*react\w*)["']/.test(body);
  const hydration = /__next_data__|__next_f|window\.__initial_state|__nuxt__|hydrate\(|createroot\(|webpackchunk|data-reactroot|ng-version|__remixcontext|__sveltekit|astro-island/.test(body);
  const textLen = body
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
  return (scriptTags >= 6 && hasAppRoot) || hydration || (hasAppRoot && textLen < 400);
}

function detectFrameworks(text, { bundle = false } = {}) {
  const t = String(text || "");
  const found = new Set();
  if (/webpackChunk|__webpack_require__/.test(t)) found.add("Webpack");
  if (/TURBOPACK|__turbopack_/.test(t)) found.add("Turbopack");
  if (/__vite__mapDeps|import\.meta\.env|\/@vite\/client/.test(t)) found.add("Vite");
  if (bundle) return [...found];
  if (/__NEXT_DATA__|\/_next\/static\/|self\.__next_f/.test(t)) found.add("Next.js");
  if (/__NUXT__|\/_nuxt\//.test(t)) found.add("Nuxt");
  if (/data-reactroot|__REACT_DEVTOOLS_GLOBAL_HOOK__|react-dom|id=["'](?:root|__next)["']/.test(t)) found.add("React");
  if (/\bng-version=/.test(t)) found.add("Angular");
  if (/\bdata-v-[a-f0-9]{8}\b|__VUE__|\bdata-v-app\b/.test(t)) found.add("Vue");
  if (/__sveltekit|class="[^"]*\bsvelte-[a-z0-9]{6,}/.test(t)) found.add("Svelte");
  if (/id=["']___gatsby["']/.test(t)) found.add("Gatsby");
  if (/__remixContext/.test(t)) found.add("Remix");
  if (/<astro-island\b/.test(t)) found.add("Astro");
  if (/\/wp-content\/|\/wp-includes\//.test(t)) found.add("WordPress");
  if (/cdn\.shopify\.com|Shopify\.theme/.test(t)) found.add("Shopify");
  return [...found];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  isStrongCodeUrl,
  LIMITS,
  UA,
  BINARY_EXT_RE,
  NON_PAGE_EXT_RE,
  slugFromHost,
  makePagePath,
  makeAssetPath,
  detectType,
  inferAssetType,
  escapeHtml,
  normalizeUrl,
  resolveCodeRef,
  extractHtmlLinks,
  extractCodeRefs,
  extractInline,
  detectShellHtml,
  detectFrameworks,
  cleanPath,
  sleep,
};
