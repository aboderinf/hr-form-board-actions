import { ODDS_RANGES, FORM_RANGES, DISCOVERY_BOOKS, parseDiscoverySlice, discoverySliceSummary } from "./discovery-ranges.mjs";

const labState = {
  period: "rolling_14d",
  view: "1117",
  form: "all",
  odds: "all",
  book: "all",
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

function segmentTable(rows = [], title = "Segments", limit = 18, clickable = false) {
  const ordered = [...rows]
    .filter((row) => Number(row.settled || 0) > 0)
    .sort((a, b) => Number(b.net_units || 0) - Number(a.net_units || 0) || Number(b.settled || 0) - Number(a.settled || 0))
    .slice(0, limit);
  if (!ordered.length) return `<div class="empty">No settled rows for this checkpoint yet.</div>`;
  return `<div class="tablewrap"><table>
    <thead><tr><th>${esc(title)}</th><th>Bets</th><th>Record</th><th>Hit rate</th><th>Break-even</th><th>Edge</th><th>Avg odds</th><th>Net</th><th>ROI</th><th>Evidence</th></tr></thead>
    <tbody>${ordered.map((row) => `<tr>
      <td>${clickable ? `<button type="button" class="discovery-slice-link" data-lab-slice="${esc(row.label)}" aria-label="Inspect ${esc(row.label)}">${esc(row.label)}</button>` : `<b>${esc(row.label)}</b>`}</td>
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

function sliceSelect(key, label, ranges, allLabel) {
  return `<label for="lab-slice-${key}">${label}<select id="lab-slice-${key}" data-lab-filter="${key}">
    <option value="all" ${labState[key] === "all" ? "selected" : ""}>${allLabel}</option>
    ${ranges.map((range) => `<option value="${esc(range.value)}" ${labState[key] === range.value ? "selected" : ""}>${esc(range.label)}</option>`).join("")}
  </select></label>`;
}

function sliceExplorer(detail, report) {
  const summary = discoverySliceSummary(detail, labState.form, labState.odds, labState.book);
  const formLabel = FORM_RANGES.find((range) => range.value === labState.form)?.label || "All form scores";
  const oddsLabel = ODDS_RANGES.find((range) => range.value === labState.odds)?.label || "All odds";
  const books = labState.book === "all" ? DISCOVERY_BOOKS : [labState.book];
  const rows = books.map((book) => ({ book, summary: discoverySliceSummary(detail, labState.form, labState.odds, book) }));
  return `<section id="discovery-slice-explorer" class="discovery-slice-explorer" aria-labelledby="discovery-slice-heading">
    <div class="eyebrow">Slice explorer</div>
    <h3 id="discovery-slice-heading" tabindex="-1">${esc(formLabel)} × ${esc(oddsLabel)}</h3>
    <p class="muted">Choose any form × odds combination, or click a slice in the tables below.</p>
    <div class="discovery-slice-controls">
      ${sliceSelect("form", "Form score", FORM_RANGES, "All form scores")}
      ${sliceSelect("odds", "Best odds · American", ODDS_RANGES, "All odds")}
      ${sliceSelect("book", "Book offering best price", DISCOVERY_BOOKS.map((book) => ({ value: book, label: book })), "All best-price books")}
      <button type="button" id="lab-reset-slice">Reset slice</button>
    </div>
    <p class="muted">${esc(periodLabels[labState.period])} · ${esc(report.start)} to ${esc(report.end)} · ${esc(labState.view === "best" ? "Best archived (hindsight)" : `${checkpointLabels[labState.view]} ET checkpoint`)}${report.latest_complete_slate ? ` · Latest complete slate: ${esc(report.latest_complete_slate)}` : ""}</p>
    <div id="discovery-slice-results" aria-live="polite">
      ${summary ? `<p>${samplePill(summary)}${labState.book !== "all" ? ` · ${esc(labState.book)} best-price bets` : ""}</p>${summaryCards(summary)}` : '<div class="empty">No archived bets match this slice for the selected period and checkpoint. Try another range or book.</div>'}
      <h4>Performance by best-price book</h4>
      <p class="muted">Each book's row includes only bets where that book supplied the archived best price. Different books can have different selections; this does not re-price the same bets at every book. Stakes: 1 unit per settled bet.</p>
      <div class="tablewrap"><table class="discovery-slice-books">
        <thead><tr><th>Best-price book</th><th>Settled bets</th><th>Record</th><th>Hit rate</th><th>Avg odds</th><th>Net units</th><th>ROI</th><th>Slates</th><th>Evidence</th></tr></thead>
        <tbody>${rows.map(({ book, summary: row }) => `<tr>
          <td><b>${esc(book)}</b></td><td>${Number(row?.settled || 0)}</td>
          <td>${row ? `${Number(row.wins || 0)}–${Number(row.losses || 0)}` : "—"}</td>
          <td>${pct(row?.hit_rate)}</td><td>${american(row?.average_odds)}</td>
          <td class="${Number(row?.net_units || 0) >= 0 ? "plus" : "loss"}">${units(row?.net_units)}</td>
          <td class="${Number(row?.roi || 0) >= 0 ? "plus" : "loss"}">${pct(row?.roi, true)}</td>
          <td>${Number(row?.slates || 0)}</td><td>${row ? samplePill(row) : '<span class="muted">No settled bets</span>'}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>
  </section>`;
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
      <td>${esc(row.dimension)}</td><td>${/rank/i.test(row.dimension) ? `<b>${esc(row.rule)}</b>` : `<button type="button" class="discovery-slice-link" data-lab-slice="${esc(row.rule)}" aria-label="Inspect ${esc(row.rule)}">${esc(row.rule)}</button>`}</td><td>${Number(row.settled || 0)}</td><td>${Number(row.slates || 0)}</td>
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
    ${sliceExplorer(detail, report)}

    <div class="eyebrow">Intersection search</div><h3>Form score × odds</h3>
    <p class="muted">Click a slice to inspect its sportsbook results above. All settled slices are shown, ordered by net units.</p>
    ${segmentTable(detail.score_odds || [], "Score × odds", Infinity, true)}

    <div class="eyebrow">Sportsbook attribution</div><h3>Best book × odds × form score</h3>
    <p class="muted">The 18 leading slices by net units. Click one to inspect it, or use the explorer to select any range and book.</p>
    ${segmentTable(detail.book_odds_score || [], "Book × odds × score", 18, true)}

    <div class="eyebrow">Evidence-gated candidates</div><h3>Segments worth following prospectively</h3>
    <p class="muted">Gate: at least 40 settled bets, 4 wins, 5 slates, and positive net units. These are exploratory candidates, not proof of a durable edge.</p>
    ${edgeTable(report)}

    <div class="eyebrow">Cross-check</div><h3>All checkpoint performance</h3>
    <p class="muted">Click any row to jump directly to that checkpoint tab.</p>
    ${checkpointTable(report.checkpoint_strategies || [])}

    <div class="notice discovery-lab-warning"><b>No fake fair odds:</b> HR Form Score is a recency/form index, not a calibrated home-run probability. Fair odds and expected EV are intentionally withheld until probability calibration is validated out of sample.</div>
  `;

  root.querySelectorAll("[data-lab-filter]").forEach((select) => select.addEventListener("change", () => {
    labState[select.dataset.labFilter] = select.value;
    const id = select.id;
    renderLab(root);
    document.getElementById(id)?.focus({ preventScroll: true });
  }));
  root.querySelector("#lab-reset-slice")?.addEventListener("click", () => {
    Object.assign(labState, { form: "all", odds: "all", book: "all" });
    renderLab(root);
    document.getElementById("lab-reset-slice")?.focus({ preventScroll: true });
  });
  root.querySelectorAll("[data-lab-slice]").forEach((button) => button.addEventListener("click", () => {
    const slice = parseDiscoverySlice(button.dataset.labSlice);
    Object.assign(labState, { form: slice.form, odds: slice.odds, book: slice.book });
    if (slice.checkpoint) labState.view = slice.checkpoint;
    renderLab(root);
    const heading = document.getElementById("discovery-slice-heading");
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
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
  .discovery-slice-explorer{border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:20px;margin:24px 0}
  .discovery-slice-explorer>.eyebrow{margin-top:0}
  .discovery-slice-explorer h4{font-size:1rem;margin:20px 0 8px}
  .discovery-slice-explorer p,.discovery-slice-explorer th,.discovery-slice-explorer td{font-size:.875rem}
  .discovery-slice-controls{display:flex;flex-wrap:wrap;align-items:flex-end;gap:14px;margin:18px 0}
  .discovery-slice-controls label{font-size:.875rem;font-weight:700;flex:1 1 190px;min-width:0}
  .discovery-slice-controls select{display:block;box-sizing:border-box;width:100%;margin-top:6px;min-height:42px;padding:9px 10px;border:1px solid var(--line,#e5e7eb);border-radius:8px;background:var(--panel,#0d1a24);color:inherit;font:inherit;font-size:1rem}
  #lab-reset-slice{min-height:42px;padding:8px 14px;cursor:pointer}
  .discovery-slice-link{font:inherit;font-weight:700;border:0;padding:8px 0;text-align:left;background:transparent;color:var(--accent,#66e7b1);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
  .discovery-slice-link:hover{text-decoration-thickness:2px}
  .discovery-slice-link:focus-visible{outline:2px solid currentColor;outline-offset:3px}
  #discovery-slice-heading{scroll-margin-top:20px}
  .discovery-slice-explorer .discovery-lab-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}
  @media (max-width:700px){
    .discovery-slice-explorer{padding:14px}
    .discovery-slice-controls label{flex-basis:100%}
    .discovery-slice-explorer .discovery-lab-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .discovery-slice-explorer .discovery-lab-metrics .card{padding:12px}
    .discovery-slice-explorer .metric strong{font-size:1.2rem;overflow-wrap:anywhere}
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
