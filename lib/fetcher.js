"use strict";

const dns = require("dns").promises;
const net = require("net");
const { LIMITS, UA, sleep } = require("./util");

const hostVerdicts = new Map();

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

// Blocks scraping internal networks unless explicitly allowed (local dev).
async function isBlockedHost(hostname) {
  if (process.env.ALLOW_PRIVATE_TARGETS === "1") return false;
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (hostVerdicts.has(host)) return hostVerdicts.get(host);
  let blocked = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal");
  if (!blocked) {
    try {
      const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
      blocked = addrs.some((a) => isPrivateIp(a.address));
    } catch {
      blocked = false;
    }
  }
  hostVerdicts.set(host, blocked);
  return blocked;
}

const BINARY_CT_RE = /^(?:image|audio|video|font)\/|application\/(?:octet-stream|pdf|zip|wasm|x-font|font)/i;

class FetchError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fetchOnce(url, { accept, referer, signal, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || LIMITS.FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "upgrade-insecure-requests": "1",
        ...(referer ? { referer } : {}),
      },
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      if (response.body) response.body.cancel().catch(() => {});
      throw new FetchError(`HTTP ${response.status}`, response.status);
    }
    if (BINARY_CT_RE.test(contentType)) {
      if (response.body) response.body.cancel().catch(() => {});
      return { text: "", contentType, finalUrl: response.url, binary: true };
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > LIMITS.MAX_FILE_CHARS * 2) {
      if (response.body) response.body.cancel().catch(() => {});
      throw new FetchError(`Too large (${Math.round(declared / 1024)} KB)`, 413);
    }
    const text = await response.text();
    return { text, contentType, finalUrl: response.url, binary: false };
  } catch (error) {
    if (error.name === "AbortError") throw new FetchError(signal && signal.aborted ? "Aborted" : "Timed out", 408);
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function fetchText(url, options = {}) {
  const retries = options.retries ?? 2;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOnce(url, options);
    } catch (error) {
      lastError = error;
      const status = error.status || 0;
      const retryable = !status || status === 408 && !(options.signal && options.signal.aborted) || status === 429 || status >= 500;
      if (!retryable || attempt === retries) break;
      await sleep(350 * 2 ** attempt + Math.random() * 200);
    }
  }
  throw lastError;
}

/** Downloads an image or font as bytes (used to make the typed page's preview fully self-contained). */
async function fetchBinary(url, { signal, referer, timeoutMs = 10_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "image/avif,image/webp,image/*,font/*,*/*;q=0.8", ...(referer ? { referer } : {}) },
    });
    if (!response.ok) throw new FetchError(`HTTP ${response.status}`, response.status);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new FetchError("Too large", 413);
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw new FetchError("Too large", 413);
    return { buffer: buf, contentType: (response.headers.get("content-type") || "").split(";")[0].trim() };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

module.exports = { fetchText, fetchBinary, isBlockedHost, FetchError };
