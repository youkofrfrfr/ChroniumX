"use strict";

// Local dev server: serves the SPA and mounts /api/scrape exactly like Vercel does.
const http = require("http");
const fs = require("fs");
const path = require("path");
const scrape = require("./api/scrape");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

if (process.env.ALLOW_PRIVATE_TARGETS === undefined) process.env.ALLOW_PRIVATE_TARGETS = "0";

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = path.normalize(path.join(ROOT, urlPath));
  const inPublic =
    filePath.startsWith(path.join(ROOT, "assets")) || filePath.startsWith(path.join(ROOT, "replay")) || filePath === path.join(ROOT, "favicon.svg");
  if (inPublic && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-cache" });
    return fs.createReadStream(filePath).pipe(res);
  }
  res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
  fs.createReadStream(path.join(ROOT, "index.html")).pipe(res);
}

const account = require("./api/account");
const admin = require("./api/admin");

const API = [
  ["/api/scrape", scrape],
  ["/api/account", account],
  ["/api/admin", admin],
];

http
  .createServer((req, res) => {
    const route = API.find(([prefix]) => req.url.startsWith(prefix));
    if (route) {
      const handler = route[1];
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          req.body = raw ? JSON.parse(raw) : {};
        } catch {
          req.body = raw;
        }
        Promise.resolve(handler(req, res)).catch((err) => {
          console.error(err);
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
      });
      return;
    }
    serveStatic(req, res);
  })
  .listen(PORT, () => console.log(`ChroniumX running at http://localhost:${PORT}`));
