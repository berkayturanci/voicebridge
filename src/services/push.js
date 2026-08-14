"use strict";

let webpush; // undefined = not tried, null = unavailable
const pushSubs = []; // [{ sub, sessionId }]

function pushEnabled() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  if (webpush === undefined) { try { webpush = require("web-push"); } catch (_) { webpush = null; } }
  if (!webpush) return false;
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:voicebridge@localhost",
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY
    );
  } catch (_) { return false; }
  return true;
}

function sendPush(payload) {
  if (!pushEnabled() || !pushSubs.length) return;
  const data = JSON.stringify(payload);
  for (let i = pushSubs.length - 1; i >= 0; i--) {
    webpush.sendNotification(pushSubs[i].sub, data).catch((e) => {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) pushSubs.splice(i, 1); // gone
    });
  }
}

module.exports = {
  pushEnabled,
  pushSubs,
  sendPush,
};
