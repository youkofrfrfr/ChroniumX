// Custom cursor: a glowing ring that eases toward the pointer, a crisp dot on it, and a fading trail.
// Pointer-only (skipped on touch and when the user prefers reduced motion); the real cursor is hidden.
export function installCursor() {
  const fine = window.matchMedia("(pointer: fine)").matches;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || reduce) return;

  const layer = document.createElement("div");
  layer.className = "cx-cursor-layer";
  const ring = document.createElement("div");
  ring.className = "cx-cursor-ring";
  const dot = document.createElement("div");
  dot.className = "cx-cursor-dot";
  const TRAIL = 6;
  const trails = Array.from({ length: TRAIL }, () => {
    const t = document.createElement("div");
    t.className = "cx-cursor-trail";
    layer.appendChild(t);
    return { el: t, x: 0, y: 0 };
  });
  layer.appendChild(ring);
  layer.appendChild(dot);
  document.body.appendChild(layer);
  document.documentElement.classList.add("cx-has-cursor");

  let mx = innerWidth / 2;
  let my = innerHeight / 2;
  let rx = mx;
  let ry = my;
  let visible = false;

  addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      mx = e.clientX;
      my = e.clientY;
      if (!visible) {
        visible = true;
        layer.style.opacity = "1";
      }
      dot.style.transform = `translate(${mx}px, ${my}px)`;
      // A pointer over a clickable control enlarges the ring.
      const interactive = e.target && e.target.closest && e.target.closest('a,button,[role="button"],input,select,textarea,.tree-row,.map-row,.nav-btn,label.toggle,[data-link]');
      ring.classList.toggle("hot", !!interactive);
    },
    { passive: true }
  );
  addEventListener("pointerdown", () => ring.classList.add("down"));
  addEventListener("pointerup", () => ring.classList.remove("down"));
  const show = () => visible && (layer.style.opacity = "1");
  const hide = () => (layer.style.opacity = "0");
  // Hide only when the pointer truly leaves the window — NOT on the spurious pointer events that
  // fire while a page's DOM is swapped (that was leaving the cursor stuck hidden between pages).
  document.addEventListener("mouseleave", (e) => {
    if (!e.relatedTarget) hide();
  });
  document.addEventListener("mouseenter", show);
  window.addEventListener("blur", hide);
  window.addEventListener("focus", show);
  // Belt and suspenders: after a page/visibility change, make sure the cursor is shown again.
  document.addEventListener("visibilitychange", () => !document.hidden && show());

  const frame = () => {
    rx += (mx - rx) * 0.18;
    ry += (my - ry) * 0.18;
    ring.style.transform = `translate(${rx}px, ${ry}px)`;
    let px = rx;
    let py = ry;
    for (const t of trails) {
      t.x += (px - t.x) * 0.35;
      t.y += (py - t.y) * 0.35;
      t.el.style.transform = `translate(${t.x}px, ${t.y}px)`;
      px = t.x;
      py = t.y;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
