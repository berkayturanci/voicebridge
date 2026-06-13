#!/usr/bin/env node
// Generate a VAPID key pair for Web Push and print it as env lines.
// Requires the optional `web-push` dependency (npm install web-push).
try {
  const webpush = require("web-push");
  const k = webpush.generateVAPIDKeys();
  console.log("# Add these to the bridge's environment to enable Web Push:");
  console.log("VAPID_PUBLIC_KEY=" + k.publicKey);
  console.log("VAPID_PRIVATE_KEY=" + k.privateKey);
  console.log("VAPID_SUBJECT=mailto:you@example.com");
} catch (_) {
  console.error("web-push is not installed. Run: npm install web-push");
  process.exit(1);
}
