import { escapeHtml } from "./ui.js";

export const SANDBOX_WITH_SCRIPTS = "allow-scripts allow-forms allow-modals allow-popups";
// "allow-scripts" only for ChroniumX's own link-navigation script: the site's scripts and inline
// handlers are stripped first, the origin stays opaque, and forms/popups stay blocked.
export const SANDBOX_NO_SCRIPTS = "allow-scripts";

// Injected into every preview: link clicks ask the Preview tab to open that page from the scrape.
const NAV_SCRIPT = `(function(){var P=parent;
document.addEventListener("click",function(e){var t=e.target;var a=t&&t.closest&&t.closest("a[href],area[href]");if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#"&&h.length>1)return;e.preventDefault();e.stopPropagation();P.postMessage({type:"cx-nav",href:a.href},"*")},true);
document.addEventListener("submit",function(e){e.preventDefault();P.postMessage({type:"cx-form",action:String(e.target&&e.target.action||"")},"*")},true);})();`;

// Sandboxed srcdoc frames have an opaque origin, so storage and cookie access throw and most
// site bundles crash before painting. This shim swaps them for in-memory versions first.
const SANDBOX_SHIM = `(()=>{const mk=()=>{const m=new Map();return{get length(){return m.size},key:i=>[...m.keys()][i]??null,getItem:k=>m.has(String(k))?m.get(String(k)):null,setItem:(k,v)=>void m.set(String(k),String(v)),removeItem:k=>void m.delete(String(k)),clear:()=>m.clear()}};
for(const n of["localStorage","sessionStorage"]){try{window[n].length}catch{try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch{}}}
let jar="";try{document.cookie}catch{try{Object.defineProperty(Document.prototype,"cookie",{get:()=>jar,set:v=>{jar=(jar?jar+"; ":"")+String(v).split(";")[0]},configurable:true})}catch{}}
try{indexedDB.open}catch{}
try{if(navigator.serviceWorker)Object.defineProperty(navigator,"serviceWorker",{value:undefined,configurable:true})}catch{}
window.addEventListener("error",e=>e.preventDefault());window.addEventListener("unhandledrejection",e=>e.preventDefault());
history.pushState=history.replaceState=function(){};})();`;

export function fileText(file) {
  return typeof file.edited === "string" ? file.edited : file.content || "";
}

function normalizePath(path) {
  const stack = [];
  for (const part of String(path || "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function resolveLocal(currentPath, ref) {
  const raw = String(ref || "").trim();
  if (!raw || /^(?:[a-z]+:|\/\/|#|data:)/i.test(raw)) return null;
  const pathPart = raw.split("#")[0].split("?")[0];
  if (!pathPart) return null;
  if (pathPart.startsWith("/")) return normalizePath(pathPart.slice(1));
  const dir = String(currentPath || "").split("/").slice(0, -1);
  return normalizePath([...dir, ...pathPart.split("/")].join("/"));
}

function stripHash(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString();
  } catch {
    return null;
  }
}

/** Index of files by their original absolute URL so absolute refs in rendered DOM still resolve. */
export function indexBySource(filesByPath) {
  const map = new Map();
  for (const f of Object.values(filesByPath || {})) {
    const u = f.sourceUrl && stripHash(f.sourceUrl);
    if (u && !map.has(u)) map.set(u, f);
  }
  return map;
}

// Captured images/fonts by original URL. Data URLs are built lazily so only what a page uses is inlined.
const mediaCache = new WeakMap();
export function mediaIndex(filesByPath) {
  const all = Object.values(filesByPath || {});
  const cached = mediaCache.get(filesByPath);
  if (cached && cached.count === all.length) return cached.map;
  const map = new Map();
  for (const f of all) {
    if (f.encoding !== "base64" || f.kind === "screenshot" || !f.sourceUrl) continue;
    const u = stripHash(f.sourceUrl);
    if (u && !map.has(u)) map.set(u, f);
  }
  mediaCache.set(filesByPath, { count: all.length, map });
  return map;
}

export function dataUrl(f) {
  return `data:${f.contentType || (f.type === "font" ? "font/woff2" : "image/png")};base64,${f.content}`;
}

function makeSwap(media) {
  return (abs) => {
    if (!media || !media.size || !abs || /^(?:data:|blob:)/i.test(abs)) return abs;
    const hit = media.get(stripHash(abs));
    return hit ? dataUrl(hit) : abs;
  };
}

function absolutizeCss(css, baseUrl, swap = (u) => u) {
  if (!baseUrl) return css;
  const fix = (ref) => {
    if (/^(?:data:|blob:|#)/i.test(ref)) return ref;
    try {
      return swap(new URL(ref, baseUrl).toString());
    } catch {
      return ref;
    }
  };
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (m, q, ref) => `url(${q}${fix(ref.trim())}${q})`)
    .replace(/@import\s+(["'])([^"']+)\1/g, (m, q, ref) => `@import ${q}${fix(ref)}${q}`);
}

function findAsset(ref, file, filesByPath, bySource) {
  const base = file.sourceUrl ? file.sourceUrl.split("#")[0] : null;
  if (base) {
    try {
      const abs = stripHash(new URL(ref, base).toString());
      if (abs && bySource.has(abs)) return bySource.get(abs);
    } catch {}
  }
  const local = resolveLocal(file.path, ref);
  return local && filesByPath[local] ? filesByPath[local] : null;
}

/**
 * Builds a self-contained HTML document for an iframe srcdoc: captured CSS/JS are inlined,
 * and a <base> tag points everything else (images, fonts) back to the live origin.
 */
// Removes pop-ups that were open when the page was captured: dialogs, cookie/consent banners and the
// full-screen overlay (with its blur) wrapped around them. Markup-only heuristics, no computed styles.
const OVERLAY_HINT = /(?:^|[\s_-])(?:modal|overlay|backdrop|popup|pop-up|lightbox|cookie|consent|newsletter|gdpr|onetrust)(?:$|[\s_-])|\bfixed\b[^"]*\binset-0\b|\binset-0\b[^"]*\bfixed\b/i;
function hidePopupsIn(doc) {
  let removed = 0;
  const hinted = (el) => OVERLAY_HINT.test(`${el.getAttribute("class") || ""} ${el.id || ""}`) || /position:\s*fixed/i.test(el.getAttribute("style") || "");
  const dialogs = doc.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog,[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="onetrust" i]');
  for (const d of dialogs) {
    if (!d.isConnected) continue;
    // Climb to the outermost overlay-looking wrapper below <body>.
    let top = d;
    for (let el = d.parentElement; el && el !== doc.body; el = el.parentElement) if (hinted(el)) top = el;
    top.remove();
    removed += 1;
  }
  // Leftover full-screen backdrops (e.g. Tailwind "fixed inset-0 bg-black/60 backdrop-blur").
  doc.querySelectorAll('[class*="inset-0"][class*="fixed"]').forEach((el) => {
    if (/backdrop|bg-black|bg-opacity|\/\d0|blur/i.test(el.getAttribute("class") || "") && !el.querySelector("main, header, nav, article")) {
      el.remove();
      removed += 1;
    }
  });
  if (removed) {
    for (const el of [doc.documentElement, doc.body]) {
      if (!el) continue;
      const st = el.getAttribute("style") || "";
      el.setAttribute("style", `${st.replace(/overflow\s*:\s*hidden;?/gi, "")};overflow:auto`);
      el.classList.remove("modal-open", "overflow-hidden", "no-scroll");
    }
  }
  return removed;
}

export function buildPreviewDoc(file, filesByPath, { preferRendered = false, contentOverride = null, scripts = true, hidePopups = false } = {}) {
  if (!file) return messageDoc("No page selected.");
  const type = String(file.type || "").toLowerCase();
  const bySource = indexBySource(filesByPath);
  const text = contentOverride ?? fileText(file);

  if (type === "css") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${absolutizeCss(text, file.sourceUrl)}</style>
<style>.cx-sample{font-family:system-ui,sans-serif;padding:28px;max-width:760px}</style></head>
<body><div class="cx-sample"><h1>Heading 1</h1><h2>Heading 2</h2><p>Paragraph text with a <a href="#">link</a>, <strong>bold</strong> and <em>italic</em>.</p>
<button>Button</button> <input placeholder="Input"> <select><option>Select</option></select>
<ul><li>List item</li><li>List item</li></ul><blockquote>Blockquote</blockquote><pre><code>code block</code></pre>
<table border="1"><tr><th>Head</th><th>Head</th></tr><tr><td>Cell</td><td>Cell</td></tr></table></div></body></html>`;
  }
  if (type !== "html") return messageDoc(`Live preview supports HTML and CSS files. ${file.path} is ${type || "text"}.`);

  const source = contentOverride ?? (preferRendered && file.renderedContent ? file.renderedContent : text);
  const doc = new DOMParser().parseFromString(source, "text/html");
  const head = doc.head || doc.documentElement.insertBefore(doc.createElement("head"), doc.body);

  if (file.sourceUrl && !doc.querySelector("base[href]")) {
    const base = doc.createElement("base");
    base.href = file.sourceUrl.split("#")[0];
    head.insertBefore(base, head.firstChild);
  }
  if (hidePopups) hidePopupsIn(doc);
  const baseHref = (doc.querySelector("base[href]") && doc.querySelector("base[href]").getAttribute("href")) || (file.sourceUrl || "").split("#")[0];
  const swap = makeSwap(mediaIndex(filesByPath));
  const resolve = (v) => {
    try {
      return new URL(v, baseHref).toString();
    } catch {
      return v;
    }
  };
  const swapSrcset = (v) =>
    String(v)
      .split(",")
      .map((part) => {
        const [u, ...rest] = part.trim().split(/\s+/);
        return u ? [swap(resolve(u)), ...rest].join(" ") : "";
      })
      .filter(Boolean)
      .join(", ");

  // Point every image, icon and background at the captured copy so nothing depends on the live CDN.
  doc.querySelectorAll("img[src], source[src], input[type=image][src], embed[src]").forEach((el) => {
    const v = el.getAttribute("src");
    if (v && !v.startsWith("data:")) el.setAttribute("src", swap(resolve(v)));
  });
  doc.querySelectorAll("[srcset]").forEach((el) => el.setAttribute("srcset", swapSrcset(el.getAttribute("srcset"))));
  doc.querySelectorAll("video[poster]").forEach((el) => el.setAttribute("poster", swap(resolve(el.getAttribute("poster")))));
  doc.querySelectorAll('link[rel~="icon"][href], link[rel~="apple-touch-icon"][href], image[href]').forEach((el) => el.setAttribute("href", swap(resolve(el.getAttribute("href")))));
  doc.querySelectorAll("[style]").forEach((el) => {
    const v = el.getAttribute("style");
    if (v && v.includes("url(")) el.setAttribute("style", absolutizeCss(v, baseHref, swap));
  });
  doc.querySelectorAll("style").forEach((el) => {
    if ((el.textContent || "").includes("url(")) el.textContent = absolutizeCss(el.textContent, baseHref, swap);
  });

  doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => {
    const asset = findAsset(link.getAttribute("href"), file, filesByPath, bySource);
    if (!asset) return;
    const style = doc.createElement("style");
    style.setAttribute("data-cx-src", asset.path);
    if (link.media) style.media = link.media;
    style.textContent = absolutizeCss(fileText(asset), asset.sourceUrl, swap);
    link.replaceWith(style);
  });

  if (!scripts) {
    // Without JS the browser would show <noscript> "please enable JavaScript" fallbacks, and
    // inlining megabytes of bundles that can never run only slows the frame down.
    doc.querySelectorAll('script:not([type="application/ld+json"]), noscript, link[rel~="preload"], link[rel~="modulepreload"]').forEach((el) => el.remove());
    // The frame allows ChroniumX's navigation script, so inline handlers from the site must go too.
    doc.querySelectorAll("*").forEach((el) => {
      for (const a of [...el.attributes]) if (/^on[a-z]+$/i.test(a.name)) el.removeAttribute(a.name);
      if (/^\s*javascript:/i.test(el.getAttribute("href") || "")) el.setAttribute("href", "#");
    });
  } else {
    const shim = doc.createElement("script");
    shim.setAttribute("data-cx-shim", "");
    shim.textContent = SANDBOX_SHIM;
    head.insertBefore(shim, head.querySelector("base") ? head.querySelector("base").nextSibling : head.firstChild);
  }

  doc.querySelectorAll("script[src]").forEach((script) => {
    const asset = findAsset(script.getAttribute("src"), file, filesByPath, bySource);
    if (!asset) return;
    const inline = doc.createElement("script");
    for (const attr of script.attributes) if (attr.name !== "src" && attr.name !== "integrity") inline.setAttribute(attr.name, attr.value);
    inline.setAttribute("data-cx-src", asset.path);
    inline.textContent = fileText(asset).replace(/<\/script/gi, "<\\/script");
    script.replaceWith(inline);
  });

  doc.querySelectorAll("[integrity]").forEach((el) => el.removeAttribute("integrity"));
  const nav = doc.createElement("script");
  nav.setAttribute("data-cx-nav", "");
  nav.textContent = NAV_SCRIPT;
  (doc.body || doc.documentElement).appendChild(nav);
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/** A page's full-page screenshot, shown as-is: the pixel-exact reference of what Chrome drew. */
export function screenshotDoc(shot) {
  if (!shot) return messageDoc("No screenshot for this page. Scrape again with headless Chrome to capture one.");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0b0d0e}img{display:block;width:100%;height:auto}</style></head><body><img alt="Screenshot" src="${dataUrl(shot)}"></body></html>`;
}

export function messageDoc(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b09;color:#8b958f;font:14px/1.6 Inter,system-ui,sans-serif;padding:24px;text-align:center}div{max-width:460px;padding:22px 26px;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:rgba(255,255,255,.03)}</style></head><body><div>${escapeHtml(message)}</div></body></html>`;
}
