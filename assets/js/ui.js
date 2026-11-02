import { icon } from "./icons.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Toasts ────────────────────────────────────────────────────────────────
const TOAST_ICONS = { success: "checkCircle", warn: "alert", error: "xCircle", info: "info" };

export function toast(title, message = "", type = "info", ms = 4200) {
  const host = $("#toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast glass ${type}`;
  el.innerHTML = `${icon(TOAST_ICONS[type] || "info")}<div><b>${escapeHtml(title)}</b>${message ? `<span>${escapeHtml(message)}</span>` : ""}</div><i class="life" style="animation-duration:${ms}ms;color:var(--${type === "success" ? "accent" : type === "error" ? "danger" : type === "warn" ? "warn" : "accent-3"})"></i>`;
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 350);
  };
  el.addEventListener("click", close);
  setTimeout(close, ms);
}

// ── Modal confirm ─────────────────────────────────────────────────────────
export function confirmDialog({ title, message, confirmText = "Confirm", cancelText = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const overlay = $("#modal");
    $("#modalTitle").textContent = title;
    $("#modalText").textContent = message;
    const actions = $("#modalActions");
    actions.innerHTML = "";
    const cancel = document.createElement("button");
    cancel.className = "btn btn-sm";
    cancel.type = "button";
    cancel.textContent = cancelText;
    const ok = document.createElement("button");
    ok.className = `btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`;
    ok.type = "button";
    ok.textContent = confirmText;
    actions.append(cancel, ok);
    const finish = (v) => {
      overlay.classList.remove("open");
      document.removeEventListener("keydown", onKey);
      overlay.onclick = null;
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter") finish(true);
    };
    cancel.onclick = () => finish(false);
    ok.onclick = () => finish(true);
    overlay.onclick = (e) => e.target === overlay && finish(false);
    document.addEventListener("keydown", onKey);
    overlay.classList.add("open");
    setTimeout(() => ok.focus(), 50);
  });
}

// ── Ripple on every .btn ─────────────────────────────────────────────────
export function installRipples() {
  document.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest(".btn, .nav-btn, .act-btn");
    if (!btn || btn.disabled || reducedMotion()) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const r = document.createElement("span");
    r.className = "ripple";
    r.style.width = r.style.height = `${size}px`;
    r.style.left = `${e.clientX - rect.left - size / 2}px`;
    r.style.top = `${e.clientY - rect.top - size / 2}px`;
    if (getComputedStyle(btn).position === "static") btn.style.position = "relative";
    btn.style.overflow = "hidden";
    btn.appendChild(r);
    setTimeout(() => r.remove(), 650);
  });
}

// ── Animated number counters ─────────────────────────────────────────────
const counterState = new WeakMap();
export function animateNumber(el, to, { duration = 600, format = (v) => Math.round(v).toLocaleString() } = {}) {
  if (!el) return;
  const target = Number(to) || 0;
  const prev = counterState.get(el);
  const from = prev ? prev.value : Number(String(el.textContent).replace(/[^\d.-]/g, "")) || 0;
  if (prev && prev.raf) cancelAnimationFrame(prev.raf);
  if (reducedMotion() || from === target) {
    el.textContent = format(target);
    counterState.set(el, { value: target });
    return;
  }
  const start = performance.now();
  const state = { value: from, raf: 0 };
  counterState.set(el, state);
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    state.value = from + (target - from) * eased;
    el.textContent = format(state.value);
    if (t < 1) state.raf = requestAnimationFrame(step);
    else state.value = target;
  };
  state.raf = requestAnimationFrame(step);
}

// ── Page transitions ─────────────────────────────────────────────────────
export function transition(update) {
  if (document.startViewTransition && !reducedMotion()) {
    return document.startViewTransition(update).finished.catch(() => {});
  }
  update();
  return Promise.resolve();
}

// ── Boot sequence ────────────────────────────────────────────────────────
export function createBoot() {
  const boot = $("#boot");
  const title = $("#bootTitle");
  const bar = $("#bootBar");
  const stepEl = $("#bootStep");
  const pctEl = $("#bootPct");
  const word = "ChroniumX";
  title.innerHTML = [...word].map((c, i) => `<span style="--i:${i}" class="${c === "X" ? "x" : ""}">${c}</span>`).join("");

  let shown = 0;
  let target = 0;
  let skipped = false;
  let raf = 0;
  const startedAt = performance.now();

  const tick = () => {
    shown += (target - shown) * 0.12;
    if (Math.abs(target - shown) < 0.2) shown = target;
    bar.style.width = `${shown}%`;
    pctEl.textContent = `${Math.round(shown)}%`;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const skip = () => (skipped = true);
  window.addEventListener("keydown", skip, { once: true });
  boot.addEventListener("click", skip, { once: true });

  return {
    step(label, pct) {
      stepEl.style.opacity = "0";
      setTimeout(() => {
        stepEl.textContent = label;
        stepEl.style.opacity = "1";
      }, 120);
      target = Math.max(target, pct);
    },
    async finish() {
      target = 100;
      const minTime = reducedMotion() ? 0 : 1900;
      while (!skipped && performance.now() - startedAt < minTime) {
        await new Promise((r) => setTimeout(r, 50));
      }
      cancelAnimationFrame(raf);
      bar.style.transition = "width .35s var(--ease-out)";
      bar.style.width = "100%";
      pctEl.textContent = "100%";
      if (!skipped) await new Promise((r) => setTimeout(r, 380));
      boot.classList.add("leaving");
      document.body.classList.remove("is-booting");
      setTimeout(() => document.body.classList.add("is-ready"), 120);
      setTimeout(() => boot.remove(), 900);
    },
  };
}
