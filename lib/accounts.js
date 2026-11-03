"use strict";

/*
 * Accounts, sessions and moderation for ChroniumX.
 *
 * Passwords are NEVER stored or logged in readable form: each one is salted and hashed with scrypt,
 * and only the salt + hash are kept. Login re-hashes the attempt and compares. There is deliberately
 * no way to read a password back, which is what protects both the people who sign up and the owner.
 *
 * Persistence is a single JSON file. Locally it lives in ./data; on a serverless host it falls back
 * to /tmp, which is per-instance and wiped between cold starts — fine for a hobby deployment, but use
 * a real database (and set AUTH_SECRET + ADMIN_PASSWORD_HASH as env vars) for anything that must last.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
const DATA_DIR = process.env.CHRONIUMX_DATA_DIR || (IS_SERVERLESS ? path.join(os.tmpdir(), "chroniumx") : path.join(__dirname, "..", "data"));
const DATA_FILE = path.join(DATA_DIR, "accounts.json");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// The admin password is NEVER shipped in this (public) source. It is configured per instance and
// read, in order, from: the ADMIN_PASSWORD_HASH env var ("salt:hash", from `npm run set-admin`),
// the ADMIN_PASSWORD env var (hashed at boot), or an admin hash saved in the gitignored data file
// (written by `npm run set-admin`). If none is set, the admin dashboard stays locked for everyone.
let cache = null;

function load() {
  if (cache) return cache;
  cache = { users: {}, scrapeLog: [], ipLog: {}, blockedIps: {}, secret: null };
  try {
    if (fs.existsSync(DATA_FILE)) cache = { ...cache, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
  } catch {}
  if (!cache.secret) {
    cache.secret = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");
    save();
  }
  return cache;
}

let saveTimer = null;
function save() {
  if (!cache) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

// ── Password hashing ────────────────────────────────────────────────────────
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const attempt = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

// ── Tokens (HMAC-signed, stateless) ─────────────────────────────────────────
function signToken(userId) {
  const body = `${userId}.${Date.now() + TOKEN_TTL_MS}`;
  const sig = crypto.createHmac("sha256", load().secret).update(body).digest("base64url");
  return `${Buffer.from(body).toString("base64url")}.${sig}`;
}
function verifyToken(token) {
  try {
    const [b64, sig] = String(token || "").split(".");
    if (!b64 || !sig) return null;
    const body = Buffer.from(b64, "base64url").toString();
    const expected = crypto.createHmac("sha256", load().secret).update(body).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const [userId, expiry] = body.split(".");
    if (Number(expiry) < Date.now()) return null;
    const user = load().users[userId];
    return user && !user.banned ? user : null;
  } catch {
    return null;
  }
}

// ── Accounts ────────────────────────────────────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function publicUser(u) {
  return { id: u.id, username: u.username, admin: !!u.admin, createdAt: u.createdAt, scrapeCount: u.scrapeCount || 0 };
}

function signup({ username, password, ip }) {
  const db = load();
  username = String(username || "").trim();
  if (!USERNAME_RE.test(username)) throw new Error("Username must be 3–32 letters, numbers, . _ or -");
  if (String(password || "").length < 8) throw new Error("Password must be at least 8 characters");
  const id = username.toLowerCase();
  if (db.users[id]) throw new Error("That username is taken");
  const user = { id, username, password: hashPassword(password), createdAt: Date.now(), scrapeCount: 0, lastIp: ip || null };
  db.users[id] = user;
  recordIp(ip, id);
  save();
  return { user: publicUser(user), token: signToken(id) };
}

function login({ username, password, ip }) {
  const db = load();
  const id = String(username || "").trim().toLowerCase();
  const user = db.users[id];
  // Verify even when the user is missing, so timing doesn't reveal which usernames exist.
  const ok = verifyPassword(password, user ? user.password : "x:0");
  if (!user || !ok) throw new Error("Wrong username or password");
  if (user.banned) throw new Error("This account has been disabled");
  user.lastIp = ip || user.lastIp;
  user.lastLogin = Date.now();
  recordIp(ip, id);
  saveSoon();
  return { user: publicUser(user), token: signToken(id) };
}

function changeUsername({ userId, newUsername }) {
  const db = load();
  const u = db.users[userId];
  if (!u) throw new Error("Not signed in");
  const name = String(newUsername || "").trim();
  if (!USERNAME_RE.test(name)) throw new Error("Username must be 3–32 letters, numbers, . _ or -");
  const newId = name.toLowerCase();
  if (newId !== userId && db.users[newId]) throw new Error("That username is taken");
  // The id is the lowercased username, so a change that alters the id re-keys the record and its logs.
  if (newId !== userId) {
    delete db.users[userId];
    u.id = newId;
    db.users[newId] = u;
    db.scrapeLog.forEach((r) => (r.userId === userId ? (r.userId = newId) : null));
    for (const e of Object.values(db.ipLog)) e.users = e.users.map((x) => (x === userId ? newId : x));
  }
  u.username = name;
  save();
  return { user: publicUser(u), token: signToken(u.id) };
}

function changePassword({ userId, currentPassword, newPassword }) {
  const db = load();
  const u = db.users[userId];
  if (!u) throw new Error("Not signed in");
  if (!verifyPassword(currentPassword, u.password)) throw new Error("Current password is wrong");
  if (String(newPassword || "").length < 8) throw new Error("New password must be at least 8 characters");
  u.password = hashPassword(newPassword);
  save();
  return { user: publicUser(u), token: signToken(u.id) };
}

function deleteSelf({ userId, password }) {
  const db = load();
  const u = db.users[userId];
  if (!u) throw new Error("Not signed in");
  if (!verifyPassword(password, u.password)) throw new Error("Password is wrong");
  deleteUser(userId);
  return { ok: true };
}

// ── Saved AI chats (per account) ────────────────────────────────────────────
function setChat(userId, chat) {
  const db = load();
  const u = db.users[userId];
  if (!u) return;
  try {
    if (JSON.stringify(chat || {}).length > 2_000_000) return; // ~2MB cap per account
  } catch {
    return;
  }
  u.chat = chat || null;
  saveSoon();
}
function getChat(userId) {
  const u = load().users[userId];
  return (u && u.chat) || null;
}

// ── Activity logging (for abuse moderation) ─────────────────────────────────
function recordIp(ip, userId) {
  if (!ip) return;
  const db = load();
  const e = db.ipLog[ip] || { ip, first: Date.now(), count: 0, users: [] };
  e.last = Date.now();
  e.count += 1;
  if (userId && !e.users.includes(userId)) e.users.push(userId);
  db.ipLog[ip] = e;
}

function logScrape({ url, slug, ip, userId, fileCount, engine }) {
  const db = load();
  db.scrapeLog.unshift({ at: Date.now(), url, slug, ip: ip || null, userId: userId || null, fileCount: fileCount || 0, engine: engine || null });
  if (db.scrapeLog.length > 5000) db.scrapeLog.length = 5000;
  if (userId && db.users[userId]) db.users[userId].scrapeCount = (db.users[userId].scrapeCount || 0) + 1;
  recordIp(ip, userId);
  saveSoon();
}

function isIpBlocked(ip) {
  return !!(ip && load().blockedIps[ip]);
}

// ── Admin ───────────────────────────────────────────────────────────────────
function adminHash() {
  if (process.env.ADMIN_PASSWORD_HASH) return process.env.ADMIN_PASSWORD_HASH;
  if (process.env.ADMIN_PASSWORD) return hashPassword(process.env.ADMIN_PASSWORD, "env-admin-salt");
  return load().adminHash || null;
}
function adminConfigured() {
  return !!adminHash();
}
// Persists an admin hash to the (gitignored) data file, so the plaintext never touches the repo.
function setAdminHash(hash) {
  load().adminHash = hash;
  save();
}
function verifyAdmin(password) {
  const h = adminHash();
  return !!h && verifyPassword(password, h);
}

function adminSnapshot() {
  const db = load();
  return {
    users: Object.values(db.users).map((u) => ({ ...publicUser(u), banned: !!u.banned, lastIp: u.lastIp || null, lastLogin: u.lastLogin || null })),
    scrapeLog: db.scrapeLog.slice(0, 500),
    ips: Object.values(db.ipLog)
      .map((e) => ({ ...e, blocked: !!db.blockedIps[e.ip] }))
      .sort((a, b) => b.last - a.last)
      .slice(0, 500),
    blockedIps: Object.keys(db.blockedIps),
    stats: { users: Object.keys(db.users).length, scrapes: db.scrapeLog.length, ips: Object.keys(db.ipLog).length, blocked: Object.keys(db.blockedIps).length },
  };
}

function blockIp(ip, on = true) {
  const db = load();
  if (on) db.blockedIps[ip] = { at: Date.now() };
  else delete db.blockedIps[ip];
  save();
}
function banUser(userId, on = true) {
  const db = load();
  if (db.users[userId]) db.users[userId].banned = on;
  save();
}
function deleteUser(userId) {
  const db = load();
  delete db.users[userId];
  db.scrapeLog = db.scrapeLog.filter((s) => s.userId !== userId);
  save();
}
function clearScrapeLog() {
  const db = load();
  db.scrapeLog = [];
  save();
}

module.exports = {
  signup,
  login,
  changeUsername,
  changePassword,
  deleteSelf,
  setChat,
  getChat,
  verifyToken,
  publicUser,
  logScrape,
  recordIp,
  isIpBlocked,
  verifyAdmin,
  adminConfigured,
  setAdminHash,
  adminSnapshot,
  blockIp,
  banUser,
  deleteUser,
  clearScrapeLog,
  hashPassword,
};
