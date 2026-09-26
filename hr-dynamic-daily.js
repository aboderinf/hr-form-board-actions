const DYNAMIC_URL = "/data/hr-dynamic-daily.json";

const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[c]));
const pct = (value, digits = 1) => value == null ? "-" : (Number(value) >= 0 ? "+" : "") + (Number(value) * 100).toFixed(digits) + "%";
const units = (value) => value == null ? "-" : (Number(value) >= 0 ? "+" : "") + Number(value).toFixed(2) + "u";
const odds = (value) => value == null ? "-" : (Number(value) > 0 ? "+" : "") + Math.round(Number(value));

let cached = null;
let loading = null;

async function loadDynamic() {
  if (cached) return cached;
  if (!loading) {
    loading = fetch(DYNAMIC_URL + "?v=" + Date.now(), { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Dynamic picks HTTP " + response.status);
        return response.json();
      })
      .then((data) => {
        cached = data;
        return data;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

function metric(label, summary, detail = "") {
  summary = summary || {};
  return '<article class="hrp-stat"><span>' + esc(label) + '</span><strong class="' +
    (Number(summary.roi || 0) >= 0 ? "plus" : "loss") + '">' + pct(summary.roi) +
    '</strong><small>' + Number(summary.wins || 0) + '-' + Number(summary.losses || 0) +
    ' | ' + units(summary.net_units) + (detail ? ' | ' + esc(detail) : '') + '</small></article>';
}

function picksTable(rows) {
  rows = rows || [];
  if (!rows.length) return '<div class="empty">No dynamic selections at this checkpoint.</div>';
  const body = rows.map((row, index) => '<tr><td>' + (index + 1) + '</td><td><b>' +
    esc(row.player || "-") + '</b><div class="muted">' + esc(row.team || "") +
    (row.matchup ? ' | ' + esc(row.matchup) : '') + '</div></td><td>' +
    esc(row.checkpoint || "-") + '</td><td>' + (row.score == null ? "-" : Number(row.score).toFixed(4)) +
    '</td><td class="plus"><b>' + odds(row.odds) + '</b></td><td>' + esc(row.book || "-") +
    '</td><td>' + esc(((row.cell || {}).form) || "-") + '</td><td><span class="pill">' +
    esc(row.result || "PENDING") + '</span></td></tr>').join("");
  return '<div class="tablewrap"><table class="hrp-table"><thead><tr><th>#</th><th>Player</th><th>CP</th><th>Score</th><th>Price</th><th>Book</th><th>Form cell</th><th>Status</th></tr></thead><tbody>' +
    body + '</tbody></table></div>';
}

function ledger(daily, label) {
  daily = daily || [];
  if (!daily.length) return '<div class="empty">No ' + esc(label) + ' ledger rows yet.</div>';
  const rows = [...daily].reverse().map((day) => {
    const selections = day.selections || [];
    return '<tr><td><b>' + esc(day.slate_date) + '</b></td><td>' + Number(day.bets || 0) +
      '</td><td>' + Number(day.wins || 0) + '-' + Number(day.losses || 0) + '</td><td class="' +
      (Number(day.net_units || 0) >= 0 ? "plus" : "loss") + '">' + units(day.net_units) +
      '</td><td class="' + (Number(day.roi || 0) >= 0 ? "plus" : "loss") + '">' + pct(day.roi) +
      '</td><td class="' + (Number((day.cumulative || {}).net_units || 0) >= 0 ? "plus" : "loss") +
      '">' + units((day.cumulative || {}).net_units) + '<div class="muted">' +
      pct((day.cumulative || {}).roi) + '</div></td></tr><tr class="hrp-ledger-detail"><td colspan="6"><details class="hrp-ledger-dropdown"><summary>Actual picks · ' +
      selections.length + '</summary>' + picksTable(selections) + '</details></td></tr>';
  }).join("");
  return '<div class="tablewrap"><table class="hrp-table"><thead><tr><th>Date</th><th>Bets</th><th>Record</th><th>Net</th><th>ROI</th><th>Cumulative</th></tr></thead><tbody>' +
    rows + '</tbody></table></div>';
}

function checkpointCards(current) {
  const cps = (current || {}).checkpoints || [];
  if (!cps.length) return '<div class="empty">No checkpoint has been frozen for this slate yet.</div>';
  return '<div class="hrp-checkpoint-grid">' + cps.map((cp) =>
    '<article class="hrp-stat"><span>' + esc(cp.checkpoint) + ' ET</span><strong>' +
    Number((cp.picks || []).length) + '</strong><small>' + Number((cp.qualified_cells || []).length) +
    ' top available cells</small></article>'
  ).join("") + '</div>';
}

function renderDynamic(data) {
  const root = document.querySelector("#app .hrp-root");
  if (!root || document.querySelector(".hrd-dynamic")) return;

  const research = data.research || {};
  const dev = (research.development || {}).summary || {};
  const validation = (research.validation || {}).summary || {};
  const forward = (data.forward || {}).summary || {};
  const current = data.current || {};
  const rule = data.rule || {};
  const robustness = (research.search_space || {}).top_100_development_selected_profitable_on_validation;

  const section = document.createElement("section");
  section.className = "card section hrd-dynamic";
  section.innerHTML =
    '<div class="eyebrow">DYNAMIC DAILY PICKS | ACTIVE</div><h2>Rolling ROI selector</h2>' +
    '<p class="muted">Re-evaluated independently at 08:17, 11:17, 17:17 and 20:17 ET. It ranks only qualifying cells actually represented on the current slate and freezes the exact checkpoint book and price.</p>' +
    '<div class="hrp-stats">' + metric("Development", dev, "Aug 18–Sep 11") +
    metric("14-day holdout", validation, "Sep 12–25") + metric("Forward", forward, "from Sep 26") +
    '<article class="hrp-stat"><span>Robustness</span><strong>' + Number(robustness || 0) +
    '/100</strong><small>top development selectors profitable on holdout</small></article></div>' +
    '<details open><summary>Rule definition</summary><table><tbody>' +
    '<tr><td>Cell</td><td>' + esc(rule.cell || "-") + '</td></tr>' +
    '<tr><td>All-history gate</td><td>' + esc(rule.all_time_gate || "-") + '</td></tr>' +
    '<tr><td>30-day gate</td><td>' + esc(rule.trailing_30d_gate || "-") + '</td></tr>' +
    '<tr><td>14-day gate</td><td>' + esc(rule.trailing_14d_gate || "-") + '</td></tr>' +
    '<tr><td>Ranking</td><td>' + esc(rule.ranking || "-") + '</td></tr>' +
    '<tr><td>Players</td><td>' + esc(rule.player_selection || "-") + '</td></tr></tbody></table></details>' +
    '<div class="eyebrow" style="margin-top:18px">TODAY</div>' + checkpointCards(current) +
    picksTable(current.picks || []) +
    '<details><summary>Prospective ledger</summary>' + ledger((data.forward || {}).daily || [], "forward") + '</details>' +
    '<details><summary>Untouched Sep 12–25 validation ledger</summary>' +
    ledger((research.validation || {}).daily || [], "validation") + '</details>';

  const experimental = root.querySelector(".hrp-experimental");
  if (experimental) root.insertBefore(section, experimental);
  else root.appendChild(section);
}

async function renderIfNeeded() {
  if ((location.hash.slice(1) || "today") !== "picks") return;
  if (!document.querySelector("#app .hrp-root") || document.querySelector(".hrd-dynamic")) return;
  try {
    renderDynamic(await loadDynamic());
  } catch (error) {
    console.warn("Dynamic Daily Picks unavailable:", error);
  }
}

const observer = new MutationObserver(() => void renderIfNeeded());
observer.observe(document.getElementById("app"), { childList: true, subtree: true });
addEventListener("hashchange", () => setTimeout(() => void renderIfNeeded(), 0));
setTimeout(() => void renderIfNeeded(), 0);
