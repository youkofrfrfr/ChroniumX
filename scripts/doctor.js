#!/usr/bin/env node
"use strict";

// Checks every way ChroniumX can start headless Chrome on this machine and prints what works.
// Usage: npm run doctor   (or: node scripts/doctor.js --json)
const { diagnoseBrowser } = require("../lib/browser");

(async () => {
  const report = await diagnoseBrowser();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`ChroniumX browser doctor — ${report.platform}, Node ${report.node}${report.serverless ? ", serverless" : ""}`);
    if (report.chromiumPackage) console.log(`@sparticuz/chromium ${report.chromiumPackage}`);
    for (const s of report.strategies) {
      console.log(`  ${s.ok ? "✔" : "✘"} ${s.kind.padEnd(20)} ${s.ok ? `${s.version || "ok"} (${s.ms} ms)` : s.error}`);
    }
    if (!report.strategies.length) console.log("  ✘ no launch methods are available on this host");
    console.log(report.working && report.working.length ? `\nHeadless Chrome works via: ${report.working.join(", ")}` : "\nNo headless Chrome available. Scrapes will use the static engine. Set BROWSER_WS_ENDPOINT to a hosted browser to fix that.");
  }
  process.exit(report.working && report.working.length ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
