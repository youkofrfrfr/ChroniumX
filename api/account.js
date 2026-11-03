"use strict";

// Signup, login and "who am I". Passwords are hashed in lib/accounts (scrypt); none is stored plainly.
const { sendJson, clientIp, bearer, readJsonBody, setCors } = require("../lib/http");
const accounts = require("../lib/accounts");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    return res.end();
  }
  const ip = clientIp(req);
  if (accounts.isIpBlocked(ip)) return sendJson(res, 403, { error: "Access from your network has been blocked." });

  // The action comes from the ?action= query or the request body — never a sub-path, because
  // serverless hosts (Vercel) route only /api/account to this function, not /api/account/signup.
  const query = new URL(req.url, "http://x").searchParams;
  const pathTail = req.url.split("?")[0].split("/").filter(Boolean).pop();
  let action = (query.get("action") || "").toLowerCase();

  if (req.method === "GET") {
    if (action === "me" || pathTail === "me") {
      const user = accounts.verifyToken(bearer(req));
      return sendJson(res, 200, { user: user ? accounts.publicUser(user) : null });
    }
    return sendJson(res, 400, { error: "Unknown account action" });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST required" });

  const body = await readJsonBody(req);
  // Prefer body.action, then the query, then the legacy sub-path (local dev).
  action = (body.action || action || (pathTail !== "account" ? pathTail : "") || "").toLowerCase();
  try {
    if (action === "signup") return sendJson(res, 200, accounts.signup({ username: body.username, password: body.password, ip }));
    if (action === "login") return sendJson(res, 200, accounts.login({ username: body.username, password: body.password, ip }));

    // Everything below needs a valid session.
    const me = accounts.verifyToken(bearer(req));
    if (!me) return sendJson(res, 401, { error: "Please sign in again" });
    if (action === "username") return sendJson(res, 200, accounts.changeUsername({ userId: me.id, newUsername: body.username }));
    if (action === "password") return sendJson(res, 200, accounts.changePassword({ userId: me.id, currentPassword: body.currentPassword, newPassword: body.newPassword }));
    if (action === "delete") return sendJson(res, 200, accounts.deleteSelf({ userId: me.id, password: body.password }));
    return sendJson(res, 404, { error: "Unknown account action" });
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
};
