"use strict";

const path = require("path");
const fs = require("fs");
const { PUBLIC_DIR } = require("../config");
const { send } = require("./http-helpers");

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.url.split("?")[0]); }
  catch (_) { return send(res, 400, "Bad request"); }
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Forbidden");
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      ext === ".svg" ? "image/svg+xml" :
      ext === ".json" ? "application/json; charset=utf-8" :
      ext === ".webmanifest" ? "application/manifest+json; charset=utf-8" :
      ext === ".png" ? "image/png" :
      "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  });
}

module.exports = { serveStatic };
