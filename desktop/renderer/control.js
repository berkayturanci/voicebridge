"use strict";

const $ = (id) => document.getElementById(id);
let current = null;
let networkRefreshTimer = null;

function setText(id, value) {
  $(id).textContent = value || "-";
}

function agentLabel(id) {
  const found = (current && current.agents || []).find((a) => a.id === id);
  return found ? found.label : id || "-";
}

function setRunning(value) {
  const status = typeof value === "object" && value !== null ? value : { running: !!value };
  const running = !!status.running;
  const processRunning = !!status.processRunning;
  const pill = $("pill");
  pill.classList.remove("on", "warn", "err");
  if (running) {
    pill.textContent = "Running";
    pill.classList.add("on");
  } else if (status.status === "starting") {
    pill.textContent = "Starting";
    pill.classList.add("warn");
  } else if (status.status === "error") {
    pill.textContent = "Error";
    pill.classList.add("err");
  } else {
    pill.textContent = "Stopped";
  }
  $("toggle").textContent = processRunning ? "Stop" : "Start";
  $("open").disabled = !running;
}

function renderBridgeState(state, running) {
  const phase = (state && state.phase) || (running ? "running" : "stopped");
  const message = (state && state.message) || (running ? "Bridge is running." : "Bridge is stopped.");
  const bridgePill = $("bridgePill");
  const diagnostic = $("bridgeDiagnostic");
  bridgePill.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
  bridgePill.classList.toggle("on", phase === "running");
  bridgePill.classList.toggle("warn", phase === "starting");
  bridgePill.classList.toggle("err", phase === "error");
  diagnostic.textContent = message;
  diagnostic.classList.toggle("good", phase === "running");
  diagnostic.classList.toggle("bad", phase === "error");
  $("toggle").disabled = phase === "starting";
  if (phase === "starting") $("toggle").textContent = "Starting";
}

function appendLog(line) {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  el.textContent += line + "\n";
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function fillAgentSelect(select, value) {
  select.textContent = "";
  for (const agent of current.agents || []) {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.label + (agent.available ? "" : " (missing CLI)");
    select.appendChild(option);
  }
  select.value = value || "claude";
}

function renderAgentAvailability() {
  const wrap = $("agentAvailability");
  wrap.textContent = "";
  for (const agent of current.agents || []) {
    const tag = document.createElement("span");
    tag.className = "tag" + (agent.available ? " on" : " warn");
    tag.textContent = (agent.available ? "Available: " : "Missing: ") + agent.label;
    wrap.appendChild(tag);
  }
}

function tokenFingerprint(token) {
  if (!token) return "No token";
  return "Token ready: " + token.slice(0, 4) + "..." + token.slice(-4);
}

function tokenStorageLabel(storage) {
  if (!storage) return "";
  return storage.secure ? "stored in " + storage.backend : "stored in " + storage.backend;
}

function mobileSummary(state) {
  if (!state || !state.lastSeen) return "No mobile seen";
  const agoMs = Number(state.lastSeenAgoMs || 0);
  const seconds = Math.max(1, Math.round(agoMs / 1000));
  const age = seconds < 60 ? seconds + "s ago" : Math.round(seconds / 60) + "m ago";
  return (state.connected ? "Connected" : "Last seen") + " / " + age;
}

function currentSettings(prefix) {
  return {
    port: parseInt($(prefix + "Port").value, 10) || 8787,
    host: $(prefix + "Host").value.trim() || "127.0.0.1",
    publicUrl: $(prefix + "PublicUrl").value.trim(),
    projectDir: $(prefix + "Project").value.trim(),
    agent: $(prefix + "Agent").value || "claude",
  };
}

function controlSettings() {
  return {
    port: parseInt($("port").value, 10) || 8787,
    host: $("host").value.trim() || "127.0.0.1",
    publicUrl: $("publicUrl").value.trim(),
    projectDir: $("projectDir").value.trim(),
    agent: $("agent").value || "claude",
  };
}

function validateSetup(settings) {
  if (!settings.projectDir) return "Choose a project folder first.";
  if (!settings.agent) return "Choose an agent mode.";
  if (settings.port < 1 || settings.port > 65535) return "Choose a valid port.";
  return "";
}

function renderStatus(s) {
  current = s;
  const settings = s.settings || {};
  const showWizard = !(s.setup && s.setup.complete);
  $("wizard").classList.toggle("hidden", !showWizard);
  $("control").classList.toggle("hidden", showWizard);

  $("port").value = settings.port || 8787;
  $("host").value = settings.host || "127.0.0.1";
  $("publicUrl").value = settings.publicUrl || "";
  $("projectDir").value = settings.projectDir || "";

  $("setupPort").value = settings.port || 8787;
  $("setupHost").value = settings.host || "127.0.0.1";
  $("setupPublicUrl").value = settings.publicUrl || "";
  $("setupProject").value = settings.projectDir || "";
  setText("setupTokenStatus", tokenFingerprint(settings.token) + " / " + tokenStorageLabel(s.tokenStorage));

  fillAgentSelect($("agent"), settings.agent);
  fillAgentSelect($("setupAgent"), settings.agent);
  renderAgentAvailability();

  setText("url", s.url);
  setText("mobileUrl", s.mobileUrl);
  setText("mobileSummary", mobileSummary(s.mobileState));
  $("pairingQr").src = s.pairingQrDataUrl || "";
  $("pairingQr").classList.toggle("empty", !s.pairingQrDataUrl);
  setText("projectSummary", settings.projectDir || "No project selected");
  setText("agentSummary", agentLabel(settings.agent));
  setText("pairingPreview", JSON.stringify({
    schema: "voicebridge.pairing",
    version: 1,
    bridgeUrl: s.mobileUrl,
    token: settings.token ? "<hidden>" : "",
    projectLabel: s.pairingPayload && s.pairingPayload.projectLabel,
    agent: settings.agent,
  }, null, 2));

  $("log").textContent = (s.logs || []).join("\n") + (s.logs && s.logs.length ? "\n" : "");
  $("log").scrollTop = $("log").scrollHeight;
  setRunning(s);
  renderBridgeState(s.bridgeState, s.running);
}

function renderNetwork(n) {
  const tailscale = n.tailscale || {};
  const health = n.health || {};
  const networkPill = $("networkPill");
  const tailscaleText = tailscale.message || (!tailscale.installed
    ? "Tailscale CLI not found"
    : tailscale.running
      ? "Online" + (tailscale.dnsName ? " / " + tailscale.dnsName : "")
      : "Installed, not online");
  const healthText = health.message || (!health.configured
    ? "Public URL missing"
    : health.ok
      ? "OK"
      : "Failed" + (health.status ? " (" + health.status + ")" : ""));

  setText("tailscaleStatus", tailscaleText);
  setText("publicHealth", healthText);
  setText("serveCommand", n.serveCommand);
  networkPill.textContent = health.ok
    ? "Ready"
    : health.category === "auth"
      ? "Token"
      : health.category === "missing_url" && tailscale.running
        ? "Needs URL"
        : tailscale.running
          ? "Verify"
          : "Manual setup";
  networkPill.classList.toggle("on", !!health.ok);
  networkPill.classList.toggle("warn", !health.ok);
}

async function refreshNetwork() {
  try {
    renderNetwork(await window.vb.networkStatus());
  } catch (_) {
    renderNetwork({ tailscale: { installed: false, running: false }, health: { configured: false }, serveCommand: "-" });
  }
}

async function refresh() {
  renderStatus(await window.vb.getStatus());
  refreshInfo();
  clearTimeout(networkRefreshTimer);
  networkRefreshTimer = setTimeout(refreshNetwork, 100);
}

// Agents + active sessions, pulled from the running bridge.
async function refreshInfo() {
  const info = await window.vb.info();
  const ag = $("agents");
  ag.textContent = "";
  const agents = info.agents || [];
  if (!agents.length) { ag.innerHTML = '<span class="tag">-</span>'; }
  agents.forEach((a) => {
    const t = document.createElement("span");
    t.className = "tag" + (a.available ? " on" : "");
    t.textContent = (a.available ? "Available: " : "Missing: ") + (a.label || a.id);
    ag.appendChild(t);
  });
  const se = $("sessions");
  se.textContent = "";
  const sessions = info.sessions || [];
  if (!sessions.length) { se.innerHTML = '<div class="sess">-</div>'; return; }
  sessions.forEach((x) => {
    const d = document.createElement("div");
    d.className = "sess";
    const bits = [x.agentLabel || x.agent, x.mode].filter(Boolean);
    if (x.runner === "cloud") bits.push("cloud");
    d.textContent = x.name + " (" + bits.join(" / ") + ")";
    se.appendChild(d);
  });
}

async function chooseProject(targetId) {
  const folder = await window.vb.chooseProject();
  if (folder) $(targetId).value = folder;
}

$("setupChooseProject").addEventListener("click", () => chooseProject("setupProject"));
$("chooseProject").addEventListener("click", () => chooseProject("projectDir"));

$("regenSetupToken").addEventListener("click", async () => {
  const token = await window.vb.generateToken();
  await window.vb.saveSettings({ token });
  await refresh();
});

$("regenToken").addEventListener("click", async () => {
  if (!confirm("Regenerate the access token? Existing phone pairing details will stop working.")) return;
  const token = await window.vb.generateToken();
  await window.vb.saveSettings({ token });
  await window.vb.restart();
  setTimeout(refresh, 400);
});

$("finishSetup").addEventListener("click", async () => {
  const next = currentSettings("setup");
  const error = validateSetup(next);
  $("setupError").textContent = error;
  if (error) return;
  await window.vb.saveSettings({ ...next, setupComplete: true });
  await window.vb.start();
  setTimeout(refresh, 500);
});

$("apply").addEventListener("click", async () => {
  await window.vb.saveSettings(controlSettings());
  await window.vb.restart();
  setTimeout(refresh, 400);
});

$("toggle").addEventListener("click", async () => {
  const s = await window.vb.getStatus();
  if (s.processRunning) await window.vb.stop();
  else {
    await window.vb.saveSettings(controlSettings());
    await window.vb.start();
  }
  setTimeout(refresh, 400);
});

$("open").addEventListener("click", () => window.vb.openWeb());

$("copyPairing").addEventListener("click", async () => {
  await window.vb.copyPairing();
});

$("copyMobileUrl").addEventListener("click", async () => {
  await window.vb.copyMobileUrl();
});

$("copyServeCommand").addEventListener("click", async () => {
  await window.vb.copyServeCommand();
});

$("verifyPublicUrl").addEventListener("click", async () => {
  renderNetwork({ ...(await window.vb.networkStatus()), health: await window.vb.verifyPublicUrl() });
});

$("refreshNetwork").addEventListener("click", refreshNetwork);

window.vb.onLog(appendLog);
window.vb.onStatus(() => { refresh(); });

refresh();
setInterval(refreshInfo, 4000);
