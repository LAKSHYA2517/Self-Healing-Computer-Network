const COLORS = { gray: "#9e9e9e", green: "#2e7d32", red: "#d32f2f" };
let topo, state, network, nodes, edges, selected = null;

const api = (path, body) =>
  fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(async r => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  });

function setup() {
  nodes = new vis.DataSet(topo.nodes.map(n => ({
    id: n.id, x: n.x, y: n.y, shape: "circle", font: { size: 14 },
    label: n.id === topo.source ? n.id + "\n(src)" : n.id === topo.destination ? n.id + "\n(dst)" : n.id,
  })));
  edges = new vis.DataSet(topo.links.map(l => ({
    id: l.id, from: l.a, to: l.b, label: l.latency + " ms", font: { size: 11, align: "middle" },
  })));
  network = new vis.Network(document.getElementById("graph"), { nodes, edges }, {
    physics: false, interaction: { dragNodes: false },
  });
  network.on("click", p => {
    selected = p.edges.length && !p.nodes.length ? { type: "link", id: p.edges[0] }
      : p.nodes.length ? { type: "node", id: p.nodes[0] } : null;
    render();
  });
  const opt = id => `<option>${id}</option>`;
  const link_sel = document.getElementById("link-sel");
  link_sel.innerHTML = topo.links.map(l => opt(l.id)).join("");
  document.getElementById("node-sel").innerHTML = topo.nodes.map(n => opt(n.id)).join("");
}

const nodeFailed = id => state.failed_nodes.includes(id);
const linkDown = l => state.failed_links.includes(l.id) || nodeFailed(l.a) || nodeFailed(l.b);

function renderGraph() {
  const base = new Set(state.baseline_path.links);
  const broken = state.route_status === "BROKEN";
  nodes.update(topo.nodes.map(n => {
    const f = nodeFailed(n.id);
    const endpoint = n.id === topo.source || n.id === topo.destination;
    return {
      id: n.id,
      color: { background: f ? "#ef9a9a" : endpoint ? "#bbdefb" : "#e0e0e0",
               border: f ? COLORS.red : "#616161" },
      label: (f ? "✕ " : "") + nodes.get(n.id).label.replace(/^✕ /, ""),
      borderWidth: f ? 3 : 1,
    };
  }));
  edges.update(topo.links.map(l => {
    const down = linkDown(l), onBase = base.has(l.id);
    let color = COLORS.gray, width = 1.5, dashes = false;
    if (down) { color = COLORS.red; dashes = true; }
    if (onBase && !broken) { color = COLORS.green; width = 5; }
    if (onBase && broken) { color = COLORS.red; width = 5; dashes = down; }
    return { id: l.id, color: { color }, width, dashes };
  }));
}

function renderBanner() {
  const b = document.getElementById("banner"), p = state.baseline_path;
  const ok = state.route_status === "OK";
  b.className = ok ? "ok" : "broken";
  b.textContent = ok ? `ROUTE OK: ${p.nodes.join(" -> ")} (cost ${p.cost})`
                     : "ROUTE BROKEN: baseline path invalid";
}

const fmt = (v, d = 1) => v == null ? "–" : v.toFixed(d);

function renderTable() {
  document.querySelector("#metrics tbody").innerHTML = topo.links.map(l => {
    const m = state.link_metrics[l.id] || { status: "…" };
    const cls = [m.status === "down" ? "down" : "", selected?.id === l.id ? "sel" : ""].join(" ");
    return `<tr class="${cls}"><td>${l.id}</td><td>${l.a}-${l.b}</td><td>${m.status}</td>` +
      `<td>${fmt(m.latency_ms)}</td><td>${fmt(m.loss_pct)}</td><td>${fmt(m.util_pct, 0)}</td></tr>`;
  }).join("");
}

function sparkline(vals) {
  const pts = vals.filter(v => v != null);
  if (pts.length < 2) return "";
  const max = Math.max(...pts), min = Math.min(...pts), w = 200, h = 30;
  const d = vals.map((v, i) => v == null ? null : `${(i / (vals.length - 1) * w).toFixed(1)},` +
    `${(h - (max === min ? h / 2 : (v - min) / (max - min) * h)).toFixed(1)}`).filter(Boolean).join(" ");
  return `<svg class="spark" width="${w}" height="${h}"><polyline points="${d}" fill="none" stroke="#1565c0"/></svg>`;
}

function renderSelected() {
  const el = document.getElementById("selected");
  if (!selected) { el.textContent = "Click a link or router to inspect it."; return; }
  if (selected.type === "node") {
    el.innerHTML = `<b>Router ${selected.id}</b>: ${nodeFailed(selected.id) ? "FAILED" : "up"}`;
    return;
  }
  const l = topo.links.find(x => x.id === selected.id), m = state.link_metrics[l.id];
  el.innerHTML = `<b>Link ${l.id}</b> (${l.a}-${l.b}, base ${l.latency} ms, ${l.bw} Mbps)` + (m
    ? `<br>${m.status} · latency ${fmt(m.latency_ms)} ms · loss ${fmt(m.loss_pct)}% · util ${fmt(m.util_pct, 0)}%`
      + sparkline(state.history[l.id]) : "");
}

function renderEvents() {
  document.getElementById("events").innerHTML = state.events.slice(-15).reverse().map(e =>
    `<li class="${e.level}">${new Date(e.ts * 1000).toLocaleTimeString()} ${e.level} ${e.message}</li>`).join("");
}

function render() {
  if (!state) return;
  renderGraph(); renderBanner(); renderTable(); renderSelected(); renderEvents();
}

async function poll() {
  try {
    state = await api("/api/state");
    document.getElementById("conn").hidden = true;
    render();
  } catch {
    document.getElementById("conn").hidden = false;
  }
}

async function act(path, body) {
  try { state = await api(path, body); render(); } catch (e) { alert(e.message); }
}

document.querySelectorAll("button[data-act]").forEach(b => b.onclick = () =>
  act("/api/" + b.dataset.act, { type: b.dataset.type,
    id: document.getElementById(b.dataset.type + "-sel").value }));
document.getElementById("reset").onclick = () => act("/api/reset", {});

(async function init() {
  while (!topo) {
    try { topo = await api("/api/topology"); } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  setup();
  await poll();
  setInterval(poll, 1000);
})();
