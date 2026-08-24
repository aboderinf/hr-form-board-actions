const labState = {
  period: "rolling_14d",
  view: "1117",
};

let discoveryPayload = null;
let loadingPromise = null;

const checkpointLabels = {
  "0817": "8:17 AM",
  "1117": "11:17 AM",
  "1717": "5:17 PM",
  "2017": "8:17 PM",
};

const periodLabels = {
  rolling_14d: "Last 14 days",
  calendar_month: "This month",
  all_time: "All archived",
};

function pct(value, signed = false) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Number(value) * 100;
  return `${signed && n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function units(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}u`;
}

function american(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Math.round(Number(value));
  return n > 0 ? `+${n}` : String(n);
}

function esc(value) {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function samplePill(row = {}) {
  const status = row.sample_status || "small sample";
  return `<span class="pill">${esc(status)} · ${Number(row.settled || 0)} bets / ${Number(row.slates || 0)} slates</span>`;
}

function summaryCards(summary = {}) {
  return `<div class="grid4 discovery-lab-metrics">
    <div class="card"><div class="metric"><strong>${Number(summary.wins || 0)}–${Number(summary.losses || 0)}</strong><span>Record</span></div></div>
    <div class="card"><div class="metric"><strong>${pct(summary.hit_rate)}</strong><span>Hit rate</span></div></div>
    <div class="card"><div class="metric"><strong>${pct(summary.market_break_even_hit_rate)}</strong><span>Market break-even</span></div></div>
    <div class="card"><div class="metric"><strong>${pct(summary.hit_rate_edge, true)}</strong><span>Hit-rate edge</span></div></div>
    <div class="card"><div class="metric"><strong>${units(summary.net_units)}</strong><span>Net units</span></div></div>
    <div class="card"><div class="metric"><strong>${pct(summary.roi, true)}</strong><span>ROI</span></div></div>
    <div class="card"><div class="metric"><strong>${american(summary.average_odds)}</strong><span>Average price</span></div></div>
    <div class="card"><div class="metric"><strong>${Number(summary.slates || 0)}</strong><span>Settled slates</span></div></div>
  </div>`;
}

function segmentTable(rows = [], title = "Segments", limit = 18) {
  const ordered = [...rows]
    .filter((row) => Number(row.settled || 0) > 0)
    .sort((a, b) => Number(b.net_units || 0) - Number(a.net_units || 0) || Number(b.settled || 0) - Number(a.settled || 0))
    .slice(0, limit);
  if (!ordered.length) return `<div class="empty">No settled rows for this checkpoint yet.</div>`;
  return `<div class="tablewrap"><table>
    <thead><tr><th>${esc(title)}</th><th>Bets</th><th>Record</th><th>Hit rate</th><th>Break-even</th><th>Edge</th><th>Avg odds</th><th>Net</th><th>ROI</th><th>Evidence</th></tr></thead>
    <tbody>${ordered.map((row) => `<tr>
      <td><b>${esc(row.label)}</b></td>
      <td>${Number(row.settled || 0)}</td>
      <td>${Number(row.wins || 0)}–${Number(row.losses || 0)}</td>
      <td>${pct(row.hit_rate)}</td>
      <td>${pct(row.market_break_even_hit_rate)}</td>
      <td class="${Number(row.hit_rate_edge || 0) >= 0 ? "plus" : "loss"}">${pct(row.hit_rate_edge, true)}</td>
      <td>${american(row.average_odds)}</td>
      <td class="${Number(row.net_units || 0) >= 0 ? "plus" : "loss"}">${units(row.net_units)}</td>
      <td class="${Number(row.roi || 0) >= 0 ? "plus" : "loss"}">${pct(row.roi, true)}</td>
      <td>${samplePill(row)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function checkpointTable(rows = []) {
  return `<div class="tablewrap"><table>
    <thead><tr><th>Checkpoint</th><th>Bets</th><th>Slates</th><th>Record</th><th>Hit rate</th><th>Break-even</th><th>Edge</th><th>Net</th><th>ROI</th></tr></thead>
    <tbody>${rows.map((row) => `<tr data-jump-checkpoint="${esc(row.label)}" class="checkpoint-jump-row">
      <td><b>${esc(checkpointLabels[row.label] || row.label)}</b></td>
      <td>${Number(row.settled || 0)}</td>
      <td>${Number(row.slates || 0)}</td>
      <td>${Number(row.wins || 0)}–${Number(row.losses || 0)}</td>
      <td>${pct(row.hit_rate)}</td>
      <td>${pct(row.market_break_even_hit_rate)}</td>
      <td class="${Number(row.hit_rate_edge || 0) >= 0 ? "plus" : "loss"}">${pct(row.hit_rate_edge, true)}</td>
      <td class="${Number(row.net_units || 0) >= 0 ? "plus" : "loss"}">${units(row.net_units)}</td>
      <td class="${Number(row.roi || 0) >= 0 ? "plus" : "loss"}">${pct(row.roi, true)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function edgeTable(report = {}) {
  const isBenchmark = labState.view === "best";
  let rows = (report.edges || []).filter((row) => isBenchmark
    ? row.basis === "archive-best benchmark"
    : row.basis === "fixed-checkpoint strategy" && String(row.rule || "").startsWith(labState.view));
  rows = rows.slice(0, 20);
  if (!rows.length) return `<div class="empty">No segment clears the evidence gate in this checkpoint view yet. That is useful evidence too—do not force an edge.</div>`;
  return `<div class="tablewrap"><table>
    <thead><tr><th>Dimension</th><th>Rule</th><th>Bets</th><th>Slates</th><th>Hit rate</th><th>Break-even</th><th>Net</th><th>ROI</th><th>Evidence</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td>${esc(row.dimension)}</td><td><b>${esc(row.rule)}</b></td><td>${Number(row.settled || 0)}</td><td>${Number(row.slates || 0)}</td>
      <td>${pct(row.hit_rate)}</td><td>${pct(row.market_break_even_hit_rate)}</td>
      <td class="plus">${units(row.net_units)}</td><td class="plus">${pct(row.roi, true)}</td><td>${samplePill(row)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function tabButton(label, attr, value, active) {
  return `<button type="button" ${attr}="${esc(value)}" class="${active ? "active" : ""}">${esc(label)}</button>`;
}

function checkpointTabs() {
  return `<div class="checkpoint-tab-wrap">
    <div class="muted discovery-lab-label">Checkpoint</div>
    <div class="tabs checkpoint-tabs">
      ${tabButton("Best archived", "data-lab-view", "best", labState.view === "best")}
      ${Object.entries(checkpointLabels).map(([value, label]) => tabButton(label, "data-lab-view", value, labState.view === value)).join("")}
    </div>
  </div>`;
}

function renderLab(root) {
  const report = discoveryPayload?.reports?.[labState.period];
  if (!report) {
    root.innerHTML = `<div class="empty">Checkpoint-aware Discovery data is rebuilding. The page will populate after the Discovery workflow finishes.</div>`;
    return;
  }

  const isBenchmark = labState.view === "best";
  const detail = isBenchmark ? report : report.checkpoint_details?.[labState.view] || {};
  const viewTitle = isBenchmark ? "Best archived price" : `${checkpointLabels[labState.view] || labState.view} checkpoint`;
  const viewNote = isBenchmark
    ? "Best price seen across the day, once per player-game. This is a hindsight benchmark for discovering structure, not an executable timing rule."
    : `Every metric and segment below now uses only the immutable ${checkpointLabels[labState.view] || labState.view} ET capture. Switching tabs re-runs the whole Discovery view on that checkpoint.`;

  root.innerHTML = `
    <div class="eyebrow">Checkpoint Discovery</div>
    <h2>HR Discovery by checkpoint</h2>
    <p class="muted">Use the checkpoint tabs to compare the same score, price and sportsbook relationships at each daily capture.</p>

    ${checkpointTabs()}

    <div class="discovery-lab-controls">
      <div><div class="muted discovery-lab-label">Period</div><div class="tabs">${Object.entries(periodLabels).map(([value, label]) => tabButton(label, "data-lab-period", value, labState.period === value)).join("")}</div></div>
    </div>

    <div class="notice"><b>${esc(viewTitle)}:</b> ${esc(viewNote)}</div>
    <p>${samplePill(detail.overall || {})}</p>
    ${summaryCards(detail.overall || {})}

    <div class="eyebrow">Intersection search</div><h3>Form score × odds</h3>
    <p class="muted">Shows whether a form-score band is profitable only inside particular price bands at the selected checkpoint.</p>
    ${segmentTable(detail.score_odds || [], "Score × odds")}

    <div class="eyebrow">Sportsbook attribution</div><h3>Best book × odds × form score</h3>
    <p class="muted">Shows whether FanDuel, DraftKings, or BetMGM offering the best price matters at this specific checkpoint.</p>
    ${segmentTable(detail.book_odds_score || [], "Book × odds × score")}

    <div class="eyebrow">Evidence-gated candidates</div><h3>Segments worth following prospectively</h3>
    <p class="muted">Gate: at least 40 settled bets, 4 wins, 5 slates, and positive net units. These are exploratory candidates, not proof of a durable edge.</p>
    ${edgeTable(report)}

    <div class="eyebrow">Cross-check</div><h3>All checkpoint performance</h3>
    <p class="muted">Click any row to jump directly to that checkpoint tab.</p>
    ${checkpointTable(report.checkpoint_strategies || [])}

    <div class="notice discovery-lab-warning"><b>No fake fair odds:</b> HR Form Score is a recency/form index, not a calibrated home-run probability. Fair odds and expected EV are intentionally withheld until probability calibration is validated out of sample.</div>
  `;

  root.querySelectorAll("[data-lab-period]").forEach((button) => button.addEventListener("click", () => {
    labState.period = button.dataset.labPeriod;
    renderLab(root);
  }));
  root.querySelectorAll("[data-lab-view]").forEach((button) => button.addEventListener("click", () => {
    labState.view = button.dataset.labView;
    renderLab(root);
  }));
  root.querySelectorAll("[data-jump-checkpoint]").forEach((row) => row.addEventListener("click", () => {
    labState.view = row.dataset.jumpCheckpoint;
    renderLab(root);
    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

async function loadDiscovery() {
  if (discoveryPayload) return discoveryPayload;
  if (!loadingPromise) {
    loadingPromise = fetch("/data/discovery.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        discoveryPayload = payload;
        return payload;
      })
      .catch(() => null);
  }
  return loadingPromise;
}

async function enhanceDiscovery() {
  if ((location.hash.slice(1) || "today") !== "discovery") return;
  const shell = document.querySelector("#app .shell");
  if (!shell || document.getElementById("hr-discovery-strategy-lab")) return;
  await loadDiscovery();
  if ((location.hash.slice(1) || "today") !== "discovery") return;
  const currentShell = document.querySelector("#app .shell");
  if (!currentShell || document.getElementById("hr-discovery-strategy-lab")) return;

  const root = document.createElement("section");
  root.id = "hr-discovery-strategy-lab";
  root.className = "card section discovery-lab";
  const hero = currentShell.querySelector(".hero");
  if (hero) hero.insertAdjacentElement("afterend", root);
  else currentShell.insertBefore(root, currentShell.querySelector("footer"));
  renderLab(root);
}

const style = document.createElement("style");
style.textContent = `
  .checkpoint-tab-wrap{margin:18px 0 8px;padding-bottom:14px;border-bottom:1px solid var(--line,#e5e7eb)}
  .checkpoint-tabs{display:flex;flex-wrap:wrap;gap:8px}
  .checkpoint-tabs button{font-weight:700}
  .discovery-lab-controls{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;margin:12px 0 16px}
  .discovery-lab-label{font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
  .discovery-lab-metrics{margin:14px 0 24px}
  .discovery-lab h3{margin:8px 0 10px}
  .discovery-lab .eyebrow{margin-top:24px}
  .discovery-lab .eyebrow:first-child{margin-top:0}
  .discovery-lab-warning{margin-top:22px}
  .checkpoint-jump-row{cursor:pointer}
  .checkpoint-jump-row:hover td{background:rgba(127,127,127,.08)}
  @media (max-width:700px){
    .discovery-lab-controls{display:block}
    .discovery-lab-controls>div{margin:12px 0}
    .checkpoint-tabs,.discovery-lab .tabs{overflow-x:auto;flex-wrap:nowrap;padding-bottom:4px}
    .checkpoint-tabs button,.discovery-lab .tabs button{white-space:nowrap}
  }
`;
document.head.appendChild(style);

const app = document.getElementById("app");
if (app) {
  const observer = new MutationObserver(() => {
    if (!document.getElementById("hr-discovery-strategy-lab")) enhanceDiscovery();
  });
  observer.observe(app, { childList: true, subtree: true });
}
addEventListener("hashchange", () => setTimeout(enhanceDiscovery, 0));
enhanceDiscovery();
