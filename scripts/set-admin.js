#!/usr/bin/env node
"use strict";

/*
 * Sets the admin-dashboard password for this ChroniumX instance.
 *
 *   npm run set-admin "your password"
 *
 * It saves the password as a one-way scrypt hash into the local (gitignored) data file, so the
 * dashboard works right away on this machine and the plaintext never enters the repo. It also prints
 * an ADMIN_PASSWORD_HASH line to set as an env var on a deployment (Vercel, etc.).
 */
const accounts = require("../lib/accounts");

const pw = process.argv[2];
if (!pw || pw.length < 8) {
  console.error('Usage: npm run set-admin "a-password-at-least-8-chars"');
  process.exit(1);
}
const hash = accounts.hashPassword(pw);
accounts.setAdminHash(hash);
console.log("Admin password saved for this instance (in the gitignored data file).");
console.log("\nFor a deployment, set this environment variable instead:\n");
console.log(`  ADMIN_PASSWORD_HASH=${hash}`);
