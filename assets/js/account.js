import { $, $$, escapeHtml, toast, timeAgo, formatBytes } from "./ui.js";
import { icon, hydrateIcons } from "./icons.js";

/*
 * Accounts + the hidden admin dashboard (client side).
 *
 * The admin page is reached only at an obscure path (ADMIN_ROUTE) that is never linked in the UI.
 * The path is in this file, so on a public repo it isn't truly secret — the real protection is the
 * admin password, which every /api/admin call must carry. To make the route itself private, serve
 * the app with a different ADMIN_ROUTE baked in and keep that build private.
 */
export const ADMIN_ROUTE = "/__cx-control-7q39mz";

const TOKEN_KEY = "chroniumx.token";
let token = null;
let user = null;

export function getToken() {
  return token;
}
export function currentUser() {
  return user;
}

async function api(path, body, method = "POST") {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const authListeners = [];
export function onAuthChange(cb) {
  authListeners.push(cb);
}
export function currentUserId() {
  return user ? user.id : null;
}
function emitAuth() {
  authListeners.forEach((cb) => {
    try {
      cb(user);
    } catch {}
  });
}

function setSession(data) {
  token = data.token;
  user = data.user;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
  renderAcct();
  emitAuth();
}
function clearSession() {
  token = null;
  user = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
  renderAcct();
  emitAuth();
}

function renderAcct() {
  const label = $("#acctLabel");
  if (label) label.textContent = user ? user.username : "Account";
  const btn = $("#acctBtn");
  if (btn) btn.classList.toggle("signed-in", !!user);
  $$(".acct-menu .signed-only").forEach((el) => (el.hidden = !user));
  $$(".acct-menu .guest-only").forEach((el) => (el.hidden = !!user));
  const head = $("#acctMenuHead");
  if (head) {
    head.hidden = !user;
    if (user) head.innerHTML = `Signed in as <b>${escapeHtml(user.username)}</b>`;
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────
const THEME_KEY = "chroniumx.theme";
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const state = $("#miThemeState");
  if (state) state.textContent = theme === "light" ? "Light" : "Dark";
  const icon = $("#miTheme") && $("#miTheme").querySelector("svg");
  // (icon is re-hydrated elsewhere; the label is the clear signal)
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
}
function initTheme() {
  let theme = "dark";
  try {
    theme = localStorage.getItem(THEME_KEY) || "dark";
  } catch {}
  applyTheme(theme);
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
}

// ── Profile dropdown ────────────────────────────────────────────────────────
function openMenu() {
  $("#acctMenu").hidden = false;
  $("#acctBtn").setAttribute("aria-expanded", "true");
}
function closeMenu() {
  $("#acctMenu").hidden = true;
  $("#acctBtn").setAttribute("aria-expanded", "false");
}
function wireMenu() {
  const btn = $("#acctBtn");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    $("#acctMenu").hidden ? openMenu() : closeMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".acct-wrap")) closeMenu();
  });
  $("#miTheme").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTheme();
  });
  $("#miSignin").addEventListener("click", () => {
    closeMenu();
    openAuth("login");
  });
  $("#miSignup").addEventListener("click", () => {
    closeMenu();
    openAuth("signup");
  });
  $("#miLogout").addEventListener("click", () => {
    closeMenu();
    clearSession();
    toast("Logged out", "", "info", 1800);
  });
  $("#miSettings").addEventListener("click", () => {
    closeMenu();
    openSettings();
  });
}

// ── Account settings modal ──────────────────────────────────────────────────
function openSettings() {
  if (!user) return openAuth("login");
  $("#setWho").textContent = `Signed in as ${user.username}`;
  $("#setNewUser").value = user.username;
  $("#setCurPass").value = "";
  $("#setNewPass").value = "";
  $("#setErr").hidden = true;
  $("#setOk").hidden = true;
  $("#settingsModal").classList.add("open");
}
function closeSettings() {
  $("#settingsModal").classList.remove("open");
}
function settingsMsg(ok, text) {
  $("#setErr").hidden = ok;
  $("#setOk").hidden = !ok;
  ($("#setErr").hidden ? $("#setOk") : $("#setErr")).textContent = text;
}
function wireSettings() {
  $("#setClose").addEventListener("click", closeSettings);
  $("#settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") closeSettings();
  });
  $("#setUserForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      setSession(await api("/api/account/username", { username: $("#setNewUser").value.trim() }));
      settingsMsg(true, "Username updated.");
    } catch (error) {
      settingsMsg(false, error.message);
    }
  });
  $("#setPassForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      setSession(await api("/api/account/password", { currentPassword: $("#setCurPass").value, newPassword: $("#setNewPass").value }));
      $("#setCurPass").value = "";
      $("#setNewPass").value = "";
      settingsMsg(true, "Password updated.");
    } catch (error) {
      settingsMsg(false, error.message);
    }
  });
  $("#setLogout").addEventListener("click", () => {
    closeSettings();
    clearSession();
    toast("Logged out", "", "info", 1800);
  });
  $("#setDelete").addEventListener("click", async () => {
    const pw = prompt("Deleting your account can't be undone. Enter your password to confirm:");
    if (!pw) return;
    try {
      await api("/api/account/delete", { password: pw });
      clearSession();
      closeSettings();
      toast("Account deleted", "", "info", 2400);
    } catch (error) {
      settingsMsg(false, error.message);
    }
  });
}

// ── Auth modal ──────────────────────────────────────────────────────────────
let authMode = "login";
function openAuth(mode = "login") {
  authMode = mode;
  $$("#authModal [data-authtab]").forEach((b) => b.classList.toggle("is-active", b.dataset.authtab === mode));
  $("#authTitle").textContent = mode === "signup" ? "Create your account" : "Welcome back";
  $("#authSubmit").textContent = mode === "signup" ? "Create account" : "Sign in";
  $("#authNote").hidden = mode !== "signup";
  $("#authPass").setAttribute("autocomplete", mode === "signup" ? "new-password" : "current-password");
  $("#authErr").hidden = true;
  $("#authModal").classList.add("open");
  setTimeout(() => $("#authUser").focus(), 50);
}
function closeAuth() {
  $("#authModal").classList.remove("open");
}

function wireAuth() {
  $("#authClose").addEventListener("click", closeAuth);
  $("#authModal").addEventListener("click", (e) => {
    if (e.target.id === "authModal") closeAuth();
  });
  $$("#authModal [data-authtab]").forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.authtab)));
  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("#authUser").value.trim();
    const password = $("#authPass").value;
    const err = $("#authErr");
    err.hidden = true;
    $("#authSubmit").disabled = true;
    try {
      const data = await api(`/api/account/${authMode}`, { username, password });
      setSession(data);
      closeAuth();
      $("#authForm").reset();
      toast(authMode === "signup" ? "Account created" : "Signed in", `Welcome, ${data.user.username}`, "success", 2200);
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    } finally {
      $("#authSubmit").disabled = false;
    }
  });
}

async function restore() {
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {}
  if (!token) return;
  try {
    const { user: u } = await api("/api/account/me", null, "GET");
    if (u) user = u;
    else token = null;
  } catch {
    token = null;
  }
  renderAcct();
  emitAuth();
}

// ── Admin dashboard ──────────────────────────────────────────────────────────
let adminPw = null;
let adminData = null;
let adminTab = "scrapes";

async function adminCall(op, extra) {
  const { data } = await api("/api/admin", { password: adminPw, op, ...extra });
  adminData = data;
  renderAdmin();
}

function showAdminPage() {
  $$(".page").forEach((p) => (p.hidden = p.id !== "page-admin"));
  const nav = $("#nav");
  if (nav) nav.style.visibility = "hidden"; // the admin area is off the normal nav
  $("#adminGate").hidden = !!adminPw;
  $("#adminDash").hidden = !adminPw;
  if (adminPw) adminCall("snapshot").catch(() => (adminPw = null));
  else setTimeout(() => $("#adminPw") && $("#adminPw").focus(), 60);
}

function fmtTime(ms) {
  return ms ? timeAgo(ms) : "—";
}

function renderAdmin() {
  if (!adminData) return;
  const s = adminData.stats;
  $("#adminStats").innerHTML = [
    ["Accounts", s.users],
    ["Scrapes logged", s.scrapes],
    ["IP addresses", s.ips],
    ["Blocked IPs", s.blocked],
  ]
    .map(([k, v]) => `<div class="admin-stat glass"><b>${v}</b><span>${k}</span></div>`)
    .join("");

  const q = $("#adminFilter").value.trim().toLowerCase();
  const match = (txt) => !q || txt.toLowerCase().includes(q);
  let html = "";
  if (adminTab === "scrapes") {
    const rows = adminData.scrapeLog.filter((r) => match(`${r.url} ${r.userId || ""} ${r.ip || ""}`));
    html = rows.length
      ? rows
          .map(
            (r) => `<div class="admin-row"><div class="ar-main"><span class="ar-url">${escapeHtml(r.url)}</span><span class="ar-sub">${escapeHtml(r.userId || "guest")} · ${escapeHtml(r.ip || "—")} · ${r.fileCount} files · ${escapeHtml(r.engine || "")} · ${fmtTime(r.at)}</span></div>${r.ip ? `<button class="btn btn-xs btn-danger" data-block="${escapeHtml(r.ip)}">${icon("ban")}Block IP</button>` : ""}</div>`
          )
          .join("")
      : `<div class="pal-empty">No scrapes logged yet.</div>`;
  } else if (adminTab === "users") {
    const rows = adminData.users.filter((u) => match(`${u.username} ${u.lastIp || ""}`));
    html = rows.length
      ? rows
          .map(
            (u) => `<div class="admin-row"><div class="ar-main"><span class="ar-url">${escapeHtml(u.username)}${u.admin ? ' <span class="tag">admin</span>' : ""}${u.banned ? ' <span class="tag dim">banned</span>' : ""}</span><span class="ar-sub">${u.scrapeCount || 0} scrapes · last IP ${escapeHtml(u.lastIp || "—")} · joined ${fmtTime(u.createdAt)}</span></div><div style="display:flex;gap:6px"><button class="btn btn-xs" data-ban="${escapeHtml(u.id)}" data-on="${u.banned ? "0" : "1"}">${icon("ban")}${u.banned ? "Unban" : "Ban"}</button><button class="btn btn-xs btn-danger" data-deluser="${escapeHtml(u.id)}">${icon("trash")}Delete</button></div></div>`
          )
          .join("")
      : `<div class="pal-empty">No accounts yet.</div>`;
  } else {
    const rows = adminData.ips.filter((e) => match(`${e.ip} ${(e.users || []).join(" ")}`));
    html = rows.length
      ? rows
          .map(
            (e) => `<div class="admin-row"><div class="ar-main"><span class="ar-url">${escapeHtml(e.ip)}${e.blocked ? ' <span class="tag dim">blocked</span>' : ""}</span><span class="ar-sub">${e.count} requests · ${(e.users || []).length} account(s) · last ${fmtTime(e.last)}</span></div><button class="btn btn-xs ${e.blocked ? "" : "btn-danger"}" data-block="${escapeHtml(e.ip)}" data-on="${e.blocked ? "0" : "1"}">${icon(e.blocked ? "refresh" : "ban")}${e.blocked ? "Unblock" : "Block"}</button></div>`
          )
          .join("")
      : `<div class="pal-empty">No IPs logged yet.</div>`;
  }
  $("#adminBody").innerHTML = html;
  hydrateIcons();
}

function wireAdmin() {
  $("#adminForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    adminPw = $("#adminPw").value;
    const err = $("#adminErr");
    err.hidden = true;
    try {
      await adminCall("snapshot");
      $("#adminGate").hidden = true;
      $("#adminDash").hidden = false;
    } catch (error) {
      adminPw = null;
      err.textContent = "Wrong password.";
      err.hidden = false;
    }
  });
  $("#adminLock").addEventListener("click", () => {
    adminPw = null;
    adminData = null;
    $("#adminDash").hidden = true;
    $("#adminGate").hidden = false;
    $("#adminPw").value = "";
  });
  $("#adminRefresh").addEventListener("click", () => adminCall("snapshot").catch(() => {}));
  $("#adminClear").addEventListener("click", () => {
    if (confirm("Clear the whole scrape log? Accounts and blocks stay.")) adminCall("clearScrapeLog").catch((e) => toast("Failed", e.message, "error"));
  });
  $("#adminFilter").addEventListener("input", renderAdmin);
  $$("#adminTabs [data-atab]").forEach((b) =>
    b.addEventListener("click", () => {
      adminTab = b.dataset.atab;
      $$("#adminTabs [data-atab]").forEach((x) => x.classList.toggle("is-active", x === b));
      $("#adminFilter").value = "";
      renderAdmin();
    })
  );
  $("#adminBody").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-block],[data-ban],[data-deluser]");
    if (!t) return;
    try {
      if (t.dataset.block) await adminCall("blockIp", { ip: t.dataset.block, on: t.dataset.on !== "0" });
      else if (t.dataset.ban) await adminCall("banUser", { userId: t.dataset.ban, on: t.dataset.on !== "0" });
      else if (t.dataset.deluser && confirm("Delete this account and all its scrape logs?")) await adminCall("deleteUser", { userId: t.dataset.deluser });
    } catch (error) {
      toast("Action failed", error.message, "error");
    }
  });
}

export function isAdminRoute(pathname) {
  return pathname === ADMIN_ROUTE;
}
export function enterAdmin() {
  showAdminPage();
}

// ── Heavy-JS gate (guests may scrape ordinary sites; apps like Roblox need an account) ──
// Mirror of lib/heavy.js — keep the two in sync.
const HEAVY_HOST_RE = /(^|\.)(discord|discordapp|instagram|tiktok|x|twitter|facebook|messenger|reddit|linkedin|threads|roblox|youtube|twitch|spotify|netflix|pinterest|snapchat|whatsapp|tumblr|bsky|figma|notion|canva)\.(com|net|app|tv|gg)$/i;
export function isHeavyHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return HEAVY_HOST_RE.test(h) || /(^|\.)discord\./.test(h);
}
export function isSignedIn() {
  return !!user;
}

// Shows the "make an account" prompt for a heavy site. Returns true if the scrape may continue.
export function guardHeavy(hostname) {
  if (user || !isHeavyHost(hostname)) return true;
  showAccountPrompt(
    "Account needed for JS-heavy sites",
    `${hostname} is a JavaScript-heavy app, so scraping it needs an account. Static sites work without one. Create a free account to continue — it only stores a hashed password.`
  );
  return false;
}

function showAccountPrompt(title, text) {
  const m = $("#modal");
  $("#modalTitle").textContent = title;
  $("#modalText").textContent = text;
  $("#modalActions").innerHTML = `<button class="btn" type="button" id="apLater">Maybe later</button><button class="btn btn-primary" type="button" id="apCreate">Create account</button>`;
  m.classList.add("open");
  const close = () => m.classList.remove("open");
  $("#apLater").onclick = close;
  $("#apCreate").onclick = () => {
    close();
    openAuth("signup");
  };
}

const GUEST_SCRAPES_KEY = "chroniumx.guestScrapes";
// After a guest's first (static-site) scrape, nudge them once to create an account.
export function noteScrapeDone() {
  if (user) return;
  let n = 0;
  try {
    n = Number(localStorage.getItem(GUEST_SCRAPES_KEY) || "0") + 1;
    localStorage.setItem(GUEST_SCRAPES_KEY, String(n));
  } catch {}
  if (n === 1) {
    setTimeout(
      () =>
        showAccountPrompt(
          "Nice — first scrape done!",
          "Create a free account to save your work across devices and unlock JS-heavy sites like Roblox, Discord and Instagram. Your password is only ever stored as a secure hash."
        ),
      900
    );
  }
}

export async function initAccounts() {
  initTheme();
  wireMenu();
  wireAuth();
  wireSettings();
  wireAdmin();
  renderAcct();
  await restore();
}
