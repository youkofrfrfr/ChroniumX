# ChroniumX v4 — Heavy-JS Website Source Scraper

ChroniumX pulls the real front-end source out of a website, even when the site is a JavaScript-heavy single-page app. It also gives you a full code workspace for exploring and editing what it captured.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

### Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/youkofrfrfr/ChroniumX)

Import the repo in Vercel (or run `npx vercel`). No build step or settings are needed:

- `vercel.json` serves `index.html` and `assets/` as static files, rewrites app routes (`/workspace`, `/preview/...`) to `index.html`, and deploys `api/scrape.js` as a Node 22 function with a 300 s limit.
- `@sparticuz/chromium` provides headless Chrome inside the function. Its binary is bundled explicitly through `includeFiles`.
- The function runs 2 Chrome tabs at a time (functions get one vCPU). Scrapes stop at 270 s and keep partial results.
- Optional: set `BROWSER_WS_ENDPOINT` to a hosted browser (for example Browserless) for faster, larger renders. It's used instead of the bundled Chromium.
- If Chrome can't start, the scraper falls back to the static engine and says so in the console.

`server.js` is only for local runs and is excluded from deploys by `.vercelignore`.

## Scrape engine

**Headless Chrome engine** (used automatically when a browser is available):

- Renders each page in real Chrome and captures **every response** it loads: scripts, stylesheets, lazy chunks, manifests and XHR/fetch JSON.
- **Forces every lazy webpack chunk to load.** It grabs the live `__webpack_require__` runtime and calls `.e()` for each chunk ID it knows about.
- **Dumps runtime CSS** (styled-components, emotion, `insertRule`, adopted stylesheets) that never appears in the HTML.
- Auto-scrolls to trigger lazy-loaded code, reads `__BUILD_MANIFEST` for Next.js page chunks and routes, and saves the hydrated DOM as a "rendered snapshot".

**Static engine** (always runs; it's the fallback when no browser is available):

- **Reconstructs webpack chunk URLs** by evaluating the runtime's chunk-filename function in a sandbox.
- Discovers Next.js build manifests, CRA `asset-manifest.json`, Vite `.vite/manifest.json`, Nuxt build meta, service workers, `robots.txt` and `sitemap.xml`.
- Probes for `.map` files even when there's no `sourceMappingURL` comment. It then **rebuilds the original files** from `sourcesContent` into a clean `recovered/` tree (vendor `node_modules` are optional).
- Extracts inline scripts and styles, import maps, `modulepreload` links, workers and dynamic imports.
- Crawls pages and assets in parallel, retries with backoff, and rejects SPA fallback pages served for missing assets.
- Files stream to the browser as they're saved. Bundles up to 3 MB each are kept, up to 40 MB per scrape.

Headless browser options, tried in order:

| Option | How |
| --- | --- |
| Remote browser | Set `BROWSER_WS_ENDPOINT` (for example a Browserless WebSocket URL) |
| Vercel / Lambda | `@sparticuz/chromium` (bundled) |
| Local | Auto-detects installed Chrome, Chromium, Brave or Edge, or set `CHROME_PATH` |
| REST snapshot | `BROWSER_RENDER_ENDPOINT` + `BROWSER_RENDER_TOKEN` (used when no headless Chrome is available) |

Other environment variables:

- `SCRAPE_TIME_BUDGET_MS`: time limit per scrape (default 270000).
- `ALLOW_PRIVATE_TARGETS=1`: allows scraping localhost and private-network hosts. They're blocked by default.

## Workspace

The workspace is built on Monaco, the editor engine behind VS Code.

- **Explorer:** file tree, type filters, multi-select, and ZIP / selected-files / manifest export.
- **Editing:** tabs, edit and save (stored in IndexedDB), diff against the scraped original, and one-click revert.
- **Beautify:** Prettier formats minified JS, TS, CSS, HTML and JSON (<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>).
- **Search:** regex and match-case search across every captured file (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>).
- **Quick open:** fuzzy file finder (<kbd>Ctrl</kbd>+<kbd>P</kbd>).
- **Live split preview** for HTML and CSS that updates as you type.
- **Scrape report:** frameworks detected, stats and warnings.

## Preview

The preview shows a rendered snapshot or the original HTML in a desktop, tablet or phone frame. Captured CSS and JS are inlined, and a `<base>` tag lets images and fonts load from the live site. Page scripts only run inside an opaque-origin sandbox, so they can't reach the app's data.

## Project layout

```
index.html            App shell
assets/css/app.css    Glass design system
assets/js/            app (routing, scrape UI), workspace (Monaco), preview, store (IndexedDB), ui, icons
api/scrape.js         Streaming NDJSON scrape endpoint (GET = engine capabilities)
lib/                  util, fetcher, discovery (chunk maps, manifests, source maps), browser (headless)
server.js             Local dev server that mirrors Vercel routing
```

Saved scrapes live in your browser's IndexedDB. Scrapes saved by v3 in localStorage are migrated automatically.
