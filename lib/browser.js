"use strict";

const fs = require("fs");
const { LIMITS, UA, sleep } = require("./util");
const { isBlockedHost } = require("./fetcher");
const { extractWebpackChunkIds } = require("./discovery");
const { TRACKER_HOST_RE } = require("./intel");

const LOCAL_CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const isServerless = () => !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

/*
 * @sparticuz/chromium only unpacks the system libraries Chromium needs (libnss3 and friends) when
 * AWS_EXECUTION_ENV or AWS_LAMBDA_JS_RUNTIME names the Node version. Vercel's Node 22 functions run
 * on the same Amazon Linux 2023 base but set neither, so Chromium died with "libnss3.so: cannot open
 * shared object file". Declaring the runtime before the package loads makes it unpack al2023.tar.br.
 */
function prepareServerlessChromiumEnv() {
  if (!isServerless()) return;
  const declared = `${process.env.AWS_EXECUTION_ENV || ""} ${process.env.AWS_LAMBDA_JS_RUNTIME || ""}`;
  if (/nodejs\d/i.test(declared)) return;
  const major = Number(process.versions.node.split(".")[0]);
  process.env.AWS_LAMBDA_JS_RUNTIME = `nodejs${major >= 22 ? 22 : 20}.x`;
}
prepareServerlessChromiumEnv();

// Literal require() calls so Vercel's file tracer bundles these packages into the function;
// a require(variable) would be invisible to it and Chrome would be missing at runtime.
function loadPuppeteerCore() {
  try {
    return require("puppeteer-core");
  } catch {
    return null;
  }
}

function loadServerlessChromium() {
  try {
    return require("@sparticuz/chromium");
  } catch {
    return null;
  }
}

function loadFullPuppeteer() {
  try {
    const name = "puppeteer"; // optional local-only dependency, intentionally not traced
    return require(name);
  } catch {
    return null;
  }
}

function findLocalChrome() {
  return LOCAL_CHROME_PATHS.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) || null;
}

/** Reports which headless engine would be used, without launching it. */
function engineCapabilities() {
  const wsEndpoint = process.env.BROWSER_WS_ENDPOINT || process.env.CHROME_WS_ENDPOINT;
  const core = loadPuppeteerCore() || loadFullPuppeteer();
  if (!core) return { headless: false, kind: "none", reason: "puppeteer-core is not installed" };
  if (lastGood) return { headless: true, kind: lastGood };
  if (wsEndpoint) return { headless: true, kind: "remote-ws" };
  if (isServerless() && loadServerlessChromium()) return { headless: true, kind: "serverless-chromium" };
  if (findLocalChrome()) return { headless: true, kind: "local-chrome" };
  if (loadFullPuppeteer()) return { headless: true, kind: "bundled-chrome" };
  return { headless: false, kind: "none", reason: "No Chrome executable found" };
}

/*
 * ── Self-healing browser launcher ──────────────────────────────────────────
 * Tries every way of getting a headless Chrome, in order, repairing common failures on the way,
 * and remembers whichever worked so later scrapes start with it:
 *   1. remote browser (BROWSER_WS_ENDPOINT)          4. Chromium pack downloaded at runtime
 *   2. locally installed Chrome / Chromium / Edge    5. full puppeteer's own Chrome
 *   3. bundled @sparticuz/chromium (+ system libs)
 * If all of them fail, the caller falls back to the static engine with the attempt log.
 */
const os = require("os");
const path = require("path");

const BASE_ARGS = ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--mute-audio", "--hide-scrollbars"];
const VIEWPORT = { width: 1366, height: 900 };
const LAUNCH_TIMEOUT_MS = 45_000;
let lastGood = null;

function chromiumVersion() {
  try {
    return require("@sparticuz/chromium/package.json").version;
  } catch {
    return "131.0.1";
  }
}

function packUrl() {
  if (process.env.CHROMIUM_PACK_URL) return process.env.CHROMIUM_PACK_URL;
  const v = chromiumVersion();
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return arch === "x64"
    ? `https://github.com/Sparticuz/chromium/releases/download/v${v}/chromium-v${v}-pack.tar`
    : `https://github.com/Sparticuz/chromium/releases/download/v${v}/chromium-v${v}-pack.${arch}.tar`;
}

/**
 * Makes sure Chromium's Amazon Linux system libraries (libnss3, libnspr4, libfreebl3, libexpat…)
 * are unpacked and on LD_LIBRARY_PATH, whatever the platform variables say. Unpacks both the
 * AL2023 and AL2 bundles, since a warm container may already hold a Chromium binary unpacked
 * without them.
 */
async function ensureChromiumLibs(binDirs) {
  let lambdafs;
  try {
    lambdafs = require("@sparticuz/chromium/build/lambdafs").default;
  } catch {
    return [];
  }
  const tmp = os.tmpdir();
  const libDirs = [];
  for (const flavor of ["al2023", "al2"]) {
    const libDir = path.join(tmp, flavor, "lib");
    if (!fs.existsSync(path.join(libDir, "libnss3.so"))) {
      for (const dir of binDirs) {
        const tar = path.join(dir, `${flavor}.tar.br`);
        if (!fs.existsSync(tar)) continue;
        try {
          await lambdafs.inflate(tar);
          break;
        } catch {}
      }
    }
    if (fs.existsSync(libDir)) libDirs.push(libDir);
  }
  const current = (process.env.LD_LIBRARY_PATH || "").split(":").filter(Boolean);
  process.env.LD_LIBRARY_PATH = [...new Set([...libDirs, ...current])].join(":");
  process.env.FONTCONFIG_PATH = process.env.FONTCONFIG_PATH || path.join(tmp, "fonts");
  return libDirs;
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => (t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)))]).finally(() => clearTimeout(t));
}

function shortError(error) {
  const msg = String((error && error.message) || error || "unknown error");
  const lib = msg.match(/error while loading shared libraries: ([^:]+)/);
  if (lib) return `missing system library ${lib[1]}`;
  return msg.replace(/\s+TROUBLESHOOTING:[\s\S]*$/, "").replace(/\s+/g, " ").slice(0, 220);
}

async function launchServerlessChromium(lib, { download = false } = {}) {
  const chromium = loadServerlessChromium();
  if (!chromium) throw new Error("@sparticuz/chromium is not installed");
  try {
    chromium.setGraphicsMode = false;
  } catch {}
  const bundledBin = path.join(path.dirname(require.resolve("@sparticuz/chromium")), "..", "bin");
  const packDir = path.join(os.tmpdir(), "chromium-pack");
  if (!download && !fs.existsSync(path.join(bundledBin, "chromium.br")) && !fs.existsSync(path.join(os.tmpdir(), "chromium"))) {
    throw new Error("bundled Chromium binary is missing from this deployment");
  }
  const unpack = () => withTimeout(chromium.executablePath(download ? packUrl() : undefined), 60_000, download ? "Chromium download" : "Chromium unpack");
  let executablePath = await unpack();
  await ensureChromiumLibs([bundledBin, packDir]);
  const variants = [
    { headless: chromium.headless ?? "shell", args: [...(chromium.args || []), ...BASE_ARGS] },
    // Some hosts reject --single-process / zygote flags; retry with a minimal, sandbox-free set.
    { headless: "shell", args: ["--no-sandbox", "--disable-setuid-sandbox", "--no-zygote", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars", "--mute-audio"] },
  ];
  let firstError;
  for (const v of variants) {
    try {
      if (!fs.existsSync(executablePath)) executablePath = await unpack();
      const browser = await withTimeout(lib.launch({ executablePath, headless: v.headless, args: v.args, defaultViewport: VIEWPORT, env: { ...process.env } }), LAUNCH_TIMEOUT_MS, "Chromium launch");
      return browser;
    } catch (error) {
      firstError = firstError || error;
      // A binary unpacked by an older, broken run can be corrupt; drop it so the next try unpacks a fresh one.
      if (/ENOEXEC|exec format|ETXTBSY|spawn .* ENOENT|Exec format/i.test(String(error && error.message))) {
        try {
          fs.rmSync(executablePath, { force: true });
        } catch {}
      }
    }
  }
  throw firstError;
}

function strategies() {
  const wsEndpoint = process.env.BROWSER_WS_ENDPOINT || process.env.CHROME_WS_ENDPOINT;
  const list = [];
  if (wsEndpoint) {
    list.push({
      kind: "remote-ws",
      run: async (lib) => ({ browser: await withTimeout(lib.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: VIEWPORT }), 20_000, "Remote browser connect"), remote: true }),
    });
  }
  const local = findLocalChrome();
  if (local) {
    list.push({
      kind: "local-chrome",
      run: async (lib) => ({ browser: await withTimeout(lib.launch({ executablePath: local, headless: true, args: [...BASE_ARGS, "--no-sandbox"], defaultViewport: VIEWPORT }), LAUNCH_TIMEOUT_MS, "Chrome launch") }),
    });
  }
  if (loadServerlessChromium() && (isServerless() || process.platform === "linux")) {
    list.push({ kind: "serverless-chromium", run: async (lib) => ({ browser: await launchServerlessChromium(lib) }) });
    if (process.env.CHROMIUM_DOWNLOAD !== "0") {
      list.push({ kind: "downloaded-chromium", run: async (lib) => ({ browser: await launchServerlessChromium(lib, { download: true }) }) });
    }
  }
  const full = loadFullPuppeteer();
  if (full) {
    list.push({ kind: "bundled-chrome", run: async () => ({ browser: await withTimeout(full.launch({ headless: true, args: [...BASE_ARGS, "--no-sandbox"], defaultViewport: VIEWPORT }), LAUNCH_TIMEOUT_MS, "Chrome launch") }) });
  }
  // Whatever worked last time goes first.
  if (lastGood) list.sort((a, b) => (b.kind === lastGood) - (a.kind === lastGood));
  return list;
}

/**
 * Launches headless Chrome using the first strategy that works. Returns { browser, kind, remote?, attempts }.
 * Throws an error whose `attempts` lists every strategy and why it failed.
 */
async function launchBrowser() {
  const lib = loadPuppeteerCore() || loadFullPuppeteer();
  if (!lib) throw Object.assign(new Error("puppeteer-core is not installed"), { attempts: [] });
  const attempts = [];
  for (const s of strategies()) {
    const started = Date.now();
    try {
      const { browser, remote } = await s.run(lib);
      // Prove it really works before handing it out.
      const page = await withTimeout(browser.newPage(), 15_000, "Opening a test page");
      await page.close().catch(() => {});
      attempts.push({ kind: s.kind, ok: true, ms: Date.now() - started });
      lastGood = s.kind;
      return { browser, kind: s.kind, remote: !!remote, attempts };
    } catch (error) {
      attempts.push({ kind: s.kind, ok: false, ms: Date.now() - started, error: shortError(error) });
      if (lastGood === s.kind) lastGood = null;
    }
  }
  const summary = attempts.length ? attempts.map((a) => `${a.kind}: ${a.error}`).join("; ") : "no headless browser options are available on this host";
  throw Object.assign(new Error(summary), { attempts });
}

/** Tries every launch strategy (not just the first that works) and reports each result. */
async function diagnoseBrowser() {
  const lib = loadPuppeteerCore() || loadFullPuppeteer();
  const report = {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    serverless: isServerless(),
    env: {
      VERCEL: !!process.env.VERCEL,
      AWS_EXECUTION_ENV: process.env.AWS_EXECUTION_ENV || null,
      AWS_LAMBDA_JS_RUNTIME: process.env.AWS_LAMBDA_JS_RUNTIME || null,
      BROWSER_WS_ENDPOINT: !!(process.env.BROWSER_WS_ENDPOINT || process.env.CHROME_WS_ENDPOINT),
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || null,
    },
    chromiumPackage: loadServerlessChromium() ? chromiumVersion() : null,
    packUrl: loadServerlessChromium() ? packUrl() : null,
    strategies: [],
  };
  if (!lib) {
    report.strategies.push({ kind: "puppeteer", ok: false, error: "puppeteer-core is not installed" });
    return report;
  }
  for (const s of strategies()) {
    const started = Date.now();
    try {
      const { browser, remote } = await s.run(lib);
      const page = await browser.newPage();
      await page.goto("data:text/html,<title>ok</title><p>ok</p>");
      const title = await page.title();
      const version = await browser.version().catch(() => "");
      await page.close().catch(() => {});
      await (remote ? browser.disconnect() : browser.close()).catch(() => {});
      report.strategies.push({ kind: s.kind, ok: title === "ok", version, ms: Date.now() - started });
    } catch (error) {
      report.strategies.push({ kind: s.kind, ok: false, ms: Date.now() - started, error: shortError(error) });
    }
  }
  report.working = report.strategies.filter((x) => x.ok).map((x) => x.kind);
  return report;
}

const CAPTURE_TYPES = new Set(["document", "script", "stylesheet", "xhr", "fetch", "manifest", "other"]);
const BLOCK_TYPES = new Set(["media", "texttrack", "eventsource", "websocket", "ping", "cspviolationreport"]);
// Without media capture, images and fonts are skipped too, which renders faster but previews less faithfully.
const MEDIA_TYPES = new Set(["image", "font"]);
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const MEDIA_PAGE_BUDGET = 120 * 1024 * 1024;
// Analytics, ads and session-replay beacons never matter for source capture and keep the network from going quiet.
const TRACKER_RE = TRACKER_HOST_RE;

/**
 * Tracks in-flight document/script/style/data requests so we can wait for the page to actually
 * settle instead of networkidle, which never fires on sites with long-polling or chatty beacons.
 */
function createNetTracker(page) {
  const inflight = new Map();
  let lastChange = Date.now();
  const relevant = (r) => ["document", "script", "stylesheet", "xhr", "fetch"].includes(r.resourceType());
  page.on("request", (r) => {
    if (!relevant(r)) return;
    inflight.set(r, Date.now());
    lastChange = Date.now();
  });
  const done = (r) => {
    if (inflight.delete(r)) lastChange = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    async settle(idleMs, maxMs, signal) {
      const end = Date.now() + maxMs;
      while (Date.now() < end && !(signal && signal.aborted)) {
        const now = Date.now();
        // Requests open for 4s+ are long-polls/streams; they never finish, so ignore them.
        let active = 0;
        for (const [r, t] of inflight) {
          if (now - t < 4000) active += 1;
          else if (r.resourceType() === "script" || r.resourceType() === "stylesheet") active += now - t < 8000 ? 1 : 0;
        }
        if (active === 0 && now - lastChange >= idleMs) return;
        await sleep(80);
      }
    },
  };
}

/**
 * In-page: grab each webpack/rspack runtime and request every lazy chunk it can reach.
 * Chunk ids come from the chunk-filename functions' source when they inline their maps, and
 * otherwise from the loaded module factories themselves (every lazy import compiles to
 * `__webpack_require__.e(id)`). Newly loaded modules are re-scanned for a few rounds.
 */
async function forceLoadWebpackChunks(budgetMs = 25000, hintIds = []) {
  const started = Date.now();
  const out = { runtimes: 0, ids: 0, loaded: 0, failed: 0, rounds: 0 };
  // webpack/rspack JSONP globals: any global array whose push was swapped for the chunk loader
  // (webpackChunk_N_E, __LOADABLE_LOADED_CHUNKS__, custom chunkLoadingGlobal names…).
  const keys = Object.keys(self).filter((k) => {
    try {
      const v = self[k];
      return Array.isArray(v) && (/^webpackChunk/.test(k) || v.push !== Array.prototype.push);
    } catch {
      return false;
    }
  });
  const ID_RE = /\.e\(\s*(?:"([\w./-]{1,80})"|'([\w./-]{1,80})'|(\d{1,12}))\s*\)/g;
  for (const key of keys) {
    let req = null;
    try {
      self[key].push([[`__chroniumx_probe_${Math.random()}`], {}, (r) => { req = r; }]);
    } catch {}
    if (!req || typeof req.u !== "function" || typeof req.e !== "function") continue;
    out.runtimes += 1;
    const tried = new Set();
    const scannedModules = new Set();
    const nameOf = (id) => {
      try {
        const n = req.u(id);
        return typeof n === "string" ? n.split("?")[0] : null;
      } catch {
        return null;
      }
    };
    // Some runtimes map unknown ids to a placeholder file instead of "undefined"; learn it from bogus ids.
    const bogus = new Set([nameOf(-987654321), nameOf("__chroniumx_none__"), nameOf(999999999999)].filter(Boolean));
    const valid = (id) => {
      const name = nameOf(id);
      return !!name && !/undefined|null/.test(name) && !bogus.has(name);
    };
    // Call the raw chunk handlers (req.f.j, req.f.miniCss…) so app-level retry wrappers around
    // req.e don't add seconds of backoff to every failed id.
    const ensure =
      req.f && Object.keys(req.f).length
        ? (id) => Promise.all(Object.keys(req.f).reduce((promises, k) => (req.f[k](id, promises), promises), []))
        : (id) => req.e(id);
    const collect = () => {
      const ids = new Set(tried.size ? [] : hintIds);
      const sources = [req.u, req.miniCssF].filter((f) => typeof f === "function").map((f) => f.toString());
      for (const src of sources) {
        for (const m of src.matchAll(/[{,]\s*(?:"([^"]+)"|'([^']+)'|(\d+))\s*:/g)) ids.add(m[1] || m[2] || m[3]);
      }
      const factories = req.m || {};
      for (const mid of Object.keys(factories)) {
        if (scannedModules.has(mid)) continue;
        scannedModules.add(mid);
        let src;
        try {
          src = Function.prototype.toString.call(factories[mid]);
        } catch {
          continue;
        }
        if (!src.includes(".e(")) continue;
        for (const m of src.matchAll(ID_RE)) ids.add(m[1] || m[2] || m[3]);
      }
      // Runtimes compare ids strictly — some as strings ("715528"===e), some as numbers — so keep whichever form resolves.
      const out = [];
      for (const raw of ids) {
        if (tried.has(String(raw))) continue;
        const forms = /^\d+$/.test(raw) ? [String(raw), Number(raw)] : [raw];
        const ok = forms.find(valid);
        if (ok !== undefined) out.push(ok);
      }
      return out;
    };
    for (let round = 0; round < 3 && Date.now() - started < budgetMs; round += 1) {
      const list = collect().slice(0, 8000 - tried.size);
      if (!list.length) break;
      out.rounds += 1;
      out.ids += list.length;
      for (let i = 0; i < list.length && Date.now() - started < budgetMs; i += 80) {
        const batch = list.slice(i, i + 80);
        batch.forEach((id) => tried.add(String(id)));
        const results = await Promise.allSettled(batch.map((id) => Promise.race([ensure(id), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))])));
        results.forEach((r) => (r.status === "fulfilled" ? (out.loaded += 1) : (out.failed += 1)));
      }
    }
  }
  return out;
}

/** In-page: dump stylesheet rules that never appear in markup (CSS-in-JS, insertRule, adoptedStyleSheets). */
function dumpRuntimeCss() {
  const chunks = [];
  const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
  for (const sheet of sheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules || !rules.length) continue;
    const owner = sheet.ownerNode;
    const inlineText = owner && owner.tagName === "STYLE" ? (owner.textContent || "").trim() : null;
    const injected = owner && owner.tagName === "STYLE" && inlineText.length < 20;
    const adopted = !owner;
    if (!injected && !adopted) continue;
    const label = adopted
      ? "adoptedStyleSheet"
      : ["data-emotion", "data-styled", "data-jss", "data-styled-components", "data-vite-dev-id"].find((a) => owner.hasAttribute(a)) || "injected <style>";
    chunks.push(`/* ── ${label} (${rules.length} rules) ── */\n${[...rules].map((r) => r.cssText).join("\n")}`);
  }
  return chunks.join("\n\n");
}

/**
 * In-page: closes pop-ups, newsletter modals and cookie banners. It only ever presses buttons that
 * dismiss or decline ("Maybe later", "Close", "Reject all"…), never anything that accepts or signs up.
 */
function closeOverlaysInPage() {
  const SAFE = /^(?:maybe later|not now|no,? thanks?|close|close dialog|close modal|dismiss|skip|later|remind me later|×|✕|✖|x|reject all|reject|decline|decline all|deny|deny all|only necessary|necessary only|use necessary cookies only|essential only|continue without accepting|cancel)$/i;
  const NEVER = /accept|agree|allow|subscribe|sign ?up|log ?in|sign ?in|register|buy|pay|purchase|delete|remove|join/i;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.value || "").trim().replace(/\s+/g, " ");
  const navigates = (el) => el.tagName === "A" && el.getAttribute("href") && !/^(?:#|javascript:)/i.test(el.getAttribute("href"));
  const roots = [
    ...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],[class*="modal" i],[class*="popup" i],[class*="overlay" i],[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="consent" i],[class*="newsletter" i],[id*="onetrust" i]'),
  ].filter(vis);
  let closed = 0;
  const done = new Set();
  for (const root of roots) {
    const buttons = [...root.querySelectorAll('button,[role="button"],a,input[type="button"]')].filter((b) => vis(b) && !navigates(b) && !done.has(b));
    const pick =
      buttons.find((b) => SAFE.test(label(b)) && !NEVER.test(label(b))) ||
      buttons.find((b) => /\b(?:close|dismiss)\b/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || "") && !NEVER.test(label(b)));
    if (pick) {
      done.add(pick);
      pick.click();
      closed += 1;
    }
  }
  document.querySelectorAll("dialog[open]").forEach((d) => {
    try {
      d.close();
    } catch {}
  });
  return closed;
}

async function closeOverlays(page) {
  let total = 0;
  for (let round = 0; round < 3; round += 1) {
    const n = await page.evaluate(closeOverlaysInPage).catch(() => 0);
    await page.keyboard.press("Escape").catch(() => {});
    total += n;
    if (!n) break;
    await sleep(350);
  }
  return total;
}

/**
 * In-page: opens tabs, accordions, FAQ entries and nav dropdowns so code they load lazily gets
 * requested, and returns a function body's worth of state so they can be put back afterwards.
 */
function expandUiInPage() {
  const NEVER = /log ?out|sign ?out|delete|remove|buy|pay|purchase|subscribe|accept/i;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden";
  };
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || "").trim();
  const navigates = (el) => el.closest("a[href]") && !/^(?:#|javascript:)/i.test(el.closest("a[href]").getAttribute("href"));
  window.__cxExpanded = { details: [], toggles: [], tabs: [] };
  for (const d of [...document.querySelectorAll("details:not([open])")].slice(0, 40)) {
    d.open = true;
    window.__cxExpanded.details.push(d);
  }
  const tablists = [...document.querySelectorAll('[role="tablist"]')].slice(0, 6);
  for (const list of tablists) {
    const tabs = [...list.querySelectorAll('[role="tab"]')].filter((t) => vis(t) && !navigates(t) && !NEVER.test(label(t)));
    const selected = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    if (selected) window.__cxExpanded.tabs.push(selected);
    tabs.filter((t) => t !== selected).slice(0, 8).forEach((t) => t.click());
  }
  const toggles = [...document.querySelectorAll('[aria-expanded="false"]')]
    .filter((el) => vis(el) && !navigates(el) && !NEVER.test(label(el)) && el.closest('nav,header,[role="navigation"],[role="menubar"],[class*="menu" i],[class*="accordion" i],[class*="dropdown" i],[class*="faq" i],[class*="collaps" i]'))
    .slice(0, 16);
  toggles.forEach((t) => t.click());
  window.__cxExpanded.toggles = toggles;
  return window.__cxExpanded.details.length + tablists.length + toggles.length;
}

/** In-page: puts expanded UI back the way the page first showed it. */
function restoreUiInPage() {
  const s = window.__cxExpanded;
  if (!s) return;
  s.details.forEach((d) => (d.open = false));
  s.toggles.forEach((t) => {
    if (t.getAttribute("aria-expanded") === "true") t.click();
  });
  s.tabs.forEach((t) => t.click());
}

async function autoScroll(page, maxMs) {
  await page.evaluate(async (budget) => {
    const start = Date.now();
    let last = -1;
    while (Date.now() - start < budget) {
      window.scrollBy(0, Math.max(600, window.innerHeight * 1.1));
      await new Promise((r) => setTimeout(r, 120));
      const y = window.scrollY + window.innerHeight;
      if (y >= document.documentElement.scrollHeight - 4) {
        if (last === document.documentElement.scrollHeight) break;
        last = document.documentElement.scrollHeight;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    window.scrollTo(0, 0);
  }, maxMs).catch(() => {});
}

/**
 * In-page: turns the live, hydrated page into a static, self-contained snapshot that looks the
 * same without running any JS — CSS-in-JS and adopted sheets inlined, form state and canvases
 * frozen, open shadow roots serialized declaratively, every URL made absolute, scripts removed.
 * Runs synchronously so no page script can interleave; the page is discarded afterwards.
 */
function freezeSnapshot() {
  const abs = (v) => {
    try {
      return new URL(v, document.baseURI).href;
    } catch {
      return v;
    }
  };
  const absSrcset = (v) =>
    String(v)
      .split(",")
      .map((part) => {
        const [u, ...rest] = part.trim().split(/\s+/);
        return u ? [abs(u), ...rest].join(" ") : "";
      })
      .filter(Boolean)
      .join(", ");
  const absCss = (css) => css.replace(/url\(\s*(["']?)(?!data:|blob:|#)([^"')]+)\1\s*\)/g, (m, q, u) => `url(${q}${abs(u.trim())}${q})`);
  const roots = [document];
  const shadowRoots = [];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.currentNode; n; n = walker.nextNode()) {
    if (n.shadowRoot) {
      shadowRoots.push(n.shadowRoot);
      roots.push(n.shadowRoot);
    }
  }

  for (const root of roots) {
    // CSS-in-JS libraries insert rules via CSSOM, leaving <style> tags empty in markup.
    root.querySelectorAll("style").forEach((el) => {
      try {
        const rules = el.sheet && el.sheet.cssRules;
        if (!rules || !rules.length) return;
        const text = [...rules].map((r) => r.cssText).join("\n");
        if (text.length > (el.textContent || "").length) el.textContent = text;
      } catch {}
    });
    const adopted = root.adoptedStyleSheets || [];
    if (adopted.length) {
      const css = adopted
        .map((s) => {
          try {
            return [...s.cssRules].map((r) => r.cssText).join("\n");
          } catch {
            return "";
          }
        })
        .join("\n");
      const style = document.createElement("style");
      style.setAttribute("data-cx-adopted", "");
      style.textContent = css;
      (root === document ? document.head || document.documentElement : root).appendChild(style);
    }
    root.querySelectorAll("input").forEach((el) => {
      if (el.type === "password" || el.type === "hidden" || el.type === "file") return el.removeAttribute("value");
      if (el.type === "checkbox" || el.type === "radio") el.toggleAttribute("checked", el.checked);
      else el.setAttribute("value", el.value);
    });
    root.querySelectorAll("textarea").forEach((el) => (el.textContent = el.value));
    root.querySelectorAll("select option").forEach((el) => el.toggleAttribute("selected", el.selected));
    root.querySelectorAll("canvas").forEach((el) => {
      try {
        const data = el.toDataURL("image/webp", 0.8);
        if (data.length > 400_000 || data.length < 200) return;
        const img = document.createElement("img");
        img.src = data;
        img.className = el.className;
        img.setAttribute("style", el.getAttribute("style") || "");
        img.width = el.width;
        img.height = el.height;
        el.replaceWith(img);
      } catch {}
    });
    root.querySelectorAll("img").forEach((el) => {
      const lazy = el.getAttribute("data-src") || el.getAttribute("data-lazy-src") || el.getAttribute("data-original");
      const cur = el.getAttribute("src") || "";
      if (lazy && (!cur || cur.startsWith("data:"))) el.setAttribute("src", lazy);
      const lazySet = el.getAttribute("data-srcset");
      if (lazySet && !el.getAttribute("srcset")) el.setAttribute("srcset", lazySet);
      el.removeAttribute("loading");
    });
    root.querySelectorAll("[src]").forEach((el) => {
      const v = el.getAttribute("src");
      if (v && !v.startsWith("data:")) el.setAttribute("src", abs(v));
    });
    root.querySelectorAll("[href]").forEach((el) => {
      const v = el.getAttribute("href");
      if (v && !/^(?:#|javascript:|mailto:|tel:|data:)/i.test(v)) el.setAttribute("href", abs(v));
    });
    root.querySelectorAll("[srcset]").forEach((el) => el.setAttribute("srcset", absSrcset(el.getAttribute("srcset"))));
    root.querySelectorAll("[poster]").forEach((el) => el.setAttribute("poster", abs(el.getAttribute("poster"))));
    root.querySelectorAll("[style]").forEach((el) => {
      const v = el.getAttribute("style");
      if (v && v.includes("url(")) el.setAttribute("style", absCss(v));
    });
    root.querySelectorAll("style").forEach((el) => {
      if ((el.textContent || "").includes("url(")) el.textContent = absCss(el.textContent);
    });
    root
      .querySelectorAll('script:not([type="application/ld+json"]), noscript, link[rel~="preload"], link[rel~="modulepreload"], link[rel~="prefetch"], link[rel~="dns-prefetch"], link[rel~="preconnect"], meta[http-equiv="refresh" i], meta[http-equiv="content-security-policy" i], base')
      .forEach((el) => el.remove());
    root.querySelectorAll("*").forEach((el) => {
      for (const a of [...el.attributes]) if (/^on[a-z]+$/i.test(a.name)) el.removeAttribute(a.name);
    });
  }

  const head = document.head || document.documentElement.insertBefore(document.createElement("head"), document.body);
  const base = document.createElement("base");
  base.href = location.href;
  head.insertBefore(base, head.firstChild);
  const meta = document.createElement("meta");
  meta.name = "chroniumx-snapshot";
  meta.content = `${location.href} @ ${new Date().toISOString()}`;
  head.insertBefore(meta, base.nextSibling);
  // Scroll position resets in the preview; lock the viewport-dependent scroll-hidden state off.
  document.documentElement.style.removeProperty("overflow");

  const html = document.documentElement;
  const attrs = [...html.attributes].map((a) => ` ${a.name}="${a.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join("");
  let inner;
  try {
    inner = typeof html.getHTML === "function" ? html.getHTML({ serializableShadowRoots: true, shadowRoots }) : html.innerHTML;
  } catch {
    inner = html.innerHTML;
  }
  return `<!DOCTYPE html>\n<html${attrs}>${inner}</html>`;
}

/**
 * Renders one page in headless Chrome and returns every code response it produced,
 * the hydrated DOM, runtime CSS, and in-page framework manifests.
 */
async function renderPage(browser, url, options = {}) {
  const { forceChunks = true, scroll = true, captureNetwork = true, captureMedia = true, screenshot = true, dismissPopups = true, expandUi = true, light = false, deadline = Date.now() + LIMITS.RENDER_TIMEOUT_MS, signal, onStep, skipMedia } = options;
  const workerUrls = new Set();
  let popupsClosed = 0;
  let uiExpanded = 0;
  let mediaBytes = 0;
  const page = await browser.newPage();
  const captured = [];
  const pending = [];
  let mainDocument = null;

  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await page.setRequestInterception(true);
    const net = createNetTracker(page);
    // Dedicated workers load their code outside the page's own request stream; record them here.
    page.on("workercreated", (w) => {
      try {
        if (/^https?:/i.test(w.url())) workerUrls.add(w.url());
      } catch {}
    });

    page.on("request", async (request) => {
      if (request.isInterceptResolutionHandled && request.isInterceptResolutionHandled()) return;
      try {
        const rtype = request.resourceType();
        if (BLOCK_TYPES.has(rtype) || (!captureMedia && MEDIA_TYPES.has(rtype))) return void (await request.abort());
        const u = new URL(request.url());
        if (TRACKER_RE.test(u.hostname) || /\/(?:collect|beacon|track|telemetry|pixel)(?:[/?]|$)/i.test(u.pathname)) {
          return void (await request.abort());
        }
        if ((u.protocol === "http:" || u.protocol === "https:") && (await isBlockedHost(u.hostname))) {
          return void (await request.abort());
        }
        await request.continue();
      } catch {}
    });

    page.on("response", (response) => {
      const request = response.request();
      const type = request.resourceType();
      const ctHead = (response.headers()["content-type"] || "").toLowerCase();
      if (/application\/wasm/.test(ctHead) || /\.wasm(?:\?|$)/i.test(response.url())) {
        // WebAssembly modules are code too; keep their bytes.
        if (response.status() >= 200 && response.status() < 300) {
          const wUrl = response.url();
          pending.push(
            response
              .buffer()
              .then((buf) => {
                if (buf && buf.length && buf.length <= 30 * 1024 * 1024) captured.push({ url: wUrl, type: "media", mediaKind: "wasm", contentType: "application/wasm", base64: buf.toString("base64"), bytes: buf.length });
              })
              .catch(() => {})
          );
        }
        return;
      }
      if (captureMedia && MEDIA_TYPES.has(type)) {
        // Images and fonts are kept as bytes so the preview never depends on the live CDN
        // (cross-origin fonts in particular refuse to load into a sandboxed copy).
        const mUrl = response.url();
        if (response.status() < 200 || response.status() >= 300 || !/^https?:/i.test(mUrl)) return;
        if (skipMedia && skipMedia(mUrl)) return;
        const declared = Number(response.headers()["content-length"] || 0);
        if (declared > MEDIA_MAX_BYTES) return;
        const mType = response.headers()["content-type"] || "";
        pending.push(
          response
            .buffer()
            .then((buf) => {
              if (!buf || !buf.length || buf.length > MEDIA_MAX_BYTES || mediaBytes + buf.length > MEDIA_PAGE_BUDGET) return;
              mediaBytes += buf.length;
              captured.push({ url: mUrl, type: "media", mediaKind: type, contentType: mType.split(";")[0].trim(), base64: buf.toString("base64"), bytes: buf.length });
            })
            .catch(() => {})
        );
        return;
      }
      if (!CAPTURE_TYPES.has(type)) return;
      const status = response.status();
      if (status < 200 || status >= 300) return;
      const resUrl = response.url();
      if (!/^https?:/i.test(resUrl)) return;
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      if (/^(?:image|font|audio|video)\//i.test(contentType)) return;
      if (type === "xhr" || type === "fetch" || type === "other") {
        if (!captureNetwork && type !== "other") return;
        if (!/json|javascript|css|text\/plain|manifest|map/i.test(contentType) && !/\.(?:m?js|css|json|map)(?:\?|$)/i.test(resUrl)) return;
      }
      const job = response
        .text()
        .then((text) => {
          if (!text || text.length > LIMITS.MAX_FILE_CHARS) return;
          const entry = { url: resUrl, type, contentType, text, method: request.method(), ...(type === "document" ? { headers } : {}) };
          if (type === "document" && request.frame() === page.mainFrame() && !mainDocument) mainDocument = entry;
          captured.push(entry);
        })
        .catch(() => {});
      pending.push(job);
    });

    const remaining = () => Math.max(1000, deadline - Date.now());
    const step = (s) => typeof onStep === "function" && onStep(s);
    step("loading");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining() });
    // "light" renders (every page except the one the user typed) wait and scroll less.
    await net.settle(light ? 300 : 450, Math.min(light ? 3500 : 6000, remaining()), signal);
    if (dismissPopups && !(signal && signal.aborted)) {
      step("closing pop-ups");
      popupsClosed += await closeOverlays(page);
    }

    if (scroll && !(signal && signal.aborted)) {
      step("scrolling");
      await autoScroll(page, Math.min(light ? 1200 : 3500, remaining() / 3));
      await net.settle(light ? 250 : 350, Math.min(light ? 1500 : 3000, remaining()), signal);
      // Some pop-ups only appear after scrolling or a delay.
      if (dismissPopups && (!light || popupsClosed)) popupsClosed += await closeOverlays(page);
    }

    if (expandUi && !(signal && signal.aborted)) {
      step("opening menus and tabs");
      uiExpanded = await page.evaluate(expandUiInPage).catch(() => 0);
      if (uiExpanded) {
        await net.settle(400, Math.min(3000, remaining()), signal);
        await page.evaluate(restoreUiInPage).catch(() => {});
        await sleep(250);
        if (dismissPopups) popupsClosed += await closeOverlays(page);
      }
    }

    let chunkStats = null;
    if (forceChunks && !(signal && signal.aborted)) {
      step("forcing lazy chunks");
      chunkStats = await Promise.race([
        (async () => {
          // Runtimes that wrap .u hide their chunk map in a closure; read the ids from the runtime source instead.
          await Promise.race([Promise.allSettled(pending), sleep(6000)]);
          const hintIds = new Set();
          for (const c of captured) {
            if (c.type === "script" && /\.(?:u|miniCssF)\s*=/.test(c.text)) extractWebpackChunkIds(c.text).forEach((id) => hintIds.add(id));
            if (hintIds.size > 12000) break;
          }
          return page.evaluate(forceLoadWebpackChunks, Math.max(3000, Math.min(25000, remaining() - 6000)), [...hintIds].slice(0, 12000));
        })().catch(() => null),
        sleep(Math.min(32000, remaining())).then(() => null),
      ]);
      if (chunkStats && chunkStats.ids) await net.settle(500, Math.min(8000, remaining()), signal);
    }
    step("snapshotting");

    // Pixel-exact reference of what Chrome drew, capped so very long pages stay reasonable.
    let screenshotB64 = null;
    if (screenshot && !(signal && signal.aborted)) {
      try {
        const height = await page.evaluate((max) => Math.min(document.documentElement.scrollHeight || 900, max), light ? 2400 : 7000);
        screenshotB64 = await page.screenshot({
          type: "webp",
          quality: light ? 60 : 72,
          encoding: "base64",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1366, height: Math.max(600, height) },
        });
      } catch {}
    }

    try {
      const swUrls = await page.evaluate(async () => {
        if (!navigator.serviceWorker) return [];
        const regs = await navigator.serviceWorker.getRegistrations();
        return regs.map((r) => (r.active || r.waiting || r.installing || {}).scriptURL).filter(Boolean);
      });
      swUrls.forEach((u) => workerUrls.add(u));
    } catch {}

    const inPage = await page
      .evaluate(() => {
        const bm = self.__BUILD_MANIFEST;
        const manifestFiles = [];
        const routes = [];
        if (bm && typeof bm === "object") {
          for (const [route, files] of Object.entries(bm)) {
            if (route !== "sortedPages" && Array.isArray(files)) files.forEach((f) => typeof f === "string" && /\.(?:m?js|css)$/.test(f) && manifestFiles.push(f));
            if (route.startsWith("/") && !route.includes("[") && !route.startsWith("/_")) routes.push(route);
          }
          if (Array.isArray(bm.sortedPages)) bm.sortedPages.forEach((p) => !p.includes("[") && !p.startsWith("/_") && routes.push(p));
        }
        const links = [...document.querySelectorAll("a[href]")].map((a) => a.href).slice(0, 800);
        const preloads = [...document.querySelectorAll("link[href],script[src]")].map((el) => el.href || el.src).filter(Boolean);
        // Resource timing also lists worker scripts and code fetched by iframes or loaders we never saw as tags.
        try {
          for (const e of performance.getEntriesByType("resource")) {
            if (/\.(?:m?js|css)(?:\?|$)|\/rsrc\.php\//i.test(e.name)) preloads.push(e.name);
          }
        } catch {}
        return { manifestFiles, routes: [...new Set(routes)], links, preloads, title: document.title };
      })
      .catch(() => ({ manifestFiles: [], routes: [], links: [], preloads: [], title: "" }));

    const runtimeCss = await page.evaluate(dumpRuntimeCss).catch(() => "");
    // The frozen snapshot is what the preview shows; fall back to the raw hydrated DOM if it fails.
    let renderedHtml = await page.evaluate(freezeSnapshot).catch(() => "");
    if (!renderedHtml) renderedHtml = await page.content().catch(() => "");

    await Promise.race([Promise.allSettled(pending), sleep(light ? 1200 : 2500)]);

    return {
      originalHtml: mainDocument ? mainDocument.text : null,
      renderedHtml,
      runtimeCss,
      responses: captured.filter((c) => c !== mainDocument),
      links: inPage.links,
      preloads: inPage.preloads,
      manifestFiles: inPage.manifestFiles,
      routes: inPage.routes,
      title: inPage.title,
      chunkStats,
      screenshot: screenshotB64,
      workerUrls: [...workerUrls],
      docHeaders: mainDocument && mainDocument.headers ? mainDocument.headers : null,
      popupsClosed,
      uiExpanded,
    };
  } finally {
    page.close().catch(() => {});
  }
}

module.exports = { launchBrowser, renderPage, engineCapabilities, diagnoseBrowser };
