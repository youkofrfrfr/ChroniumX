"use strict";

// "Heavy-JS" sites: big single-page apps whose pages are built entirely by JavaScript and need a real
// browser to scrape well. Guests may scrape ordinary sites; these require an account. The matching
// list is mirrored in assets/js/account.js (isHeavyHost) — keep the two in sync.
const HEAVY_HOST_RE =
  /(^|\.)(discord|discordapp|instagram|tiktok|x|twitter|facebook|messenger|reddit|linkedin|threads|roblox|youtube|twitch|spotify|netflix|pinterest|snapchat|whatsapp|tumblr|bsky|figma|notion|canva)\.(com|net|app|tv|gg)$/i;

function isHeavyHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return HEAVY_HOST_RE.test(h) || /(^|\.)discord\./.test(h);
}

module.exports = { isHeavyHost, HEAVY_HOST_RE };
