import { $, $$, escapeHtml, formatBytes, toast, confirmDialog } from "./ui.js";
import { icon } from "./icons.js";
import { buildPreviewDoc, fileText, dataUrl, SANDBOX_WITH_SCRIPTS } from "./preview.js";

const MONACO_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";
const PRETTIER_BASE = "https://cdn.jsdelivr.net/npm/prettier@3.3.3";
const TYPES = [
  ["html", "var(--t-html)"],
  ["css", "var(--t-css)"],
  ["js", "var(--t-js)"],
  ["json", "var(--t-json)"],
  ["map", "var(--t-map)"],
  ["text", "var(--t-text)"],
  ["image", "var(--t-image)"],
  ["font", "var(--t-font)"],
  ["wasm", "var(--t-wasm)"],
];
const PREFS_KEY = "chroniumx.workspace.v1";

let monacoPromise = null;
export function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${MONACO_BASE}/vs/loader.js`;
    s.onload = () => {
      window.MonacoEnvironment = {
        getWorkerUrl() {
          const src = `self.MonacoEnvironment={baseUrl:'${MONACO_BASE}/'};importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');`;
          return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        },
      };
      window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
    };
    s.onerror = () => reject(new Error("Monaco failed to load"));
    document.head.appendChild(s);
  });
  return monacoPromise;
}

let prettierPromise = null;
function loadPrettier() {
  if (prettierPromise) return prettierPromise;
  prettierPromise = Promise.all(
    ["standalone", "plugins/babel", "plugins/estree", "plugins/postcss", "plugins/html", "plugins/typescript"].map((p) => import(`${PRETTIER_BASE}/${p}.mjs`))
  ).then(([core, ...plugins]) => ({ format: (core.default && core.default.format) || core.format, plugins }));
  prettierPromise.catch(() => (prettierPromise = null));
  return prettierPromise;
}

export function languageFor(path, type) {
  const ext = String(path || "").split(/[?#]/)[0].split(".").pop().toLowerCase();
  const byExt = {
    html: "html", htm: "html", vue: "html", svelte: "html", astro: "html",
    css: "css", scss: "scss", sass: "scss", less: "less",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    json: "json", map: "json", webmanifest: "json",
    md: "markdown", mdx: "markdown", xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml", txt: "plaintext",
  };
  if (byExt[ext]) return byExt[ext];
  return { html: "html", css: "css", js: "javascript", json: "json", map: "json" }[type] || "plaintext";
}

function prettierParser(lang) {
  return { javascript: "babel", typescript: "typescript", css: "css", scss: "scss", less: "less", html: "html", json: "json" }[lang] || null;
}

function fuzzyScore(query, path) {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const name = p.split("/").pop();
  if (!q) return { score: 1, hits: [] };
  let score = 0;
  let qi = 0;
  let last = -2;
  const hits = [];
  const nameStart = p.length - name.length;
  for (let i = 0; i < p.length && qi < q.length; i += 1) {
    if (p[i] === q[qi]) {
      score += i === last + 1 ? 6 : 1;
      if (i >= nameStart) score += 3;
      if (i === nameStart || p[i - 1] === "/" || p[i - 1] === "." || p[i - 1] === "-") score += 4;
      hits.push(i);
      last = i;
      qi += 1;
    }
  }
  if (qi < q.length) return null;
  if (name.includes(q)) score += 25;
  return { score: score - p.length * 0.02, hits };
}

export function createWorkspace(ctx) {
  const els = {
    ws: $("#ws"),
    side: $("#wsSide"),
    tree: $("#tree"),
    tabs: $("#tabs"),
    host: $("#editorHost"),
    welcome: $("#wsWelcome"),
    media: $("#wsMedia"),
    toolbar: $("#edToolbar"),
    crumbs: $("#crumbs"),
    split: $("#splitPreview"),
    splitFrame: $("#splitFrame"),
    siteSelect: $("#siteSelect"),
    filter: $("#treeFilter"),
    typeFilters: $("#typeFilters"),
    fileCount: $("#fileCount"),
    selCount: $("#selCount"),
    searchInput: $("#searchInput"),
    searchResults: $("#searchResults"),
    searchCount: $("#searchCount"),
    infoBody: $("#infoBody"),
    mapBody: $("#mapBody"),
    mapFilter: $("#mapFilter"),
    warnCount: $("#warnCount"),
    palette: $("#palette"),
    paletteInput: $("#paletteInput"),
    paletteList: $("#paletteList"),
  };

  let prefs = { sideW: 300, wrap: false, split: false, types: TYPES.map((t) => t[0]) };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {}
  // Types added in later versions start visible even if an older saved filter list lacks them.
  const knownTypes = prefs.knownTypes || ["html", "css", "js", "json", "map", "text"];
  for (const [t] of TYPES) if (!knownTypes.includes(t) && !prefs.types.includes(t)) prefs.types.push(t);
  prefs.knownTypes = TYPES.map((t) => t[0]);
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  };

  const state = {
    tabs: [],
    active: null,
    expanded: new Set(),
    selected: new Set(),
    types: new Set(prefs.types),
    filter: "",
    sideView: "explorer",
    diff: false,
    searchCase: false,
    searchRegex: false,
  };

  let monaco = null;
  let editor = null;
  let diffEditor = null;
  let diffOriginal = null;
  let fallback = null;
  let mainHost = null;
  let diffHost = null;
  let splitTimer = null;

  els.ws.style.setProperty("--side-w", `${prefs.sideW}px`);
  const isNarrow = () => window.matchMedia("(max-width: 860px)").matches;
  if (isNarrow()) els.ws.classList.add("side-collapsed");

  // ── Editor bootstrap ──────────────────────────────────────────────────
  async function ensureEditor() {
    if (editor || fallback) return;
    mainHost = document.createElement("div");
    mainHost.style.cssText = "position:absolute;inset:0";
    diffHost = document.createElement("div");
    diffHost.style.cssText = "position:absolute;inset:0";
    diffHost.hidden = true;
    els.host.append(mainHost, diffHost);
    try {
      monaco = await loadMonaco();
      monaco.editor.defineTheme("chroniumx", {
        base: "vs-dark",
        inherit: true,
        rules: [
          { token: "comment", foreground: "5f7368", fontStyle: "italic" },
          { token: "keyword", foreground: "c4b5fd" },
          { token: "string", foreground: "86efac" },
          { token: "number", foreground: "fdba74" },
          { token: "regexp", foreground: "f9a8d4" },
          { token: "type", foreground: "7dd3fc" },
          { token: "tag", foreground: "7dd3fc" },
          { token: "attribute.name", foreground: "c4b5fd" },
          { token: "attribute.value", foreground: "86efac" },
          { token: "delimiter", foreground: "9ca3af" },
          { token: "variable", foreground: "e5e7eb" },
        ],
        colors: {
          "editor.background": "#070b09",
          "editor.lineHighlightBackground": "#ffffff07",
          "editor.lineHighlightBorder": "#00000000",
          "editorLineNumber.foreground": "#34433b",
          "editorLineNumber.activeForeground": "#a7f3d0",
          "editor.selectionBackground": "#34d39938",
          "editor.inactiveSelectionBackground": "#34d3991c",
          "editor.findMatchHighlightBackground": "#facc1530",
          "editorCursor.foreground": "#34d399",
          "editorIndentGuide.background1": "#ffffff0b",
          "editorIndentGuide.activeBackground1": "#ffffff22",
          "minimap.background": "#070b09",
          "scrollbarSlider.background": "#ffffff12",
          "scrollbarSlider.hoverBackground": "#ffffff22",
          "editorWidget.background": "#0c1310",
          "editorWidget.border": "#ffffff14",
          "editorSuggestWidget.selectedBackground": "#34d39926",
          "editorStickyScroll.background": "#0a100d",
          "diffEditor.insertedTextBackground": "#34d39926",
          "diffEditor.removedTextBackground": "#f8717126",
          "diffEditor.insertedLineBackground": "#34d39912",
          "diffEditor.removedLineBackground": "#f8717112",
        },
      });
      const noDiag = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true };
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(noDiag);
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(noDiag);
      monaco.languages.typescript.javascriptDefaults.setEagerModelSync(false);
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false });

      const common = {
        theme: "chroniumx",
        automaticLayout: true,
        fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
        fontSize: 13,
        fontLigatures: true,
        lineHeight: 20,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        padding: { top: 12, bottom: 12 },
        scrollBeyondLastLine: false,
        largeFileOptimizations: true,
        maxTokenizationLineLength: 20000,
        renderLineHighlight: "all",
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      };
      editor = monaco.editor.create(mainHost, {
        ...common,
        model: null,
        minimap: { enabled: true, renderCharacters: false, maxColumn: 100 },
        stickyScroll: { enabled: true },
        wordWrap: prefs.wrap ? "on" : "off",
        wordWrapMinified: prefs.wrap !== false,
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => openPalette());
      editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => toggleWrap());
      editor.addAction({
        id: "chroniumx.beautify",
        label: "ChroniumX: Beautify document (Prettier)",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
        contextMenuGroupId: "1_modification",
        run: () => beautify(),
      });
      editor.onDidChangeCursorPosition((e) => {
        $("#sbPos").textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
      });
      diffEditor = monaco.editor.createDiffEditor(diffHost, { ...common, renderSideBySide: true, originalEditable: false, minimap: { enabled: false }, enableSplitViewResizing: true });
    } catch (error) {
      ctx.log(`Monaco unavailable (${error.message}); using basic editor.`, "warn");
      fallback = document.createElement("textarea");
      fallback.className = "fallback";
      fallback.spellcheck = false;
      fallback.addEventListener("input", () => {
        const tab = activeTab();
        if (tab) {
          tab.text = fallback.value;
          setDirty(tab, tab.text !== tab.saved);
          scheduleSplit();
        }
      });
      mainHost.appendChild(fallback);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  const files = () => ctx.files() || {};
  const activeTab = () => state.tabs.find((t) => t.path === state.active) || null;
  const tabText = (tab) => (tab.model ? tab.model.getValue() : tab.text);

  function visibleFiles() {
    const term = state.filter.trim().toLowerCase();
    return Object.values(files())
      .filter((f) => state.types.has(TYPES.some((t) => t[0] === f.type) ? f.type : "text"))
      .filter((f) => !term || f.path.toLowerCase().includes(term))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  function buildTree(list) {
    const root = { name: "", path: "", folders: new Map(), files: [], count: 0 };
    for (const f of list) {
      const parts = f.path.split("/");
      let node = root;
      node.count += 1;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const p = parts.slice(0, i + 1).join("/");
        if (!node.folders.has(parts[i])) node.folders.set(parts[i], { name: parts[i], path: p, folders: new Map(), files: [], count: 0 });
        node = node.folders.get(parts[i]);
        node.count += 1;
      }
      node.files.push(f);
    }
    return root;
  }

  function filesUnder(node) {
    const out = [...node.files];
    node.folders.forEach((c) => out.push(...filesUnder(c)));
    return out;
  }

  // ── Explorer ──────────────────────────────────────────────────────────
  let treeRoot = null;
  let treeRaf = 0;
  function renderTree() {
    if (treeRaf) return;
    treeRaf = requestAnimationFrame(() => {
      treeRaf = 0;
      renderTreeNow();
    });
  }
  function renderTreeNow() {
    const list = visibleFiles();
    const total = Object.keys(files()).length;
    els.fileCount.textContent = list.length === total ? `${total} files` : `${list.length} / ${total}`;
    treeRoot = buildTree(list);
    if (state.filter) {
      const expandAll = (n) => n.folders.forEach((c) => (state.expanded.add(c.path), expandAll(c)));
      if (list.length < 400) expandAll(treeRoot);
    }
    const rows = [];
    const walk = (node, depth) => {
      const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const folder of folders) {
        const open = state.expanded.has(folder.path);
        const all = filesUnder(folder);
        const checked = all.length && all.every((f) => state.selected.has(f.path));
        rows.push(`<div class="tree-row folder ${open ? "open" : ""}" data-folder="${escapeHtml(folder.path)}" style="--d:${depth}">${icon("chevronRight", "chev")}<input class="cb" type="checkbox" ${checked ? "checked" : ""} data-cbfolder="${escapeHtml(folder.path)}" tabindex="-1" /><span class="ficon folder">${icon(open ? "folderOpen" : "folder")}</span><span class="name">${escapeHtml(folder.name)}</span><span class="sz">${folder.count}</span></div>`);
        if (open) walk(folder, depth + 1);
      }
      for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
        const name = f.path.split("/").pop();
        const type = TYPES.some((t) => t[0] === f.type) ? f.type : "text";
        const dirty = typeof f.edited === "string";
        rows.push(`<div class="tree-row file ${f.path === state.active ? "active" : ""}" data-file="${escapeHtml(f.path)}" style="--d:${depth}" title="${escapeHtml(f.path)}"><span style="width:12px"></span><input class="cb" type="checkbox" ${state.selected.has(f.path) ? "checked" : ""} data-cbfile="${escapeHtml(f.path)}" tabindex="-1" /><span class="ficon ${type}">${type === "text" ? "TXT" : type.toUpperCase().slice(0, 4)}</span><span class="name">${escapeHtml(name)}</span>${dirty ? '<span class="dirty" title="Edited"></span>' : ""}<span class="sz">${formatBytes(f.size || fileText(f).length)}</span></div>`);
      }
    };
    walk(treeRoot, 0);
    els.tree.innerHTML = rows.length ? rows.join("") : `<div class="empty" style="margin:12px;padding:24px">${icon("files")}<div>${total ? "No files match the filters." : "No files yet."}</div></div>`;
    els.selCount.textContent = String(state.selected.size);
    els.tree.classList.toggle("selecting", state.selected.size > 0);
  }

  function findFolder(path) {
    let node = treeRoot;
    for (const part of path.split("/")) {
      node = node && node.folders.get(part);
    }
    return node;
  }

  els.tree.addEventListener("click", (e) => {
    const cbFile = e.target.closest("[data-cbfile]");
    const cbFolder = e.target.closest("[data-cbfolder]");
    if (cbFile) {
      const p = cbFile.dataset.cbfile;
      cbFile.checked ? state.selected.add(p) : state.selected.delete(p);
      renderTree();
      return;
    }
    if (cbFolder) {
      const node = findFolder(cbFolder.dataset.cbfolder);
      if (node) filesUnder(node).forEach((f) => (cbFolder.checked ? state.selected.add(f.path) : state.selected.delete(f.path)));
      renderTree();
      return;
    }
    const folder = e.target.closest("[data-folder]");
    if (folder) {
      const p = folder.dataset.folder;
      state.expanded.has(p) ? state.expanded.delete(p) : state.expanded.add(p);
      renderTree();
      return;
    }
    const file = e.target.closest("[data-file]");
    if (file) {
      openFile(file.dataset.file);
      if (isNarrow()) els.ws.classList.add("side-collapsed");
    }
  });

  els.filter.addEventListener("input", () => {
    state.filter = els.filter.value;
    renderTree();
  });

  function renderTypeFilters() {
    const counts = {};
    Object.values(files()).forEach((f) => {
      const t = TYPES.some((x) => x[0] === f.type) ? f.type : "text";
      counts[t] = (counts[t] || 0) + 1;
    });
    els.typeFilters.innerHTML = TYPES.map(([t, c]) => `<button class="tf ${state.types.has(t) ? "on" : ""}" type="button" data-type="${t}" style="--c:${c}">${t} ${counts[t] || 0}</button>`).join("");
  }
  els.typeFilters.addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b) return;
    const t = b.dataset.type;
    state.types.has(t) ? state.types.delete(t) : state.types.add(t);
    prefs.types = [...state.types];
    savePrefs();
    renderTypeFilters();
    renderTree();
  });

  $("#collapseBtn").addEventListener("click", () => {
    state.expanded.clear();
    renderTree();
  });

  // ── Tabs ──────────────────────────────────────────────────────────────
  function renderTabs() {
    els.tabs.innerHTML = state.tabs
      .map((t) => {
        const f = files()[t.path];
        const type = f ? (TYPES.some((x) => x[0] === f.type) ? f.type : "text") : "text";
        return `<div class="tab ${t.path === state.active ? "active" : ""} ${t.dirty ? "dirty" : ""}" data-tab="${escapeHtml(t.path)}" title="${escapeHtml(t.path)}"><span class="ficon ${type}">${type === "text" ? "TXT" : type.toUpperCase().slice(0, 4)}</span><span class="name">${escapeHtml(t.path.split("/").pop())}</span><button class="x" type="button" data-close="${escapeHtml(t.path)}" aria-label="Close">${icon("x")}</button></div>`;
      })
      .join("");
    const activeEl = els.tabs.querySelector(".tab.active");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  els.tabs.addEventListener("click", (e) => {
    const close = e.target.closest("[data-close]");
    if (close) {
      e.stopPropagation();
      closeTab(close.dataset.close);
      return;
    }
    const tab = e.target.closest("[data-tab]");
    if (tab) activate(tab.dataset.tab);
  });
  els.tabs.addEventListener("auxclick", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab && e.button === 1) closeTab(tab.dataset.tab);
  });

  function setDirty(tab, dirty) {
    if (tab.dirty === dirty) return;
    tab.dirty = dirty;
    renderTabs();
    if (tab.path === state.active) $("#sbMod").hidden = !dirty && typeof (files()[tab.path] || {}).edited !== "string";
  }

  async function closeTab(path) {
    const idx = state.tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const tab = state.tabs[idx];
    if (tab.dirty) {
      const ok = await confirmDialog({ title: "Discard unsaved changes?", message: `${path} has edits that haven't been saved.`, confirmText: "Discard", danger: true });
      if (!ok) return;
    }
    if (state.diff && path === state.active) exitDiff();
    if (tab.model) tab.model.dispose();
    state.tabs.splice(idx, 1);
    if (state.active === path) {
      const next = state.tabs[idx] || state.tabs[idx - 1];
      state.active = null;
      if (next) activate(next.path);
      else showEmpty();
    }
    renderTabs();
  }

  function showEmpty() {
    state.active = null;
    if (editor) editor.setModel(null);
    if (fallback) fallback.value = "";
    els.toolbar.hidden = true;
    els.split.hidden = true;
    renderWelcome();
    renderStatus();
    renderTree();
    ctx.onActiveFile(null);
  }

  function renderWelcome() {
    const hasScrape = !!ctx.slug();
    els.welcome.hidden = !!state.active;
    $("#welcomeTitle").textContent = hasScrape ? "Pick a file to start" : "No scrape loaded";
    $("#welcomeText").textContent = hasScrape
      ? `${Object.keys(files()).length} files captured from ${ctx.meta()?.sourceUrl || ctx.slug()}. Choose one from the explorer or press Ctrl P.`
      : "Run a scrape, then explore and edit every file here.";
    const btn = $("#welcomeBtn");
    btn.innerHTML = hasScrape ? `${icon("files")}Open best file` : `${icon("play")}Start a scrape`;
  }

  // ── Open / activate ───────────────────────────────────────────────────
  // Images, fonts and screenshots are stored as base64; show them instead of opening them as text.
  function showMedia(path) {
    const f = files()[path];
    const prev = activeTab();
    if (prev && editor && !state.diff) prev.viewState = editor.saveViewState();
    if (state.diff) exitDiff();
    state.active = path;
    const src = dataUrl(f);
    const info = `<div class="meta">${escapeHtml(f.contentType || f.type)} · ${formatBytes(f.size)}${f.sourceUrl ? ` · ${escapeHtml(String(f.sourceUrl).replace(/#screenshot$/, " (screenshot)"))}` : ""}</div>`;
    if (f.type === "wasm") {
      els.media.innerHTML = `<div style="max-width:720px;text-align:left"><h3 style="margin:0 0 6px">WebAssembly module</h3>${info}<div class="meta" id="wasmInfo" style="margin-top:14px">Reading imports and exports…</div></div>`;
      const bytes = Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0));
      WebAssembly.compile(bytes)
        .then((mod) => {
          const imp = WebAssembly.Module.imports(mod);
          const exp = WebAssembly.Module.exports(mod);
          const list = (arr, fmt) => arr.slice(0, 400).map((x) => `<div class="map-row"><span class="m">${escapeHtml(x.kind.slice(0, 5).toUpperCase())}</span><span class="p">${escapeHtml(fmt(x))}</span></div>`).join("");
          const box = $("#wasmInfo");
          if (box) box.innerHTML = `<div class="map-group"><span>Exports</span><span>${exp.length}</span></div>${list(exp, (x) => x.name)}<div class="map-group"><span>Imports</span><span>${imp.length}</span></div>${list(imp, (x) => `${x.module}.${x.name}`)}`;
        })
        .catch((err) => {
          const box = $("#wasmInfo");
          if (box) box.textContent = `Couldn't read this module: ${err.message}`;
        });
    } else if (f.type === "font") {
      const fam = `cxfont_${Math.random().toString(36).slice(2, 8)}`;
      els.media.innerHTML = `<style>@font-face{font-family:${fam};src:url("${src}")}</style><div><div class="font-sample" style="font-family:${fam},system-ui">The quick brown fox jumps over the lazy dog<small style="font-family:${fam},system-ui">ABCDEFGHIJKLMNOPQRSTUVWXYZ · abcdefghijklmnopqrstuvwxyz · 0123456789 !?&amp;</small></div>${info}</div>`;
    } else {
      els.media.innerHTML = `<div><img alt="${escapeHtml(path)}" src="${src}">${info}</div>`;
    }
    els.media.hidden = false;
    els.welcome.hidden = true;
    els.toolbar.hidden = true;
    renderCrumbs(path);
    renderTabs();
    renderTree();
    renderStatus();
    ctx.onActiveFile(path, f);
  }

  async function openFile(path, reveal = null) {
    const f = files()[path];
    if (!f) return;
    if (f.encoding === "base64") return showMedia(path);
    await ensureEditor();
    let tab = state.tabs.find((t) => t.path === path);
    if (!tab) {
      tab = { path, dirty: false, viewState: null, model: null, text: fileText(f), saved: fileText(f) };
      if (monaco) {
        const uri = monaco.Uri.from({ scheme: "cx", path: `/${ctx.slug()}/${path}` });
        const existing = monaco.editor.getModel(uri);
        if (existing) existing.dispose();
        tab.model = monaco.editor.createModel(fileText(f), languageFor(path, f.type), uri);
        tab.savedVersion = tab.model.getAlternativeVersionId();
        tab.model.onDidChangeContent(() => {
          setDirty(tab, tab.model.getAlternativeVersionId() !== tab.savedVersion);
          if (tab.path === state.active) scheduleSplit();
        });
      }
      state.tabs.push(tab);
    }
    activate(path, reveal);
  }

  function activate(path, reveal = null) {
    const tab = state.tabs.find((t) => t.path === path);
    if (!tab) return;
    const prev = activeTab();
    if (prev && editor && prev !== tab && !state.diff) prev.viewState = editor.saveViewState();
    if (state.diff) exitDiff();
    state.active = path;
    els.media.hidden = true;
    const f = files()[path];
    if (editor) {
      editor.setModel(tab.model);
      editor.updateOptions({ minimap: { enabled: (tab.model.getValueLength() || 0) < 1_500_000, renderCharacters: false } });
      if (tab.viewState) editor.restoreViewState(tab.viewState);
      if (reveal) {
        const range = new monaco.Range(reveal.line, reveal.col || 1, reveal.line, (reveal.col || 1) + (reveal.length || 0));
        editor.setSelection(range);
        editor.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
      }
      editor.focus();
    } else if (fallback) {
      fallback.value = tab.text;
    }
    els.welcome.hidden = true;
    els.toolbar.hidden = false;
    renderCrumbs(path);
    renderTabs();
    renderTree();
    renderStatus();
    applySplit();
    // Reveal in tree
    const parts = path.split("/");
    let changed = false;
    for (let i = 1; i < parts.length; i += 1) {
      const p = parts.slice(0, i).join("/");
      if (!state.expanded.has(p)) {
        state.expanded.add(p);
        changed = true;
      }
    }
    if (changed) renderTree();
    const row = els.tree.querySelector(`[data-file="${CSS.escape(path)}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
    ctx.onActiveFile(path, f);
  }

  function renderCrumbs(path) {
    const parts = path.split("/");
    els.crumbs.innerHTML = [`<span>${escapeHtml(ctx.slug() || "")}</span>`, ...parts.map((p, i) => `<span class="${i === parts.length - 1 ? "last" : ""}">${escapeHtml(p)}</span>`)].join(`<span class="sep">${icon("chevronRight")}</span>`);
  }

  function renderStatus() {
    const meta = ctx.meta();
    $("#sbSite").innerHTML = `${icon("database")}${escapeHtml(meta ? meta.slug : "—")}`;
    const f = state.active && files()[state.active];
    const src = $("#sbSource");
    if (!f) {
      $("#sbPos").textContent = "";
      $("#sbSize").textContent = "";
      $("#sbLang").textContent = "";
      src.textContent = "";
      src.removeAttribute("href");
      $("#sbMod").hidden = true;
      return;
    }
    $("#sbSize").textContent = formatBytes(f.size || fileText(f).length);
    $("#sbLang").textContent = languageFor(f.path, f.type);
    const url = String(f.sourceUrl || "").replace(/^[A-Z]+ /, "");
    if (/^https?:\/\//.test(url)) {
      src.href = url.split("#")[0];
      src.innerHTML = `${icon("external")}${escapeHtml(url)}`;
    } else {
      src.removeAttribute("href");
      src.textContent = url;
    }
    const tab = activeTab();
    $("#sbMod").hidden = !(typeof f.edited === "string" || (tab && tab.dirty));
    $("#diffBtn").disabled = !monaco;
    $("#beautifyBtn").disabled = !prettierParser(languageFor(f.path, f.type)) && f.type !== "map";
    $("#splitBtn").disabled = !(f.type === "html" || f.type === "css");
  }

  // ── Save / revert / beautify ──────────────────────────────────────────
  async function save() {
    const tab = activeTab();
    if (!tab) return;
    const f = files()[tab.path];
    const text = tabText(tab);
    if (text === f.content) delete f.edited;
    else f.edited = text;
    f.editedAt = Date.now();
    await ctx.persistFile(f);
    if (tab.model) tab.savedVersion = tab.model.getAlternativeVersionId();
    tab.saved = text;
    setDirty(tab, false);
    renderTree();
    renderStatus();
    toast("Saved", tab.path, "success", 2200);
  }

  async function revert() {
    const tab = activeTab();
    if (!tab) return;
    const f = files()[tab.path];
    if (typeof f.edited !== "string" && !tab.dirty) return toast("Nothing to revert", "This file matches the scraped original.", "info", 2400);
    const ok = await confirmDialog({ title: "Revert to original?", message: `Discard all edits to ${tab.path} and restore the scraped version.`, confirmText: "Revert", danger: true });
    if (!ok) return;
    delete f.edited;
    await ctx.persistFile(f);
    if (tab.model) {
      tab.model.setValue(f.content);
      tab.savedVersion = tab.model.getAlternativeVersionId();
    } else {
      tab.text = f.content;
      fallback.value = f.content;
    }
    tab.saved = f.content;
    setDirty(tab, false);
    renderTree();
    renderStatus();
    toast("Reverted", tab.path, "info", 2200);
  }

  async function beautify() {
    const tab = activeTab();
    if (!tab) return;
    const f = files()[tab.path];
    const lang = languageFor(f.path, f.type);
    const parser = prettierParser(lang);
    const text = tabText(tab);
    let out = null;
    if (lang === "json") {
      try {
        out = JSON.stringify(JSON.parse(text), null, 2);
      } catch {}
    }
    if (out === null && parser) {
      if (text.length > 2_500_000) {
        const ok = await confirmDialog({ title: "Beautify a large file?", message: `This file is ${formatBytes(text.length)}. Formatting may freeze the tab for a few seconds.`, confirmText: "Beautify" });
        if (!ok) return;
      }
      const btn = $("#beautifyBtn");
      btn.disabled = true;
      toast("Beautifying…", `${tab.path} with Prettier`, "info", 1800);
      try {
        const prettier = await loadPrettier();
        await new Promise((r) => setTimeout(r, 30));
        out = await prettier.format(text, { parser, plugins: prettier.plugins, printWidth: 100, htmlWhitespaceSensitivity: "ignore" });
      } catch (error) {
        ctx.log(`Prettier failed on ${tab.path}: ${String(error.message).split("\n")[0]}`, "warn");
        if (editor) {
          await editor.getAction("editor.action.formatDocument")?.run();
          toast("Formatted with built-in formatter", "Prettier couldn't parse this file.", "warn");
          btn.disabled = false;
          return;
        }
      } finally {
        btn.disabled = false;
      }
    }
    if (out === null) return toast("Can't beautify", "No formatter for this file type.", "warn");
    if (out === text) return toast("Already formatted", tab.path, "info", 2000);
    if (editor && tab.model) {
      editor.pushUndoStop();
      editor.executeEdits("beautify", [{ range: tab.model.getFullModelRange(), text: out }]);
      editor.pushUndoStop();
    } else {
      tab.text = out;
      fallback.value = out;
      setDirty(tab, out !== tab.saved);
    }
    toast("Beautified", `${tab.path} — Ctrl S to keep it`, "success", 2600);
  }

  // ── Diff ──────────────────────────────────────────────────────────────
  function enterDiff() {
    const tab = activeTab();
    if (!tab || !diffEditor) return;
    const f = files()[tab.path];
    tab.viewState = editor.saveViewState();
    diffOriginal = monaco.editor.createModel(f.content, tab.model.getLanguageId());
    diffEditor.setModel({ original: diffOriginal, modified: tab.model });
    mainHost.hidden = true;
    diffHost.hidden = false;
    state.diff = true;
    $("#diffBtn").classList.add("is-active");
    diffEditor.layout();
  }

  function exitDiff() {
    if (!state.diff) return;
    diffEditor.setModel(null);
    if (diffOriginal) diffOriginal.dispose();
    diffOriginal = null;
    diffHost.hidden = true;
    mainHost.hidden = false;
    state.diff = false;
    $("#diffBtn").classList.remove("is-active");
    const tab = activeTab();
    if (tab && tab.viewState) editor.restoreViewState(tab.viewState);
  }

  // ── Wrap & split preview ──────────────────────────────────────────────
  function toggleWrap() {
    const wrapping = editor ? editor.getOption(monaco.editor.EditorOption.wrappingInfo).isViewportWrapping : !!prefs.wrap;
    prefs.wrap = !wrapping;
    savePrefs();
    if (editor) editor.updateOptions({ wordWrap: prefs.wrap ? "on" : "off", wordWrapMinified: prefs.wrap });
    if (fallback) fallback.style.whiteSpace = prefs.wrap ? "pre-wrap" : "pre";
    $("#wrapBtn").classList.toggle("is-active", prefs.wrap);
  }

  function applySplit() {
    const f = state.active && files()[state.active];
    const can = f && (f.type === "html" || f.type === "css");
    els.split.hidden = !(prefs.split && can);
    $("#splitBtn").classList.toggle("is-active", !!prefs.split);
    if (!els.split.hidden) renderSplit();
  }

  function scheduleSplit() {
    if (els.split.hidden) return;
    clearTimeout(splitTimer);
    splitTimer = setTimeout(renderSplit, 450);
  }

  function renderSplit() {
    const tab = activeTab();
    if (!tab) return;
    const f = files()[tab.path];
    els.splitFrame.setAttribute("sandbox", SANDBOX_WITH_SCRIPTS);
    els.splitFrame.srcdoc = buildPreviewDoc(f, files(), { contentOverride: tabText(tab) });
    $("#spLabel").textContent = `Live preview · ${tab.path.split("/").pop()}`;
  }

  // ── Search ────────────────────────────────────────────────────────────
  let searchTimer = null;
  function runSearch() {
    const q = els.searchInput.value;
    if (q.length < 2) {
      els.searchResults.innerHTML = "";
      els.searchCount.textContent = "";
      return;
    }
    let re;
    try {
      re = new RegExp(state.searchRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), state.searchCase ? "g" : "gi");
    } catch {
      els.searchCount.textContent = "invalid regex";
      return;
    }
    const groups = [];
    let total = 0;
    const needle = state.searchCase ? q : q.toLowerCase();
    for (const f of Object.values(files()).sort((a, b) => a.path.localeCompare(b.path))) {
      if (total >= 2000 || groups.length >= 300) break;
      if (f.encoding === "base64") continue;
      const text = fileText(f);
      if (!state.searchRegex && !(state.searchCase ? text : text.toLowerCase()).includes(needle)) continue;
      const lines = text.split("\n");
      const hits = [];
      for (let i = 0; i < lines.length && hits.length < 50; i += 1) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (!m) continue;
        hits.push({ line: i + 1, col: m.index + 1, len: m[0].length, text: lines[i] });
      }
      if (hits.length) {
        groups.push({ f, hits });
        total += hits.length;
      }
    }
    els.searchCount.textContent = `${total}${total >= 2000 ? "+" : ""} in ${groups.length} files`;
    els.searchResults.innerHTML = groups
      .map(({ f, hits }) => {
        const type = TYPES.some((x) => x[0] === f.type) ? f.type : "text";
        const lines = hits
          .map((h) => {
            const start = Math.max(0, h.col - 1 - 18);
            const before = h.text.slice(start, h.col - 1);
            const match = h.text.slice(h.col - 1, h.col - 1 + h.len);
            const after = h.text.slice(h.col - 1 + h.len, h.col - 1 + h.len + 120);
            return `<div class="sr-line" data-path="${escapeHtml(f.path)}" data-line="${h.line}" data-col="${h.col}" data-len="${h.len}"><span class="ln">${h.line}</span>${start ? "…" : ""}${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}</div>`;
          })
          .join("");
        return `<div class="sr-file" data-path="${escapeHtml(f.path)}"><span class="ficon ${type}">${type === "text" ? "TXT" : type.toUpperCase().slice(0, 4)}</span><span class="name" style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(f.path)}</span><span class="n">${hits.length}</span></div>${lines}`;
      })
      .join("") || `<div class="pal-empty">No matches</div>`;
  }
  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 260);
  });
  els.searchResults.addEventListener("click", (e) => {
    const line = e.target.closest(".sr-line");
    if (line) return openFile(line.dataset.path, { line: Number(line.dataset.line), col: Number(line.dataset.col), length: Number(line.dataset.len) });
    const file = e.target.closest(".sr-file");
    if (file) openFile(file.dataset.path);
  });
  $("#searchCase").addEventListener("click", (e) => {
    state.searchCase = !state.searchCase;
    e.currentTarget.classList.toggle("is-active", state.searchCase);
    runSearch();
  });
  $("#searchRegex").addEventListener("click", (e) => {
    state.searchRegex = !state.searchRegex;
    e.currentTarget.classList.toggle("is-active", state.searchRegex);
    runSearch();
  });

  // Links clicked in the split preview open the matching scraped page in the editor.
  window.addEventListener("message", (event) => {
    if (!els.splitFrame || event.source !== els.splitFrame.contentWindow) return;
    const m = event.data || {};
    if (m.type !== "cx-nav" || typeof m.href !== "string") return;
    const norm = (u) => String(u || "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
    const page = Object.values(files()).find((f) => f.type === "html" && f.sourceUrl && norm(f.sourceUrl) === norm(m.href));
    if (page) openFile(page.path);
    else toast("Page not in this scrape", m.href, "warn", 3000);
  });

  // ── Site map: API endpoints, routes and libraries found in the scrape ──
  let mapTab = "endpoints";
  function mapItems() {
    const intel = (ctx.meta() && ctx.meta().stats && ctx.meta().stats.intel) || null;
    if (!intel) return null;
    if (mapTab === "endpoints")
      return [
        ...intel.endpoints.map((e) => ({ text: `${e.method} ${e.host}${e.path}`, e })),
        ...(intel.graphql || []).map((g) => ({ text: g.op, g })),
      ];
    if (mapTab === "routes") return [...intel.routes.map((r) => ({ text: r, group: "Defined in the app's router" })), ...intel.crawledPaths.map((r) => ({ text: r, group: "Pages crawled" }))];
    return [
      ...(intel.tech || []).map((t) => ({ text: t.detail ? `${t.name} (${t.detail})` : t.name, t, group: "Hosting & tech" })),
      ...intel.libraries.map((l) => ({ text: l.version ? `${l.name}@${l.version}` : l.name, l, group: "Libraries bundled" })),
    ];
  }
  function renderMap() {
    const items = mapItems();
    if (!items) {
      els.mapBody.innerHTML = `<div class="pal-empty">${ctx.meta() ? "This scrape was made before the site map existed. Scrape again to build it." : "No scrape loaded."}</div>`;
      return;
    }
    const q = els.mapFilter.value.trim().toLowerCase();
    const list = q ? items.filter((i) => i.text.toLowerCase().includes(q)) : items;
    if (!list.length) {
      els.mapBody.innerHTML = `<div class="pal-empty">${items.length ? "No matches." : `No ${mapTab} found.`}</div>`;
      return;
    }
    let html = "";
    if (mapTab === "endpoints") {
      const eps = list.filter((i) => i.e);
      const ops = list.filter((i) => i.g);
      const captured = eps.filter((i) => i.e.captured).length;
      html += `<div class="map-group"><span>${eps.length} endpoints</span><span>${captured} with a captured response</span></div>`;
      html += eps
        .map(({ e }) => {
          const hostLabel = e.host === list[0].e.host ? "" : `<small>${escapeHtml(e.host)}</small>`;
          return `<div class="map-row ${e.captured ? "open" : ""}" ${e.captured ? `data-open="${escapeHtml(e.captured)}"` : ""} title="${escapeHtml(`${e.method} ${e.host}${e.path}`)}"><span class="m ${escapeHtml(e.method)}">${escapeHtml(e.method)}</span><span class="p">${hostLabel}${escapeHtml(e.path)}</span>${e.captured ? `<span class="tag">${e.samples > 1 ? `${e.samples} responses` : "response"}</span>` : e.inCode ? '<span class="tag dim">in code</span>' : ""}</div>`;
        })
        .join("");
      if (ops.length) {
        html += `<div class="map-group"><span>GraphQL operations</span><span>${ops.length}</span></div>`;
        // Clicking an operation searches every file for it.
        html += ops.map(({ g }) => `<div class="map-row open" data-search="${escapeHtml(g.op.split(" ")[1])}"><span class="m GQL">${escapeHtml(g.type.slice(0, 5).toUpperCase())}</span><span class="p">${escapeHtml(g.op.split(" ")[1])}</span></div>`).join("");
      }
    } else if (mapTab === "routes") {
      let group = null;
      for (const i of list) {
        if (i.group !== group) {
          group = i.group;
          html += `<div class="map-group"><span>${escapeHtml(group)}</span><span>${list.filter((x) => x.group === group).length}</span></div>`;
        }
        const page = i.group === "Pages crawled" ? Object.values(files()).find((f) => f.type === "html" && f.sourceUrl && new URL(f.sourceUrl).pathname === i.text) : null;
        html += `<div class="map-row ${page ? "open" : ""}" ${page ? `data-open="${escapeHtml(page.path)}"` : ""}><span class="p">${escapeHtml(i.text)}</span>${page ? '<span class="tag">page</span>' : ""}</div>`;
      }
    } else {
      let group = null;
      for (const i of list) {
        if (i.group !== group) {
          group = i.group;
          html += `<div class="map-group"><span>${escapeHtml(group)}</span><span>${list.filter((x) => x.group === group).length}</span></div>`;
        }
        if (i.l) html += `<div class="map-row"><span class="p">${escapeHtml(i.l.name)}</span>${i.l.version ? `<span class="tag dim">v${escapeHtml(i.l.version)}</span>` : ""}</div>`;
        else html += `<div class="map-row"><span class="p">${escapeHtml(i.t.name)}</span>${i.t.detail ? `<span class="tag dim">${escapeHtml(i.t.detail)}</span>` : ""}</div>`;
      }
    }
    els.mapBody.innerHTML = html;
  }
  els.mapBody.addEventListener("click", (e) => {
    const row = e.target.closest("[data-open]");
    if (row && files()[row.dataset.open]) openFile(row.dataset.open);
    const find = e.target.closest("[data-search]");
    if (find) {
      els.searchInput.value = find.dataset.search;
      showSide("search");
      runSearch();
    }
  });
  els.mapFilter.addEventListener("input", renderMap);
  $$("#mapTabs [data-maptab]").forEach((b) =>
    b.addEventListener("click", () => {
      mapTab = b.dataset.maptab;
      $$("#mapTabs [data-maptab]").forEach((x) => x.classList.toggle("is-active", x === b));
      renderMap();
    })
  );
  $("#mapCopy").addEventListener("click", async () => {
    const items = mapItems() || [];
    const q = els.mapFilter.value.trim().toLowerCase();
    const text = (q ? items.filter((i) => i.text.toLowerCase().includes(q)) : items).map((i) => i.text).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", `${text ? text.split("\n").length : 0} ${mapTab}`, "success", 1800);
    } catch {
      toast("Copy failed", "Clipboard access was blocked.", "warn");
    }
  });

  // ── Info panel ────────────────────────────────────────────────────────
  function renderInfo() {
    const meta = ctx.meta();
    if (!meta) {
      els.infoBody.innerHTML = `<div class="pal-empty">No scrape loaded.</div>`;
      els.warnCount.hidden = true;
      return;
    }
    const s = meta.stats || {};
    const q = s.quality || {};
    const rows = [
      ["Source", meta.sourceUrl],
      ["Engine", meta.engine || "—"],
      ["Duration", meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : "—"],
      ["Pages", s.pagesVisited],
      ["Assets saved", s.assetsSaved],
      ["Files", meta.fileCount],
      ["Total size", formatBytes(meta.totalSize)],
      ["Recovered sources", s.sourceMapSourcesSaved],
      ["Webpack chunks found", s.webpackChunksFound],
      ["Chunks force-loaded", s.forcedChunks],
      ["Runtime CSS dumps", s.runtimeCssFiles],
      ["API captures", s.networkCaptures],
      ["API endpoints mapped", s.intel ? s.intel.endpoints.length : "—"],
      ["App routes", s.intel ? s.intel.routes.length : "—"],
      ["Libraries detected", s.intel ? s.intel.libraries.length : "—"],
      ["Images & fonts", s.mediaSaved],
      ["Ads & trackers skipped", s.trackersSkipped || 0],
      ["GraphQL operations", s.intel && s.intel.graphql ? s.intel.graphql.length : "—"],
      ["Hosting & tech", s.intel && s.intel.tech ? s.intel.tech.map((t) => t.name).join(", ") || "—" : "—"],
      ["Worker scripts", s.workerScripts || 0],
      ["WebAssembly modules", s.wasmModules || 0],
      ["Pop-ups closed", s.popupsClosed || 0],
      ["Menus & tabs opened", s.uiExpanded || 0],
      ["Sitemap pages", s.sitemapPages],
      ["Completeness", q.completenessScore != null ? `${q.completenessScore}%` : "—"],
    ];
    const fw = (meta.frameworks || []).map((f) => `<span class="chip">${escapeHtml(f)}</span>`).join(" ");
    const warns = (meta.warnings || []).slice(0, 200);
    els.infoBody.innerHTML = `${fw ? `<div class="chip-row" style="justify-content:flex-start;margin:4px 0 10px">${fw}</div>` : ""}${rows
      .map(([k, v]) => `<div class="kv"><span>${k}</span><b title="${escapeHtml(v ?? "")}">${escapeHtml(v ?? 0)}</b></div>`)
      .join("")}<div class="side-title" style="margin-top:16px"><span>Warnings</span><span>${warns.length}</span></div>${warns.map((w) => `<div class="warn-item">${escapeHtml(w)}</div>`).join("") || '<div class="pal-empty">None 🎉</div>'}`;
    els.warnCount.textContent = String(Math.min(99, (meta.warnings || []).length));
    els.warnCount.hidden = !(meta.warnings || []).length;
  }

  // ── Side views & resizer ──────────────────────────────────────────────
  function showSide(view) {
    if (state.sideView === view && !els.ws.classList.contains("side-collapsed")) {
      els.ws.classList.add("side-collapsed");
      return;
    }
    els.ws.classList.remove("side-collapsed");
    state.sideView = view;
    $$(".act-btn[data-side]").forEach((b) => b.classList.toggle("active", b.dataset.side === view));
    $$(".side-view").forEach((v) => (v.hidden = v.dataset.view !== view));
    if (view === "search") setTimeout(() => els.searchInput.focus(), 30);
    if (view === "info") renderInfo();
    if (view === "map") renderMap();
  }
  $$(".act-btn[data-side]").forEach((b) => b.addEventListener("click", () => showSide(b.dataset.side)));

  (() => {
    const handle = $("#wsResizer");
    let startX = 0;
    let startW = 0;
    handle.addEventListener("pointerdown", (e) => {
      startX = e.clientX;
      startW = els.side.getBoundingClientRect().width;
      handle.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!handle.classList.contains("dragging")) return;
      const w = Math.max(200, Math.min(620, startW + e.clientX - startX));
      els.ws.style.setProperty("--side-w", `${w}px`);
      prefs.sideW = w;
    });
    handle.addEventListener("pointerup", () => {
      handle.classList.remove("dragging");
      savePrefs();
    });
  })();

  // ── Quick open palette ────────────────────────────────────────────────
  let palItems = [];
  let palSel = 0;
  function openPalette() {
    if (!ctx.slug()) return toast("No scrape loaded", "Run a scrape first.", "warn");
    els.palette.classList.add("open");
    els.paletteInput.value = "";
    renderPalette();
    setTimeout(() => els.paletteInput.focus(), 30);
  }
  function closePalette() {
    els.palette.classList.remove("open");
    if (editor && state.active) editor.focus();
  }
  function renderPalette() {
    const q = els.paletteInput.value.trim();
    palItems = Object.keys(files())
      .map((p) => ({ p, r: fuzzyScore(q, p) }))
      .filter((x) => x.r)
      .sort((a, b) => b.r.score - a.r.score)
      .slice(0, 60);
    palSel = 0;
    drawPalette();
  }
  function drawPalette() {
    els.paletteList.innerHTML = palItems.length
      ? palItems
          .map(({ p, r }, i) => {
            const f = files()[p];
            const type = TYPES.some((x) => x[0] === f.type) ? f.type : "text";
            const nameStart = p.lastIndexOf("/") + 1;
            const hit = new Set(r.hits);
            const name = [...p.slice(nameStart)].map((c, j) => (hit.has(nameStart + j) ? `<b>${escapeHtml(c)}</b>` : escapeHtml(c))).join("");
            return `<div class="pal-item ${i === palSel ? "sel" : ""}" data-i="${i}"><span class="ficon ${type}">${type === "text" ? "TXT" : type.toUpperCase().slice(0, 4)}</span><span>${name}</span><span class="dir">${escapeHtml(p.slice(0, nameStart))}</span></div>`;
          })
          .join("")
      : `<div class="pal-empty">No matching files</div>`;
    const sel = els.paletteList.querySelector(".sel");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }
  els.paletteInput.addEventListener("input", renderPalette);
  els.paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      palSel = Math.min(palItems.length - 1, palSel + 1);
      drawPalette();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      palSel = Math.max(0, palSel - 1);
      drawPalette();
      e.preventDefault();
    } else if (e.key === "Enter" && palItems[palSel]) {
      const p = palItems[palSel].p;
      closePalette();
      openFile(p);
    } else if (e.key === "Escape") closePalette();
  });
  els.paletteList.addEventListener("click", (e) => {
    const item = e.target.closest("[data-i]");
    if (!item) return;
    const p = palItems[Number(item.dataset.i)].p;
    closePalette();
    openFile(p);
  });
  els.palette.addEventListener("click", (e) => e.target === els.palette && closePalette());
  $("#paletteBtn").addEventListener("click", openPalette);

  // ── Exports ───────────────────────────────────────────────────────────
  function download(content, filename, type) {
    const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const safeName = (s) => String(s || "file").replace(/[\\/:*?"<>|]+/g, "_");

  async function zip(list, name) {
    if (!window.JSZip) return toast("ZIP unavailable", "JSZip failed to load.", "error");
    if (!list.length) return toast("Nothing to export", "Select files first.", "warn");
    const z = new window.JSZip();
    list.forEach((f) => (f.encoding === "base64" ? z.file(f.path, f.content, { base64: true }) : z.file(f.path, fileText(f))));
    toast("Building ZIP…", `${list.length} files`, "info", 1800);
    const blob = await z.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    download(blob, `${safeName(name)}.zip`, "application/zip");
    ctx.log(`Exported ${list.length} files to ${name}.zip (${formatBytes(blob.size)})`, "success");
    toast("ZIP ready", `${list.length} files · ${formatBytes(blob.size)}`, "success");
  }

  $("#zipAllBtn").addEventListener("click", () => zip(Object.values(files()), ctx.slug() || "scrape"));
  $("#zipSelBtn").addEventListener("click", () => zip([...state.selected].map((p) => files()[p]).filter(Boolean), `${ctx.slug()}-selected`));
  $("#manifestBtn").addEventListener("click", () => {
    const meta = ctx.meta();
    if (!meta) return;
    const manifest = {
      ...meta,
      files: Object.values(files()).map((f) => ({ path: f.path, type: f.type, kind: f.kind, sourceUrl: f.sourceUrl, size: f.size, edited: typeof f.edited === "string", renderSource: f.renderSource })),
    };
    download(JSON.stringify(manifest, null, 2), `${safeName(meta.slug)}-manifest.json`, "application/json");
  });
  $("#dlFileBtn").addEventListener("click", () => {
    const tab = activeTab();
    if (tab) download(tabText(tab), safeName(tab.path.split("/").pop()), "text/plain");
  });

  // ── Toolbar ───────────────────────────────────────────────────────────
  $("#saveBtn").addEventListener("click", save);
  $("#revertBtn").addEventListener("click", revert);
  $("#beautifyBtn").addEventListener("click", beautify);
  $("#wrapBtn").addEventListener("click", toggleWrap);
  $("#wrapBtn").classList.toggle("is-active", prefs.wrap);
  $("#diffBtn").addEventListener("click", () => (state.diff ? exitDiff() : enterDiff()));
  $("#splitBtn").addEventListener("click", () => {
    prefs.split = !prefs.split;
    savePrefs();
    applySplit();
  });
  $("#welcomeBtn").addEventListener("click", () => {
    if (!ctx.slug()) return ctx.goHome();
    const best = ctx.bestFile();
    if (best) openFile(best);
  });
  els.siteSelect.addEventListener("change", () => ctx.switchScrape(els.siteSelect.value));

  // Global shortcuts while the workspace is visible
  document.addEventListener("keydown", (e) => {
    if (!ctx.isVisible()) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      openPalette();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      showSide("search");
    } else if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      els.ws.classList.toggle("side-collapsed");
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (e.altKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      if (state.active) closeTab(state.active);
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.tabs.some((t) => t.dirty)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ── Public API ────────────────────────────────────────────────────────
  return {
    async load() {
      if (state.diff) exitDiff();
      state.tabs.forEach((t) => t.model && t.model.dispose());
      state.tabs = [];
      state.active = null;
      state.selected.clear();
      state.expanded.clear();
      els.filter.value = state.filter = "";
      els.searchResults.innerHTML = "";
      els.searchCount.textContent = "";
      renderTypeFilters();
      renderTabs();
      showEmpty();
      renderInfo();
      renderMap();
    },
    renderSites(list, active) {
      els.siteSelect.innerHTML = list.length
        ? list.map((s) => `<option value="${escapeHtml(s.slug)}" ${s.slug === active ? "selected" : ""}>${escapeHtml(s.slug)} · ${s.fileCount || 0} files</option>`).join("")
        : `<option value="">No saved scrapes</option>`;
    },
    openFile,
    refresh() {
      renderTypeFilters();
      renderTree();
      renderInfo();
      renderMap();
    },
    hasDirty: () => state.tabs.some((t) => t.dirty),
    activePath: () => state.active,
    warm: () => ensureEditor(),
    layout() {
      if (editor) editor.layout();
      if (diffEditor && state.diff) diffEditor.layout();
    },
  };
}
