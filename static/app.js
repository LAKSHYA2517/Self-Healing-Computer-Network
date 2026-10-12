const C = { gray: "#9e9e9e", amber: "#ef8f00", red: "#d32f2f", blue: "#1565c0", purple: "#7b1fa2" };
let topo, state, network, nodes, edges, selected = null, charts = {}, summaryShown = false;

const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => v == null ? "–" : Number(v).toFixed(d);

const api = (path, body) =>
  fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(async r => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  });

function setupGraph() {
  nodes = new vis.DataSet(topo.nodes.map(n => ({
    id: n.id, x: n.x, y: n.y, shape: "circle", font: { size: 14 },
    label: n.id === topo.source ? n.id + "\n(src)" : n.id === topo.destination ? n.id + "\n(dst)" : n.id,
  })));
  edges = new vis.DataSet(topo.links.map(l => ({
    id: l.id, from: l.a, to: l.b, label: l.latency + " ms", font: { size: 11, align: "middle" },
  })));
  network = new vis.Network($("graph"), { nodes, edges }, {
    physics: false, interaction: { dragNodes: false },
  });
  network.on("click", p => {
    selected = p.nodes.length ? { type: "node", id: p.nodes[0] }
      : p.edges.length ? { type: "link", id: p.edges[0] } : null;
    if (selected) $(selected.type + "-sel").value = selected.id;
    render();
  });
  const opts = items => items.map(i => `<option>${i.id}</option>`).join("");
  $("link-sel").innerHTML = opts(topo.links);
  $("node-sel").innerHTML = opts(topo.nodes);
}

function lineChart(id, title, yMax) {
  const ds = (label, color, dash) => ({ label, data: [], borderColor: color, borderWidth: 2,
    borderDash: dash, pointRadius: 0, spanGaps: false, tension: 0 });
  return new Chart($(id), {
    type: "line",
    data: { labels: [], datasets: [ds("Static", C.purple, [6, 4]), ds("Self-healing", C.blue, [])] },
    options: {
      animation: false, maintainAspectRatio: false,
      plugins: { title: { display: true, text: title }, legend: { position: "bottom", labels: { boxWidth: 12 } } },
      scales: { y: { beginAtZero: true, suggestedMax: yMax }, x: { ticks: { maxTicksLimit: 8 } } },
    },
  });
}

function renderCharts() {
  const s = state.series.static, h = state.series.healing;
  const labels = h.map(r => r.tick);
  for (const [id, key] of [["delivery", "delivery_pct"], ["delay", "delay_ms"]]) {
    const c = charts[id];
    c.data.labels = labels;
    c.data.datasets[0].data = s.map(r => r[key]);
    c.data.datasets[1].data = h.map(r => r[key]);
    c.update("none");
  }
}

function renderKpis() {
  for (const [flow, title] of [["static", "Static routing"], ["healing", "Self-healing"]]) {
    const k = state.kpis[flow], el = $("kpi-" + flow);
    const down = k.available === false;
    el.className = "kpi" + (down ? " bad" : "");
    const cell = (label, v) => `<div><small>${label}</small><b>${v}</b></div>`;
    el.innerHTML = `<h2>${title}${down ? " — UNAVAILABLE" : ""}</h2><div class="vals">` +
      cell("Delivery", fmt(k.delivery_pct, 0) + "%") + cell("Delay", fmt(k.delay_ms) + " ms") +
      cell("Throughput", fmt(k.throughput_mbps, 0) + " Mbps") + cell("Lost", k.lost_packets) +
      cell("Route changes", k.route_changes) + cell("Availability", fmt(k.availability_pct) + "%") +
      "</div>" + (flow === "healing" && k.last_recovery_ticks != null
        ? `<small>Last recovery: ${k.last_recovery_ticks} ticks</small>` : "");
  }
}

function renderGraph() {
  const dead = new Set(state.dead_nodes);
  const heal = new Set(state.healing_path ? state.healing_path.links : []);
  const stat = new Set(state.static_path.links);
  nodes.update(topo.nodes.map(n => {
    const f = dead.has(n.id), end = n.id === topo.source || n.id === topo.destination;
    const base = nodes.get(n.id).label.replace(/^✕ /, "");
    return { id: n.id, label: (f ? "✕ " : "") + base, borderWidth: f ? 3 : 1,
      color: { background: f ? "#ef9a9a" : end ? "#bbdefb" : "#e0e0e0", border: f ? C.red : "#616161" } };
  }));
  edges.update(topo.links.map(l => {
    const h = (state.link_health[l.id] || {}).health || "healthy";
    let color = C.gray, width = 1.5, dashes = false;
    if (h === "degraded") { color = C.amber; width = 2.5; dashes = [2, 5]; }
    if (h === "down") { color = C.red; width = 2.5; dashes = [8, 6]; }
    if (stat.has(l.id)) { width = 5; dashes = [10, 6]; color = h === "down" ? C.red : C.purple; }
    if (heal.has(l.id)) { width = 5; dashes = false; color = C.blue; }
    return { id: l.id, color: { color }, width, dashes };
  }));
}

function renderControls() {
  const sc = state.scenario;
  $("sc-progress").max = sc.duration || 1;
  $("sc-progress").value = sc.running || sc.finished ? Math.min(state.tick, sc.duration) : 0;
  $("sc-label").textContent = sc.running ? `${sc.name}: ${state.tick}/${sc.duration}`
    : sc.finished ? `${sc.name}: finished` : "idle";
  $("tick").textContent = state.tick;
}

function renderHealthTable() {
  $("health").querySelector("tbody").innerHTML = topo.links.map(l => {
    const h = state.link_health[l.id] || { health: "healthy", since: 0 };
    const m = state.link_metrics[l.id] || {};
    const cls = h.health + (selected && selected.id === l.id ? " sel" : "");
    const status = h.health + (h.reason ? ` (${h.reason})` : "");
    return `<tr class="${cls}"><td>${l.id}</td><td>${l.a}-${l.b}</td><td>${status}</td>` +
      `<td>${fmt(m.latency_ms)}</td><td>${fmt(m.loss_pct)}</td><td>${fmt(m.util_pct, 0)}</td><td>${h.since}</td></tr>`;
  }).join("");
}

function sparkline(vals) {
  const pts = vals.filter(v => v != null);
  if (pts.length < 2) return "";
  const max = Math.max(...pts), min = Math.min(...pts), w = 200, h = 30;
  const d = vals.map((v, i) => v == null ? null : `${(i / (vals.length - 1) * w).toFixed(1)},` +
    `${(h - (max === min ? h / 2 : (v - min) / (max - min) * h)).toFixed(1)}`).filter(Boolean).join(" ");
  return `<svg class="spark" width="${w}" height="${h}"><polyline points="${d}" fill="none" stroke="${C.blue}"/></svg>`;
}

function renderSelected() {
  const el = $("selected");
  if (!selected) { el.textContent = "Click a link or router to inspect it."; return; }
  if (selected.type === "node") {
    const dead = state.dead_nodes.includes(selected.id);
    el.innerHTML = `<b>Router ${selected.id}</b>: ${dead ? "detected DOWN" : "up"}`;
    return;
  }
  const l = topo.links.find(x => x.id === selected.id), m = state.link_metrics[l.id];
  const imp = state.impairments[l.id];
  el.innerHTML = `<b>Link ${l.id}</b> (${l.a}-${l.b}, base ${l.latency} ms, ${l.bw} Mbps)` +
    (m ? `<br>${m.status} · latency ${fmt(m.latency_ms)} ms · loss ${fmt(m.loss_pct)}% · util ${fmt(m.util_pct, 0)}%` +
      sparkline(state.history[l.id]) : "") +
    (imp ? `<br><small>injected: loss ${imp.loss_pct}%, util ${imp.util_pct ?? "–"}, latency x${imp.latency_mult}</small>` : "");
}

function renderEvents() {
  $("events").innerHTML = state.events.slice(-20).reverse().map(e =>
    `<li class="${e.level}">t=${e.tick} ${e.level} ${e.message}</li>`).join("");
}

async function showSummary() {
  try {
    const s = await api("/api/summary");
    const rows = [["Packets sent", "sent"], ["Packets lost", "lost"], ["Loss %", "loss_pct"],
      ["Outage ticks", "outage_ticks"], ["Availability %", "availability_pct"],
      ["Route changes", "route_changes"], ["Avg delay (ms)", "avg_delay_ms"],
      ["Avg throughput (Mbps)", "avg_throughput_mbps"]];
    let html = `<tr><th>Metric</th><th>Static</th><th>Self-healing</th></tr>` +
      rows.map(([label, k]) => `<tr><td>${label}</td><td>${fmt(s.static[k], 2).replace(/\.?0+$/, "")}</td>` +
        `<td>${fmt(s.healing[k], 2).replace(/\.?0+$/, "")}</td></tr>`).join("");
    for (const f of s.healing.faults) {
      html += `<tr><td colspan="3"><b>t=${f.fault_tick}</b> ${f.fault}</td></tr>` +
        `<tr><td>Detection (ticks)</td><td>–</td><td>${f.detection_ticks ?? "–"}</td></tr>` +
        `<tr><td>Recovery (ticks)</td><td>never</td><td>${f.recovery_ticks ?? "no reroute needed"}</td></tr>`;
    }
    $("summary-title").textContent = `Run summary (${s.ticks} ticks)`;
    $("summary-table").innerHTML = html;
    $("summary").hidden = false;
  } catch (e) { alert(e.message); }
}

function render() {
  if (!state) return;
  renderKpis(); renderGraph(); renderCharts(); renderControls();
  renderHealthTable(); renderSelected(); renderEvents();
  $("tick").textContent = state.tick;
  if (state.scenario.finished && !summaryShown) { summaryShown = true; showSummary(); }
  if (!state.scenario.finished) summaryShown = false;
}

async function poll() {
  try {
    state = await api("/api/state");
    $("conn").hidden = true;
    render();
  } catch {
    $("conn").hidden = false;
  }
}

async function act(path, body) {
  try { state = await api(path, body); render(); } catch (e) { alert(e.message); }
}

function wire() {
  document.querySelectorAll("button[data-act]").forEach(b => b.onclick = () =>
    act("/api/" + b.dataset.act, { type: b.dataset.type, id: $(b.dataset.type + "-sel").value }));
  const link = () => $("link-sel").value;
  $("degrade").onclick = () => act("/api/degrade", { id: link(), loss_pct: +$("loss").value });
  $("congest").onclick = () => act("/api/congest", { id: link(), util_pct: +$("util").value });
  $("clear").onclick = () => act("/api/clear", { id: link() });
  $("reset").onclick = () => act("/api/reset", {});
  $("loss").oninput = () => $("loss-v").textContent = $("loss").value;
  $("util").oninput = () => $("util-v").textContent = $("util").value;
  $("sc-run").onclick = () => { summaryShown = false; act("/api/scenario/start", { name: $("scenario-sel").value }); };
  $("sc-stop").onclick = () => act("/api/scenario/stop", {});
  $("show-summary").onclick = showSummary;
  $("summary-close").onclick = () => { $("summary").hidden = true; };
}

(async function init() {
  while (!topo) {
    try { topo = await api("/api/topology"); } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  setupGraph();
  charts.delivery = lineChart("chart-delivery", "Delivery % (last 120 ticks)", 100);
  charts.delay = lineChart("chart-delay", "End-to-end delay ms", 50);
  wire();
  try {
    const list = await api("/api/scenarios");
    $("scenario-sel").innerHTML = list.map(s => `<option value="${s.name}">${s.title} (${s.duration} ticks)</option>`).join("");
  } catch { /* scenarios list is optional for manual use */ }
  await poll();
  setInterval(poll, 1000);
})();
