"use strict";

const vm = require("vm");
const { normalizeUrl, detectType } = require("./util");

// Reads one JS expression starting at `start`, stopping at a top-level , ; or unmatched closer.
function readExpression(src, start, maxLen = 60_000) {
  let depth = 0;
  let i = start;
  const end = Math.min(src.length, start + maxLen);
  const templateStack = [];
  while (i < end) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < end && src[i] !== ch) i += src[i] === "\\" ? 2 : 1;
    } else if (ch === "`") {
      i += 1;
      while (i < end && src[i] !== "`") {
        if (src[i] === "\\") i += 1;
        else if (src[i] === "$" && src[i + 1] === "{") {
          templateStack.push(depth);
          depth += 1;
          i += 1;
          break;
        }
        i += 1;
      }
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return src.slice(start, i);
      depth -= 1;
      if (ch === "}" && templateStack.length && templateStack[templateStack.length - 1] === depth) {
        templateStack.pop();
        i += 1;
        while (i < end && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
      }
    } else if ((ch === "," || ch === ";") && depth === 0) {
      return src.slice(start, i);
    }
    i += 1;
  }
  return null;
}

function objectKeys(expr) {
  const keys = new Set();
  const re = /[{,]\s*(?:"([^"\\]{1,120})"|'([^'\\]{1,120})'|(\d{1,9})|([A-Za-z_$][\w$]{0,80}))\s*:/g;
  let m;
  while ((m = re.exec(expr)) !== null) keys.add(m[1] || m[2] || m[3] || m[4]);
  return keys;
}

function evalChunkFn(expr) {
  try {
    const fn = vm.runInNewContext(`(${expr})`, Object.create(null), { timeout: 60 });
    return typeof fn === "function" ? fn : null;
  } catch {
    return null;
  }
}

/**
 * Reconstructs every lazy chunk URL from a webpack runtime by evaluating its
 * chunk-filename functions (__webpack_require__.u / .miniCssF) in a sandbox.
 */
function extractWebpackChunkUrls(text, scriptUrl, hints = {}) {
  const src = String(text || "");
  if (!/webpack|\.u\s*=|miniCssF/.test(src)) return [];
  const urls = new Set();

  let publicPath = null;
  const pMatch = src.match(/\b[a-zA-Z_$][\w$]*\.p\s*=\s*(["'])([^"']*)\1/);
  if (pMatch) publicPath = pMatch[2];

  let base;
  if (publicPath && publicPath !== "auto") {
    base = normalizeUrl(publicPath, scriptUrl);
  } else if (hints.nextBase && /\/_next\//.test(scriptUrl)) {
    base = hints.nextBase;
  } else {
    base = new URL(".", scriptUrl).toString();
  }
  if (!base) return [];

  const fnRe = /\b[a-zA-Z_$][\w$]*\.(u|miniCssF|k)\s*=\s*(?=function|\(?\s*[a-zA-Z_$][\w$]*\s*\)?\s*=>)/g;
  let m;
  let guard = 0;
  while ((m = fnRe.exec(src)) !== null && guard < 12) {
    guard += 1;
    const expr = readExpression(src, m.index + m[0].length);
    if (!expr || expr.length > 50_000) continue;
    const fn = evalChunkFn(expr);
    if (!fn) continue;
    const ids = objectKeys(expr);
    let count = 0;
    for (const id of ids) {
      if (count > 4000) break;
      for (const candidate of [id, Number(id)]) {
        if (typeof candidate === "number" && Number.isNaN(candidate)) continue;
        let out;
        try {
          out = fn(candidate);
        } catch {
          continue;
        }
        if (typeof out === "string" && /\.(?:m?js|css)(?:\?|$)/.test(out) && !/undefined/.test(out)) {
          const abs = normalizeUrl(out, base);
          if (abs) {
            urls.add(abs);
            count += 1;
          }
          break;
        }
      }
    }
  }
  return [...urls];
}

function extractBuildIds(text) {
  const ids = new Set();
  const s = String(text || "");
  let m;
  const re1 = /"buildId"\s*:\s*"([^"]+)"/g;
  while ((m = re1.exec(s)) !== null) ids.add(m[1]);
  const re2 = /\/_next\/static\/([\w-]{6,})\/_(?:build|ssg)Manifest\.js/g;
  while ((m = re2.exec(s)) !== null) ids.add(m[1]);
  return [...ids];
}

function parseSitemap(xml, origin, max = 200) {
  const locs = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || ""))) !== null && locs.length < max) {
    const abs = normalizeUrl(m[1].trim(), origin);
    if (abs) locs.push(abs);
  }
  return locs;
}

function parseRobotsSitemaps(text, origin) {
  const out = [];
  String(text || "").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m) {
      const abs = normalizeUrl(m[1], origin);
      if (abs) out.push(abs);
    }
  });
  return out;
}

function normalizeSourceName(raw, index) {
  let name = String(raw || "")
    .replace(/^webpack:\/\/[^/]*\//i, "")
    .replace(/^webpack:\/\//i, "")
    .replace(/^(?:file|vite|rollup|turbopack|ng):\/+/i, "")
    .replace(/^[a-z]:[\\/]/i, "")
    .replace(/\\/g, "/")
    .replace(/\?[^/]*$/, "")
    .replace(/^\/+/, "");
  name = name
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*]+/g, "_"))
    .join("/");
  return name || `source-${index + 1}.js`;
}

/** Turns sourcesContent from a v3 source map into individual original files. */
function extractSourceMapSources(mapText, { includeVendor = false } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(mapText || ""));
  } catch {
    return { files: [], skippedVendor: 0 };
  }
  const maps = Array.isArray(parsed.sections) ? parsed.sections.map((s) => s.map).filter(Boolean) : [parsed];
  const files = [];
  let skippedVendor = 0;
  for (const map of maps) {
    const sources = Array.isArray(map.sources) ? map.sources : [];
    const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
    const root = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
    for (let i = 0; i < sources.length; i += 1) {
      const content = contents[i];
      if (typeof content !== "string" || !content.trim()) continue;
      const name = normalizeSourceName(root && !/^[a-z]+:/i.test(sources[i]) ? `${root}/${sources[i]}` : sources[i], i);
      const isVendor = /(?:^|\/)node_modules\//.test(name) || /^\(webpack\)|^webpack\/(?:runtime|bootstrap)/.test(name);
      if (isVendor && !includeVendor) {
        skippedVendor += 1;
        continue;
      }
      const type = detectType(name);
      const hasExt = /\.[a-z0-9]{1,8}$/i.test(name.split("/").pop());
      files.push({ name, content, type: type === "text" && !hasExt ? "js" : type });
    }
  }
  return { files, skippedVendor };
}

module.exports = {
  extractWebpackChunkUrls,
  extractBuildIds,
  parseSitemap,
  parseRobotsSitemaps,
  extractSourceMapSources,
  readExpression,
};
