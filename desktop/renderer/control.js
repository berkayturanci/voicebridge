"use strict";
const $ = (id) => document.getElementById(id);

function setRunning(value) {
  const status = typeof value === "object" && value !== null ? value : { running: !!value };
  const running = !!status.running;
  const processRunning = !!status.processRunning;
  const pill = $("pill");
  pill.classList.remove("on", "warn", "err");
  if (running) {
    pill.textContent = "● Running";
    pill.classList.add("on");
  } else if (status.status === "starting") {
    pill.textContent = "◌ Starting";
    pill.classList.add("warn");
  } else if (status.status === "error") {
    pill.textContent = "⚠ Error";
    pill.classList.add("err");
  } else {
    pill.textContent = "○ Stopped";
  }
  $("toggle").textContent = processRunning ? "Stop" : "Start";
  $("open").disabled = !running;
  const err = $("bridgeError");
  err.textContent = status.error || "";
  err.classList.toggle("on", !!status.error);
}

function appendLog(line) {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  el.textContent += line + "\n";
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function refresh() {
  const s = await window.vb.getStatus();
  $("port").value = s.settings.port || 8787;
  $("host").value = s.settings.host || "127.0.0.1";
  $("token").value = s.settings.token || "";
  $("url").textContent = s.url;
  $("log").textContent = (s.logs || []).join("\n") + (s.logs && s.logs.length ? "\n" : "");
  $("log").scrollTop = $("log").scrollHeight;
  setRunning(s);
  refreshInfo();
}

// Agents + active sessions, pulled from the running bridge.
async function refreshInfo() {
  const info = await window.vb.info();
  const ag = $("agents");
  ag.textContent = "";
  const agents = info.agents || [];
  if (!agents.length) { ag.innerHTML = '<span class="tag">—</span>'; }
  agents.forEach((a) => {
    const t = document.createElement("span");
    t.className = "tag" + (a.available ? " on" : "");
    t.textContent = (a.available ? "● " : "○ ") + (a.label || a.id);
    ag.appendChild(t);
  });
  const se = $("sessions");
  se.textContent = "";
  const sessions = info.sessions || [];
  if (!sessions.length) { se.innerHTML = '<div class="sess">—</div>'; return; }
  sessions.forEach((x) => {
    const d = document.createElement("div");
    d.className = "sess";
    const bits = [x.agentLabel || x.agent, x.mode].filter(Boolean);
    if (x.runner === "cloud") bits.push("☁️");
    d.textContent = "• " + x.name + "  (" + bits.join(" · ") + ")";
    se.appendChild(d);
  });
}

function currentSettings() {
  return {
    port: parseInt($("port").value, 10) || 8787,
    host: $("host").value.trim() || "127.0.0.1",
    token: $("token").value.trim(),
  };
}

$("gen").addEventListener("click", async () => {
  $("token").value = await window.vb.generateToken();
});
$("apply").addEventListener("click", async () => {
  await window.vb.saveSettings(currentSettings());
  await window.vb.restart();
  setTimeout(refresh, 400);
});
$("toggle").addEventListener("click", async () => {
  const s = await window.vb.getStatus();
  if (s.processRunning) await window.vb.stop();
  else { await window.vb.saveSettings(currentSettings()); await window.vb.start(); }
  setTimeout(refresh, 400);
});
$("open").addEventListener("click", () => window.vb.openWeb());

window.vb.onLog(appendLog);
window.vb.onStatus((status) => { setRunning(status); refresh(); });

refresh();
setInterval(refreshInfo, 4000); // keep the agents/sessions panel live
