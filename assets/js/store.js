// IndexedDB persistence: scrape metadata in `scrapes`, file bodies in `files` keyed by [slug, path].
const DB_NAME = "chroniumx";
const DB_VERSION = 1;
const LEGACY_KEY = "sourcevault.scrapes.v1";
let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB unavailable"));
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("scrapes")) db.createObjectStore("scrapes", { keyPath: "slug" });
      if (!db.objectStoreNames.contains("files")) {
        const files = db.createObjectStore("files", { keyPath: ["slug", "path"] });
        files.createIndex("bySlug", "slug");
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

export async function listScrapes() {
  const db = await openDb();
  const all = await req(db.transaction("scrapes").objectStore("scrapes").getAll());
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function loadFiles(slug) {
  const db = await openDb();
  const rows = await req(db.transaction("files").objectStore("files").index("bySlug").getAll(IDBKeyRange.only(slug)));
  const map = {};
  rows.forEach((r) => (map[r.path] = r));
  return map;
}

export async function putScrape(meta) {
  const db = await openDb();
  const tx = db.transaction("scrapes", "readwrite");
  tx.objectStore("scrapes").put(meta);
  return txDone(tx);
}

export async function putFiles(slug, files) {
  if (!files.length) return;
  const db = await openDb();
  const tx = db.transaction("files", "readwrite");
  const store = tx.objectStore("files");
  files.forEach((f) => store.put({ ...f, slug }));
  return txDone(tx);
}

export async function putFile(slug, file) {
  return putFiles(slug, [file]);
}

export async function deleteScrape(slug) {
  const db = await openDb();
  const tx = db.transaction(["scrapes", "files"], "readwrite");
  tx.objectStore("scrapes").delete(slug);
  const idx = tx.objectStore("files").index("bySlug");
  const cursorReq = idx.openKeyCursor(IDBKeyRange.only(slug));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      tx.objectStore("files").delete(cursor.primaryKey);
      cursor.continue();
    }
  };
  return txDone(tx);
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(["scrapes", "files"], "readwrite");
  tx.objectStore("scrapes").clear();
  tx.objectStore("files").clear();
  return txDone(tx);
}

/** One-time import of scrapes saved by ChroniumX v3 in localStorage. */
export async function migrateLegacy() {
  let raw;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return 0;
  }
  if (!raw) return 0;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  let count = 0;
  for (const scrape of Object.values(parsed || {})) {
    if (!scrape || !scrape.slug || !scrape.files) continue;
    const files = Object.values(scrape.files).map((f) => ({ ...f, kind: f.kind || (f.type === "html" ? "page" : "asset") }));
    await putFiles(scrape.slug, files);
    await putScrape({
      slug: scrape.slug,
      sourceUrl: scrape.sourceUrl,
      createdAt: scrape.createdAt,
      stats: scrape.stats || {},
      warnings: scrape.warnings || [],
      frameworks: [],
      engine: "legacy",
      fileCount: files.length,
      totalSize: files.reduce((n, f) => n + (f.size || 0), 0),
    });
    count += 1;
  }
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {}
  return count;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch {}
  return null;
}
