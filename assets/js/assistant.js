import { $, $$, toast } from "./ui.js";
import { hydrateIcons } from "./icons.js";

/*
 * AI Assistant — builds a complete, responsive website from a short description.
 *
 * It runs entirely on the device: a template engine interprets the request (site type, name,
 * sections, colour) and assembles a themed single-file site. "With guidelines" means it refuses
 * anything designed to deceive or harm — fake sign-in / payment pages, brand impersonation,
 * phishing, scams, malware or illegal content — and builds only legitimate sites.
 */

// ── Guidelines: requests that are declined ──────────────────────────────────
const BRANDS = "google|gmail|paypal|apple|icloud|microsoft|outlook|office\\s?365|facebook|meta|instagram|whatsapp|snapchat|tiktok|amazon|netflix|roblox|discord|steam|epic\\s?games|coinbase|binance|metamask|kraken|chase|wells\\s?fargo|citibank|bank\\s?of|barclays|hsbc|revolut";
const SECRETS = "password|passwd|credential|login\\s?detail|card\\s?number|credit\\s?card|cvv|cvc|ssn|social\\s?security|seed\\s?phrase|private\\s?key|recovery\\s?phrase|2fa\\s?code|otp";
const BLOCKED = [
  { re: /\bphish/i, why: "phishing pages" },
  { re: /\bfake\b[^.]{0,30}\b(log\s?-?\s?in|sign\s?-?\s?in|account|verification|checkout)\b/i, why: "fake sign-in or checkout pages" },
  // credential/payment harvesting, either word order, singular or plural
  { re: new RegExp(`\\b(steal|harvest|capture|collect|grab|log|keylog|phish|exfiltrat|siphon|skim)\\w*\\b[^.]{0,40}\\b(${SECRETS})s?\\b`, "i"), why: "pages that harvest credentials or payment details" },
  { re: new RegExp(`\\b(${SECRETS})s?\\b[^.]{0,40}\\b(steal|harvest|grab|collect|capture|phish|skim)`, "i"), why: "pages that harvest credentials or payment details" },
  // brand impersonation sign-in, either word order
  { re: new RegExp(`\\b(${BRANDS})\\b[^.]{0,30}\\b(log\\s?-?\\s?in|sign\\s?-?\\s?in|account|verify|password|checkout)\\b`, "i"), why: "impersonating a real brand" },
  { re: new RegExp(`\\b(log\\s?-?\\s?in|sign\\s?-?\\s?in|verify|unlock|account)\\b[^.]{0,30}\\b(${BRANDS})\\b`, "i"), why: "impersonating a real brand" },
  { re: /\b(impersonat|clone)\w*\b[^.]{0,30}\b(login|site|page|brand|bank)\b/i, why: "impersonating a real site or brand" },
  { re: /\b(malware|ransomware|keylogger|spyware|trojan|botnet|exploit\s?kit|rootkit|worm payload)\b/i, why: "malware" },
  { re: /\b(scam|carding|card\s?ing|fraud|ponzi|pyramid\s?scheme|money\s?mule)\b/i, why: "scams or fraud" },
  { re: /\b(wallet|crypto)\s?drainer\b|\bdrain(er|ing)?\b[^.]{0,20}\bwallet\b/i, why: "crypto-draining pages" },
  { re: /\bddos\b|\bstresser\b|\bbooter\b|\bdos\s?tool\b/i, why: "attack tools" },
];

export function checkGuidelines(prompt) {
  const p = String(prompt || "");
  for (const b of BLOCKED) if (b.re.test(p)) return b.why;
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function pickTitle(prompt, type) {
  // Quoted name wins.
  const q = prompt.match(/\b(?:called|named)\s+["\u2019']([^"\u2019']{2,40})["\u2019']/i) || prompt.match(/["\u2019']([^"\u2019']{2,40})["\u2019']/);
  if (q) return cap(q[1].trim());
  // "called/named X" — a run of Capitalized words joined by & / "and", stopping at any lowercase word.
  const m = prompt.match(/\b(?:called|named)\s+([A-Z][\w'.-]*(?:\s+(?:&|and|[A-Z][\w'.-]*))*)/);
  if (m) return m[1].replace(/\band\b/gi, "&").replace(/\s+/g, " ").trim();
  // "for a/an/my/the <noun>" — a short lowercase phrase, cut at connectors.
  const f = prompt.match(/\bfor\s+(?:a|an|my|the)\s+([a-z][\w' -]{1,24}?)(?:\s+(?:called|named|site|website|landing|page|with|that|,|\.)|$)/i);
  if (f) return cap(f[1].trim());
  return { landing: "Northwind", portfolio: "Alex Rivera", blog: "The Dispatch", "coming-soon": "Launching Soon" }[type] || "Northwind";
}

function detectSections(prompt, type) {
  const p = prompt.toLowerCase();
  const has = (k) => k.some((x) => p.includes(x));
  const wanted = new Set();
  if (has(["feature", "what we do", "benefit", "service"])) wanted.add("features");
  if (has(["about", "story", "who we are", "mission"])) wanted.add("about");
  if (has(["menu", "product", "catalog"])) wanted.add("products");
  if (has(["price", "pricing", "plan", "subscription"])) wanted.add("pricing");
  if (has(["gallery", "photo", "portfolio", "work", "project"])) wanted.add("gallery");
  if (has(["testimonial", "review", "customer"])) wanted.add("testimonials");
  if (has(["team", "staff", "people"])) wanted.add("team");
  if (has(["faq", "question"])) wanted.add("faq");
  if (has(["contact", "get in touch", "reach us", "email us"])) wanted.add("contact");
  // Sensible defaults per type if the prompt was vague.
  if (wanted.size === 0) {
    if (type === "portfolio") ["about", "gallery", "contact"].forEach((s) => wanted.add(s));
    else if (type === "blog") wanted.add("posts");
    else if (type === "coming-soon") wanted.add("signup");
    else ["features", "about", "contact"].forEach((s) => wanted.add(s));
  }
  if (type === "blog") wanted.add("posts");
  return [...wanted];
}

function pickAccent(prompt, fallback) {
  const named = {
    orange: "#ea580c", amber: "#d97706", red: "#dc2626", rose: "#e11d48", pink: "#db2777",
    purple: "#7c3aed", violet: "#7c3aed", indigo: "#4f46e5", blue: "#2563eb", sky: "#0284c7",
    cyan: "#0891b2", teal: "#0d9488", green: "#059669", emerald: "#059669", lime: "#65a30d",
    yellow: "#ca8a04", brown: "#92400e", warm: "#ea580c", gold: "#ca8a04",
  };
  for (const [k, v] of Object.entries(named)) if (new RegExp(`\\b${k}\\b`, "i").test(prompt)) return v;
  return fallback || "#4f46e5";
}

const LOREM = {
  about: "We started with a simple idea and a lot of care. Today that same care goes into everything we make — thoughtfully built, honestly priced, and made to last.",
  feature: ["Fast by default", "Thoughtfully designed", "Built to scale", "Friendly support", "Fair pricing", "Private & secure"],
  feats: "Every detail is considered so the whole thing just works — the moment you arrive and every time after.",
};

function hero(title, tagline, accent, type) {
  const cta = type === "coming-soon" ? "" : `<a class="btn primary" href="#contact">Get started</a><a class="btn ghost" href="#about">Learn more</a>`;
  return `<header class="hero"><div class="wrap">
    <span class="pill">${type === "portfolio" ? "Portfolio" : type === "blog" ? "Journal" : "Welcome"}</span>
    <h1>${esc(tagline)}</h1>
    <p class="lead">A clean, modern ${type === "portfolio" ? "portfolio" : type === "blog" ? "publication" : "site"} for ${esc(title)} — fast, responsive and ready to make it yours.</p>
    <div class="cta">${cta}</div>
  </div></header>`;
}

function section(id, inner) {
  return `<section id="${id}" class="sec"><div class="wrap">${inner}</div></section>`;
}

function buildSections(list, title) {
  const parts = [];
  for (const s of list) {
    if (s === "features")
      parts.push(
        section("features", `<h2>What you get</h2><p class="sub">${LOREM.feats}</p><div class="grid3">${LOREM.feature.map((f) => `<div class="card"><div class="ic"></div><h3>${f}</h3><p>${LOREM.feats}</p></div>`).join("")}</div>`)
      );
    else if (s === "about") parts.push(section("about", `<div class="split"><div><h2>About ${esc(title)}</h2><p>${LOREM.about}</p><p>${LOREM.feats}</p></div><div class="art"></div></div>`));
    else if (s === "products")
      parts.push(section("products", `<h2>Our menu</h2><p class="sub">A few of our favourites.</p><div class="grid3">${["House Blend", "Cold Brew", "Flat White", "Mocha", "Chai Latte", "Seasonal Special"].map((n) => `<div class="card"><div class="ic"></div><h3>${n}</h3><p>Made fresh, every day.</p><span class="price">$4</span></div>`).join("")}</div>`));
    else if (s === "pricing")
      parts.push(
        section("pricing", `<h2>Simple pricing</h2><div class="grid3">${[["Starter", "$0", ["1 project", "Community support"]], ["Pro", "$19", ["Unlimited projects", "Priority support", "Custom domain"]], ["Team", "$49", ["Everything in Pro", "5 seats", "Analytics"]]].map(([n, pr, feats], i) => `<div class="card plan ${i === 1 ? "feat" : ""}"><h3>${n}</h3><div class="price big">${pr}<small>/mo</small></div><ul>${feats.map((f) => `<li>${f}</li>`).join("")}</ul><a class="btn ${i === 1 ? "primary" : "ghost"}" href="#contact">Choose</a></div>`).join("")}</div>`)
      );
    else if (s === "gallery") parts.push(section("gallery", `<h2>Selected work</h2><div class="gal">${Array.from({ length: 6 }, (_, i) => `<div class="shot shot${(i % 3) + 1}"></div>`).join("")}</div>`));
    else if (s === "testimonials")
      parts.push(section("testimonials", `<h2>Kind words</h2><div class="grid3">${[["“Exactly what we needed — fast and polished.”", "Sam P."], ["“The team genuinely cares about the details.”", "Jordan L."], ["“Set up in minutes. Looks fantastic.”", "Riya M."]].map(([q, who]) => `<figure class="card quote"><blockquote>${q}</blockquote><figcaption>— ${who}</figcaption></figure>`).join("")}</div>`));
    else if (s === "team") parts.push(section("team", `<h2>The team</h2><div class="grid3">${["Avery", "Noah", "Mira"].map((n) => `<div class="card person"><div class="ava"></div><h3>${n}</h3><p>Co-founder</p></div>`).join("")}</div>`));
    else if (s === "faq")
      parts.push(section("faq", `<h2>FAQ</h2><div class="faq">${[["Is there a free plan?", "Yes — start free and upgrade whenever you're ready."], ["Can I cancel anytime?", "Of course. No contracts, no fuss."], ["Do you offer support?", "Friendly support on every plan."]].map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</div>`));
    else if (s === "posts")
      parts.push(section("posts", `<h2>Latest posts</h2><div class="posts">${[["Getting started", "A short guide to the essentials."], ["Design notes", "How we think about the little things."], ["Behind the scenes", "What a week here looks like."]].map(([t, d]) => `<article class="post"><div class="thumb"></div><div><h3>${t}</h3><p>${d}</p><a href="#">Read more →</a></div></article>`).join("")}</div>`));
    else if (s === "signup")
      parts.push(section("signup", `<div class="center"><h2>We're launching soon</h2><p class="sub">Leave your email and be the first to know.</p><form class="signup" onsubmit="event.preventDefault();this.querySelector('.ok').hidden=false;"><input type="email" placeholder="you@email.com" required><button class="btn primary" type="submit">Notify me</button></form><p class="ok" hidden>Thanks! We'll be in touch.</p></div>`));
    else if (s === "contact")
      parts.push(section("contact", `<div class="split"><div><h2>Get in touch</h2><p>We'd love to hear from you. Drop a message and we'll reply soon.</p></div><form class="contact" onsubmit="event.preventDefault();this.querySelector('.ok').hidden=false;"><input placeholder="Your name" required><input type="email" placeholder="Email" required><textarea placeholder="Message" rows="4"></textarea><button class="btn primary" type="submit">Send</button><p class="ok" hidden>Thanks — message sent!</p></form></div>`));
  }
  return parts.join("\n");
}

export function generateSite({ type = "landing", prompt = "", color } = {}) {
  const title = pickTitle(prompt, type);
  const accent = pickAccent(prompt, color);
  const sections = detectSections(prompt, type);
  const tagline =
    type === "portfolio" ? `${title} — designer & maker`
    : type === "blog" ? `${title}`
    : type === "coming-soon" ? `${title}`
    : `Meet ${title}`;
  const navLinks = sections.filter((s) => ["about", "features", "products", "pricing", "gallery", "posts", "faq", "contact"].includes(s));
  const nav = `<nav class="nav"><div class="wrap"><a class="brand" href="#">${esc(title)}</a><button class="burger" aria-label="Menu" onclick="document.querySelector('.links').classList.toggle('open')">≡</button><div class="links">${navLinks.map((s) => `<a href="#${s}">${cap(s)}</a>`).join("")}${type !== "coming-soon" ? '<a class="btn primary sm" href="#contact">Contact</a>' : ""}</div></div></nav>`;

  const body = `${nav}${hero(title, tagline, accent, type)}${buildSections(sections, title)}<footer class="foot"><div class="wrap"><span>© ${new Date().getFullYear()} ${esc(title)}</span><span>Built with ChroniumX AI Assistant</span></div></footer>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--a:${accent};--ink:#0f141a;--mut:#5b6672;--bg:#ffffff;--soft:#f5f7fa;--line:#e7ebef;--radius:16px}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{width:min(1080px,92%);margin:0 auto}
a{color:inherit;text-decoration:none}
h1,h2,h3{line-height:1.12;letter-spacing:-.02em;margin:0 0 .4em}
h1{font-size:clamp(34px,6vw,60px);font-weight:800}h2{font-size:clamp(26px,3.4vw,38px);font-weight:750}
.sub{color:var(--mut);max-width:620px;margin:0 0 28px;font-size:18px}
.nav{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:66px}
.brand{font-weight:800;font-size:19px}
.links{display:flex;align-items:center;gap:22px}.links a{color:var(--mut);font-weight:600;font-size:15px}.links a:hover{color:var(--ink)}
.burger{display:none;background:none;border:0;font-size:26px;cursor:pointer}
.btn{display:inline-flex;align-items:center;gap:8px;padding:12px 22px;border-radius:999px;font-weight:700;cursor:pointer;border:1px solid transparent;transition:.2s;font-size:15px}
.btn.primary{background:var(--a);color:#fff}.btn.primary:hover{filter:brightness(1.08);transform:translateY(-1px)}
.btn.ghost{background:transparent;border-color:var(--line);color:var(--ink)}.btn.ghost:hover{background:var(--soft)}
.btn.sm{padding:9px 16px;font-size:14px}
.hero{padding:clamp(60px,12vw,120px) 0 clamp(50px,8vw,90px);background:radial-gradient(900px 500px at 70% -10%,color-mix(in srgb,var(--a) 18%,transparent),transparent 60%),var(--soft)}
.hero .pill{display:inline-block;background:color-mix(in srgb,var(--a) 14%,transparent);color:var(--a);font-weight:700;font-size:13px;padding:6px 14px;border-radius:999px;margin-bottom:18px}
.hero .lead{font-size:20px;color:var(--mut);max-width:620px;margin:10px 0 28px}
.cta{display:flex;gap:12px;flex-wrap:wrap}
.sec{padding:clamp(48px,7vw,86px) 0}.sec:nth-child(even){background:var(--soft)}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.card{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:26px}
.card .ic{width:44px;height:44px;border-radius:12px;background:color-mix(in srgb,var(--a) 18%,transparent);margin-bottom:14px}
.card h3{font-size:19px}.card p{color:var(--mut);margin:0}
.split{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:center}
.art{aspect-ratio:4/3;border-radius:var(--radius);background:linear-gradient(135deg,var(--a),color-mix(in srgb,var(--a) 30%,#fff))}
.price{display:inline-block;margin-top:10px;font-weight:800;color:var(--a)}
.plan{text-align:center}.plan.feat{border-color:var(--a);box-shadow:0 20px 50px -20px color-mix(in srgb,var(--a) 50%,transparent)}
.price.big{font-size:40px;font-weight:800;margin:6px 0}.price.big small{font-size:15px;color:var(--mut);font-weight:600}
.plan ul{list-style:none;padding:0;margin:14px 0 20px;color:var(--mut)}.plan li{padding:6px 0;border-top:1px solid var(--line)}
.gal{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.shot{aspect-ratio:1;border-radius:var(--radius)}.shot1{background:linear-gradient(135deg,var(--a),#fff)}.shot2{background:linear-gradient(135deg,#334155,var(--a))}.shot3{background:linear-gradient(135deg,var(--a),#0ea5e9)}
.quote blockquote{margin:0 0 10px;font-size:18px}.quote figcaption{color:var(--mut);font-weight:600}
.person .ava{width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,var(--a),#fff);margin:0 auto 12px}.person{text-align:center}
.faq details{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:10px}.faq summary{font-weight:700;cursor:pointer}
.posts{display:grid;gap:18px}.post{display:grid;grid-template-columns:200px 1fr;gap:20px;align-items:center;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.post .thumb{aspect-ratio:16/10;background:linear-gradient(135deg,var(--a),#fff)}.post h3{margin:16px 0 6px}.post a{color:var(--a);font-weight:700}
.center{text-align:center;max-width:560px;margin:0 auto}
.signup,.contact{display:flex;flex-direction:column;gap:12px;max-width:440px}.signup{flex-direction:row;justify-content:center}
input,textarea{padding:13px 16px;border:1px solid var(--line);border-radius:12px;font:inherit;background:var(--bg)}
input:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--a) 50%,transparent);border-color:var(--a)}
.ok{color:var(--a);font-weight:700}
.foot{padding:30px 0;border-top:1px solid var(--line);color:var(--mut)}.foot .wrap{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:14px}
@media(max-width:820px){.grid3,.gal{grid-template-columns:1fr 1fr}.split,.post{grid-template-columns:1fr}.burger{display:block}.links{position:absolute;top:66px;left:0;right:0;flex-direction:column;background:var(--bg);border-bottom:1px solid var(--line);padding:14px;display:none}.links.open{display:flex}}
@media(max-width:560px){.grid3,.gal{grid-template-columns:1fr}}
</style></head>
<body>${body}</body></html>`;
}

// ── Page wiring ──────────────────────────────────────────────────────────────
const SWATCHES = ["#4f46e5", "#7c3aed", "#2563eb", "#0891b2", "#0d9488", "#059669", "#ca8a04", "#ea580c", "#dc2626", "#db2777"];

export function initAssistant() {
  let type = "landing";
  let color = SWATCHES[0];
  let currentHtml = "";

  const sw = $("#asstSwatches");
  if (sw)
    sw.innerHTML = SWATCHES.map((c, i) => `<button class="swatch ${i === 0 ? "on" : ""}" type="button" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join("");

  $$("#asstTypes [data-asttype]").forEach((b) =>
    b.addEventListener("click", () => {
      type = b.dataset.asttype;
      $$("#asstTypes [data-asttype]").forEach((x) => x.classList.toggle("is-active", x === b));
    })
  );
  sw &&
    sw.addEventListener("click", (e) => {
      const s = e.target.closest("[data-color]");
      if (!s) return;
      color = s.dataset.color;
      $$("#asstSwatches .swatch").forEach((x) => x.classList.toggle("on", x === s));
    });

  const setButtons = (on) => ["asstCopy", "asstDownload", "asstOpen"].forEach((id) => ($(`#${id}`).disabled = !on));

  $("#asstGenerate").addEventListener("click", () => {
    const prompt = $("#asstPrompt").value.trim();
    const err = $("#asstErr");
    err.hidden = true;
    const blocked = checkGuidelines(prompt);
    if (blocked) {
      err.textContent = `I can't build ${blocked}. Try a legitimate site — a business, portfolio, blog, event or product page.`;
      err.hidden = false;
      $("#asstStatus").textContent = "Request declined by the guidelines.";
      return;
    }
    $("#asstStatus").textContent = "Generating…";
    // A beat so the status shows, then generate (it's instant).
    setTimeout(() => {
      try {
        currentHtml = generateSite({ type, prompt, color });
        const frame = $("#asstFrame");
        frame.srcdoc = currentHtml;
        $("#asstEmpty").hidden = true;
        frame.style.opacity = "1";
        setButtons(true);
        $("#asstStatus").textContent = `Generated a ${type.replace("-", " ")} site · ${(currentHtml.length / 1024).toFixed(1)} KB`;
      } catch (e) {
        err.textContent = "Something went wrong generating that. Try rephrasing.";
        err.hidden = false;
      }
    }, 180);
  });

  $("#asstCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(currentHtml);
      toast("Copied", "The full HTML is on your clipboard.", "success", 1800);
    } catch {
      toast("Copy failed", "Clipboard was blocked.", "warn");
    }
  });
  $("#asstDownload").addEventListener("click", () => {
    const blob = new Blob([currentHtml], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "site.html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("#asstOpen").addEventListener("click", () => {
    const blob = new Blob([currentHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}
