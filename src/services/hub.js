"use strict";

const crypto = require("crypto");
const { ACCESS_TOKEN } = require("../config");
const { wsAcceptKey, wsEncode } = require("../routes/http-helpers");
const { attachWs, authorizedWs } = require("./stt");
const sessionsService = require("./sessions");
const approvalsService = require("./approvals");

// Map<sessionId, Set<wsClient>>
const sessionSubscriptions = new Map();
// Set<wsClient>
const allClients = new Set();

function subscribe(sessionId, client) {
  if (!sessionId || !client || typeof sessionId !== "string") return;
  if (!sessionSubscriptions.has(sessionId)) sessionSubscriptions.set(sessionId, new Set());
  sessionSubscriptions.get(sessionId).add(client);
  client.subscribedSessions.add(sessionId);
}

function unsubscribe(sessionId, client) {
  if (!sessionId || !client || typeof sessionId !== "string") return;
  if (sessionSubscriptions.has(sessionId)) {
    const set = sessionSubscriptions.get(sessionId);
    set.delete(client);
    if (set.size === 0) sessionSubscriptions.delete(sessionId);
  }
  client.subscribedSessions.delete(sessionId);
}

function deleteSession(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return;
  sessionSubscriptions.delete(sessionId);
}

function unsubscribeAll(client) {
  if (!client) return;
  allClients.delete(client);
  for (const sId of Array.from(client.subscribedSessions || [])) {
    unsubscribe(sId, client);
  }
}

function broadcast(sessionId, eventObj) {
  if (!sessionId || !eventObj || typeof sessionId !== "string") return;
  const set = sessionSubscriptions.get(sessionId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(eventObj);
  for (const client of Array.from(set)) {
    try {
      client.send(payload);
    } catch (_) {
      unsubscribeAll(client);
    }
  }
}

function broadcastAll(eventObj) {
  if (!eventObj) return;
  const payload = JSON.stringify(eventObj);
  for (const client of Array.from(allClients)) {
    try {
      client.send(payload);
    } catch (_) {
      unsubscribeAll(client);
    }
  }
}

function handleWsUpgrade(req, socket, head) {
  const parsed = new URL(req.url || "/", "http://x");
  if (parsed.pathname !== "/ws") return false;

  const reject = (code, msg) => {
    try { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
  };

  if (!authorizedWs(req, parsed)) { reject(401, "Unauthorized"); return true; }

  const key = req.headers["sec-websocket-key"];
  if (!key) { reject(400, "Bad Request"); return true; }

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
    "\r\n",
  ].join("\r\n"));

  let closed = false;
  const client = {
    socket,
    subscribedSessions: new Set(),
    send: (str) => {
      if (closed) return;
      try { socket.write(wsEncode(str, { opcode: 1 })); } catch (_) {}
    },
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribeAll(client);
      try { socket.end(wsEncode(Buffer.alloc(0), { opcode: 0x8 })); } catch (_) {}
    }
  };

  allClients.add(client);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribeAll(client);
    try { socket.destroy(); } catch (_) {}
  };

  const ws = attachWs(socket, {
    incomingMasked: true,
    onMessage: (payload) => {
      try {
        let msg = {};
        try { msg = JSON.parse(payload.toString("utf8")); } catch (_) { return; }

        if (msg.type === "ping") {
          client.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          return;
        }

        if (msg.type === "subscribe" && typeof msg.sessionId === "string") {
          subscribe(msg.sessionId, client);
          const s = sessionsService.resolveSession(msg.sessionId);
          client.send(JSON.stringify({
            type: "subscribed",
            sessionId: msg.sessionId,
            session: s ? sessionsService.publicSession(s) : null
          }));
          return;
        }

        if (msg.type === "unsubscribe" && typeof msg.sessionId === "string") {
          unsubscribe(msg.sessionId, client);
          client.send(JSON.stringify({ type: "unsubscribed", sessionId: msg.sessionId }));
          return;
        }

        if (msg.type === "approval" && typeof msg.id === "string") {
          const approved = Boolean(msg.approved);
          const appr = approvalsService.getApproval(msg.id);
          const res = approvalsService.resolveApproval(msg.id, approved);
          if (res) {
            broadcastAll({
              type: "approval_resolved",
              id: msg.id,
              approved,
              approval: appr
            });
          }
          return;
        }
      } catch (_) {}
    },
    onClose: cleanup,
    onError: cleanup,
  });

  if (head && head.length) ws.push(head);
  return true;
}

module.exports = {
  subscribe,
  unsubscribe,
  deleteSession,
  unsubscribeAll,
  broadcast,
  broadcastAll,
  handleWsUpgrade,
  _internals: {
    sessionSubscriptions,
    allClients,
  }
};
