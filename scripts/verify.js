#!/usr/bin/env node
"use strict";

/*
 * Pre-deploy check. A frozen loading screen on a deploy almost always means one front-end module
 * failed to load (a missing file, a bad import path) or an API function won't start. This script
 * catches those before you push, by:
 *   1. checking every local file index.html references actually exists,
 *   2. following the ES-module import graph from app.js and flagging any missing module,
 *   3. loading every api/*.js and lib/*.js to make sure they don't throw on import.
 * Exits non-zero (and lists the problems) if anything would break a deploy.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const problems = [];
const ok = [];

function rel(p) {
  return path.relative(ROOT, p);
}

// 1. Local files referenced from index.html.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const refRe = /(?:src|href)\s*=\s*"([^"]+)"/g;
let m;
const seen = new Set();
while ((m = refRe.exec(html)) !== null) {
  const url = m[1];
  if (/^(https?:)?\/\//.test(url) || url.startsWith("data:") || url.startsWith("#") || url.startsWith("mailto:")) continue;
  const clean = url.split(/[?#]/)[0].replace(/^\//, "");
  if (!clean || seen.has(clean)) continue;
  seen.add(clean);
  if (fs.existsSync(path.join(ROOT, clean))) ok.push(`index.html → ${clean}`);
  else problems.push(`index.html references a file that does not exist: ${url}`);
}

// 2. ES-module import graph, starting at app.js.
const visited = new Set();
function walkModule(file) {
  if (visited.has(file)) return;
  visited.add(file);
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    problems.push(`module missing: ${rel(file)}`);
    return;
  }
  const importRe = /\bfrom\s*["'](\.[^"']+)["']/g;
  let im;
  while ((im = importRe.exec(src)) !== null) {
    let target = im[1];
    if (!/\.[a-z]+$/.test(target)) target += ".js";
    const resolved = path.resolve(path.dirname(file), target);
    if (fs.existsSync(resolved)) walkModule(resolved);
    else problems.push(`${rel(file)} imports a module that does not exist: ${im[1]}`);
  }
}
const entry = path.join(ROOT, "assets/js/app.js");
if (fs.existsSync(entry)) walkModule(entry);
else problems.push("assets/js/app.js is missing");

// 3. Server modules load cleanly.
for (const dir of ["api", "lib"]) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith(".js"))) {
    try {
      require(path.join(ROOT, dir, f));
      ok.push(`loads: ${dir}/${f}`);
    } catch (error) {
      problems.push(`${dir}/${f} fails to load: ${error.message}`);
    }
  }
}

console.log(`ChroniumX verify — ${ok.length} checks passed, ${problems.length} problem(s)`);
if (problems.length) {
  for (const p of problems) console.log(`  ✘ ${p}`);
  console.log("\nFix these before deploying — any one of them can freeze the app on load.");
  process.exit(1);
}
console.log("  ✔ all front-end modules resolve and all API/lib modules load.");
