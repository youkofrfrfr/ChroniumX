"use strict";

const { once } = require("events");
const {
  LIMITS,
  BINARY_EXT_RE,
  slugFromHost,
  makePagePath,
  makeAssetPath,
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
  isStrongCodeUrl,
} = require("../lib/util");
const { fetchText, fetchBinary, isBlockedHost } = require("../lib/fetcher");
const {
  extractWebpackChunkUrls,
  extractBuildIds,
  parseSitemap,
  parseRobotsSitemaps,
  extractSourceMapSources,
} = require("../lib/discovery");
const { launchBrowser, renderPage, engineCapabilities } = require("../lib/browser");

// Serverless functions stop at 300 s; a local server can keep going much longer for max-size scrapes.
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
const TIME_BUDGET_MS = Number(process.env.SCRAPE_TIME_BUDGET_MS) || (IS_SERVERLESS ? 270_000 : 900_000);
const SAVE_TYPES = new Set(["css", "js", "json", "map"]);

function setCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  setCors(res);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

const clampInt = (v, lo, hi, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

// ── Fallback renderers for when no headless Chrome is available ──────────────
async function fetchRemoteRendered(url) {
  const endpoint = String(process.env.BROWSER_RENDER_ENDPOINT || process.env.BROWSERLESS_REST_URL || "").trim();
  const token = String(process.env.BROWSER_RENDER_TOKEN || process.env.BROWSERLESS_TOKEN || "").trim();
  if (!endpoint || !token) throw new Error("Remote renderer not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.RENDER_TIMEOUT_MS);
  try {
    const joiner = endpoint.includes("?") ? "&" : "?";
    const response = await fetch(`${endpoint}${joiner}token=${encodeURIComponent(token)}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, gotoOptions: { waitUntil: "networkidle2", timeout: LIMITS.RENDER_TIMEOUT_MS } }),
    });
    if (!response.ok) throw new Error(`Remote renderer HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProxySnapshot(url) {
  const response = await fetch(`https://r.jina.ai/${url}`, { headers: { "x-return-format": "html" } });
  if (!response.ok) throw new Error(`Proxy renderer HTTP ${response.status}`);
  const text = (await response.text()).trim();
  if (text.length < 120) throw new Error("Proxy renderer returned empty content");
  if (/^<!doctype|^<html/i.test(text)) return text;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Rendered Snapshot</title></head><body><pre style="white-space:pre-wrap">${escapeHtml(text)}</pre></body></html>`;
}

// ── Handler ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method === "GET") {
    return sendJson(res, 200, { ok: true, engine: engineCapabilities(), limits: { maxPages: LIMITS.MAX_PAGES, maxAssets: LIMITS.MAX_ASSETS, maxDepth: LIMITS.MAX_DEPTH } });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST for /api/scrape" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  let startUrl;
  try {
    startUrl = new URL(String(body.url || "").trim());
    if (startUrl.protocol !== "http:" && startUrl.protocol !== "https:") throw new Error();
    startUrl.hash = "";
  } catch {
    return sendJson(res, 400, { error: "Provide a valid http/https URL." });
  }
  if (await isBlockedHost(startUrl.hostname)) {
    return sendJson(res, 400, { error: "That host resolves to a private network address and cannot be scraped." });
  }

  const opts = {
    pageLimit: clampInt(body.maxPages, 1, LIMITS.MAX_PAGES, 10),
    assetLimit: clampInt(body.maxAssets, 1, LIMITS.MAX_ASSETS, 400),
    maxDepth: clampInt(body.maxDepth, 1, LIMITS.MAX_DEPTH, 3),
    sameOriginAssetsOnly: body.sameOriginAssetsOnly === true,
    engine: ["auto", "headless", "static"].includes(body.engine) ? body.engine : body.renderJs === false ? "static" : "auto",
    forceChunks: body.forceChunks !== false,
    autoScroll: body.autoScroll !== false,
    captureNetwork: body.captureNetwork !== false,
    captureMedia: body.captureMedia !== false,
    probeSourceMaps: body.probeSourceMaps !== false,
    includeVendorSources: body.includeVendorSources === true,
    discoverSitemap: body.discoverSitemap !== false,
    extractInlineScripts: body.extractInlineScripts !== false,
  };

  const startedAt = Date.now();
  const deadline = startedAt + TIME_BUDGET_MS;
  const abort = new AbortController();
  const slug = slugFromHost(startUrl.hostname);
  const origin = startUrl.origin;
  const hints = { nextBase: null, nuxtBase: null };

  const files = new Map(); // path -> size
  const visitedPages = new Set();
  const queuedPages = new Set();
  const pageQueue = [{ url: startUrl.toString(), depth: 0 }];
  queuedPages.add(startUrl.toString());
  const assetQueue = [];
  const softQueue = [];
  const seenAssets = new Set();
  const savedAssetUrls = new Set();
  const warnings = [];
  const frameworks = new Set();
  const buildIdsSeen = new Set();
  const counters = { totalChars: 0, mediaChars: 0, attempts: 0, pagesDone: 0 };
  const savedMedia = new Set();
  let activePages = 0;
  const stats = {
    savedAssets: 0,
    processedAssets: 0,
    discoveredFromCode: 0,
    webpackChunksFound: 0,
    sourceMapSourcesSaved: 0,
    vendorSourcesSkipped: 0,
    runtimeCssFiles: 0,
    networkCaptures: 0,
    mediaSaved: 0,
    inlineScripts: 0,
    inlineStyles: 0,
    shellPages: 0,
    renderedPages: 0,
    headlessRenders: 0,
    remoteRenders: 0,
    proxyRenders: 0,
    failedRenders: 0,
    forcedChunks: 0,
    sitemapPages: 0,
  };

  const warn = (msg) => {
    if (warnings.length < 600) warnings.push(msg);
  };

  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const stopped = () => abort.signal.aborted || Date.now() > deadline;

  res.statusCode = 200;
  setCors(res);
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("x-accel-buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const send = async (event) => {
    if (res.writableEnded || res.destroyed) return;
    if (!res.write(`${JSON.stringify(event)}\n`)) {
      await Promise.race([once(res, "drain"), once(res, "close"), sleep(15000)]);
    }
  };
  const progress = () => ({
    pagesVisited: visitedPages.size,
    pagesDone: counters.pagesDone,
    activePages,
    pageLimit: opts.pageLimit,
    assetsProcessed: stats.processedAssets,
    assetsSaved: stats.savedAssets,
    assetLimit: opts.assetLimit,
    filesSaved: files.size,
    queued: assetQueue.length + softQueue.length,
  });

  async function saveFile(record) {
    const content = record.content;
    if (typeof content !== "string" || !content.length) return false;
    if (content.length > LIMITS.MAX_FILE_CHARS) {
      warn(`Skipped oversized file (${Math.round(content.length / 1024)} KB): ${record.path}`);
      return false;
    }
    const prev = files.get(record.path) || 0;
    let rendered = typeof record.renderedContent === "string" && record.renderedContent.trim() ? record.renderedContent : null;
    if (rendered && rendered.length > LIMITS.MAX_RENDER_SNAPSHOT_CHARS) {
      warn(`Rendered snapshot too large for ${record.path}`);
      rendered = null;
    }
    const size = content.length + (rendered ? rendered.length : 0);
    const isMedia = record.encoding === "base64";
    const budgetKey = isMedia ? "mediaChars" : "totalChars";
    const budget = isMedia ? LIMITS.MAX_MEDIA_CHARS : LIMITS.MAX_TOTAL_CHARS;
    // The page the user typed always keeps its own files, so its preview is complete even when
    // other crawled pages have used up the budget.
    if (!record.priority && counters[budgetKey] - prev + size > budget) {
      if (!counters[`${budgetKey}Warned`]) warn(isMedia ? "Reached the image/font budget; remaining media was skipped." : "Reached total size budget; remaining files were skipped.");
      counters[`${budgetKey}Warned`] = true;
      return false;
    }
    counters[budgetKey] += size - prev;
    files.set(record.path, size);
    await send({
      type: "file",
      file: {
        path: record.path,
        type: record.type,
        kind: record.kind || "asset",
        sourceUrl: record.sourceUrl || "",
        size: record.bytes || content.length,
        content,
        ...(record.encoding ? { encoding: record.encoding, contentType: record.contentType || "" } : {}),
        ...(record.screenshotPath ? { screenshotPath: record.screenshotPath } : {}),
        renderedContent: rendered,
        renderedSize: rendered ? rendered.length : 0,
        renderSource: record.renderSource || null,
        shellDetected: !!record.shellDetected,
      },
      progress: progress(),
    });
    return true;
  }

  function enqueueAsset(rawUrl, { soft = false, allowText = false, fromCode = false } = {}) {
    const url = normalizeUrl(rawUrl);
    if (!url || seenAssets.has(url) || BINARY_EXT_RE.test(url)) return;
    if (seenAssets.size >= LIMITS.MAX_DISCOVERED_ASSETS) return;
    seenAssets.add(url);
    if (fromCode) stats.discoveredFromCode += 1;
    (soft ? softQueue : assetQueue).push({ url, soft, allowText });
  }

  function enqueuePage(rawUrl, depth) {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.origin !== origin || depth >= opts.maxDepth) return;
    if (visitedPages.has(url) || queuedPages.has(url) || queuedPages.size > opts.pageLimit * 8) return;
    queuedPages.add(url);
    pageQueue.push({ url, depth });
  }

  function noteFrameworkHints(url) {
    const idx = url.indexOf("/_next/");
    if (idx > 0 && !hints.nextBase) hints.nextBase = url.slice(0, idx + 7);
    const nIdx = url.indexOf("/_nuxt/");
    if (nIdx > 0 && !hints.nuxtBase) hints.nuxtBase = url.slice(0, nIdx + 1);
  }

  function noteBuildIds(text) {
    if (!hints.nextBase && /\/_next\/|__NEXT_DATA__/.test(text)) hints.nextBase = `${origin}/_next/`;
    for (const id of extractBuildIds(text)) {
      if (buildIdsSeen.has(id) || !hints.nextBase) continue;
      buildIdsSeen.add(id);
      for (const f of ["_buildManifest.js", "_ssgManifest.js", "_middlewareManifest.js", "_clientMiddlewareManifest.json"]) {
        enqueueAsset(`${hints.nextBase}static/${id}/${f}`, { soft: true });
      }
    }
  }

  /** Saves a fetched/captured code asset and mines it for further code. */
  async function ingestAsset(url, text, contentType, { soft = false, allowText = false, kind = "asset", priority = false } = {}) {
    let obj;
    try {
      obj = new URL(url);
    } catch {
      return false;
    }
    const expectsCode = /\.(?:m?js|cjs|css|map|json)(?:\?|$)/i.test(obj.pathname);
    const type = inferAssetType(obj.pathname, contentType, text);
    if (type === "html") return false; // SPA fallback page served for a missing asset
    if (expectsCode && /^\s*</.test(text) && type !== "css") return false;
    if (!SAVE_TYPES.has(type) && !(allowText && type === "text")) return false;
    if (type === "map" && !/"mappings"\s*:/.test(text)) return false;
    if (stats.savedAssets >= opts.assetLimit && !priority) return false;

    const path = makeAssetPath(obj, origin);
    const saved = await saveFile({ path, type, sourceUrl: url, content: text, kind, priority });
    if (!saved) return false;
    stats.savedAssets += 1;
    savedAssetUrls.add(url);
    seenAssets.add(url);
    noteFrameworkHints(url);

    if (type === "js" || type === "css" || type === "json") {
      if (type === "js") detectFrameworks(text.slice(0, 200_000), { bundle: true }).forEach((f) => frameworks.add(f));
      if (type === "js") noteBuildIds(text.slice(0, 50_000));
      for (const ref of extractCodeRefs(text)) {
        const abs = resolveCodeRef(ref, url, hints);
        if (abs) enqueueAsset(abs, { soft: !isStrongCodeUrl(abs), fromCode: true });
      }
      if (type === "js") {
        const chunkUrls = extractWebpackChunkUrls(text, url, hints);
        stats.webpackChunksFound += chunkUrls.length;
        chunkUrls.forEach((u) => enqueueAsset(u, { soft: false, fromCode: true }));
      }
      if (opts.probeSourceMaps && type !== "json" && !/sourceMappingURL\s*=/.test(text.slice(-600))) {
        enqueueAsset(`${url.split(/[?#]/)[0]}.map`, { soft: true });
      }
    }

    if (type === "map") {
      const { files: sources, skippedVendor } = extractSourceMapSources(text, { includeVendor: opts.includeVendorSources });
      stats.vendorSourcesSkipped += skippedVendor;
      for (const src of sources) {
        if (stats.sourceMapSourcesSaved >= LIMITS.MAX_SOURCEMAP_FILES || stopped()) break;
        const ok = await saveFile({
          path: `recovered/${src.name}`,
          type: src.type,
          sourceUrl: `${url}#${src.name}`,
          content: src.content,
          kind: "recovered",
        });
        if (ok) stats.sourceMapSourcesSaved += 1;
      }
    }
    return true;
  }

  const MEDIA_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif",
    "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/bmp": "bmp",
    "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf", "application/font-woff": "woff",
    "application/font-woff2": "woff2", "application/x-font-ttf": "ttf", "application/vnd.ms-fontobject": "eot",
  };
  /** Saves an image or font captured by the browser as a base64 file. */
  async function saveMedia(entry, { priority = false } = {}) {
    if (savedMedia.has(entry.url)) return;
    let u;
    try {
      u = new URL(entry.url);
    } catch {
      return;
    }
    let path = makeAssetPath(u, origin);
    const ext = MEDIA_EXT[entry.contentType];
    if (ext && !/\.[a-z0-9]{2,5}$/i.test(path)) path += `.${ext}`;
    const isSvg = entry.contentType === "image/svg+xml";
    const type = entry.mediaKind === "font" || /^(?:font\/|application\/(?:x-)?font|application\/vnd\.ms-fontobject)/.test(entry.contentType) ? "font" : "image";
    if (await saveFile({ path, type, sourceUrl: entry.url, content: entry.base64, encoding: "base64", contentType: entry.contentType || (isSvg ? "image/svg+xml" : ""), bytes: entry.bytes, kind: "media", priority })) {
      // Only mark it saved on success, so a page with priority can still keep a copy another page couldn't.
      savedMedia.add(entry.url);
      stats.mediaSaved = (stats.mediaSaved || 0) + 1;
    }
  }

  const MEDIA_URL_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot)(?:[?#]|$)/i;
  /**
   * Downloads every image/font the typed page's CSS references but Chrome never drew (hover states,
   * other breakpoints, hidden screens), so its preview needs nothing from the live site.
   */
  async function completePageMedia(cssList) {
    const want = new Set();
    for (const { css, base } of cssList) {
      for (const m of String(css).matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
        const ref = m[2].trim();
        if (/^(?:data:|blob:|#)/i.test(ref)) continue;
        try {
          const abs = new URL(ref, base).toString().split("#")[0];
          if (MEDIA_URL_RE.test(abs) && !savedMedia.has(abs)) want.add(abs);
        } catch {}
      }
      if (want.size >= 800) break;
    }
    const list = [...want].slice(0, 800);
    if (!list.length) return;
    await send({ type: "phase", message: `Saving ${list.length} more images and fonts used by the page's CSS…`, progress: progress() });
    let i = 0;
    const worker = async () => {
      while (i < list.length && !stopped()) {
        const url = list[i++];
        try {
          if (await isBlockedHost(new URL(url).hostname)) continue;
          const { buffer, contentType } = await fetchBinary(url, { signal: abort.signal, referer: `${origin}/` });
          if (!buffer.length || /^text\/html/i.test(contentType)) continue;
          const isFont = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(url) || /font/i.test(contentType);
          const ct = contentType || (/\.svg/i.test(url) ? "image/svg+xml" : isFont ? "font/woff2" : "image/png");
          await saveMedia({ url, mediaKind: isFont ? "font" : "image", contentType: ct, base64: buffer.toString("base64"), bytes: buffer.length }, { priority: true });
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
  }

  async function saveNetworkCapture(entry) {
    if (!opts.captureNetwork || stats.networkCaptures >= LIMITS.MAX_NETWORK_CAPTURES) return;
    if (!/json/i.test(entry.contentType)) return;
    let pretty = entry.text;
    try {
      pretty = JSON.stringify(JSON.parse(entry.text), null, 2);
    } catch {
      return;
    }
    const u = new URL(entry.url);
    const q = u.search ? `__${u.search.slice(1).replace(/[^a-z0-9=&_-]+/gi, "_").slice(0, 50)}` : "";
    const base = cleanPath(u.pathname) || "root";
    const path = `network/${u.host}/${base.replace(/\.json$/i, "")}${q}.json`;
    if (await saveFile({ path, type: "json", sourceUrl: `${entry.method || "GET"} ${entry.url}`, content: pretty, kind: "network" })) {
      stats.networkCaptures += 1;
    }
  }

  async function processInline(html, pagePath, pageUrl, suffix) {
    const base = pagePath.replace(/\//g, "_").replace(/\.html?$/i, "") || "page";
    const styles = extractInline(html, "style");
    for (let i = 0; i < styles.length; i += 1) {
      if (await saveFile({ path: `inline/${base}${suffix}/style-${i + 1}.css`, type: "css", sourceUrl: `${pageUrl}#inline-style-${i + 1}`, content: styles[i].content, kind: "inline" })) {
        stats.inlineStyles += 1;
      }
    }
    if (!opts.extractInlineScripts) return;
    const scripts = extractInline(html, "script");
    const bundled = [];
    let n = 0;
    for (const s of scripts) {
      n += 1;
      const isJson = /json/.test(s.type) || s.id === "__NEXT_DATA__";
      if (s.type && !isJson && !/javascript|module/.test(s.type)) continue;
      // Small scripts (analytics snippets, RSC flight pushes) are merged into one file per page.
      if (!isJson && !s.id && s.content.length < 4000) {
        bundled.push(`/* ── inline script #${n} ── */\n${s.content}`);
        continue;
      }
      let content = s.content;
      if (isJson) {
        try {
          content = JSON.stringify(JSON.parse(content), null, 2);
        } catch {}
      }
      const name = s.id ? s.id.replace(/[^a-z0-9_-]+/gi, "_") : `script-${n}`;
      if (await saveFile({ path: `inline/${base}${suffix}/${name}.${isJson ? "json" : "js"}`, type: isJson ? "json" : "js", sourceUrl: `${pageUrl}#${name}`, content, kind: "inline" })) {
        stats.inlineScripts += 1;
      }
    }
    if (bundled.length) {
      if (await saveFile({ path: `inline/${base}${suffix}/inline-scripts.js`, type: "js", sourceUrl: `${pageUrl}#inline-scripts`, content: bundled.join("\n\n"), kind: "inline" })) {
        stats.inlineScripts += bundled.length;
      }
    }
  }

  // ── Engine setup ───────────────────────────────────────────────────────────
  let browserHandle = null;
  let headlessError = null;
  // With a real browser available every page is rendered: the frozen snapshot is what the preview shows.
  let renderBudget = opts.engine === "static" ? 0 : opts.pageLimit;
  let chunkForceRuns = 0;
  if (opts.engine !== "static") {
    try {
      browserHandle = await launchBrowser();
    } catch (error) {
      headlessError = error.message;
      warn(`Headless Chrome unavailable (${error.message}); using static engine with fallbacks.`);
    }
  }

  await send({
    type: "start",
    slug,
    origin,
    engine: browserHandle ? browserHandle.kind : opts.engine === "static" ? "static" : "static+fallback",
    headlessError,
    options: opts,
    ...progress(),
  });

  // ── Page processing ────────────────────────────────────────────────────────
  async function processPage(entry) {
    const { url, depth } = entry;
    const pagePath = makePagePath(new URL(url));
    let originalHtml = null;
    let renderedHtml = null;
    let renderSource = "none";
    let shellDetected = false;
    let pageError = null;
    let rendered = null;

    const wantsHeadless = browserHandle && renderBudget > 0 && opts.engine !== "static";

    try {
      if (!wantsHeadless) {
        const r = await fetchText(url, { signal: abort.signal, referer: depth ? origin : undefined });
        originalHtml = r.text;
        shellDetected = detectShellHtml(originalHtml);
      }

      const shouldRender = wantsHeadless || (opts.engine !== "static" && shellDetected && renderBudget > 0);
      if (shouldRender && browserHandle && !stopped()) {
        renderBudget -= 1;
        const label = new URL(url).pathname;
        await send({ type: "phase", message: `Rendering ${label} in headless Chrome…`, progress: progress() });
        // The lazy-chunk set is site-wide, so forcing it on the first couple of pages is enough.
        const forceHere = opts.forceChunks && chunkForceRuns < 2;
        if (forceHere) chunkForceRuns += 1;
        try {
          rendered = await renderPage(browserHandle.browser, url, {
            forceChunks: forceHere,
            onStep: (s) => send({ type: "phase", message: `Rendering ${label} · ${s}`, progress: progress() }),
            scroll: opts.autoScroll,
            captureNetwork: opts.captureNetwork,
            captureMedia: opts.captureMedia,
            skipMedia: (u) => savedMedia.has(u),
            // Forcing thousands of lazy chunks (Discord, X) needs longer than a plain render.
            deadline: Math.min(deadline - 5000, Date.now() + LIMITS.RENDER_TIMEOUT_MS + (forceHere ? 25_000 : 0)),
            signal: abort.signal,
          });
          renderedHtml = rendered.renderedHtml;
          originalHtml = originalHtml || rendered.originalHtml;
          renderSource = "headless";
          stats.headlessRenders += 1;
        } catch (error) {
          stats.failedRenders += 1;
          warn(`Headless render failed for ${url}: ${error.message}`);
        }
      } else if (shouldRender && !browserHandle) {
        try {
          renderedHtml = await fetchRemoteRendered(url);
          renderSource = "remote";
          stats.remoteRenders += 1;
        } catch {
          try {
            renderedHtml = await fetchProxySnapshot(url);
            renderSource = "proxy";
            stats.proxyRenders += 1;
          } catch (error) {
            stats.failedRenders += 1;
            warn(`All renderers failed for ${url}: ${error.message}`);
          }
        }
      }

      if (!originalHtml) {
        const r = await fetchText(url, { signal: abort.signal });
        originalHtml = r.text;
      }
      shellDetected = shellDetected || detectShellHtml(originalHtml);
      if (shellDetected) stats.shellPages += 1;
      if (renderedHtml) stats.renderedPages += 1;

      detectFrameworks(originalHtml).forEach((f) => frameworks.add(f));
      if (renderedHtml) detectFrameworks(renderedHtml).forEach((f) => frameworks.add(f));
      noteBuildIds(originalHtml);

      let screenshotPath = null;
      if (rendered && rendered.screenshot) {
        const shot = `screenshots/${pagePath.replace(/(?:^|\/)index\.html?$/i, "").replace(/\.html?$/i, "") || "home"}.webp`;
        if (await saveFile({ path: shot, type: "image", sourceUrl: `${url}#screenshot`, content: rendered.screenshot, encoding: "base64", contentType: "image/webp", bytes: Math.round(rendered.screenshot.length * 0.75), kind: "screenshot", priority: true })) {
          screenshotPath = shot;
        }
      }

      await saveFile({
        path: pagePath,
        priority: depth === 0,
        screenshotPath,
        type: "html",
        sourceUrl: url,
        content: originalHtml,
        renderedContent: renderedHtml,
        renderSource,
        shellDetected,
        kind: "page",
      });

      const linkSets = [extractHtmlLinks(originalHtml, url, hints)];
      if (renderedHtml) linkSets.push(extractHtmlLinks(renderedHtml, url, hints));
      for (const set of linkSets) {
        set.pageLinks.forEach((l) => enqueuePage(l, depth + 1));
        set.assetLinks.forEach((l) => enqueueAsset(l));
        set.softAssetLinks.forEach((l) => enqueueAsset(l, { soft: true, fromCode: true }));
      }

      await processInline(originalHtml, pagePath, url, "");

      if (rendered) {
        if (rendered.chunkStats) stats.forcedChunks += rendered.chunkStats.loaded || 0;
        if (rendered.runtimeCss && rendered.runtimeCss.length > 20) {
          const base = pagePath.replace(/\//g, "_").replace(/\.html?$/i, "");
          if (await saveFile({ path: `runtime-css/${base}.css`, type: "css", sourceUrl: `${url}#cssom`, content: rendered.runtimeCss, kind: "runtime", priority: depth === 0 })) {
            stats.runtimeCssFiles += 1;
          }
        }
        for (const resp of rendered.responses) {
          if (stopped()) break;
          if (resp.type === "media") {
            await saveMedia(resp, { priority: depth === 0 });
            continue;
          }
          if (resp.type === "document") continue;
          if (resp.type === "xhr" || resp.type === "fetch") {
            if (/\.(?:m?js|css|map)(?:\?|$)/i.test(resp.url)) {
              if (!savedAssetUrls.has(resp.url)) await ingestAsset(resp.url, resp.text, resp.contentType, { priority: depth === 0 });
            } else {
              await saveNetworkCapture(resp);
            }
            continue;
          }
          if (savedAssetUrls.has(resp.url)) continue;
          try {
            const u = new URL(resp.url);
            if (opts.sameOriginAssetsOnly && u.origin !== origin) continue;
          } catch {
            continue;
          }
          seenAssets.add(resp.url);
          await ingestAsset(resp.url, resp.text, resp.contentType, { allowText: resp.type === "manifest", kind: "captured", priority: depth === 0 });
        }
        if (depth === 0 && opts.captureMedia && !stopped()) {
          const cssList = rendered.responses.filter((r) => r.type === "stylesheet" || /text\/css/i.test(r.contentType || "")).map((r) => ({ css: r.text, base: r.url }));
          for (const m of String(renderedHtml || "").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssList.push({ css: m[1], base: url });
          if (rendered.runtimeCss) cssList.push({ css: rendered.runtimeCss, base: url });
          await completePageMedia(cssList);
        }
        rendered.links.forEach((l) => enqueuePage(l, depth + 1));
        rendered.preloads.forEach((l) => enqueueAsset(l));
        rendered.routes.forEach((r) => enqueuePage(new URL(r, origin).toString(), depth + 1));
        rendered.manifestFiles.forEach((f) => {
          const abs = resolveCodeRef(f, url, { ...hints, nextBase: hints.nextBase || `${origin}/_next/` });
          if (abs) enqueueAsset(abs, { fromCode: true });
        });
      }
    } catch (error) {
      pageError = error.message;
      warn(`Failed page: ${url} (${error.message})`);
    }

    counters.pagesDone += 1;
    await send({ type: "page", url, path: pagePath, depth, rendered: !!renderedHtml, renderSource, shellDetected, error: pageError, chunkStats: rendered && rendered.chunkStats, progress: progress() });
  }

  // ── Asset processing ───────────────────────────────────────────────────────
  async function processAsset(item) {
    const { url, soft, allowText } = item;
    counters.attempts += 1;
    stats.processedAssets += 1;
    let obj;
    try {
      obj = new URL(url);
    } catch {
      return;
    }
    if (opts.sameOriginAssetsOnly && obj.origin !== origin) return;
    if (savedAssetUrls.has(url)) return;
    if (await isBlockedHost(obj.hostname)) return;

    try {
      const accept = /\.css(?:\?|$)/i.test(obj.pathname)
        ? "text/css,*/*;q=0.1"
        : /\.(?:m?js|cjs)(?:\?|$)/i.test(obj.pathname)
          ? "application/javascript,text/javascript,*/*;q=0.1"
          : "application/json,text/plain,*/*;q=0.5";
      // Soft refs are guesses mined from code; fail fast so dead ones don't hold up a worker.
      const r = await fetchText(url, { accept, referer: `${origin}/`, signal: abort.signal, retries: soft ? 0 : 2, timeoutMs: soft ? 6000 : undefined });
      if (r.binary) return;
      const saved = await ingestAsset(url, r.text, r.contentType, { soft, allowText });
      await send({ type: "asset", url, saved, soft, progress: progress() });
    } catch (error) {
      if (!soft) warn(`Failed asset: ${url} (${error.message})`);
      await send({ type: "asset", url, saved: false, soft, error: soft ? null : error.message, progress: progress() });
    }
  }

  // ── Discovery probes (robots, sitemap, manifests) ─────────────────────────
  async function runProbes() {
    for (const p of ["/manifest.json", "/site.webmanifest", "/asset-manifest.json", "/.vite/manifest.json", "/sw.js", "/service-worker.js", "/_nuxt/builds/latest.json"]) {
      enqueueAsset(`${origin}${p}`, { soft: true });
    }
    if (!opts.discoverSitemap) return;
    const sitemapUrls = [`${origin}/sitemap.xml`];
    try {
      const robots = await fetchText(`${origin}/robots.txt`, { signal: abort.signal, retries: 0 });
      if (robots.text && !/^\s*</.test(robots.text)) {
        await saveFile({ path: "robots.txt", type: "text", sourceUrl: `${origin}/robots.txt`, content: robots.text, kind: "probe" });
        sitemapUrls.unshift(...parseRobotsSitemaps(robots.text, origin));
      }
    } catch {}
    for (const sm of [...new Set(sitemapUrls)].slice(0, 3)) {
      try {
        const r = await fetchText(sm, { signal: abort.signal, retries: 0 });
        if (!/<(?:urlset|sitemapindex)/i.test(r.text)) continue;
        let locs = parseSitemap(r.text, origin);
        if (/<sitemapindex/i.test(r.text) && locs.length) {
          const child = await fetchText(locs[0], { signal: abort.signal, retries: 0 }).catch(() => null);
          locs = child ? parseSitemap(child.text, origin) : [];
        }
        let added = 0;
        locs.forEach((l) => {
          const before = queuedPages.size;
          enqueuePage(l, 1);
          if (queuedPages.size > before) added += 1;
        });
        stats.sitemapPages += added;
        if (added) await send({ type: "phase", message: `Sitemap added ${added} pages`, progress: progress() });
        break;
      } catch {}
    }
  }

  // ── Run pools ──────────────────────────────────────────────────────────────
  let activeAssets = 0;
  let pagesDone = false;
  // Each headless tab is mostly waiting on the network, so several in parallel is the main speed win.
  // Serverless gets one vCPU, so fewer tabs there; remote browsers bring their own capacity.
  const pageConcurrency = browserHandle
    ? { "local-chrome": 5, "bundled-chrome": 5, "remote-ws": 4, "serverless-chromium": 2 }[browserHandle.kind] || 3
    : 6;
  const assetConcurrency = browserHandle && browserHandle.kind === "serverless-chromium" ? 16 : 28;
  const maxAttempts = opts.assetLimit * 3 + 400;

  const pageWorker = async () => {
    while (!stopped()) {
      if (visitedPages.size >= opts.pageLimit) return;
      const entry = pageQueue.shift();
      if (!entry) {
        if (activePages === 0) return;
        await sleep(60);
        continue;
      }
      if (visitedPages.has(entry.url)) continue;
      visitedPages.add(entry.url);
      activePages += 1;
      try {
        await processPage(entry);
      } finally {
        activePages -= 1;
      }
    }
  };

  const assetWorker = async () => {
    while (!stopped()) {
      if (stats.savedAssets >= opts.assetLimit || counters.attempts >= maxAttempts) return;
      const item = assetQueue.shift() || softQueue.shift();
      if (!item) {
        if (pagesDone && activeAssets === 0) return;
        await sleep(60);
        continue;
      }
      activeAssets += 1;
      try {
        await processAsset(item);
      } finally {
        activeAssets -= 1;
      }
    }
  };

  const heartbeat = setInterval(() => {
    send({ type: "tick", elapsedMs: Date.now() - startedAt, progress: progress() });
  }, 2000);

  try {
    const probeTask = runProbes();
    const assetTasks = Array.from({ length: assetConcurrency }, assetWorker);
    await Promise.all(Array.from({ length: pageConcurrency }, pageWorker));
    await probeTask;
    pagesDone = true;
    await Promise.all(assetTasks);
    // Workers may have exited early waiting on pages; drain anything left.
    if (!stopped() && (assetQueue.length || softQueue.length)) {
      await Promise.all(Array.from({ length: assetConcurrency }, assetWorker));
    }
  } catch (error) {
    warn(`Scrape aborted: ${error.message}`);
  } finally {
    clearInterval(heartbeat);
    if (browserHandle) {
      (browserHandle.remote ? browserHandle.browser.disconnect() : browserHandle.browser.close()).catch(() => {});
    }
  }

  if (Date.now() > deadline) warn("Time budget reached; results are partial. Lower limits or run again for more.");
  if (abort.signal.aborted) return;

  const discovered = seenAssets.size;
  const assetsCoverage = discovered ? Math.min(1, savedAssetUrls.size / Math.max(1, assetQueue.length + savedAssetUrls.size)) : 1;
  const renderCoverage = stats.shellPages ? Math.min(1, stats.renderedPages / stats.shellPages) : 1;
  const depthScore = Math.min(1, (stats.sourceMapSourcesSaved > 0 ? 0.5 : 0) + (stats.webpackChunksFound + stats.forcedChunks > 0 ? 0.3 : 0) + (stats.runtimeCssFiles > 0 ? 0.2 : 0.1));
  const completenessScore = Math.round((assetsCoverage * 0.35 + renderCoverage * 0.35 + depthScore * 0.3) * 100);

  await send({
    type: "done",
    payload: {
      slug,
      sourceUrl: startUrl.toString(),
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      engine: browserHandle ? browserHandle.kind : "static",
      frameworks: [...frameworks],
      stats: {
        ...stats,
        pagesVisited: visitedPages.size,
        assetsFound: discovered,
        assetsProcessed: stats.processedAssets,
        assetsSaved: stats.savedAssets,
        filesSaved: files.size,
        totalChars: counters.totalChars,
        pageLimit: opts.pageLimit,
        assetLimit: opts.assetLimit,
        maxDepth: opts.maxDepth,
        sameOriginAssetsOnly: opts.sameOriginAssetsOnly,
        renderer: {
          mode: opts.engine,
          shellPagesDetected: stats.shellPages,
          renderedPages: stats.renderedPages,
          headless: stats.headlessRenders,
          remote: stats.remoteRenders,
          proxy: stats.proxyRenders,
          failed: stats.failedRenders,
        },
        quality: { assetsCoverage, renderCoverage, depthScore, completenessScore },
      },
      warnings,
    },
  });
  res.end();
};
