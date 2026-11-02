"use strict";

/*
 * Admin moderation API. Every request must carry the admin password (checked against a scrypt hash,
 * never a stored plaintext). The dashboard it serves lives at an obscure client route and is never
 * linked from the UI, but obscurity is not the security here — this password gate is.
 */
const { sendJson, clientIp, readJsonBody, setCors } = require("../lib/http");
const accounts = require("../lib/accounts");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST required" });

  const body = await readJsonBody(req);
  if (!accounts.verifyAdmin(body.password)) {
    // Same reply whether the route or the password is wrong, so neither can be probed.
    return sendJson(res, 403, { error: "Not authorized" });
  }

  const op = body.op || "snapshot";
  try {
    switch (op) {
      case "snapshot":
        return sendJson(res, 200, { ok: true, data: accounts.adminSnapshot() });
      case "blockIp":
        accounts.blockIp(body.ip, body.on !== false);
        break;
      case "banUser":
        accounts.banUser(body.userId, body.on !== false);
        break;
      case "deleteUser":
        accounts.deleteUser(body.userId);
        break;
      case "clearScrapeLog":
        accounts.clearScrapeLog();
        break;
      default:
        return sendJson(res, 400, { error: "Unknown op" });
    }
    return sendJson(res, 200, { ok: true, data: accounts.adminSnapshot() });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
};
