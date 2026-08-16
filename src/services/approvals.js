"use strict";

const crypto = require("crypto");

const pendingApprovals = new Map();

function generateApprovalId() {
  return "appr_" + crypto.randomBytes(6).toString("hex");
}

function createApproval({ sessionId, tool = "tool", command = "", details = "", description = "", resolve }) {
  const id = generateApprovalId();
  const record = {
    id,
    sessionId: sessionId || "default",
    tool: String(tool || "tool"),
    command: String(command || ""),
    details: String(details || ""),
    description: String(description || command || tool),
    createdAt: Date.now(),
    resolve,
  };
  pendingApprovals.set(id, record);
  return {
    id: record.id,
    sessionId: record.sessionId,
    tool: record.tool,
    command: record.command,
    details: record.details,
    description: record.description,
    createdAt: record.createdAt,
  };
}

function getApproval(id) {
  const p = pendingApprovals.get(id);
  if (!p) return null;
  return {
    id: p.id,
    sessionId: p.sessionId,
    tool: p.tool,
    command: p.command,
    details: p.details,
    description: p.description,
    createdAt: p.createdAt,
  };
}

function resolveApproval(id, approved) {
  const p = pendingApprovals.get(id);
  if (!p) return false;
  pendingApprovals.delete(id);
  if (typeof p.resolve === "function") {
    try {
      p.resolve(Boolean(approved));
    } catch (_) {}
  }
  return true;
}

function getPendingApprovals(sessionId) {
  const list = [];
  for (const p of pendingApprovals.values()) {
    if (!sessionId || p.sessionId === sessionId) {
      list.push({
        id: p.id,
        sessionId: p.sessionId,
        tool: p.tool,
        command: p.command,
        details: p.details,
        description: p.description,
        createdAt: p.createdAt,
      });
    }
  }
  return list;
}

function clearSessionApprovals(sessionId, reason = "Session closed") {
  for (const [id, p] of pendingApprovals.entries()) {
    if (!sessionId || p.sessionId === sessionId) {
      pendingApprovals.delete(id);
      if (typeof p.resolve === "function") {
        try {
          p.resolve(false, reason);
        } catch (_) {}
      }
    }
  }
}

function publicApproval(p) {
  if (!p) return null;
  return {
    id: p.id,
    sessionId: p.sessionId,
    tool: p.tool,
    command: p.command,
    details: p.details,
    description: p.description,
    createdAt: p.createdAt,
  };
}

module.exports = {
  pendingApprovals,
  createApproval,
  getApproval,
  publicApproval,
  resolveApproval,
  getPendingApprovals,
  clearSessionApprovals,
};
