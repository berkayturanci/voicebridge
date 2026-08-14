"use strict";

function cleanDnsName(value) {
  return String(value || "").trim().replace(/\.$/, "");
}

function bridgeTargetUrl(port) {
  const safePort = Number.parseInt(port, 10) || 8787;
  return `http://127.0.0.1:${safePort}`;
}

function serveCommand(settings = {}, platform = process.platform) {
  const bin = platform === "win32" ? "tailscale.exe" : "tailscale";
  return `${bin} serve --bg ${bridgeTargetUrl(settings.port)}`;
}

function likelyPublicUrls(status = {}) {
  const urls = [];
  const dnsName = cleanDnsName(status.dnsName);
  if (dnsName) urls.push(`https://${dnsName}`);
  return urls;
}

function describeCommandError(result = {}) {
  if (result.error === "not_installed") {
    return {
      installed: false,
      running: false,
      authenticated: false,
      state: "cli_missing",
      error: "not_installed",
      message: "Tailscale CLI not found. Install Tailscale, then refresh.",
      suggestedPublicUrls: [],
    };
  }

  return {
    installed: true,
    running: false,
    authenticated: false,
    state: "cli_error",
    error: result.error || "command_failed",
    message: `Could not read Tailscale status: ${result.error || "command failed"}.`,
    suggestedPublicUrls: [],
  };
}

function describeTailscaleStatus(result = {}) {
  if (!result.ok) return describeCommandError(result);

  const data = result.data && typeof result.data === "object" ? result.data : {};
  const self = data.Self && typeof data.Self === "object" ? data.Self : null;
  const backendState = String(data.BackendState || "").trim();
  const dnsName = cleanDnsName(self && self.DNSName);
  const tailscaleIps = Array.isArray(self && self.TailscaleIPs) ? self.TailscaleIPs : [];
  const authenticated = !!(self && (self.ID || dnsName || tailscaleIps.length));
  const online = !!(self && self.Online);
  const running = online || backendState.toLowerCase() === "running";
  const base = {
    installed: true,
    running,
    authenticated,
    backendState,
    dnsName,
    tailscaleIps,
    suggestedPublicUrls: likelyPublicUrls({ dnsName }),
  };

  if (!authenticated || /needslogin|login/i.test(backendState)) {
    return {
      ...base,
      running: false,
      authenticated: false,
      state: "logged_out",
      message: "Tailscale is installed but not logged in. Run tailscale up first.",
    };
  }

  if (!running) {
    return {
      ...base,
      state: "offline",
      message: backendState
        ? `Tailscale is ${backendState}, not online.`
        : "Tailscale is installed but this device is not online.",
    };
  }

  return {
    ...base,
    state: "online",
    message: dnsName ? `Online as ${dnsName}.` : "Tailscale is online.",
  };
}

function publicProbeUrl(publicUrl, pathname) {
  if (!publicUrl) return { ok: false, error: "missing_public_url" };
  try {
    const url = new URL(publicUrl);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return { ok: true, url };
  } catch (_) {
    return { ok: false, error: "invalid_public_url" };
  }
}

function classifyNetworkError(error) {
  const code = String(error || "");
  if (code === "timeout") return { category: "timeout", message: "Public URL timed out. Check Tailscale Serve and network reachability." };
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return { category: "dns", message: "Public URL DNS lookup failed. Check the Tailscale hostname." };
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return { category: "network", message: "Public URL is not reachable. Check Tailscale Serve and the bridge port." };
  }
  if (/CERT|TLS|SSL/i.test(code)) return { category: "tls", message: "Public URL failed TLS verification." };
  return { category: "network", message: `Public URL request failed: ${code || "network error"}.` };
}

function describePublicProbe(result = {}, opts = {}) {
  const probe = opts.probe || "health";
  if (!result.configured) {
    return {
      configured: false,
      ok: false,
      status: 0,
      error: "missing_public_url",
      category: "missing_url",
      message: "No public URL configured. Paste the Tailscale HTTPS URL after serving.",
    };
  }

  if (result.error === "invalid_public_url") {
    return {
      ...result,
      ok: false,
      status: 0,
      category: "invalid_url",
      message: "Public URL is not a valid URL.",
    };
  }

  if (result.error) {
    return {
      ...result,
      ok: false,
      status: result.status || 0,
      error: result.error,
      ...classifyNetworkError(result.error),
    };
  }

  const status = Number(result.status || result.statusCode || 0);
  if (status >= 200 && status < 300) {
    return {
      ...result,
      ok: true,
      status,
      category: "ready",
      message: probe === "auth" ? "Public URL and token are reachable." : "Public URL health check passed.",
    };
  }

  if (status === 401 || status === 403) {
    return {
      ...result,
      ok: false,
      status,
      category: "auth",
      error: "auth_failed",
      message: "Public URL is reachable, but the access token was rejected.",
    };
  }

  return {
    ...result,
    ok: false,
    status,
    category: status >= 500 ? "server" : "http",
    message: status
      ? `Public URL responded with HTTP ${status}.`
      : "Public URL did not return a valid HTTP response.",
  };
}

module.exports = {
  bridgeTargetUrl,
  describePublicProbe,
  describeTailscaleStatus,
  publicProbeUrl,
  serveCommand,
};
