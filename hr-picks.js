const PRIMARY_URL = "/data/hr-picks.json";
const COMPANION_URL = "/data/hr-volume-companion.json";
const PORTFOLIO_URL = "/data/hr-portfolio.json";
const EXPERIMENTAL_URL = "/data/hr-companion.json";

const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[c]));
const pct = (value, digits = 1) => value == null ? "-" : (Number(value) >= 0 ? "+" : "") + (Number(value) * 100).toFixed(digits) + "%";
const units = (value) => value == null ? "-" : (Number(value) >= 0 ? "+" : "") + Number(value).toFixed(2) + "u";
const odds = (value) => value == null ? "-" : (Number(value) > 0 ? "+" : "") + Math.round(Number(value));
const record = (summary = {}) => Number(summary.wins || 0) + "-" + Number(summary.losses || 0) + (Number(summary.voids || 0) ? " | " + Number(summary.voids || 0) + "V" : "");

let bundle = null;
let loading = null;

async function fetchJson(url, required = true) {
  const response = await fetch(url + "?v=" + Date.now(), { cache: "no-store" });
  if (!response.ok) {
    if (!required) return null;
    throw new Error(url + " HTTP " + response.status);
  }
  return response.json();
}

async function load() {
  if (bundle) return bundle;
  if (!loading) {
    loading = Promise.all([
      fetchJson(PRIMARY_URL, true),
      fetchJson(COMPANION_URL, false),
      fetchJson(PORTFOLIO_URL, false),
      fetchJson(EXPERIMENTAL_URL, false),
    ]).then(([primary, companion, portfolio, experimental]) => {
      bundle = { primary, companion, portfolio, experimental };
      return bundle;
    }).finally(() => { loading = null; });
  }
  return loading;
}

function ensureNav() {
  const nav = document.querySelector(".top nav");
  if (!nav || nav.querySelector('[href="#picks"]')) return;
  const link = document.createElement("a");
  link.className = "nav";
  link.href = "#picks";
  link.textContent = "HR Picks";
  const discovery = nav.querySelector('[href="#discovery"]');
  if (discovery && discovery.nextSibling) nav.insertBefore(link, discovery.nextSibling);
  else nav.appendChild(link);
}

function setNavActive() {
  document.querySelectorAll(".top nav .nav").forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === "#picks");
  });
}

function metricCard(label, summary, detail) {
  summary = summary || {};
  detail = detail || "";
  const cls = Number(summary.roi || 0) >= 0 ? "plus" : "loss";
  return '<article class="hrp-stat"><span>' + esc(label) + '</span><strong class="' + cls + '">' +
    pct(summary.roi) + '</strong><small>' + esc(record(summary)) + ' | ' + units(summary.net_units) +
    (detail ? ' | ' + esc(detail) : '') + '</small></article>';
}

function picksTable(rows, options) {
  rows = rows || [];
  options = options || {};
  if (!rows.length) return '<div class="empty">No selections are frozen yet.</div>';
  const showStrategy = !!options.showStrategy;
  const showCell = !!options.showCell;
  let head = '<thead><tr><th>#</th><th>Player</th>';
  if (showStrategy) head += '<th>Strategy</th>';
  head += '<th>Score</th><th>Price</th><th>Book</th>';
  if (showCell) head += '<th>Trigger cell</th>';
  head += '<th>Game</th><th>Status</th></tr></thead>';
  const body = rows.map((row, index) => {
    let html = '<tr><td>' + (index + 1) + '</td><td><b>' + esc(row.player) + '</b><div class="muted">' +
      esc(row.team || "") + (row.matchup ? ' | ' + esc(row.matchup) : '') + '</div></td>';
    if (showStrategy) html += '<td><span class="pill">' + esc(row.strategy || row.mode || "-") + '</span></td>';
    html += '<td>' + (row.score == null ? "-" : Number(row.score).toFixed(4)) + '</td>' +
      '<td class="plus"><b>' + odds(row.odds) + '</b></td><td>' + esc(row.book || "-") + '</td>';
    if (showCell) html += '<td>' + esc((row.cell || {}).label || "-") + '</td>';
    html += '<td>' + esc(row.game_start_at || "-") + '</td><td><span class="pill">' +
      esc(row.result || "PENDING") + '</span></td></tr>';
    return html;
  }).join("");
  return '<div class="tablewrap"><table class="hrp-table">' + head + '<tbody>' + body + '</tbody></table></div>';
}

function ledgerTable(daily, mode) {
  daily = daily || [];
  if (!daily.length) return '<div class="empty">Forward tracking begins September 21, 2026. No daily ledger rows are available yet.</div>';
  const label = mode === "combined" ? "Mix" : "Mode";
  const body = [...daily].reverse().map((day) => {
    let modeText = day.mode || mode || "-";
    if (mode === "combined" && day.sources) modeText = "P " + Number(day.sources.primary || 0) + " / C " + Number(day.sources.companion || 0);
    const selections = Array.isArray(day.selections) ? day.selections : [];
    const summaryRow = '<tr><td><b>' + esc(day.slate_date) + '</b></td><td><span class="pill">' + esc(modeText) +
      '</span></td><td>' + Number(day.bets || 0) + '</td><td>' + esc(record(day)) + '</td><td class="' +
      (Number(day.net_units || 0) >= 0 ? "plus" : "loss") + '">' + units(day.net_units) + '</td><td class="' +
      (Number(day.roi || 0) >= 0 ? "plus" : "loss") + '">' + pct(day.roi) + '</td><td class="' +
      (Number((day.cumulative || {}).net_units || 0) >= 0 ? "plus" : "loss") + '">' +
      units((day.cumulative || {}).net_units) + '<div class="muted">' + pct((day.cumulative || {}).roi) +
      '</div></td></tr>';
    const detail = selections.length
      ? '<tr class="hrp-ledger-detail"><td colspan="7"><details class="hrp-ledger-dropdown"><summary>Actual picks · ' +
        selections.length + '</summary>' + picksTable(selections, { showStrategy: mode === "combined" }) + '</details></td></tr>'
      : '<tr class="hrp-ledger-detail"><td colspan="7"><details class="hrp-ledger-dropdown"><summary>Actual picks · 0</summary><div class="empty">No player-level selections were saved for this ledger row.</div></details></td></tr>';
    return summaryRow + detail;
  }).join("");
  return '<div class="tablewrap"><table class="hrp-table"><thead><tr><th>Date</th><th>' + label +
    '</th><th>Bets</th><th>Record</th><th>Net</th><th>ROI</th><th>Cumulative</th></tr></thead><tbody>' +
    body + '</tbody></table></div>';
}

function experimentalCheckpointCards(current) {
  current = current || {};
  const rows = current.checkpoints || [];
  if (!rows.length) return '<div class="empty">No experimental checkpoint has been frozen for this slate yet.</div>';
  return '<div class="hrp-checkpoint-grid">' + rows.map((row) =>
    '<article class="hrp-stat"><span>' + esc(row.checkpoint) + ' ET</span><strong>' +
    Number((row.picks || []).length) + '</strong><small>' +
    Number((row.qualified_cells || []).length) + ' qualifying evidence-gated cells</small></article>'
  ).join("") + '</div>';
}

function currentStatusMessage(current, readyText) {
  if (!current) return readyText;
  if (current.status === "checkpoint_pending") return "Waiting for the 17:17 archive.";
  if (current.status === "checkpoint_missed") return "17:17 checkpoint missed. Exact archived odds are unavailable; no later odds were substituted and no ledger pick was created.";
  return readyText;
}

function currentPicksTable(current, daily, options) {
  current = current || {};
  daily = daily || [];
  const currentRows = Array.isArray(current.picks) ? current.picks : [];
  if (currentRows.length) return picksTable(currentRows, options);

  const sameDay = [...daily].reverse().find((day) =>
    day && day.slate_date === current.slate_date && Array.isArray(day.selections) && day.selections.length
  );
  if (sameDay) {
    return '<div class="notice"><b>Recovered from the saved ledger snapshot:</b> current.picks was empty, but the same-day frozen selections are present in the ledger.</div>' +
      picksTable(sameDay.selections, options);
  }

  const latest = [...daily].reverse().find((day) =>
    day && Array.isArray(day.selections) && day.selections.length
  );
  if (latest) {
    return '<div class="empty">No picks are frozen for ' + esc(current.slate_date || "the current slate") +
      ' yet. Most recent frozen slate: <b>' + esc(latest.slate_date) + '</b>.</div>' +
      picksTable(latest.selections, options);
  }
  return picksTable([], options);
}

function renderBody(primary, companion, portfolio, experimental) {
  const shell = document.querySelector("#app .shell");
  if (!shell) return;
  ensureNav();
  setNavActive();

  const header = shell.querySelector("header.top");
  const footer = shell.querySelector("footer.footer");
  [...shell.children].forEach((node) => {
    if (node !== header && node !== footer) node.remove();
  });

  const pRule = primary.rule || {};
  const pForward = (primary.forward || {}).summary || {};
  const pCurrent = primary.current || {};
  const pGate = primary.promotion_gate || {};

  const cRule = (companion || {}).rule || {};
  const cForward = ((companion || {}).forward || {}).summary || {};
  const cCurrent = (companion || {}).current || {};
  const cGate = (companion || {}).promotion_gate || {};

  const portForward = ((portfolio || {}).forward || {}).summary || {};
  const portCurrent = (portfolio || {}).current || {};

  const expForward = ((experimental || {}).forward || {}).summary || {};
  const expCurrent = (experimental || {}).current || {};

  const pCal = ((primary.calibration || {}).winner || {}).full || {};
  const pRetro = (primary.retrospective || {}).summary || {};
  const cCal = ((companion || {}).calibration || {});
  const cRetro = (((companion || {}).retrospective || {}).summary || {});

  let html = '';

  html += '<section class="hero hrp-hero"><div class="card"><div class="eyebrow">HR PICKS | FIXED TWO-RULE PORTFOLIO</div>' +
    '<h1>Primary + volume companion.</h1><p class="muted">Both official strategies are fixed, independently frozen at 17:17 ET, and tracked prospectively from September 21. The adaptive four-checkpoint system remains visible only as an experimental track.</p>' +
    '<div class="hrp-stats">' + metricCard("Primary forward", pForward) + metricCard("Companion forward", cForward) +
    metricCard("Combined portfolio", portForward) + metricCard("Experimental", expForward, "not in combined") + '</div></div>' +
    '<div class="card"><div class="eyebrow">COMBINED PORTFOLIO</div><h2>Selective + volume, one ledger.</h2>' +
    '<p class="muted">The combined record is the union of the separately frozen Primary and Companion selections. Same-player overlap is defensively counted once; with the current disjoint score bands it should normally be zero.</p>' +
    '<div class="notice"><b>Forward only:</b> calibration and Sep. 6–20 diagnostics stay evidence panels, not ledger entries.</div></div></section>';

  html += '<section class="hero hrp-hero"><div class="card"><div class="eyebrow">PRIMARY / SELECTIVE | ACTIVE</div>' +
    '<h2>' + esc(pRule.label || "1717 · 0.100–0.199 · +400–499 · any best book · top 3/slate") + '</h2>' +
    '<div class="hrp-rule-grid"><div><span>Checkpoint</span><b>17:17 ET</b></div><div><span>Form</span><b>0.100–0.199</b></div>' +
    '<div><span>Odds</span><b>+400–499</b></div><div><span>Cap</span><b>Top 3</b></div></div>' +
    '<p class="muted">Best archived book is allowed. Qualifiers rank by HR Form score, then archived price.</p></div>' +
    '<div class="card"><div class="eyebrow">COMPANION / VOLUME | ACTIVE</div>' +
    '<h2>' + esc(cRule.label || "1717 · 0.200+ · below +400 · DraftKings best price · top 10/slate") + '</h2>' +
    '<div class="hrp-rule-grid"><div><span>Checkpoint</span><b>17:17 ET</b></div><div><span>Form</span><b>≥0.200</b></div>' +
    '<div><span>Odds</span><b>Below +400</b></div><div><span>Book / cap</span><b>DK best · Top 10</b></div></div>' +
    '<p class="muted">DraftKings must be the archived best-price book. The exact 17:17 DK price is frozen and never replaced.</p></div></section>';

  html += '<section class="card section"><div class="eyebrow">PRIMARY | TODAY</div><h2>' + esc(pCurrent.slate_date || "Today") +
    ' · 17:17 ET</h2><p class="muted">' + currentStatusMessage(pCurrent, "Primary selections are frozen for forward tracking.") +
    '</p>' + currentPicksTable(pCurrent, (primary.forward || {}).daily || []) + '</section>';

  html += '<section class="card section"><div class="eyebrow">COMPANION | TODAY</div><h2>' + esc(cCurrent.slate_date || pCurrent.slate_date || "Today") +
    ' · 17:17 ET</h2><p class="muted">' + (!companion ? "Fixed companion data will appear after the next Discovery rebuild." :
    currentStatusMessage(cCurrent, "Volume selections are independently frozen for forward tracking.")) +
    '</p>' + (companion ? currentPicksTable(cCurrent, ((companion.forward || {}).daily || [])) : '<div class="empty">Awaiting fixed companion build.</div>') + '</section>';

  html += '<section class="card section"><div class="eyebrow">PRIMARY | DAILY LEDGER</div><h2>Selective rule record</h2>' +
    '<div class="hrp-stats">' + metricCard("Forward ROI", pForward) +
    '<article class="hrp-stat"><span>Settled bets</span><strong>' + Number(pForward.bets || 0) + '</strong><small>' + esc(record(pForward)) + '</small></article>' +
    '<article class="hrp-stat"><span>Betting slates</span><strong>' + Number(pForward.slates || 0) + '</strong><small>Forward only</small></article>' +
    '<article class="hrp-stat"><span>Promotion gate</span><strong>' + (pGate.passed ? "PASS" : "TRACKING") + '</strong><small>Independent primary gate</small></article></div>' +
    ledgerTable((primary.forward || {}).daily || [], "primary") + '</section>';

  html += '<section class="card section"><div class="eyebrow">COMPANION | DAILY LEDGER</div><h2>Higher-volume rule record</h2>' +
    '<div class="hrp-stats">' + metricCard("Forward ROI", cForward) +
    '<article class="hrp-stat"><span>Settled bets</span><strong>' + Number(cForward.bets || 0) + '</strong><small>' + esc(record(cForward)) + '</small></article>' +
    '<article class="hrp-stat"><span>Betting slates</span><strong>' + Number(cForward.slates || 0) + '</strong><small>Forward only</small></article>' +
    '<article class="hrp-stat"><span>Promotion gate</span><strong>' + (cGate.passed ? "PASS" : "TRACKING") + '</strong><small>Independent companion gate</small></article></div>' +
    (companion ? ledgerTable(((companion.forward || {}).daily || []), "companion") : '<div class="empty">Awaiting fixed companion build.</div>') + '</section>';

  html += '<section class="card section hrp-combined"><div class="eyebrow">COMBINED PORTFOLIO | DAILY LEDGER</div><h2>Two-rule portfolio record</h2>' +
    '<div class="hrp-stats">' + metricCard("Combined ROI", portForward) +
    '<article class="hrp-stat"><span>Settled bets</span><strong>' + Number(portForward.bets || 0) + '</strong><small>' + esc(record(portForward)) + '</small></article>' +
    '<article class="hrp-stat"><span>Profitable slates</span><strong>' + Number(portForward.profitable_slates || 0) + '</strong><small>Forward only</small></article>' +
    '<article class="hrp-stat"><span>Overlap deduped</span><strong>' + Number((portfolio || {}).overlap_deduped || 0) + '</strong><small>Same player / slate</small></article></div>' +
    (portfolio ? ledgerTable(((portfolio.forward || {}).daily || []), "combined") : '<div class="empty">Combined ledger will appear after the next Discovery rebuild.</div>') +
    '<details><summary>Current combined selections</summary>' + (portfolio ? currentPicksTable(portCurrent, ((portfolio.forward || {}).daily || []), { showStrategy: true }) : '<div class="empty">Awaiting portfolio build.</div>') + '</details></section>';

  html += '<section class="card section"><div class="eyebrow">FIXED-RULE EVIDENCE</div><h2>Calibration and diagnostic context</h2>' +
    '<p class="muted">These historical panels describe why the rules were chosen. They do not alter the rules or enter the prospective ledgers.</p>' +
    '<div class="hrp-evidence-grid"><article><h3>Primary / Selective</h3><div class="hrp-stats">' +
    metricCard("Calibration", pCal) + metricCard("Sep. 6–20", pRetro) + '</div></article><article><h3>Companion / Volume</h3><div class="hrp-stats">' +
    metricCard("Calibration", cCal.full || {}) + metricCard("Early half", cCal.early || {}) + metricCard("Late half", cCal.late || {}) + metricCard("Sep. 6–20", cRetro) +
    '</div></article></div></section>';

  html += '<section class="card section hrp-experimental"><div class="eyebrow">EXPERIMENTAL | DYNAMIC DISCOVERY</div>' +
    '<h2>Adaptive evidence-gated track</h2><p class="muted">This is the previously deployed all-checkpoint dynamic system. It remains prospectively tracked for research, but it is not the official Companion and is excluded from the Combined Portfolio ledger.</p>' +
    '<div class="hrp-stats">' + metricCard("Experimental forward", expForward) +
    '<article class="hrp-stat"><span>Checkpoints</span><strong>4</strong><small>08:17 · 11:17 · 17:17 · 20:17</small></article>' +
    '<article class="hrp-stat"><span>Selection cap</span><strong>NONE</strong><small>Evidence-gated qualifiers</small></article>' +
    '<article class="hrp-stat"><span>Portfolio impact</span><strong>NONE</strong><small>Tracked separately</small></article></div>' +
    (experimental ? experimentalCheckpointCards(expCurrent) : '<div class="empty">Experimental data unavailable.</div>') +
    (experimental ? currentPicksTable(expCurrent, ((experimental.forward || {}).daily || []), { showCell: true }) : '') +
    '<details><summary>Experimental daily ledger</summary>' + (experimental ? ledgerTable(((experimental.forward || {}).daily || []), "experimental") : '') + '</details></section>';

  html += '<section class="card section"><div class="eyebrow">EXECUTION GUARDRAILS</div><h2>What is frozen</h2><table><tbody>' +
    '<tr><td>Primary</td><td>17:17 ET · score 0.100–0.199 · +400–499 · any archived best-price book · top 3.</td></tr>' +
    '<tr><td>Companion</td><td>17:17 ET · score ≥0.200 · DraftKings is archived best price · odds below +400 · top 10.</td></tr>' +
    '<tr><td>Price handling</td><td>Each strategy keeps its original checkpoint book and price permanently; settlement only updates result and profit.</td></tr>' +
    '<tr><td>Combined</td><td>Union of Primary + Companion only. Dynamic Experimental selections never enter the official portfolio ledger.</td></tr>' +
    '<tr><td>Stake</td><td>1 flat unit per unique HR prop. No plate appearance is void.</td></tr></tbody></table></section>';

  const wrap = document.createElement("div");
  wrap.className = "hrp-root";
  wrap.innerHTML = html;
  if (footer) shell.insertBefore(wrap, footer);
  else shell.appendChild(wrap);
}

async function renderIfNeeded() {
  ensureNav();
  if ((location.hash.slice(1) || "today") !== "picks") return;
  setNavActive();
  if (document.querySelector("#app .hrp-root")) return;
  const shell = document.querySelector("#app .shell");
  if (!shell) return;
  try {
    const data = await load();
    if ((location.hash.slice(1) || "today") !== "picks") return;
    renderBody(data.primary, data.companion, data.portfolio, data.experimental);
  } catch (error) {
    const header = shell.querySelector("header.top");
    const footer = shell.querySelector("footer.footer");
    [...shell.children].forEach((node) => {
      if (node !== header && node !== footer) node.remove();
    });
    const section = document.createElement("section");
    section.className = "card section";
    section.innerHTML = '<div class="eyebrow">HR PICKS</div><h2>Daily rules unavailable</h2><p class="loss">' + esc(error.message || error) + '</p>';
    if (footer) shell.insertBefore(section, footer);
    else shell.appendChild(section);
  }
}

const style = document.createElement("style");
style.textContent = [
  ".hrp-root{display:contents}",
  ".hrp-hero{margin-top:0}",
  ".hrp-rule-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}",
  ".hrp-rule-grid>div{border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:12px}",
  ".hrp-rule-grid span,.hrp-stat span{display:block;font-size:.76rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted,#8492a6)}",
  ".hrp-rule-grid b{display:block;margin-top:4px}",
  ".hrp-stats,.hrp-checkpoint-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0}",
  ".hrp-stat{border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:14px}",
  ".hrp-stat strong{display:block;font-size:1.35rem;margin:6px 0}",
  ".hrp-stat small{color:var(--muted,#8492a6)}",
  ".hrp-table .muted{font-size:.78rem;margin-top:3px}",
  ".hrp-ledger-detail>td{padding:6px 0 14px}",
  ".hrp-ledger-detail .tablewrap{margin-top:10px}",
  ".hrp-ledger-dropdown{margin:0 8px}",
  ".hrp-ledger-dropdown>summary{cursor:pointer;font-weight:800;padding:8px 10px;border:1px solid var(--line,#e5e7eb);border-radius:10px}",
  ".hrp-ledger-dropdown[open]>summary{margin-bottom:8px}",
  ".hrp-root details{margin-top:16px}",
  ".hrp-root summary{cursor:pointer;font-weight:700}",
  ".hrp-combined{border-width:2px}",
  ".hrp-experimental{opacity:.94}",
  ".hrp-evidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
  ".hrp-evidence-grid .hrp-stats{grid-template-columns:repeat(2,minmax(0,1fr))}",
  "@media(max-width:800px){.hrp-stats,.hrp-checkpoint-grid,.hrp-rule-grid,.hrp-evidence-grid{grid-template-columns:1fr 1fr}}",
  "@media(max-width:520px){.hrp-stats,.hrp-checkpoint-grid,.hrp-rule-grid,.hrp-evidence-grid{grid-template-columns:1fr}}"
].join("");

document.head.appendChild(style);

const observer = new MutationObserver(() => {
  ensureNav();
  void renderIfNeeded();
});
observer.observe(document.getElementById("app"), { childList: true, subtree: true });
addEventListener("hashchange", () => setTimeout(() => void renderIfNeeded(), 0));
setTimeout(() => void renderIfNeeded(), 0);
