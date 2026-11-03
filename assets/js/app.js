import { icon, hydrateIcons } from "./icons.js";
import * as store from "./store.js";
import { $, $$, escapeHtml, formatBytes, formatDuration, timeAgo, toast, confirmDialog, installRipples, animateNumber, transition, createBoot } from "./ui.js";
import { createWorkspace, loadMonaco } from "./workspace.js";
import { buildPreviewDoc, messageDoc, screenshotDoc, SANDBOX_WITH_SCRIPTS, SANDBOX_NO_SCRIPTS } from "./preview.js";
import { replayOrigin, startReplay, replayShellUrl, REPLAY_SANDBOX } from "./replay.js";
import { installCursor } from "./cursor.js";
import { initAccounts, getToken, isAdminRoute, enterAdmin, guardHeavy, noteScrapeDone, currentUserId, onAuthChange } from "./account.js";
import { initAssistant, showBetaNotice } from "./assistant.js";

const PREFS_KEY = "chroniumx.prefs.v4";
const PAGES = ["home", "workspace", "preview", "console", "updates", "assistant"];
const RING_LEN = 2 * Math.PI * 84;

const state = {
  page: "home",
  scrapes: [],
  slug: null,
  meta: null,
  files: {},
  running: false,
  abort: null,
  logs: [],
  logFilter: "all",
  pvMode: "rendered",
  pvDevice: "desktop",
  pvScripts: false,
  pvHidePopups: true,
  pvBack: [],
  pvFwd: [],
  pvPath: null,
  lastAutoHost: null,
  engineCaps: null,
};

// ── Console log ─────────────────────────────────────────────────────────
const TAGS = { info: "INFO", success: "OK", warn: "WARN", error: "ERR", dim: "SYS" };
let logQueue = [];
let logRaf = 0;
function flushLogs() {
  logRaf = 0;
  const batch = logQueue;
  logQueue = [];
  if (state.page === "console" && batch.length) {
    const box = $("#log");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const frag = document.createDocumentFragment();
    for (const e of batch) if (matchesLog(e)) frag.appendChild(buildLogLine(e));
    box.appendChild(frag);
    while (box.children.length > 2500) box.firstElementChild.remove();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  $("#logCount").textContent = `${state.logs.length} lines`;
}
function log(message, level = "info") {
  const now = new Date();
  const entry = { ts: now.toTimeString().slice(0, 8), level, message: String(message) };
  state.logs.push(entry);
  if (state.logs.length > 6000) state.logs.splice(0, state.logs.length - 5000);
  logQueue.push(entry);
  if (!logRaf) logRaf = requestAnimationFrame(flushLogs);
}
function buildLogLine(e) {
  const line = document.createElement("div");
  line.className = `log-line ${e.level}`;
  line.style.animation = "none";
  line.innerHTML = `<span class="ts">${e.ts}</span><span class="tag">${TAGS[e.level] || "LOG"}</span><span class="msg">${escapeHtml(e.message)}</span>`;
  return line;
}
function matchesLog(e) {
  const q = $("#logSearch").value.trim().toLowerCase();
  if (state.logFilter !== "all" && e.level !== state.logFilter) return false;
  return !q || e.message.toLowerCase().includes(q);
}
function renderLog() {
  const box = $("#log");
  box.innerHTML = "";
  const list = state.logs.filter(matchesLog).slice(-2000);
  const frag = document.createDocumentFragment();
  list.forEach((e) => frag.appendChild(buildLogLine(e)));
  box.appendChild(frag);
  if (!list.length) box.innerHTML = `<div class="pal-empty">Console output will appear here.</div>`;
  box.scrollTop = box.scrollHeight;
}

// ── Prefs ───────────────────────────────────────────────────────────────
const inputs = {
  url: $("#urlInput"),
  pages: $("#pagesInput"),
  assets: $("#assetsInput"),
  depth: $("#depthInput"),
  chunks: $("#optChunks"),
  scroll: $("#optScroll"),
  maps: $("#optMaps"),
  network: $("#optNetwork"),
  media: $("#optMedia"),
  trackers: $("#optTrackers"),
  popups: $("#optPopups"),
  expand: $("#optExpand"),
  sitemap: $("#optSitemap"),
  inline: $("#optInline"),
  vendor: $("#optVendor"),
  sameOrigin: $("#optSameOrigin"),
  slug: $("#slugInput"),
  preferred: $("#preferredInput"),
};
let engine = "auto";

function savePrefs() {
  const p = { engine };
  for (const [k, el] of Object.entries(inputs)) p[k] = el.type === "checkbox" ? el.checked : el.value;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {}
}
function loadPrefs() {
  let p = {};
  try {
    p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {}
  for (const [k, el] of Object.entries(inputs)) {
    if (!(k in p)) continue;
    if (el.type === "checkbox") el.checked = !!p[k];
    else el.value = p[k];
  }
  if (p.engine) engine = p.engine;
  setEngine(engine, false);
  syncRanges();
}
function syncRanges() {
  [
    [inputs.pages, "#pagesOut"],
    [inputs.assets, "#assetsOut"],
    [inputs.depth, "#depthOut"],
  ].forEach(([el, out]) => {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty("--fill", `${pct}%`);
    $(out).textContent = Number(el.value).toLocaleString();
  });
}
function setEngine(value, persist = true) {
  engine = value;
  $$("#engineGroup [data-engine]").forEach((b) => b.classList.toggle("is-active", b.dataset.engine === value));
  if (persist) savePrefs();
}

// Auto-tune always aims for the biggest capture the engine allows; only the shape of the crawl changes per site type.
function autoProfile(host) {
  const h = String(host || "").toLowerCase();
  if (
    /(^|\.)(discord|discordapp|instagram|tiktok|x|twitter|facebook|messenger|reddit|linkedin|threads|roblox|youtube|twitch|spotify|netflix|pinterest|snapchat|whatsapp|tumblr|bsky|figma|notion|canva)\.(com|net|app|tv|gg)$/.test(h) ||
    /(^|\.)discord\./.test(h)
  ) {
    return { name: "Max · JS-heavy app", pages: 30, assets: 15000, depth: 4, engine: "headless", sameOrigin: false };
  }
  if (/(^|\.)(wikipedia|developer\.mozilla|readthedocs)\.|(^|\.)docs\.|\.github\.io$/.test(h)) {
    return { name: "Max · Docs", pages: 100, assets: 8000, depth: 6, engine: "auto", sameOrigin: true };
  }
  if (/(^|\.)(shopify|etsy|amazon|ebay|walmart|aliexpress)\./.test(h) || /myshopify\.com$/.test(h)) {
    return { name: "Max · Commerce", pages: 50, assets: 15000, depth: 5, engine: "headless", sameOrigin: false };
  }
  return { name: "Max", pages: 50, assets: 15000, depth: 5, engine: "headless", sameOrigin: false };
}

function normalizeTarget(raw) {
  let v = String(raw || "").trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return u;
  } catch {
    return null;
  }
}

function applyAutoProfile(force = false) {
  const u = normalizeTarget(inputs.url.value);
  if (!u) return;
  if (!force && state.lastAutoHost === u.hostname && state.lastAutoUrl === u.toString()) return;
  state.lastAutoUrl = u.toString();
  state.lastAutoHost = u.hostname;
  const p = autoProfile(u.hostname);
  inputs.pages.value = p.pages;
  inputs.assets.value = p.assets;
  inputs.depth.value = p.depth;
  inputs.sameOrigin.checked = p.sameOrigin;
  // Auto-tune goes for the biggest capture: every discovery pass on, vendor sources included.
  for (const k of ["chunks", "scroll", "maps", "network", "media", "trackers", "popups", "expand", "sitemap", "inline", "vendor"]) inputs[k].checked = true;
  setEngine(p.engine, false);
  syncRanges();
  savePrefs();
  const chip = $("#profileChip");
  chip.hidden = false;
  chip.innerHTML = `${icon("wand")}Profile: <b>${escapeHtml(p.name)}</b>`;
  if (force) toast("Auto-tuned", `${p.name} profile for ${u.hostname}`, "success", 2400);
}

// ── Navigation ──────────────────────────────────────────────────────────
let indicatorPlaced = false;
function moveIndicator() {
  const active = $(`.nav-btn[data-page="${state.page}"]`);
  const ind = $("#navIndicator");
  if (!active || !active.offsetWidth) return;
  if (!indicatorPlaced) ind.style.transition = "none";
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.transform = `translateX(${active.offsetLeft}px)`;
  if (!indicatorPlaced) {
    void ind.offsetWidth;
    ind.style.transition = "";
    indicatorPlaced = true;
  }
}

function routeFor(page) {
  if (page === "home") return "/";
  if (page === "workspace") {
    if (!state.slug) return "/workspace";
    const path = workspace.activePath();
    return path ? `/${encodeURIComponent(state.slug)}/${path.split("/").map(encodeURIComponent).join("/")}` : `/${encodeURIComponent(state.slug)}`;
  }
  return `/${page}`;
}

async function go(page, { push = true, animate = true } = {}) {
  if (!PAGES.includes(page)) page = "home";
  // Leaving the hidden admin area restores the normal nav.
  const nav = $("#nav");
  if (nav) nav.style.visibility = "";
  if ((page === "workspace" || page === "preview") && !state.slug && state.scrapes.length) {
    let last = null;
    try {
      last = localStorage.getItem("chroniumx.lastSlug");
    } catch {}
    await activateScrape(state.scrapes.some((s) => s.slug === last) ? last : state.scrapes[0].slug);
  }
  const prev = state.page;
  const swap = () => {
    state.page = page;
    window.scrollTo(0, 0);
    $$("main[data-page]").forEach((m) => (m.hidden = m.dataset.page !== page));
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
    $("#toolsBtn").classList.toggle("active", page === "assistant");
    moveIndicator();
    const main = $(`#page-${page}`);
    if (!document.startViewTransition && animate) {
      main.classList.remove("page-enter");
      void main.offsetWidth;
      main.classList.add("page-enter");
    }
  };
  if (animate && prev !== page) await transition(swap);
  else swap();
  if (push) {
    const url = routeFor(page);
    if (location.pathname !== url) history.pushState({}, "", url);
  }
  if (page === "workspace") {
    workspace.layout();
    if (state.slug && !workspace.activePath() && location.pathname.split("/").filter(Boolean).length < 2) {
      const best = bestFile();
      if (best) workspace.openFile(best);
    }
  }
  if (page === "preview") renderPreviewPage();
  if (page === "console") renderLog();
  if (page === "assistant") showBetaNotice();
}

$$(".nav-btn").forEach((b) => b.addEventListener("click", () => go(b.dataset.page)));

// Tools switcher (Scraper / AI Assistant).
$("#toolsBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("#toolsMenu");
  m.hidden = !m.hidden;
  $("#toolsBtn").setAttribute("aria-expanded", String(!m.hidden));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".tools-wrap")) {
    $("#toolsMenu").hidden = true;
    $("#toolsBtn").setAttribute("aria-expanded", "false");
  }
});
$$("#toolsMenu [data-tool]").forEach((b) =>
  b.addEventListener("click", () => {
    $("#toolsMenu").hidden = true;
    go(b.dataset.tool === "assistant" ? "assistant" : "home");
  })
);
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  go("home");
});
window.addEventListener("resize", moveIndicator);

async function applyRoute() {
  // The hidden admin dashboard is reached only at its own obscure path, never through the nav.
  if (isAdminRoute(location.pathname)) {
    state.page = "admin";
    enterAdmin();
    return;
  }
  const parts = location.pathname.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const first = parts[0];
  if (!first) return go("home", { push: false, animate: false });
  if (["updates", "console", "workspace", "assistant"].includes(first)) return go(first, { push: false, animate: false });
  if (first === "preview") {
    if (parts[1] && parts[1] !== state.slug && state.scrapes.some((s) => s.slug === parts[1])) await activateScrape(parts[1]);
    if (parts.length > 2) state.pvPath = parts.slice(2).join("/");
    return go("preview", { push: false, animate: false });
  }
  if (state.scrapes.some((s) => s.slug === first)) {
    if (first !== state.slug) await activateScrape(first);
    await go("workspace", { push: false, animate: false });
    const path = parts.slice(1).join("/");
    if (path && state.files[path]) workspace.openFile(path);
    else {
      const best = bestFile();
      if (best) workspace.openFile(best);
    }
    return;
  }
  history.replaceState({}, "", "/");
  go("home", { push: false, animate: false });
}
window.addEventListener("popstate", applyRoute);

// ── Scrapes library ─────────────────────────────────────────────────────
const AVATAR_GRADS = [
  "linear-gradient(135deg,#34d399,#38bdf8)",
  "linear-gradient(135deg,#a78bfa,#f472b6)",
  "linear-gradient(135deg,#fbbf24,#fb7185)",
  "linear-gradient(135deg,#60a5fa,#a78bfa)",
  "linear-gradient(135deg,#f2f2f2,#9ca3af)",
];
function renderSaved() {
  const grid = $("#savedGrid");
  $("#clearAllBtn").hidden = !state.scrapes.length;
  if (!state.scrapes.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${icon("layers")}<div>No saved scrapes yet. Your captures will appear here.</div></div>`;
    return;
  }
  grid.innerHTML = state.scrapes
    .map((s, i) => {
      const host = (() => {
        try {
          return new URL(s.sourceUrl).hostname.replace(/^www\./, "");
        } catch {
          return s.slug;
        }
      })();
      const grad = AVATAR_GRADS[[...s.slug].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_GRADS.length];
      return `<article class="glass-card site-card" data-slug="${escapeHtml(s.slug)}" style="animation:pageIn .6s var(--ease-out) ${i * 60}ms both">
        <div class="actions">
          <button class="btn btn-xs btn-icon" type="button" data-act="preview" title="Preview">${icon("eye")}</button>
          <button class="btn btn-xs btn-icon btn-danger" type="button" data-act="delete" title="Delete">${icon("trash")}</button>
        </div>
        <div class="top"><div class="avatar" style="background:${grad}">${escapeHtml(host[0] || "?").toUpperCase()}</div>
        <div style="min-width:0"><div class="name">${escapeHtml(s.slug)}${s.partial ? ' <span class="chip" style="height:20px;font-size:10px">partial</span>' : ""}</div><div class="url">${escapeHtml(s.sourceUrl || "")}</div></div></div>
        <div class="meta"><span><b>${(s.fileCount || 0).toLocaleString()}</b> files</span><span><b>${formatBytes(s.totalSize || 0)}</b></span><span>${escapeHtml(timeAgo(s.createdAt))}</span></div>
        ${(s.frameworks || []).length ? `<div class="chip-row" style="justify-content:flex-start;margin-top:10px">${s.frameworks.slice(0, 4).map((f) => `<span class="chip" style="height:24px;font-size:11px">${escapeHtml(f)}</span>`).join("")}</div>` : ""}
      </article>`;
    })
    .join("");
}

$("#savedGrid").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-slug]");
  if (!card) return;
  const slug = card.dataset.slug;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "delete") {
    const ok = await confirmDialog({ title: `Delete ${slug}?`, message: "All captured files and your edits for this scrape will be permanently removed from this browser.", confirmText: "Delete", danger: true });
    if (!ok) return;
    card.style.transition = "all .4s var(--ease)";
    card.style.opacity = "0";
    card.style.transform = "scale(.95)";
    await store.deleteScrape(slug);
    if (state.slug === slug) {
      state.slug = null;
      state.meta = null;
      state.files = {};
      await workspace.load();
    }
    await refreshScrapes();
    toast("Deleted", slug, "info", 2200);
    log(`Deleted scrape ${slug}`, "warn");
    return;
  }
  await activateScrape(slug);
  if (act === "preview") return go("preview");
  await go("workspace");
  const best = bestFile();
  if (best) workspace.openFile(best);
});

$("#clearAllBtn").addEventListener("click", async () => {
  const ok = await confirmDialog({ title: "Delete every scrape?", message: "This permanently removes all captured sites and edits stored in this browser.", confirmText: "Delete all", danger: true });
  if (!ok) return;
  await store.clearAll();
  state.slug = null;
  state.meta = null;
  state.files = {};
  await workspace.load();
  await refreshScrapes();
  toast("Library cleared", "", "info", 2000);
});

// A scrape belongs to whoever made it. Signed in, you see only your own; signed out, only guest
// captures. Scrapes saved before this (no owner) stay visible to everyone as legacy.
function ownsScrape(s) {
  const me = currentUserId() || "guest";
  return !s.owner || s.owner === me;
}
async function refreshScrapes() {
  state.allScrapes = await store.listScrapes();
  state.scrapes = state.allScrapes.filter(ownsScrape);
  renderSaved();
  workspace.renderSites(state.scrapes, state.slug);
}

// Signing in or out re-scopes which scrapes are visible, and closes one you can no longer see.
onAuthChange(async () => {
  const active = state.slug && (state.allScrapes || []).find((s) => s.slug === state.slug);
  if (active && !ownsScrape(active)) {
    state.slug = null;
    state.files = {};
    state.meta = null;
    if (state.page === "workspace" || state.page === "preview") go("home");
  }
  await refreshScrapes().catch(() => {});
});

async function activateScrape(slug) {
  if (workspace.hasDirty()) {
    const ok = await confirmDialog({ title: "Unsaved edits", message: "Switching scrapes will discard unsaved edits in open tabs.", confirmText: "Switch anyway", danger: true });
    if (!ok) {
      workspace.renderSites(state.scrapes, state.slug);
      return false;
    }
  }
  const meta = state.scrapes.find((s) => s.slug === slug);
  if (!meta) return false;
  state.slug = slug;
  state.meta = meta;
  state.files = await store.loadFiles(slug);
  try {
    localStorage.setItem("chroniumx.lastSlug", slug);
  } catch {}
  state.pvPath = null;
  state.pvBack = [];
  state.pvFwd = [];
  await workspace.load();
  workspace.renderSites(state.scrapes, slug);
  return true;
}

const sameUrl = (a, b) => !!a && !!b && String(a).replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase() === String(b).replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
function scorePath(f) {
  const p = f.path.toLowerCase();
  let s = 0;
  // The page the user actually asked to scrape always comes first.
  if (state.meta && sameUrl(f.sourceUrl, state.meta.sourceUrl)) s += 5000;
  if (f.type === "html") s += 500;
  if (p === "index.html") s += 900;
  else if (p.endsWith("/index.html")) s += 300;
  if (f.kind === "page") s += 200;
  s -= p.split("/").length * 4;
  return s;
}
function bestFile({ htmlOnly = false } = {}) {
  const preferred = inputs.preferred.value.trim();
  if (preferred && state.files[preferred] && (!htmlOnly || state.files[preferred].type === "html")) return preferred;
  const list = Object.values(state.files).filter((f) => !htmlOnly || f.type === "html");
  list.sort((a, b) => scorePath(b) - scorePath(a) || a.path.localeCompare(b.path));
  return list[0] ? list[0].path : null;
}

// ── Workspace ───────────────────────────────────────────────────────────
const workspace = createWorkspace({
  files: () => state.files,
  slug: () => state.slug,
  meta: () => state.meta,
  log,
  isVisible: () => state.page === "workspace",
  bestFile: () => bestFile(),
  goHome: () => go("home"),
  async persistFile(file) {
    await store.putFile(state.slug, file);
  },
  async switchScrape(slug) {
    if (!slug) return;
    if (await activateScrape(slug)) {
      history.replaceState({}, "", routeFor("workspace"));
      const best = bestFile();
      if (best) workspace.openFile(best);
    }
  },
  onActiveFile(path) {
    if (state.page !== "workspace" || !state.slug) return;
    const url = routeFor("workspace");
    if (location.pathname !== url) history.replaceState({}, "", url);
  },
});

// ── Mission control ─────────────────────────────────────────────────────
const mission = {
  shownPct: 0,
  startedAt: 0,
  feedQueue: [],
  feedRaf: 0,
  recovered: 0,
};

function setRing(pct, label) {
  const p = Math.max(0, Math.min(100, pct));
  $("#ringFill").style.strokeDashoffset = String(RING_LEN * (1 - p / 100));
  $("#ringPct").textContent = `${Math.round(p)}%`;
  if (label) $("#ringLabel").textContent = label;
  $("#progressBar").style.width = `${p}%`;
}

function setMissionState(text, running) {
  $("#missionState").textContent = text;
  $("#ringWrap").classList.toggle("running", running);
  $("#ringWrap").classList.toggle("idle", !running);
  $("#phaseSpinner").hidden = !running;
  $("#runDot").hidden = !running;
}

function onProgress(p, tick = false) {
  if (!p) return;
  animateNumber($("#statPages"), p.pagesVisited);
  animateNumber($("#statAssets"), p.assetsSaved);
  animateNumber($("#statFiles"), p.filesSaved);
  const done = p.pagesDone != null ? p.pagesDone + (p.activePages || 0) * 0.5 : p.pagesVisited;
  const pageFrac = p.pageLimit ? Math.min(1, done / p.pageLimit) : 0;
  const assetTotal = p.assetsProcessed + p.queued;
  const assetFrac = assetTotal ? p.assetsProcessed / assetTotal : 0;
  const capFrac = p.assetLimit ? p.assetsSaved / p.assetLimit : 0;
  // Asset discovery keeps growing while pages are still crawling, so weight pages heavily until they finish.
  const raw = (pageFrac * 0.55 + Math.max(assetFrac * Math.min(1, pageFrac + 0.25), capFrac) * 0.42) * 100;
  // Long renders send no new counts; creep toward the cap so a working scrape never looks frozen.
  const creep = tick ? mission.shownPct + (97 - mission.shownPct) * 0.012 : mission.shownPct;
  mission.shownPct = Math.max(creep, Math.min(97, raw));
  setRing(mission.shownPct, "capturing");
  const elapsed = (Date.now() - mission.startedAt) / 1000;
  if (mission.shownPct > 4) {
    const eta = (elapsed / mission.shownPct) * (100 - mission.shownPct);
    $("#etaText").textContent = `${formatDuration(elapsed)} · ETA ${formatDuration(eta)}`;
  } else {
    $("#etaText").textContent = formatDuration(elapsed);
  }
}

function queueFeed(file) {
  mission.feedQueue.push(file);
  if (mission.feedQueue.length > 30) mission.feedQueue.splice(0, mission.feedQueue.length - 30);
  if (mission.feedRaf) return;
  const pump = () => {
    const feed = $("#feed");
    const batch = mission.feedQueue.splice(0, 2);
    for (const f of batch) {
      const el = document.createElement("div");
      el.className = "feed-item";
      el.innerHTML = `<span class="type-badge ${escapeHtml(f.type)}">${escapeHtml(f.type)}</span><span class="p">${escapeHtml(f.path)}</span><span style="margin-left:auto;color:var(--faint)">${formatBytes(f.size)}</span>`;
      feed.prepend(el);
      while (feed.children.length > 9) feed.lastElementChild.remove();
    }
    mission.feedRaf = mission.feedQueue.length ? setTimeout(pump, 90) : 0;
  };
  mission.feedRaf = setTimeout(pump, 0);
}

function resetMission() {
  mission.shownPct = 0;
  mission.recovered = 0;
  mission.feedQueue = [];
  $("#feed").innerHTML = "";
  $("#resultSlot").innerHTML = "";
  ["#statPages", "#statAssets", "#statFiles", "#statRecovered"].forEach((s) => ($(s).textContent = "0"));
  setRing(0, "starting");
  $("#etaText").textContent = "";
}

function renderResult(meta) {
  const q = (meta.stats && meta.stats.quality) || {};
  const s = meta.stats || {};
  $("#resultSlot").innerHTML = `<div class="result-card">
    <h4>${icon("checkCircle")} ${meta.partial ? "Partial capture saved" : "Capture complete"} · ${escapeHtml(meta.slug)}</h4>
    <div style="color:var(--muted);font-size:13px">${(meta.fileCount || 0).toLocaleString()} files · ${formatBytes(meta.totalSize)} · ${meta.durationMs ? (meta.durationMs / 1000).toFixed(1) + "s" : ""} · engine ${escapeHtml(meta.engine || "")}${q.completenessScore != null ? ` · completeness ${q.completenessScore}%` : ""}</div>
    <div class="chip-row">${(meta.frameworks || []).map((f) => `<span class="chip"><b>${escapeHtml(f)}</b></span>`).join("")}
      ${s.forcedChunks ? `<span class="chip">${icon("zap")}${s.forcedChunks} lazy chunks forced</span>` : ""}
      ${s.runtimeCssFiles ? `<span class="chip">${icon("layers")}${s.runtimeCssFiles} runtime CSS dumps</span>` : ""}
      ${s.networkCaptures ? `<span class="chip">${icon("activity")}${s.networkCaptures} API responses</span>` : ""}</div>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" type="button" id="openWsBtn">${icon("code")}Open workspace</button>
      <button class="btn btn-sm" type="button" id="openPvBtn">${icon("eye")}Preview</button>
    </div></div>`;
  $("#openWsBtn").onclick = async () => {
    await go("workspace");
    const best = bestFile();
    if (best) workspace.openFile(best);
  };
  $("#openPvBtn").onclick = () => go("preview");
}

// ── Scrape run ──────────────────────────────────────────────────────────
async function readNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      await onEvent(ev);
    }
  }
  if (buf.trim()) {
    try {
      await onEvent(JSON.parse(buf.trim()));
    } catch {}
  }
}

async function runScrape() {
  if (state.running) return;
  const target = normalizeTarget(inputs.url.value);
  if (!target) {
    toast("Enter a valid URL", "Example: https://example.com", "warn");
    inputs.url.focus();
    $("#scrapeForm").animate([{ transform: "translateX(0)" }, { transform: "translateX(-8px)" }, { transform: "translateX(8px)" }, { transform: "translateX(0)" }], { duration: 320 });
    return;
  }
  inputs.url.value = target.toString();
  // Guests can scrape ordinary sites; heavy-JS apps prompt a sign-up and stop here.
  if (!guardHeavy(target.hostname)) return;
  applyAutoProfile();
  savePrefs();

  const body = {
    url: target.toString(),
    maxPages: Number(inputs.pages.value),
    maxAssets: Number(inputs.assets.value),
    maxDepth: Number(inputs.depth.value),
    engine,
    forceChunks: inputs.chunks.checked,
    autoScroll: inputs.scroll.checked,
    probeSourceMaps: inputs.maps.checked,
    captureNetwork: inputs.network.checked,
    captureMedia: inputs.media.checked,
    skipTrackers: inputs.trackers.checked,
    dismissPopups: inputs.popups.checked,
    expandUi: inputs.expand.checked,
    discoverSitemap: inputs.sitemap.checked,
    extractInlineScripts: inputs.inline.checked,
    includeVendorSources: inputs.vendor.checked,
    sameOriginAssetsOnly: inputs.sameOrigin.checked,
  };

  state.running = true;
  state.abort = new AbortController();
  $("#startBtn").hidden = true;
  $("#stopBtn").hidden = false;
  resetMission();
  mission.startedAt = Date.now();
  setMissionState("Running", true);
  $("#phaseText").textContent = `Connecting to ${target.hostname}…`;
  $("#missionPanel").scrollIntoView({ behavior: "smooth", block: "center" });

  log("─".repeat(52), "dim");
  log(`Scrape started → ${body.url}`, "info");
  log(`pages ${body.maxPages} · assets ${body.maxAssets} · depth ${body.maxDepth} · engine ${engine}`, "dim");

  let slug = null;
  let pending = [];
  let flushing = Promise.resolve();
  const seenPaths = new Map();
  let fileCount = 0;
  let totalSize = 0;
  let donePayload = null;
  let lastFlush = Date.now();
  const flush = () => {
    if (!pending.length || !slug) return flushing;
    const batch = pending;
    pending = [];
    lastFlush = Date.now();
    flushing = flushing.then(() => store.putFiles(slug, batch)).catch((err) => log(`Storage error: ${err.message}`, "error"));
    return flushing;
  };

  try {
    const res = await fetch("/api/scrape", {
      method: "POST",
      headers: { "content-type": "application/json", ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
      body: JSON.stringify(body),
      signal: state.abort.signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }

    await readNdjson(res, async (ev) => {
      switch (ev.type) {
        case "start": {
          slug = inputs.slug.value.trim() ? inputs.slug.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || ev.slug : ev.slug;
          if (state.scrapes.some((s) => s.slug === slug)) {
            await store.deleteScrape(slug);
            log(`Replacing previous scrape "${slug}"`, "warn");
          }
          const eng = ev.engine;
          $("#phaseText").textContent = eng.includes("chrome") || eng.includes("chromium") || eng === "remote-ws" ? "Headless Chrome launched — rendering…" : "Static engine crawling…";
          log(`Engine: ${eng}${ev.headlessError ? ` (headless unavailable: ${ev.headlessError})` : ""}`, ev.headlessError ? "warn" : "success");
          break;
        }
        case "phase":
          $("#phaseText").textContent = ev.message;
          log(ev.message, "dim");
          onProgress(ev.progress);
          break;
        case "page":
          log(`Page ${ev.progress.pagesVisited}/${ev.progress.pageLimit} ${ev.url}${ev.rendered ? ` [${ev.renderSource}]` : ""}${ev.chunkStats && ev.chunkStats.loaded ? ` · forced ${ev.chunkStats.loaded} chunks` : ""}`, ev.error ? "warn" : "info");
          if (ev.error) log(`  ↳ ${ev.error}`, "warn");
          $("#phaseText").textContent = `Crawled ${new URL(ev.url).pathname}`;
          onProgress(ev.progress);
          break;
        case "asset":
          if (!ev.soft || ev.saved) log(`${ev.saved ? "Saved" : "Skipped"} ${ev.url}${ev.error ? ` (${ev.error})` : ""}`, ev.saved ? "success" : ev.error ? "warn" : "dim");
          onProgress(ev.progress);
          break;
        case "file": {
          const f = ev.file;
          pending.push(f);
          const sz = f.size + (f.renderedSize || 0);
          totalSize += sz - (seenPaths.get(f.path) || 0);
          seenPaths.set(f.path, sz);
          fileCount = seenPaths.size;
          if (f.kind === "recovered") animateNumber($("#statRecovered"), ++mission.recovered);
          queueFeed(f);
          onProgress(ev.progress);
          if (pending.length >= 60 || Date.now() - lastFlush > 1500) flush();
          break;
        }
        case "tick":
          onProgress(ev.progress, true);
          break;
        case "done":
          donePayload = ev.payload;
          break;
      }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      log("Scrape stopped by user.", "warn");
      toast("Scrape stopped", fileCount ? `Keeping ${fileCount} files captured so far.` : "", "warn");
    } else {
      log(`Scrape failed: ${error.message}`, "error");
      toast("Scrape failed", error.message, "error", 6000);
    }
  }

  await flush();
  await flushing;

  if (slug && fileCount) {
    const meta = {
      slug,
      sourceUrl: (donePayload && donePayload.sourceUrl) || body.url,
      createdAt: new Date().toISOString(),
      durationMs: donePayload ? donePayload.durationMs : Date.now() - mission.startedAt,
      engine: donePayload ? donePayload.engine : "partial",
      frameworks: donePayload ? donePayload.frameworks : [],
      stats: donePayload ? donePayload.stats : {},
      warnings: donePayload ? donePayload.warnings : ["Scrape was interrupted before completion."],
      fileCount,
      totalSize,
      partial: !donePayload,
      owner: currentUserId() || "guest",
    };
    await store.putScrape(meta);
    await refreshScrapes();
    await activateScrape(slug);
    setRing(100, donePayload ? "complete" : "partial");
    animateNumber($("#statFiles"), fileCount);
    renderResult(meta);
    $("#phaseText").textContent = donePayload ? `Done — ${fileCount.toLocaleString()} files captured.` : `Stopped — ${fileCount} files kept.`;
    if (donePayload) {
      log(`Scrape complete: ${fileCount} files (${formatBytes(totalSize)}) in ${(meta.durationMs / 1000).toFixed(1)}s`, "success");
      if (meta.warnings.length) log(`${meta.warnings.length} warnings — see Workspace → Report`, "warn");
      toast("Capture complete", `${fileCount.toLocaleString()} files from ${slug}`, "success", 5000);
      $("#ringWrap").animate([{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }], { duration: 600, easing: "cubic-bezier(.34,1.56,.64,1)" });
      noteScrapeDone();
    }
  } else {
    setRing(0, "ready");
    if (!state.abort.signal.aborted) $("#phaseText").textContent = "No files were captured.";
  }

  setMissionState(donePayload ? "Complete" : "Idle", false);
  $("#etaText").textContent = mission.startedAt ? formatDuration((Date.now() - mission.startedAt) / 1000) : "";
  log("─".repeat(52), "dim");
  state.running = false;
  state.abort = null;
  $("#startBtn").hidden = false;
  $("#stopBtn").hidden = true;
}

$("#scrapeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  runScrape();
});
$("#stopBtn").addEventListener("click", () => state.abort && state.abort.abort());
$$("[data-example]").forEach((b) =>
  b.addEventListener("click", () => {
    inputs.url.value = b.dataset.example;
    applyAutoProfile();
    inputs.url.focus();
  })
);
inputs.url.addEventListener("change", () => applyAutoProfile());
inputs.url.addEventListener("blur", () => applyAutoProfile());
$("#autoTuneBtn").addEventListener("click", () => applyAutoProfile(true));
$$("#engineGroup [data-engine]").forEach((b) => b.addEventListener("click", () => setEngine(b.dataset.engine)));
[inputs.pages, inputs.assets, inputs.depth].forEach((el) => el.addEventListener("input", () => (syncRanges(), savePrefs())));
Object.values(inputs).forEach((el) => el.addEventListener("change", savePrefs));

// ── Preview page ────────────────────────────────────────────────────────
function renderPreviewPage() {
  const sel = $("#pvPage");
  const pages = Object.values(state.files).filter((f) => f.type === "html").sort((a, b) => scorePath(b) - scorePath(a));
  let frame = $("#pvFrame");
  $$("[data-pvmode]").forEach((b) => b.classList.toggle("is-active", b.dataset.pvmode === state.pvMode));
  $$("[data-device]").forEach((b) => b.classList.toggle("is-active", b.dataset.device === state.pvDevice));
  $("#pvScripts").classList.toggle("is-active", state.pvScripts);
  $("#pvPopups").classList.toggle("is-active", state.pvHidePopups);
  $("#device").className = `device ${state.pvDevice}`;
  fitViewport();
  if (!pages.length) {
    sel.innerHTML = `<option>No HTML pages</option>`;
    frame.setAttribute("sandbox", SANDBOX_NO_SCRIPTS);
    frame.srcdoc = messageDoc(state.slug ? "This scrape has no HTML pages to preview." : "No scrape loaded yet. Run a scrape from the Scrape tab.");
    $("#pvStatus").textContent = "";
    $("#pvAddr").textContent = "about:blank";
    return;
  }
  if (!state.pvPath || !state.files[state.pvPath] || state.files[state.pvPath].type !== "html") state.pvPath = pages[0].path;
  sel.innerHTML = pages.map((f) => `<option value="${escapeHtml(f.path)}" ${f.path === state.pvPath ? "selected" : ""}>${escapeHtml(f.path)}</option>`).join("");
  const file = state.files[state.pvPath];
  const hasRendered = !!file.renderedContent;
  const useRendered = state.pvMode === "rendered" && hasRendered;
  if (state.stopReplay) {
    state.stopReplay();
    state.stopReplay = null;
  }
  // A frame that has hosted sandboxed srcdoc pages won't reliably start a real-origin page (and vice
  // versa), so Live always gets a fresh frame element, and so does the first mode after Live.
  if (state.pvMode === "live" || state.pvFrameWasLive) {
    const fresh = frame.cloneNode(false);
    fresh.removeAttribute("src");
    fresh.removeAttribute("srcdoc");
    fresh.removeAttribute("style");
    // Sandbox flags must be right before the frame is inserted; Chromium keeps the flags it was inserted with.
    fresh.setAttribute("sandbox", state.pvMode === "live" ? REPLAY_SANDBOX : SANDBOX_NO_SCRIPTS);
    frame.replaceWith(fresh);
    frame = fresh;
    fitViewport();
  }
  state.pvFrameWasLive = state.pvMode === "live";
  if (state.pvMode === "live") {
    const origin = state.replayOrigin === undefined ? replayOrigin(null) : state.replayOrigin;
    if (!origin) {
      frame.setAttribute("sandbox", SANDBOX_NO_SCRIPTS);
      frame.srcdoc = messageDoc("Live mode needs a second origin to run page code safely. Open the app at localhost or 127.0.0.1, or set REPLAY_ORIGIN on your deployment.");
    } else {
      state.stopReplay = startReplay({
        frame,
        origin,
        slug: state.slug,
        meta: state.meta,
        files: state.files,
        page: file,
        onStatus: (t) => ($("#pvStatus").textContent = t),
        onLog: (m) => {
          state.replayLog = state.replayLog || [];
          state.replayLog.push(m);
          log(`[live] ${m.message}`, m.level === "error" ? "warn" : "dim");
        },
        onError: (msg) => {
          $("#pvStatus").textContent = `Live replay failed: ${msg}`;
          toast("Live replay failed", msg, "error", 5000);
        },
      });
    }
  } else if (state.pvMode === "screenshot") {
    const shot = file.screenshotPath && state.files[file.screenshotPath];
    frame.setAttribute("sandbox", SANDBOX_NO_SCRIPTS);
    frame.srcdoc = screenshotDoc(shot);
  } else {
    frame.setAttribute("sandbox", state.pvScripts ? SANDBOX_WITH_SCRIPTS : SANDBOX_NO_SCRIPTS);
    frame.srcdoc = buildPreviewDoc(file, state.files, { preferRendered: useRendered, scripts: state.pvScripts, hidePopups: state.pvHidePopups });
  }
  $("#pvAddr").textContent = file.sourceUrl || file.path;
  updatePreviewNotice(file, useRendered);
  if (state.pvMode !== "live")
    $("#pvStatus").textContent =
      state.pvMode === "screenshot"
        ? file.screenshotPath
          ? "Screenshot Chrome took during the scrape"
          : "No screenshot for this page"
        : state.pvMode === "rendered"
          ? hasRendered
            ? `Your scraped page (HTML + CSS + images + fonts) · links open other scraped pages${state.pvScripts ? " · site scripts on" : ""}`
            : "This page wasn't rendered in Chrome, so this is its server HTML"
          : `Your scraped server HTML, before JavaScript ran${state.pvScripts ? " · site scripts on" : ""}`;
  $("#pvBack").disabled = !state.pvBack.length;
  $("#pvFwd").disabled = !state.pvFwd.length;
  const url = `/preview/${encodeURIComponent(state.slug)}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
  if (state.page === "preview" && location.pathname !== url) history.replaceState({}, "", url);
}
// Lay the page out at a real device width and scale it down to fit the frame.
const DEVICE_WIDTH = { desktop: 1366, tablet: 768, mobile: 390 };
function fitViewport() {
  const vp = $("#pvViewport");
  const frame = $("#pvFrame");
  if (!vp || !vp.clientWidth) return;
  const target = DEVICE_WIDTH[state.pvDevice] || 1366;
  const avail = vp.clientWidth;
  const width = Math.max(target, state.pvDevice === "desktop" ? avail : 0);
  const scale = Math.min(1, avail / width);
  frame.style.width = `${width}px`;
  frame.style.height = `${Math.ceil(vp.clientHeight / scale)}px`;
  frame.style.transform = scale < 1 ? `scale(${scale})` : "";
}
if (window.ResizeObserver) new ResizeObserver(() => fitViewport()).observe($("#pvViewport"));

// Visible text in an HTML document, ignoring scripts, styles and markup.
function visibleTextLength(html) {
  const body = String(html || "").match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (body ? body[1] : String(html || ""))
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function updatePreviewNotice(file, useRendered) {
  const notice = $("#pvNotice");
  let text = "";
  if (state.pvMode === "screenshot" || state.pvMode === "live") {
    notice.hidden = true;
    return;
  }
  const original = visibleTextLength(file.content);
  if (!useRendered && file.renderedContent) {
    const rendered = visibleTextLength(file.renderedContent);
    if (rendered > 80 && original < rendered * 0.5) {
      text = "Server HTML is the file this site's server sent before its JavaScript ran, so it's mostly empty here. Page shows the same scrape after the JavaScript built it.";
    }
  } else if (state.pvMode === "rendered" && !file.renderedContent && original < 200) {
    text = "This page wasn't rendered in Chrome, and its server HTML is nearly empty. Scrape again with Headless Chrome on to capture what it looks like.";
  }
  notice.hidden = !text;
  $("#pvNoticeText").textContent = text;
  $("#pvNoticeBtn").hidden = !(text && file.renderedContent);
}
$("#pvNoticeBtn").addEventListener("click", () => {
  state.pvMode = "rendered";
  renderPreviewPage();
});

// ── Preview navigation: links inside a scraped page open the matching scraped page ──
function pageForUrl(href) {
  return Object.values(state.files).find((f) => f.type === "html" && f.sourceUrl && sameUrl(f.sourceUrl, href));
}
function goPreviewPage(path, { record = true } = {}) {
  if (!path || path === state.pvPath) return;
  if (record && state.pvPath) {
    state.pvBack.push(state.pvPath);
    state.pvFwd = [];
  }
  state.pvPath = path;
  renderPreviewPage();
}
window.addEventListener("message", (event) => {
  const frame = $("#pvFrame");
  if (!frame || event.source !== frame.contentWindow) return;
  const m = event.data || {};
  if (m.type === "cx-form") {
    toast("Forms are off in Preview", "Submitting would send data to the real site.", "info", 2600);
    return;
  }
  if (m.type !== "cx-nav" || typeof m.href !== "string") return;
  let target;
  try {
    target = new URL(m.href);
  } catch {
    return;
  }
  if (!/^https?:$/.test(target.protocol)) return;
  const page = pageForUrl(target.href);
  if (page) return goPreviewPage(page.path);
  const siteOrigin = state.meta && state.meta.sourceUrl ? new URL(state.meta.sourceUrl).origin : null;
  const sameSite = siteOrigin && target.hostname.replace(/^www\./, "") === new URL(siteOrigin).hostname.replace(/^www\./, "");
  if (sameSite) {
    toast("Page not in this scrape", `${target.pathname} wasn't captured. Raise the page limit or scrape it directly.`, "warn", 3600);
  } else {
    window.open(target.href, "_blank", "noopener");
  }
});
$("#pvBack").addEventListener("click", () => {
  const prev = state.pvBack.pop();
  if (!prev) return;
  state.pvFwd.push(state.pvPath);
  goPreviewPage(prev, { record: false });
});
$("#pvFwd").addEventListener("click", () => {
  const next = state.pvFwd.pop();
  if (!next) return;
  state.pvBack.push(state.pvPath);
  goPreviewPage(next, { record: false });
});

$("#pvPage").addEventListener("change", (e) => goPreviewPage(e.target.value));
$$("[data-pvmode]").forEach((b) =>
  b.addEventListener("click", () => {
    state.pvMode = b.dataset.pvmode;
    renderPreviewPage();
  })
);
$$("[data-device]").forEach((b) =>
  b.addEventListener("click", () => {
    state.pvDevice = b.dataset.device;
    $$("[data-device]").forEach((x) => x.classList.toggle("is-active", x === b));
    $("#device").className = `device ${state.pvDevice}`;
    fitViewport();
  })
);
$("#pvPopups").addEventListener("click", () => {
  state.pvHidePopups = !state.pvHidePopups;
  renderPreviewPage();
  toast(state.pvHidePopups ? "Pop-ups hidden" : "Pop-ups shown", state.pvHidePopups ? "Dialogs, cookie banners and their overlays are removed from the preview." : "Showing the page exactly as it was captured.", "info", 2400);
});
$("#pvScripts").addEventListener("click", () => {
  state.pvScripts = !state.pvScripts;
  renderPreviewPage();
  toast(state.pvScripts ? "Scripts enabled" : "Scripts disabled", "Page JS runs in an isolated sandbox with no access to this app.", "info", 2600);
});
$("#pvReload").addEventListener("click", renderPreviewPage);
$("#pvOpen").addEventListener("click", () => {
  const file = state.pvPath && state.files[state.pvPath];
  if (!file) return;
  if (state.pvMode === "live") {
    // Full window: the page is top-level, so frame-busting code and full-screen layouts behave as on the real site.
    const origin = state.replayOrigin === undefined ? replayOrigin(null) : state.replayOrigin;
    if (!origin) return toast("Live unavailable", "Open the app at localhost, or set REPLAY_ORIGIN.", "warn");
    const win = window.open(replayShellUrl(origin), "_blank");
    if (!win) return toast("Pop-up blocked", "Allow pop-ups for this app to open Live in a full window.", "warn");
    const stop = startReplay({
      win,
      origin,
      slug: state.slug,
      meta: state.meta,
      files: state.files,
      page: file,
      onStatus: () => {},
      onLog: (m) => log(`[live window] ${m.message}`, m.level === "error" ? "warn" : "dim"),
      onError: (msg) => toast("Live replay failed", msg, "error", 5000),
    });
    setTimeout(stop, 10 * 60_000);
    return;
  }
  let html =
    state.pvMode === "screenshot"
      ? screenshotDoc(file.screenshotPath && state.files[file.screenshotPath])
      : buildPreviewDoc(file, state.files, { preferRendered: state.pvMode === "rendered" && !!file.renderedContent, scripts: false, hidePopups: state.pvHidePopups });
  // New tabs share this origin, so scraped scripts are blocked there.
  html = html.replace(/<head([^>]*)>/i, `<head$1><meta http-equiv="Content-Security-Policy" content="script-src 'none'">`);
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

// ── Console page ────────────────────────────────────────────────────────
$$("#logFilters [data-level]").forEach((b) =>
  b.addEventListener("click", () => {
    state.logFilter = b.dataset.level;
    $$("#logFilters [data-level]").forEach((x) => x.classList.toggle("is-active", x === b));
    renderLog();
  })
);
$("#logSearch").addEventListener("input", renderLog);
$("#logClear").addEventListener("click", () => {
  state.logs = [];
  $("#logCount").textContent = "0 lines";
  renderLog();
});
$("#logCopy").addEventListener("click", async () => {
  const text = state.logs.filter(matchesLog).map((e) => `${e.ts} [${TAGS[e.level] || "LOG"}] ${e.message}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied", `${text.split("\n").length} lines`, "success", 1800);
  } catch {
    toast("Copy failed", "Clipboard access was denied.", "error");
  }
});

// ── Engine status ───────────────────────────────────────────────────────
async function checkEngine() {
  const pill = $("#enginePill");
  const label = $("#engineLabel");
  try {
    const res = await fetch("/api/scrape", { method: "GET" });
    const data = await res.json();
    state.engineCaps = data.engine;
    state.replayOrigin = replayOrigin(data.replayOrigin);
    if (data.engine && data.engine.headless) {
      pill.className = "engine-pill glass ok";
      label.textContent = { "local-chrome": "Headless Chrome ready", "serverless-chromium": "Serverless Chromium", "remote-ws": "Remote browser", "bundled-chrome": "Bundled Chrome" }[data.engine.kind] || "Headless ready";
    } else {
      pill.className = "engine-pill glass warn";
      label.textContent = "Static engine";
      pill.title = data.engine && data.engine.reason ? `Headless unavailable: ${data.engine.reason}` : "";
    }
    log(`Engine check: ${data.engine ? data.engine.kind : "unknown"}`, "dim");
  } catch {
    pill.className = "engine-pill glass warn";
    label.textContent = "API offline";
    log("Scrape API is not reachable. Run `npm start` locally or deploy to Vercel.", "error");
  }
}

// ── Boot ────────────────────────────────────────────────────────────────
// Monaco rejects pending work with a "Canceled" error when models are swapped; it's harmless.
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason && (e.reason.name === "Canceled" || e.reason.message === "Canceled")) e.preventDefault();
});

(async function boot() {
  hydrateIcons();
  installRipples();
  installCursor();
  initAccounts().catch(() => {});
  initAssistant();
  const loader = createBoot();
  // Safety net: whatever happens during startup, never leave the boot screen stuck.
  let finished = false;
  const finishOnce = async () => {
    if (finished) return;
    finished = true;
    try {
      window.dispatchEvent(new Event("cx-ready"));
    } catch {}
    try {
      await loader.finish();
    } catch {}
  };
  const safety = setTimeout(finishOnce, 8000);
  window.addEventListener("error", (e) => {
    log(`Startup error: ${e.message}`, "error");
    finishOnce();
  });
  loadPrefs();
  log("ChroniumX v4.16.1 initialized.", "dim");

  loader.step("Opening local vault…", 18);
  try {
    await store.openDb();
    const migrated = await store.migrateLegacy();
    if (migrated) log(`Migrated ${migrated} scrape(s) from v3 storage.`, "success");
  } catch (error) {
    log(`Storage unavailable: ${error.message}`, "error");
  }

  loader.step("Loading saved scrapes…", 40);
  try {
    await refreshScrapes();
  } catch {}

  loader.step("Probing scrape engine…", 62);
  await Promise.race([checkEngine(), new Promise((r) => setTimeout(r, 2500))]);

  loader.step("Warming code editor…", 84);
  await Promise.race([loadMonaco().catch(() => {}), new Promise((r) => setTimeout(r, 2200))]);

  loader.step("Ready", 100);
  try {
    await applyRoute();
  } catch (error) {
    log(`Routing error: ${error.message}`, "error");
    try {
      state.page = "home";
      $$(".page").forEach((p) => (p.hidden = p.id !== "page-home"));
    } catch {}
  }
  moveIndicator();
  clearTimeout(safety);
  await finishOnce();
  moveIndicator();
  if (state.page === "home" && !inputs.url.value) setTimeout(() => inputs.url.focus({ preventScroll: true }), 400);
})();
