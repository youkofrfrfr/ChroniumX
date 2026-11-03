import { $, $$, toast } from "./ui.js";
import { hydrateIcons } from "./icons.js";
import { loadMonaco } from "./workspace.js";

/*
 * AI Assistant — a chat you describe a website to, and it builds it, then refines it with every
 * follow-up ("make it dark", "add pricing", "call it Aurora"). It keeps a running spec of the site
 * and regenerates a complete, responsive page on each turn. Everything runs on your device.
 *
 * It's a beta, on-device generator (not a large language model), so it works from patterns rather
 * than open-ended understanding — but it follows guidelines: legitimate sites only, never fake
 * sign-in / payment pages, brand impersonation, phishing, scams, malware or illegal content.
 */

// ── Guidelines ───────────────────────────────────────────────────────────────
const BRANDS = "google|gmail|paypal|apple|icloud|microsoft|outlook|office\\s?365|facebook|meta|instagram|whatsapp|snapchat|tiktok|amazon|netflix|roblox|discord|steam|epic\\s?games|coinbase|binance|metamask|kraken|chase|wells\\s?fargo|citibank|bank\\s?of|barclays|hsbc|revolut";
const SECRETS = "password|passwd|credential|login\\s?detail|card\\s?number|credit\\s?card|cvv|cvc|ssn|social\\s?security|seed\\s?phrase|private\\s?key|recovery\\s?phrase|2fa\\s?code|otp";
const BLOCKED = [
  { re: /\bphish/i, why: "phishing pages" },
  { re: /\bfake\b[^.]{0,30}\b(log\s?-?\s?in|sign\s?-?\s?in|account|verification|checkout)\b/i, why: "fake sign-in or checkout pages" },
  { re: new RegExp(`\\b(steal|harvest|capture|collect|grab|log|keylog|phish|exfiltrat|siphon|skim)\\w*\\b[^.]{0,40}\\b(${SECRETS})s?\\b`, "i"), why: "pages that harvest credentials or payment details" },
  { re: new RegExp(`\\b(${SECRETS})s?\\b[^.]{0,40}\\b(steal|harvest|grab|collect|capture|phish|skim)`, "i"), why: "pages that harvest credentials or payment details" },
  { re: new RegExp(`\\b(${BRANDS})\\b[^.]{0,30}\\b(log\\s?-?\\s?in|sign\\s?-?\\s?in|account|verify|password|checkout)\\b`, "i"), why: "impersonating a real brand" },
  { re: new RegExp(`\\b(log\\s?-?\\s?in|sign\\s?-?\\s?in|verify|unlock|account)\\b[^.]{0,30}\\b(${BRANDS})\\b`, "i"), why: "impersonating a real brand" },
  { re: /\b(impersonat|clone)\w*\b[^.]{0,30}\b(login|site|page|brand|bank)\b/i, why: "impersonating a real site or brand" },
  { re: /\b(malware|ransomware|keylogger|spyware|trojan|botnet|exploit\s?kit|rootkit)\b/i, why: "malware" },
  { re: /\b(scam|carding|card\s?ing|fraud|ponzi|pyramid\s?scheme|money\s?mule)\b/i, why: "scams or fraud" },
  { re: /\b(wallet|crypto)\s?drainer\b|\bdrain(er|ing)?\b[^.]{0,20}\bwallet\b/i, why: "crypto-draining pages" },
  { re: /\bddos\b|\bstresser\b|\bbooter\b|\bdos\s?tool\b/i, why: "attack tools" },
];
export function checkGuidelines(prompt) {
  const p = String(prompt || "");
  for (const b of BLOCKED) if (b.re.test(p)) return b.why;
  return null;
}

// ── Text helpers ─────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cap = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());

const NAMED_COLORS = {
  orange: "#ea580c", amber: "#d97706", red: "#dc2626", crimson: "#dc2626", rose: "#e11d48", pink: "#db2777",
  purple: "#7c3aed", violet: "#7c3aed", indigo: "#4f46e5", blue: "#2563eb", navy: "#1e3a8a", sky: "#0284c7",
  cyan: "#0891b2", teal: "#0d9488", turquoise: "#0d9488", green: "#059669", emerald: "#059669", mint: "#10b981",
  lime: "#65a30d", yellow: "#ca8a04", gold: "#ca8a04", brown: "#92400e", warm: "#ea580c", black: "#111827", slate: "#475569",
};
function findColor(text) {
  const hex = text.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (hex) return hex[0];
  for (const [k, v] of Object.entries(NAMED_COLORS)) if (new RegExp(`\\b${k}\\b`, "i").test(text)) return v;
  return null;
}

const SECTION_WORDS = {
  features: ["feature", "benefit", "what we do", "what you get", "service", "highlight"],
  about: ["about", "story", "who we are", "mission", "bio"],
  products: ["menu", "product", "catalog", "catalogue", "shop", "store", "dishes"],
  pricing: ["pricing", "price", "plan", "subscription", "tiers"],
  gallery: ["gallery", "photo", "portfolio piece", "work", "project", "showcase"],
  testimonials: ["testimonial", "review", "customer", "what people say"],
  team: ["team", "staff", "people", "crew"],
  faq: ["faq", "question", "q&a"],
  posts: ["blog", "post", "article", "journal", "news"],
  signup: ["signup", "sign up", "email list", "waitlist", "notify", "subscribe"],
  contact: ["contact", "get in touch", "reach us", "email us", "message us", "find us"],
};
function matchSection(text) {
  const p = text.toLowerCase();
  for (const [sec, words] of Object.entries(SECTION_WORDS)) if (words.some((w) => p.includes(w))) return sec;
  return null;
}
function detectSections(text) {
  const p = text.toLowerCase();
  const found = new Set();
  for (const [sec, words] of Object.entries(SECTION_WORDS)) if (words.some((w) => p.includes(w))) found.add(sec);
  return [...found];
}

function detectType(text) {
  const p = text.toLowerCase();
  if (/\bcoming\s?-?soon|under\s?construction|launching|waitlist|teaser\b/.test(p)) return "coming-soon";
  if (/\bportfolio|showcase my work|designer|photographer|freelance\b/.test(p)) return "portfolio";
  if (/\bblog|journal|publication|newsletter|articles\b/.test(p)) return "blog";
  return "landing";
}

function detectTitle(text) {
  const q = text.match(/\b(?:called|named|titled)\s+["’']([^"’']{2,40})["’']/i) || text.match(/["’']([^"’']{2,40})["’']/);
  if (q) return cap(q[1].trim());
  const m = text.match(/\b(?:called|named|titled|rename(?:d)?\s+to|name\s+it|change\s+the\s+name\s+to)\s+([A-Z][\w'.&-]*(?:\s+(?:&|and|[A-Z][\w'.&-]*)){0,4})/);
  if (m) return m[1].replace(/\band\b/gi, "&").replace(/\s+/g, " ").trim();
  const f = text.match(/\bfor\s+(?:a|an|my|the|our)\s+([a-z][\w' -]{1,26}?)(?:\s+(?:called|named|site|website|landing|page|with|that|,|\.)|$)/i);
  if (f) return cap(f[1].trim());
  return null;
}

// ── Site generator ───────────────────────────────────────────────────────────
const LOREM = {
  about: "We started with a simple idea and a lot of care. Today that same care goes into everything we make — thoughtfully built, honestly priced, and made to last.",
  features: ["Fast by default", "Thoughtfully designed", "Built to scale", "Friendly support", "Fair pricing", "Private & secure"],
  feats: "Every detail is considered so the whole thing just works — the moment you arrive and every time after.",
};
const sectionLabel = { features: "Features", about: "About", products: "Menu", pricing: "Pricing", gallery: "Work", testimonials: "Reviews", team: "Team", faq: "FAQ", posts: "Blog", contact: "Contact", signup: "Notify" };

function buildSections(list, title) {
  const parts = [];
  const sec = (id, inner) => `<section id="${id}" class="sec"><div class="wrap">${inner}</div></section>`;
  for (const s of list) {
    if (s === "features") parts.push(sec("features", `<h2>What you get</h2><p class="sub">${LOREM.feats}</p><div class="grid3">${LOREM.features.map((f) => `<div class="card"><div class="ic"></div><h3>${f}</h3><p>${LOREM.feats}</p></div>`).join("")}</div>`));
    else if (s === "about") parts.push(sec("about", `<div class="split"><div><h2>About ${esc(title)}</h2><p>${LOREM.about}</p><p>${LOREM.feats}</p></div><div class="art"></div></div>`));
    else if (s === "products") parts.push(sec("products", `<h2>Our menu</h2><p class="sub">A few of our favourites.</p><div class="grid3">${["House Blend", "Cold Brew", "Flat White", "Mocha", "Chai Latte", "Seasonal Special"].map((n) => `<div class="card"><div class="ic"></div><h3>${n}</h3><p>Made fresh, every day.</p><span class="price">$4</span></div>`).join("")}</div>`));
    else if (s === "pricing") parts.push(sec("pricing", `<h2>Simple pricing</h2><div class="grid3">${[["Starter", "$0", ["1 project", "Community support"]], ["Pro", "$19", ["Unlimited projects", "Priority support", "Custom domain"]], ["Team", "$49", ["Everything in Pro", "5 seats", "Analytics"]]].map(([n, pr, feats], i) => `<div class="card plan ${i === 1 ? "feat" : ""}"><h3>${n}</h3><div class="price big">${pr}<small>/mo</small></div><ul>${feats.map((f) => `<li>${f}</li>`).join("")}</ul><a class="btn ${i === 1 ? "primary" : "ghost"}" href="#contact">Choose</a></div>`).join("")}</div>`));
    else if (s === "gallery") parts.push(sec("gallery", `<h2>Selected work</h2><div class="gal">${Array.from({ length: 6 }, (_, i) => `<div class="shot shot${(i % 3) + 1}"></div>`).join("")}</div>`));
    else if (s === "testimonials") parts.push(sec("testimonials", `<h2>Kind words</h2><div class="grid3">${[["“Exactly what we needed — fast and polished.”", "Sam P."], ["“The team genuinely cares about the details.”", "Jordan L."], ["“Set up in minutes. Looks fantastic.”", "Riya M."]].map(([q, who]) => `<figure class="card quote"><blockquote>${q}</blockquote><figcaption>— ${who}</figcaption></figure>`).join("")}</div>`));
    else if (s === "team") parts.push(sec("team", `<h2>The team</h2><div class="grid3">${["Avery", "Noah", "Mira"].map((n) => `<div class="card person"><div class="ava"></div><h3>${n}</h3><p>Co-founder</p></div>`).join("")}</div>`));
    else if (s === "faq") parts.push(sec("faq", `<h2>FAQ</h2><div class="faq">${[["Is there a free plan?", "Yes — start free and upgrade whenever you're ready."], ["Can I cancel anytime?", "Of course. No contracts, no fuss."], ["Do you offer support?", "Friendly support on every plan."]].map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</div>`));
    else if (s === "posts") parts.push(sec("posts", `<h2>Latest posts</h2><div class="posts">${[["Getting started", "A short guide to the essentials."], ["Design notes", "How we think about the little things."], ["Behind the scenes", "What a week here looks like."]].map(([t, d]) => `<article class="post"><div class="thumb"></div><div><h3>${t}</h3><p>${d}</p><a href="#">Read more →</a></div></article>`).join("")}</div>`));
    else if (s === "signup") parts.push(sec("signup", `<div class="center"><h2>Be the first to know</h2><p class="sub">Leave your email and we'll let you know when we launch.</p><form class="signup" onsubmit="event.preventDefault();this.querySelector('.ok').hidden=false;"><input type="email" placeholder="you@email.com" required><button class="btn primary" type="submit">Notify me</button></form><p class="ok" hidden>Thanks! We'll be in touch.</p></div>`));
    else if (s === "contact") parts.push(sec("contact", `<div class="split"><div><h2>Get in touch</h2><p>We'd love to hear from you. Drop a message and we'll reply soon.</p></div><form class="contact" onsubmit="event.preventDefault();this.querySelector('.ok').hidden=false;"><input placeholder="Your name" required><input type="email" placeholder="Email" required><textarea placeholder="Message" rows="4"></textarea><button class="btn primary" type="submit">Send</button><p class="ok" hidden>Thanks — message sent!</p></form></div>`));
  }
  return parts.join("\n");
}

export function renderSite(spec) {
  const { type, title, accent, dark } = spec;
  const sections = spec.sections;
  const tagline = type === "portfolio" ? `${title} — designer & maker` : type === "coming-soon" ? `${title} is launching soon` : `Meet ${title}`;
  const navLinks = sections.filter((s) => s !== "hero" && sectionLabel[s]);
  const nav = `<nav class="nav"><div class="wrap"><a class="brand" href="#">${esc(title)}</a><button class="burger" aria-label="Menu" onclick="document.querySelector('.links').classList.toggle('open')">≡</button><div class="links">${navLinks.map((s) => `<a href="#${s}">${sectionLabel[s]}</a>`).join("")}${type !== "coming-soon" && sections.includes("contact") ? '<a class="btn primary sm" href="#contact">Contact</a>' : ""}</div></div></nav>`;
  const cta = type === "coming-soon" ? "" : `<a class="btn primary" href="#${sections.includes("contact") ? "contact" : sections[0] || ""}">Get started</a>${sections.includes("about") ? '<a class="btn ghost" href="#about">Learn more</a>' : ""}`;
  const hero = `<header class="hero"><div class="wrap"><span class="pill">${type === "portfolio" ? "Portfolio" : type === "blog" ? "Journal" : type === "coming-soon" ? "Coming soon" : "Welcome"}</span><h1>${esc(tagline)}</h1><p class="lead">A clean, modern ${type === "portfolio" ? "portfolio" : type === "blog" ? "publication" : "site"} for ${esc(title)} — fast, responsive and ready to make yours.</p><div class="cta">${cta}</div></div></header>`;
  const body = `${nav}${hero}${buildSections(sections, title)}<footer class="foot"><div class="wrap"><span>© ${new Date().getFullYear()} ${esc(title)}</span><span>Built with ChroniumX AI</span></div></footer>`;

  const light = { ink: "#0f141a", mut: "#5b6672", bg: "#ffffff", soft: "#f5f7fa", line: "#e7ebef" };
  const darkp = { ink: "#e8edf2", mut: "#94a3b2", bg: "#0d1117", soft: "#161b22", line: "#272e38" };
  const t = dark ? darkp : light;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--a:${accent};--ink:${t.ink};--mut:${t.mut};--bg:${t.bg};--soft:${t.soft};--line:${t.line};--radius:16px}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{width:min(1080px,92%);margin:0 auto}
a{color:inherit;text-decoration:none}
h1,h2,h3{line-height:1.12;letter-spacing:-.02em;margin:0 0 .4em}
h1{font-size:clamp(34px,6vw,60px);font-weight:800}h2{font-size:clamp(26px,3.4vw,38px);font-weight:750}
.sub{color:var(--mut);max-width:620px;margin:0 0 28px;font-size:18px}
.nav{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:66px}
.brand{font-weight:800;font-size:19px}
.links{display:flex;align-items:center;gap:22px}.links a{color:var(--mut);font-weight:600;font-size:15px}.links a:hover{color:var(--ink)}
.burger{display:none;background:none;border:0;font-size:26px;cursor:pointer;color:var(--ink)}
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
.art{aspect-ratio:4/3;border-radius:var(--radius);background:linear-gradient(135deg,var(--a),color-mix(in srgb,var(--a) 30%,var(--bg)))}
.price{display:inline-block;margin-top:10px;font-weight:800;color:var(--a)}
.plan{text-align:center}.plan.feat{border-color:var(--a);box-shadow:0 20px 50px -20px color-mix(in srgb,var(--a) 50%,transparent)}
.price.big{font-size:40px;font-weight:800;margin:6px 0}.price.big small{font-size:15px;color:var(--mut);font-weight:600}
.plan ul{list-style:none;padding:0;margin:14px 0 20px;color:var(--mut)}.plan li{padding:6px 0;border-top:1px solid var(--line)}
.gal{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.shot{aspect-ratio:1;border-radius:var(--radius)}.shot1{background:linear-gradient(135deg,var(--a),var(--bg))}.shot2{background:linear-gradient(135deg,#334155,var(--a))}.shot3{background:linear-gradient(135deg,var(--a),#0ea5e9)}
.quote blockquote{margin:0 0 10px;font-size:18px}.quote figcaption{color:var(--mut);font-weight:600}
.person .ava{width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,var(--a),var(--bg));margin:0 auto 12px}.person{text-align:center}
.faq details{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:10px}.faq summary{font-weight:700;cursor:pointer}
.posts{display:grid;gap:18px}.post{display:grid;grid-template-columns:200px 1fr;gap:20px;align-items:center;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.post .thumb{aspect-ratio:16/10;background:linear-gradient(135deg,var(--a),var(--bg))}.post h3{margin:16px 0 6px}.post a{color:var(--a);font-weight:700}
.center{text-align:center;max-width:560px;margin:0 auto}
.signup,.contact{display:flex;flex-direction:column;gap:12px;max-width:440px}.signup{flex-direction:row;justify-content:center}
input,textarea{padding:13px 16px;border:1px solid var(--line);border-radius:12px;font:inherit;background:var(--bg);color:var(--ink)}
input:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--a) 50%,transparent);border-color:var(--a)}
.ok{color:var(--a);font-weight:700}
.foot{padding:30px 0;border-top:1px solid var(--line);color:var(--mut)}.foot .wrap{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:14px}
@media(max-width:820px){.grid3,.gal{grid-template-columns:1fr 1fr}.split,.post{grid-template-columns:1fr}.burger{display:block}.links{position:absolute;top:66px;left:0;right:0;flex-direction:column;background:var(--bg);border-bottom:1px solid var(--line);padding:14px;display:none}.links.open{display:flex}}
@media(max-width:560px){.grid3,.gal{grid-template-columns:1fr}}
</style></head>
<body>${body}</body></html>`;
}

// ── Conversation: turn a message into spec changes + a reply ─────────────────
const DEFAULT_SECTIONS = { landing: ["features", "about", "contact"], portfolio: ["about", "gallery", "contact"], blog: ["posts", "about"], "coming-soon": ["signup"] };

function freshSpec(text) {
  const type = detectType(text);
  const spec = {
    type,
    title: detectTitle(text) || { landing: "Northwind", portfolio: "Alex Rivera", blog: "The Dispatch", "coming-soon": "Launching Soon" }[type],
    accent: findColor(text) || "#4f46e5",
    dark: /\bdark\b/i.test(text) && !/\blight\b/i.test(text),
    sections: [],
  };
  const found = detectSections(text);
  spec.sections = found.length ? found : [...DEFAULT_SECTIONS[type]];
  if (type === "blog" && !spec.sections.includes("posts")) spec.sections.unshift("posts");
  return spec;
}

// Interprets a follow-up against the current spec, returns a human reply or a guidelines refusal.
function applyEdit(spec, text) {
  const p = text.toLowerCase();
  const changes = [];

  // Colour
  const col = findColor(text);
  if (col && /\b(colou?r|theme|accent|make it|turn it|change)\b/.test(p)) {
    spec.accent = col;
    changes.push("changed the colour");
  } else if (col && Object.values(NAMED_COLORS).includes(col)) {
    spec.accent = col;
    changes.push("changed the colour");
  }
  // Dark / light
  if (/\bdark(\s?mode)?\b/.test(p)) {
    if (!spec.dark) { spec.dark = true; changes.push("switched to dark mode"); }
  } else if (/\blight(\s?mode)?\b/.test(p)) {
    if (spec.dark) { spec.dark = false; changes.push("switched to light mode"); }
  }
  // Type
  const typeWord = /\b(portfolio)\b/.test(p) ? "portfolio" : /\b(blog|journal)\b/.test(p) ? "blog" : /\bcoming\s?-?soon\b/.test(p) ? "coming-soon" : /\blanding\b/.test(p) ? "landing" : null;
  if (typeWord && /\b(make it|turn it into|change .*to|should be)\b/.test(p) && typeWord !== spec.type) {
    spec.type = typeWord;
    changes.push(`made it a ${typeWord.replace("-", " ")} site`);
  }
  // Rename
  const newName = detectTitle(text);
  if (newName && /\b(call it|rename|name it|named|titled|change the name|title)\b/.test(p)) {
    spec.title = newName;
    changes.push(`renamed it to ${newName}`);
  }
  // Remove sections
  const removing = /\b(remove|without|no more|get rid of|delete|drop|take out|hide)\b/.test(p);
  const adding = /\b(add|include|also|put in|with a|with an|append|insert|give it|need a|want a)\b/.test(p);
  const sec = matchSection(text);
  if (sec && removing) {
    if (spec.sections.includes(sec)) { spec.sections = spec.sections.filter((x) => x !== sec); changes.push(`removed the ${sectionLabel[sec].toLowerCase()} section`); }
  } else if (sec && (adding || !removing)) {
    if (!spec.sections.includes(sec)) { spec.sections.push(sec); changes.push(`added a ${sectionLabel[sec].toLowerCase()} section`); }
  } else {
    // Multiple sections mentioned at once ("add pricing and a gallery")
    const multi = detectSections(text).filter((s) => !spec.sections.includes(s));
    if (multi.length && !removing) { multi.forEach((s) => spec.sections.push(s)); changes.push(`added ${multi.map((s) => sectionLabel[s].toLowerCase()).join(" and ")}`); }
  }

  if (!changes.length) return { reply: "I wasn't sure what to change there. Try things like “make it dark”, “add a pricing section”, “use a teal colour”, or “call it Aurora”.", changed: false };
  return { reply: `Done — I ${joinList(changes)}. Anything else?`, changed: true };
}

function joinList(arr) {
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
}

// Greetings, thanks and one-word replies get an instant answer instead of a build.
function isSmallTalk(text) {
  const s = text.trim().toLowerCase();
  if (s.length > 24) return false;
  return /^(hi+|hey+|hello+|yo|sup|hiya|heya|howdy|gm|good\s(morning|afternoon|evening|night)|thanks?|thank\syou|thx|ty|ok(ay)?|cool|nice|great|awesome|lol|lmao|haha+|test+|hmm+|ye(ah|p|s)?|nope?|no|wsp|whats\sup|what'?s\sup)[!.…?\s]*$/i.test(s);
}

// A new description (vs a tweak) starts a fresh site.
function looksLikeNewSite(text) {
  return /\b(a |an |another |new )?(landing|portfolio|blog|coming\s?-?soon|website|site|page|homepage)\b/.test(text.toLowerCase()) && /\b(for|about|called|named|that|selling|to)\b/.test(text.toLowerCase());
}

// ── Page wiring ──────────────────────────────────────────────────────────────
export function showBetaNotice() {
  let seen = false;
  try { seen = sessionStorage.getItem("chroniumx.aiBetaSeen") === "1"; } catch {}
  const el = $("#asstBeta");
  if (el) el.hidden = seen;
}

export function initAssistant() {
  let spec = null;
  let currentHtml = "";
  let aiMode = false; // true once we confirm a Claude key is configured on the server
  let aiModel = null;
  let busy = false;
  const chat = $("#asstChat");
  const input = $("#asstPrompt");

  // Is real Claude available (server has ANTHROPIC_API_KEY)? If so, use it instead of the on-device generator.
  (async () => {
    try {
      const r = await fetch("/api/ai");
      const d = await r.json();
      aiMode = !!d.available;
      aiModel = d.model || null;
    } catch {}
    // Always label the badge "beta", whichever engine is active.
    const tag = $("#asstModeTag");
    if (tag) {
      tag.textContent = "beta";
      tag.title = "Beta";
    }
  })();

  const betaOk = $("#asstBetaOk");
  if (betaOk) betaOk.addEventListener("click", () => {
    $("#asstBeta").hidden = true;
    try { sessionStorage.setItem("chroniumx.aiBetaSeen", "1"); } catch {}
    input && input.focus();
  });

  function addMsg(role, text) {
    const el = document.createElement("div");
    el.className = `asst-msg ${role}`;
    el.innerHTML = role === "assistant" ? `<span class="am-ic">${iconSvg()}</span><div class="am-txt">${esc(text)}</div>` : `<div class="am-txt">${esc(text)}</div>`;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }
  function iconSvg() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>';
  }
  function setButtons(on) {
    ["asstCopy", "asstDownload", "asstOpen"].forEach((id) => ($(`#${id}`).disabled = !on));
  }

  // ── Live code editor (Monaco, read-only) ──
  let editor = null;
  let monacoRef = null;
  const ensureEditor = (async () => {
    try {
      monacoRef = await loadMonaco();
      try {
        monacoRef.editor.defineTheme("cx-futuristic", {
          base: "vs-dark",
          inherit: true,
          rules: [
            { token: "tag", foreground: "34d399" },
            { token: "attribute.name", foreground: "a78bfa" },
            { token: "attribute.value", foreground: "38bdf8" },
            { token: "string", foreground: "38bdf8" },
            { token: "comment", foreground: "5b6672" },
          ],
          colors: { "editor.background": "#070c12", "editor.lineHighlightBackground": "#0e1620", "editorLineNumber.foreground": "#2a3542" },
        });
      } catch {}
      editor = monacoRef.editor.create($("#asstEditor"), {
        value: "",
        language: "html",
        theme: "cx-futuristic",
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        renderWhitespace: "none",
        wordWrap: "on",
      });
    } catch {}
  })();
  function setCode(code, { reveal = false } = {}) {
    if (!editor) return;
    editor.setValue(code);
    if (reveal) {
      const last = editor.getModel().getLineCount();
      editor.revealLine(last);
    }
  }
  function setView(v) {
    const work = $("#asstWork");
    work.className = `asst-work view-${v}`;
    $$("#asstViews [data-view]").forEach((b) => b.classList.toggle("is-active", b.dataset.view === v));
    if (editor) setTimeout(() => editor.layout(), 60);
  }
  $$("#asstViews [data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  function updatePreview(html) {
    const frame = $("#asstFrame");
    frame.srcdoc = html;
    frame.style.opacity = "1";
    $("#asstEmpty").hidden = true;
  }
  function showHtml(html) {
    currentHtml = html;
    setCode(html);
    updatePreview(html);
    setButtons(true);
    $("#asstStatus").textContent = `${(html.length / 1024).toFixed(1)} KB${aiMode ? " · Claude" : ""}`;
  }
  function render() {
    currentHtml = renderSite(spec);
    showHtml(currentHtml);
    $("#asstStatus").textContent = `${spec.title} · ${spec.type.replace("-", " ")} · ${spec.sections.length} sections · ${(currentHtml.length / 1024).toFixed(1)} KB`;
  }

  // ── Thinking panel (streamed reasoning, collapsible) ──
  function addThinking() {
    const el = document.createElement("div");
    el.className = "asst-think open";
    el.innerHTML = `<button class="at-head" type="button"><span class="at-dot"></span><span class="at-title">Thinking…</span><i data-icon="chevronDown" class="at-chev"></i></button><div class="at-body"><div class="at-text"></div></div>`;
    chat.appendChild(el);
    hydrateIcons();
    const body = el.querySelector(".at-text");
    el.querySelector(".at-head").addEventListener("click", () => el.classList.toggle("open"));
    chat.scrollTop = chat.scrollHeight;
    return {
      append(t) {
        body.textContent += t;
        chat.scrollTop = chat.scrollHeight;
      },
      done() {
        el.querySelector(".at-title").textContent = "Thought process";
        el.querySelector(".at-dot").classList.add("done");
        if (body.textContent.trim()) el.classList.remove("open");
        else el.remove();
      },
    };
  }

  // Opening greeting.
  addMsg("assistant", "Hi! Describe the website you want — for example “a landing page for a coffee shop called Bean & Co with a menu and contact form”. Then just tell me any changes: “make it dark”, “add pricing”, “use a teal colour”. I build simple, legitimate sites only.");

  // Splits the model's streamed output into the chat reply (before the code fence) and the HTML.
  function splitStream(full) {
    const fence = full.search(/```html|```\s*<!doctype|```\s*<html/i);
    if (fence < 0) return { reply: full, code: "", inCode: false };
    let after = full.slice(fence).replace(/^```html\s*/i, "").replace(/^```\s*/i, "");
    const close = after.indexOf("```");
    const code = close >= 0 ? after.slice(0, close) : after;
    return { reply: full.slice(0, fence).trim(), code: code, inCode: true };
  }

  // Real Claude builds/edits the site: streams its thinking into the chat and the code into the editor.
  async function sendAI(text) {
    busy = true;
    $("#asstSend").disabled = true;
    const think = addThinking();
    const replyEl = addMsg("assistant", "");
    const replyTxt = replyEl.querySelector(".am-txt");
    replyTxt.innerHTML = '<span class="asst-cursor"></span>';
    $("#asstGenBadge").hidden = false;
    $("#asstScan").hidden = false;
    setView("code");
    let hadCode = false;
    let lastPreview = 0;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 180000);
    let full = "";
    const onText = () => {
      const { reply, code, inCode } = splitStream(full);
      replyTxt.textContent = reply || (inCode ? "Building your site…" : "");
      if (code) {
        hadCode = true;
        setCode(code, { reveal: true });
        const now = Date.now();
        if (now - lastPreview > 700) {
          lastPreview = now;
          updatePreview(code);
        }
      }
    };

    try {
      const r = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, html: currentHtml }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        think.done();
        replyTxt.textContent = d.error || "Something went wrong — try again.";
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === "think") think.append(ev.d);
          else if (ev.t === "text") {
            full += ev.d;
            onText();
          } else if (ev.t === "error") {
            think.done();
            replyTxt.textContent = ev.m || "The AI hit an error.";
            return;
          }
        }
      }
      // Finalize.
      think.done();
      const { reply, code } = splitStream(full);
      if (code && code.trim()) {
        showHtml(code.trim());
        setView("split");
      }
      replyTxt.textContent = reply || (hadCode ? "Done — here's your site." : full.trim() || "Done.");
    } catch (e) {
      think.done();
      replyTxt.textContent = e && e.name === "AbortError" ? "That took too long — try a simpler request, or try again." : "I couldn't reach the AI. Check your connection and try again.";
    } finally {
      clearTimeout(timeout);
      $("#asstGenBadge").hidden = true;
      $("#asstScan").hidden = true;
      busy = false;
      $("#asstSend").disabled = false;
    }
  }

  // The on-device generator (used when no Claude key is configured).
  function sendLocal(text) {
    if (!spec || looksLikeNewSite(text)) {
      spec = freshSpec(text);
      render();
      addMsg("assistant", `Here's a ${spec.type.replace("-", " ")} site for ${spec.title}${spec.sections.length ? `, with ${joinList(spec.sections.map((s) => sectionLabel[s].toLowerCase()))}` : ""}. Tell me anything to change.`);
    } else {
      const { reply } = applyEdit(spec, text);
      render();
      addMsg("assistant", reply);
    }
  }

  function send() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    $("#asstErr").hidden = true;
    const blocked = checkGuidelines(text);
    addMsg("user", text);
    input.value = "";
    input.style.height = "";
    if (blocked) {
      addMsg("assistant", `Sorry — I can't build ${blocked}. I only make legitimate sites. Try a business, portfolio, blog, event or product page.`);
      return;
    }
    // Greetings / one-word replies: answer instantly, don't build or call the model.
    if (isSmallTalk(text)) {
      addMsg("assistant", currentHtml ? "Hey! What would you like to change, or shall I build something new?" : "Hey! Tell me what site you'd like — e.g. “a landing page for a bakery with a menu and contact form”.");
      return;
    }
    if (aiMode) sendAI(text);
    else sendLocal(text);
  }

  $("#asstSend").addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  // Auto-grow the input.
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });

  $("#asstCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(currentHtml); toast("Copied", "The full HTML is on your clipboard.", "success", 1800); }
    catch { toast("Copy failed", "Clipboard was blocked.", "warn"); }
  });
  $("#asstDownload").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([currentHtml], { type: "text/html" }));
    a.download = (spec && spec.title ? spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "site") + ".html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("#asstOpen").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([currentHtml], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}
