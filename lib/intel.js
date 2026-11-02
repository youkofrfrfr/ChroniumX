"use strict";

/*
 * Site intelligence gathered while scraping: the API endpoints an app calls, the routes it
 * defines, and the libraries bundled into it. Runs on the server over captured code and traffic.
 */

// Ads, analytics and session-replay hosts. Their code is never part of the site itself.
const TRACKER_HOST_RE =
  /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com|googlesyndication\.com|googletagservices\.com|doubleclick\.net|googleadservices\.com|adservice\.google\.[a-z.]+|fundingchoicesmessages\.google\.com|facebook\.net|connect\.facebook\.com|hotjar\.com|hotjar\.io|segment\.(?:io|com)|mixpanel\.com|amplitude\.com|fullstory\.com|clarity\.ms|bat\.bing\.com|scorecardresearch\.com|newrelic\.com|nr-data\.net|sentry\.io|ingest\.sentry\.io|datadoghq\.com|browser-intake-datadoghq\.com|optimizely\.com|analytics\.tiktok\.com|ads-twitter\.com|criteo\.(?:com|net)|taboola\.com|outbrain\.com|quantserve\.com|adsrvr\.org|amazon-adsystem\.com|onetrust\.com|cookielaw\.org|cloudflareinsights\.com|plausible\.io|umami\.is|posthog\.com|heap(?:analytics)?\.(?:io|com)|intercomcdn\.com|branch\.io|appsflyer\.com|braze\.com|launchdarkly\.com|px-cloud\.net|perimeterx\.net|ecsv2\.roblox\.com|metrics\.roblox\.com|adnxs\.com|rubiconproject\.com|pubmatic\.com|openx\.net|media\.net|moatads\.com|chartbeat\.(?:com|net)|yandex\.ru\/metrika|mc\.yandex\.ru)$/i;

function isTrackerUrl(url) {
  try {
    const u = new URL(url);
    return TRACKER_HOST_RE.test(u.hostname) || /\/(?:adsbygoogle|gpt|beacon\.min|analytics|gtag|gtm)\.js(?:\?|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

// Well-known libraries: a code signature, and an optional pattern that captures the version.
const LIBRARY_SIGNATURES = [
  ["React", /__REACT_DEVTOOLS_GLOBAL_HOOK__|react\.(?:element|fragment|portal)|ReactCurrentOwner/, /\bversion\s*[:=]\s*"(1[6-9]\.\d+\.\d+(?:-[\w.]+)?)"[^;]{0,120}(?:rendererPackageName|react-dom)/],
  ["React DOM", /react-dom|rendererPackageName:"react-dom"/, /rendererPackageName:"react-dom"[^}]{0,200}?version:"(\d+\.\d+\.\d+)"|version:"(\d+\.\d+\.\d+)"[^}]{0,200}?rendererPackageName:"react-dom"/],
  ["React Router", /useNavigate|createBrowserRouter|react-router/],
  ["Next.js", /__NEXT_DATA__|next\/dist|__next_f/],
  ["Vue", /__VUE__|createVNode|__vue_app__/, /version\s*[:=]\s*"(3\.\d+\.\d+)"/],
  ["Angular", /ng-version|ɵcmp|platformBrowser/, /ng-version="?(\d+\.\d+\.\d+)/],
  ["Svelte", /svelte-[a-z0-9]{6}|SvelteComponent/],
  ["Preact", /__PREACT_DEVTOOLS__|preact/],
  ["Monaco Editor", /monaco-editor|MonacoEnvironment|vs\/editor\/editor/, /monaco-editor[@/v ]+(\d+\.\d+\.\d+)/],
  ["CodeMirror", /CodeMirror|cm-editor/],
  ["jQuery", /jQuery\s+v?\d|jquery\.org\/license/, /jQuery\s+v?(\d+\.\d+\.\d+)/],
  ["Lodash", /lodash|__lodash_hash_undefined__/, /@license\s+Lodash[^\n]*?(\d+\.\d+\.\d+)|VERSION\s*=\s*"(4\.\d+\.\d+)"/],
  ["axios", /AxiosError|axios\/|ERR_BAD_REQUEST/, /VERSION\s*=\s*"(1\.\d+\.\d+)"[^;]{0,80}axios|axios\/(\d+\.\d+\.\d+)/],
  ["Socket.IO", /socket\.io|engine\.io/],
  ["Firebase", /firebaseapp\.com|@firebase\//, /SDK_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/],
  ["Supabase", /supabase\.co|@supabase\//],
  ["Sentry", /@sentry\/|__SENTRY__/, /SDK_VERSION\s*=\s*"(\d+\.\d+\.\d+)"[^;]{0,60}sentry/i],
  ["Stripe.js", /js\.stripe\.com|Stripe\(/],
  ["Tailwind CSS", /tailwindcss v?\d|--tw-[a-z-]+:/, /tailwindcss v?(\d+\.\d+\.\d+)/],
  ["Framer Motion", /framer-motion|MotionValue|useAnimation/],
  ["highlight.js", /hljs|highlight\.js/],
  ["Prism", /Prism\.languages|prismjs/],
  ["marked", /marked\s*\(|markedjs/],
  ["DOMPurify", /DOMPurify/, /DOMPurify\s+(\d+\.\d+\.\d+)/],
  ["date-fns", /date-fns/],
  ["Moment.js", /moment\.version|momentjs/, /version\s*=\s*"(2\.\d+\.\d+)"[^;]{0,40}moment/],
  ["Chart.js", /Chart\.js|chartjs/, /Chart\.js v(\d+\.\d+\.\d+)/],
  ["three.js", /THREE\.|three\.module|REVISION\s*=\s*"\d{3}"/, /REVISION\s*=\s*"(\d{3})"/],
  ["D3", /d3-(?:selection|scale|shape)|d3\.select/],
  ["Zustand", /zustand/],
  ["Redux", /@@redux\/INIT|redux-toolkit|createSlice/],
  ["TanStack Query", /@tanstack\/query|QueryClient|queryKey/],
  ["Zod", /ZodError|z\.object/],
  ["Workbox", /workbox-|precacheAndRoute/],
  ["Lottie", /lottie|bodymovin/],
  ["Swiper", /swiper-slide|Swiper\(/],
  ["Google Ads / GPT", /googletag\.cmd|adsbygoogle/],
];

const ROUTE_RE = /\bpath\s*:\s*["'`](\/[^"'`\s]{0,120}|\*|[a-z][\w:/*-]{0,80})["'`]/g;
const ENDPOINT_STR_RE = /["'`]((?:https?:\/\/[a-z0-9.-]+)?\/(?:api|v\d+|graphql|rest|rpc|trpc|ajax|auth|oauth)(?:\/[^"'`\s<>]{0,160})?)["'`]/gi;
const ENDPOINT_TPL_RE = /`((?:https?:\/\/[a-z0-9.-]+)?(?:\$\{[^}]{1,60}\})?\/(?:api|v\d+|graphql|rest|rpc|trpc|auth)\/[^`\s]{0,160})`/g;
const METHOD_NEAR_RE = /\.(get|post|put|patch|delete|head)\s*\(\s*$|method\s*:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i;

// Response headers that reveal hosting, CDN and server tech.
const HEADER_TECH = [
  ["Cloudflare", (h) => h["cf-ray"] || /cloudflare/i.test(h.server || "")],
  ["Vercel", (h) => h["x-vercel-id"] || /vercel/i.test(h.server || "")],
  ["Netlify", (h) => h["x-nf-request-id"] || /netlify/i.test(h.server || "")],
  ["Amazon CloudFront", (h) => h["x-amz-cf-id"] || /cloudfront/i.test(h.via || "")],
  ["Amazon S3", (h) => /AmazonS3/i.test(h.server || "")],
  ["Fastly", (h) => /fastly/i.test(`${h["x-served-by"] || ""} ${h.via || ""}`) || h["x-fastly-request-id"]],
  ["Akamai", (h) => /akamai/i.test(`${h.server || ""} ${h["x-akamai-transformed"] || ""}`) || h["x-akamai-request-id"]],
  ["Google Cloud", (h) => /gws|Google Frontend|gfe/i.test(`${h.server || ""} ${h.via || ""}`)],
  ["GitHub Pages", (h) => h["x-github-request-id"]],
  ["Fly.io", (h) => h["fly-request-id"]],
  ["Render", (h) => h["x-render-origin-server"] || h["rndr-id"]],
  ["Railway", (h) => /railway/i.test(h.server || "") || h["x-railway-edge"]],
  ["Heroku", (h) => /heroku/i.test(h.via || "")],
  ["Azure", (h) => h["x-azure-ref"] || h["x-msedge-ref"]],
  ["nginx", (h) => /nginx/i.test(h.server || "")],
  ["Apache", (h) => /apache/i.test(h.server || "")],
  ["LiteSpeed", (h) => /litespeed/i.test(h.server || "")],
  ["Caddy", (h) => /caddy/i.test(h.server || "")],
  ["OpenResty", (h) => /openresty/i.test(h.server || "")],
  ["Express", (h) => /express/i.test(h["x-powered-by"] || "")],
  ["Next.js", (h) => /next\.js/i.test(h["x-powered-by"] || "") || h["x-nextjs-cache"] || h["x-nextjs-prerender"]],
  ["PHP", (h) => /php/i.test(h["x-powered-by"] || "")],
  ["ASP.NET", (h) => /asp\.net/i.test(`${h["x-powered-by"] || ""} ${h["x-aspnet-version"] || ""}`)],
  ["WordPress", (h) => /wp-json|wordpress/i.test(`${h.link || ""} ${h["x-powered-by"] || ""}`)],
  ["Shopify", (h) => h["x-shopid"] || h["x-shopify-stage"]],
  ["HTTP/3", (h) => /h3/.test(h["alt-svc"] || "")],
  ["HSTS", (h) => h["strict-transport-security"]],
  ["Content Security Policy", (h) => h["content-security-policy"]],
];

const GRAPHQL_RE = /\b(query|mutation|subscription|fragment)\s+([A-Z_][\w]{1,80})\s*(?:\(|\{|on\s)/g;
const WS_RE = /["'`](wss?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^"'`\s<>]{0,160})?)["'`]/gi;

function normalizeEndpointPath(raw) {
  let p = String(raw)
    .replace(/\$\{[^}]*\}/g, ":param")
    .replace(/[?#].*$/, "")
    // A template placeholder glued onto a segment ("/keys${qs}") is a query string, not a path part.
    .replace(/([^/]):param\b/g, "$1")
    .replace(/\/+$/, "");
  return p || "/";
}

function createIntel(origin) {
  const endpoints = new Map(); // key -> { method, host, path, inCode, captured }
  const routes = new Set();
  const libraries = new Map(); // name -> version|""
  const tech = new Map(); // name -> detail
  const graphql = new Map(); // "query Name" -> type
  const siteHost = new URL(origin).hostname.replace(/^www\./, "");

  const keyFor = (method, host, path) => `${method} ${host}${path}`;
  function addEndpoint(method, host, path, fields) {
    if (!path || path.length > 200) return;
    const key = keyFor(method, host, path);
    const e = endpoints.get(key) || { method, host, path, inCode: 0, captured: null };
    Object.assign(e, fields.captured ? { captured: fields.captured } : {});
    if (fields.inCode) e.inCode += 1;
    endpoints.set(key, e);
  }

  return {
    /** Mines a JS bundle from the site (or its CDN) for endpoints, routes and libraries. */
    scanCode(text, sourceUrl) {
      if (!text || isTrackerUrl(sourceUrl)) return;
      let host = siteHost;
      try {
        host = new URL(sourceUrl).hostname.replace(/^www\./, "");
      } catch {}
      const body = text.length > 8_000_000 ? text.slice(0, 8_000_000) : text;
      for (const re of [ENDPOINT_STR_RE, ENDPOINT_TPL_RE]) {
        re.lastIndex = 0;
        let m;
        let n = 0;
        while ((m = re.exec(body)) !== null && n < 2000) {
          n += 1;
          let raw = m[1];
          let epHost = siteHost;
          const abs = raw.match(/^https?:\/\/([a-z0-9.-]+)(\/.*)$/i);
          if (abs) {
            epHost = abs[1].replace(/^www\./, "");
            raw = abs[2];
          } else if (raw.startsWith("${")) {
            raw = raw.replace(/^\$\{[^}]*\}/, "");
          }
          if (/\.(?:js|css|png|svg|jpg|woff2?|map)(?:$|\?)/i.test(raw)) continue;
          const before = body.slice(Math.max(0, m.index - 24), m.index);
          const near = body.slice(Math.max(0, m.index - 24), m.index + m[0].length + 80);
          const mm = before.match(METHOD_NEAR_RE) || near.match(/method\s*:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i);
          const method = mm ? (mm[1] || mm[2]).toUpperCase() : "ANY";
          addEndpoint(method, epHost, normalizeEndpointPath(raw), { inCode: true });
        }
      }
      GRAPHQL_RE.lastIndex = 0;
      let g;
      let gn = 0;
      while ((g = GRAPHQL_RE.exec(body)) !== null && gn < 1500) {
        gn += 1;
        // Only real operations: they sit inside a string/template and open a selection set.
        const ctx = body.slice(g.index, g.index + 200);
        if (!/[{(]/.test(ctx)) continue;
        graphql.set(`${g[1]} ${g[2]}`, g[1]);
      }
      if (graphql.size) addEndpoint("POST", siteHost, "/graphql", { inCode: true });
      WS_RE.lastIndex = 0;
      let w;
      let wn = 0;
      while ((w = WS_RE.exec(body)) !== null && wn < 200) {
        wn += 1;
        try {
          const u = new URL(w[1].replace(/\$\{[^}]*\}/g, "x"));
          addEndpoint("WS", u.hostname.replace(/^www\./, ""), normalizeEndpointPath(u.pathname + (u.search ? "" : "")), { inCode: true });
        } catch {}
      }
      ROUTE_RE.lastIndex = 0;
      let r;
      let rn = 0;
      while ((r = ROUTE_RE.exec(body)) !== null && rn < 1500) {
        rn += 1;
        const route = r[1];
        // Router configs use paths like "/paste/:id"; skip file paths and SVG path data.
        if (/\.[a-z]{2,4}$/i.test(route) || /^[MmLlCc]\s?\d/.test(route)) continue;
        routes.add(route.startsWith("/") || route === "*" ? route : `/${route}`);
      }
      if (host === siteHost || /cdn|static|assets/.test(host) || sourceUrl.includes(siteHost)) {
        const head = body.slice(0, 600_000);
        for (const [name, sig, ver] of LIBRARY_SIGNATURES) {
          if (libraries.has(name) && libraries.get(name)) continue;
          if (!sig.test(body)) continue;
          let version = "";
          if (ver) {
            const vm = head.match(ver) || body.match(ver);
            if (vm) version = vm.slice(1).find(Boolean) || "";
          }
          libraries.set(name, version || libraries.get(name) || "");
        }
        // License banners name bundled packages and their versions directly.
        const banner = /\/\*[!*]\s*(?:@license\s+)?([@\w][\w./-]{1,60})\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/g;
        let b;
        let bn = 0;
        while ((b = banner.exec(head)) !== null && bn < 60) {
          bn += 1;
          if (!/^(?:copyright|license|the|this|version)$/i.test(b[1]) && !libraries.has(b[1])) libraries.set(b[1], b[2]);
        }
      }
    },
    /** Records an API call the browser actually made, linked to its saved response. */
    addCaptured(method, url, filePath) {
      try {
        const u = new URL(url);
        addEndpoint((method || "GET").toUpperCase(), u.hostname.replace(/^www\./, ""), normalizeEndpointPath(u.pathname), { captured: filePath });
      } catch {}
    },
    /** Reads hosting/CDN/server tech from a page's response headers. */
    addHeaders(headers) {
      const h = {};
      for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = String(v);
      for (const [name, test] of HEADER_TECH) {
        try {
          if (test(h) && !tech.has(name)) tech.set(name, name === "nginx" || name === "Apache" || name === "LiteSpeed" ? h.server || "" : "");
        } catch {}
      }
      const known = [...tech.keys()].some((t) => h.server && h.server.toLowerCase().includes(t.toLowerCase()));
      if (h.server && !known && !tech.has(`Server: ${h.server}`)) tech.set(`Server: ${h.server}`, "");
    },
    addPagePath(pathname) {
      if (pathname) routes.add(`page:${pathname}`);
    },
    toJSON() {
      // Fold concrete captured calls (/api/pastes/077zbk…) into the code's pattern (/api/pastes/:param),
      // or into an inferred /:id pattern, so each endpoint appears once with a sample response.
      const isId = (seg) => /^(?=.*\d)[A-Za-z0-9_-]{6,}$/.test(seg) || /^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg);
      const raw = [...endpoints.values()];
      const patterns = raw.filter((e) => e.path.includes(":"));
      const merged = new Map();
      for (const e of raw) {
        if (e.path.includes(":") || !e.captured) {
          merged.set(`${e.method} ${e.host}${e.path}`, { ...e, samples: e.captured ? 1 : 0 });
        }
      }
      for (const e of raw.filter((x) => x.captured && !x.path.includes(":"))) {
        const segs = e.path.split("/");
        const pat = patterns.find((p) => {
          if (p.host !== e.host) return false;
          const ps = p.path.split("/");
          return ps.length === segs.length && ps.every((x, i) => x === segs[i] || x.startsWith(":"));
        });
        const path = pat ? pat.path : segs.map((x) => (isId(x) ? ":id" : x)).join("/");
        const method = e.method;
        const anyKey = `ANY ${e.host}${path}`;
        const key = `${method} ${e.host}${path}`;
        const target = merged.get(key) || merged.get(anyKey) || { method, host: e.host, path, inCode: 0, captured: null, samples: 0 };
        if (target.method === "ANY") {
          merged.delete(anyKey);
          target.method = method;
        }
        target.captured = target.captured || e.captured;
        target.samples += 1;
        merged.set(key, target);
      }
      // Collapse ANY into a concrete method when the same path was also seen with one.
      const list = [...merged.values()];
      const concrete = new Set(list.filter((e) => e.method !== "ANY").map((e) => `${e.host}${e.path}`));
      const finalList = list
        .filter((e) => e.method !== "ANY" || !concrete.has(`${e.host}${e.path}`))
        .sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0) || a.path.localeCompare(b.path))
        .slice(0, 1500);
      const definedRoutes = [...routes].filter((r) => !r.startsWith("page:") && !/^\/(?:api|v\d+|graphql)\//.test(r)).sort();
      const crawled = [...routes].filter((r) => r.startsWith("page:")).map((r) => r.slice(5)).sort();
      return {
        endpoints: finalList,
        routes: definedRoutes.slice(0, 800),
        crawledPaths: crawled.slice(0, 800),
        libraries: [...libraries.entries()].map(([name, version]) => ({ name, version })).sort((a, b) => a.name.localeCompare(b.name)),
        tech: [...tech.entries()].map(([name, detail]) => ({ name, detail })),
        graphql: [...graphql.entries()].map(([op, type]) => ({ op, type })).sort((a, b) => a.op.localeCompare(b.op)).slice(0, 1000),
      };
    },
  };
}

module.exports = { createIntel, isTrackerUrl, TRACKER_HOST_RE };
