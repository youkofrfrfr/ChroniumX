import { escapeHtml } from "./ui.js";

export const SANDBOX_WITH_SCRIPTS = "allow-scripts allow-forms allow-modals allow-popups";
export const SANDBOX_NO_SCRIPTS = "allow-forms allow-popups";

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

function absolutizeCss(css, baseUrl) {
  if (!baseUrl) return css;
  const fix = (ref) => {
    if (/^(?:data:|blob:|https?:|\/\/|#)/i.test(ref)) return ref;
    try {
      return new URL(ref, baseUrl).toString();
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
export function buildPreviewDoc(file, filesByPath, { preferRendered = false, contentOverride = null, scripts = true } = {}) {
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

  doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => {
    const asset = findAsset(link.getAttribute("href"), file, filesByPath, bySource);
    if (!asset) return;
    const style = doc.createElement("style");
    style.setAttribute("data-cx-src", asset.path);
    if (link.media) style.media = link.media;
    style.textContent = absolutizeCss(fileText(asset), asset.sourceUrl);
    link.replaceWith(style);
  });

  if (!scripts) {
    // Without JS the browser would show <noscript> "please enable JavaScript" fallbacks, and
    // inlining megabytes of bundles that can never run only slows the frame down.
    doc.querySelectorAll('script:not([type="application/ld+json"]), noscript, link[rel~="preload"], link[rel~="modulepreload"]').forEach((el) => el.remove());
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
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

export function messageDoc(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b09;color:#8b958f;font:14px/1.6 Inter,system-ui,sans-serif;padding:24px;text-align:center}div{max-width:460px;padding:22px 26px;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:rgba(255,255,255,.03)}</style></head><body><div>${escapeHtml(message)}</div></body></html>`;
}
