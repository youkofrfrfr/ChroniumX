"use strict";

/*
 * Real-AI endpoint for the Assistant. When ANTHROPIC_API_KEY is set on the server, the chat is
 * powered by Claude (the Messages API) instead of the on-device generator, so it can build and
 * edit far richer, more custom sites. The key stays server-side — it is never sent to the browser.
 *
 * Set up: get a key at console.anthropic.com, then set ANTHROPIC_API_KEY (locally in your shell,
 * or in your Vercel project's Environment Variables). Optional: AI_MODEL (default claude-opus-5-5;
 * cheaper options: claude-sonnet-5-5, claude-haiku-5-5).
 */
const { sendJson, clientIp, readJsonBody, setCors } = require("../lib/http");
const accounts = require("../lib/accounts");

const MODEL = process.env.AI_MODEL || "claude-opus-5-5";
function hasKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}
function getClient() {
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default || mod;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const SYSTEM = `You are ChroniumX's website builder: a friendly, expert web designer who turns a short description into a complete, polished, responsive website, then refines it on request.

Output format, every time:
1. First, one or two short, friendly sentences about what you built or changed.
2. Then the ENTIRE website as a single self-contained HTML document inside ONE \`\`\`html code fence. Always output the full, updated document — never a diff or a fragment. Put all CSS in a <style> tag and all JS in a <script> tag; no external build tools. You may use public, key-less APIs and CDNs for images or data when the user asks for dynamic content.

Design well: modern layout, good spacing and typography, a cohesive colour palette, accessible contrast, mobile-responsive, subtle polish. Prefer system fonts or Google Fonts.

Guidelines (hard limits): build only legitimate sites. Never create fake sign-in or payment pages, pages that impersonate a real brand or collect someone's credentials or card details, phishing, scams, malware, or anything illegal. If a request asks for that, refuse in your sentence(s), do not output HTML for it, and offer a legitimate alternative.`;

function extractHtml(text) {
  const m = text.match(/```html\s*([\s\S]*?)```/i) || text.match(/```\s*(<!doctype[\s\S]*?)```/i);
  if (m) {
    const html = m[1].trim();
    const reply = text.slice(0, m.index).trim() || "Here's your site.";
    return { reply, html };
  }
  // No fence: if the whole thing is an HTML doc, treat it as the site.
  if (/<!doctype html|<html[\s>]/i.test(text)) return { reply: "Here's your site.", html: text.trim() };
  return { reply: text.trim(), html: null };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method === "GET") {
    return sendJson(res, 200, { available: hasKey(), model: hasKey() ? MODEL : null });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST required" });
  if (accounts.isIpBlocked(clientIp(req))) return sendJson(res, 403, { error: "Access from your network has been blocked." });
  if (!hasKey()) return sendJson(res, 503, { error: "AI is not configured on this server. Set ANTHROPIC_API_KEY to enable it.", available: false });

  const body = await readJsonBody(req);
  const message = String(body.message || "").slice(0, 8000).trim();
  const currentHtml = typeof body.html === "string" ? body.html.slice(0, 200000) : "";
  if (!message) return sendJson(res, 400, { error: "Say what you'd like to build." });

  // The whole conversation is carried as the current HTML plus the new instruction.
  const userText = currentHtml
    ? `Here is the current website:\n\`\`\`html\n${currentHtml}\n\`\`\`\n\nApply this change and return the full updated document:\n${message}`
    : `Build this website:\n${message}`;

  // Stream the model's thinking and output to the browser as NDJSON, so the UI can show the AI
  // reasoning in the chat and the code being written live in the editor.
  res.statusCode = 200;
  setCors(res);
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("x-accel-buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = (obj) => {
    try {
      res.write(`${JSON.stringify(obj)}\n`);
    } catch {}
  };

  let stream;
  try {
    const client = getClient();
    stream = client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      system: SYSTEM,
      thinking: { type: "adaptive", display: "summarized" },
      messages: [{ role: "user", content: userText }],
    });
    // If the browser goes away, stop generating (and stop billing).
    req.on("close", () => {
      try {
        stream.abort();
      } catch {}
    });
    send({ t: "model", model: MODEL });
    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      const d = event.delta || {};
      if (d.type === "thinking_delta" && d.thinking) send({ t: "think", d: d.thinking });
      else if (d.type === "text_delta" && d.text) send({ t: "text", d: d.text });
    }
    send({ t: "done" });
    res.end();
  } catch (error) {
    const status = error && error.status;
    const msg = status === 401 ? "The server's ANTHROPIC_API_KEY is invalid." : status === 429 ? "Claude is rate-limited right now — try again in a moment." : (error && error.message) || "AI request failed.";
    send({ t: "error", m: msg });
    res.end();
  }
};
