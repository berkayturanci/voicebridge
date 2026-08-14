"use strict";

function classifyBridgeFatal(text, port) {
  const msg = String(text || "");
  if (/EADDRINUSE/.test(msg)) {
    return `Port ${port || 8787} is already in use. Stop the other process or choose a different port.`;
  }
  if (/EACCES/.test(msg)) {
    return `Port ${port || 8787} is not allowed. Choose a higher port or adjust permissions.`;
  }
  return "";
}

function healthOk(payload) {
  return !!payload && payload.ok === true;
}

function fetchFailureMessage(result) {
  if (!result) return "Bridge health check failed.";
  if (result.statusCode) return `Bridge health check failed (${result.statusCode}).`;
  if (result.error === "timeout") return "Bridge health check timed out.";
  if (result.error) return `Bridge health check failed: ${result.error}`;
  return "Bridge health check failed.";
}

module.exports = { classifyBridgeFatal, healthOk, fetchFailureMessage };
