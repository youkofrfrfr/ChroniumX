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

  const action = (req.url.split("?")[0].split("/").pop() || "").toLowerCase();

  if (req.method === "GET" && action === "me") {
    const user = accounts.verifyToken(bearer(req));
    return sendJson(res, 200, { user: user ? accounts.publicUser(user) : null });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST required" });

  const body = await readJsonBody(req);
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
