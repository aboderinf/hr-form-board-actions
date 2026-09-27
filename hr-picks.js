const PRIMARY_URL = "/data/hr-picks.json";
const COMPANION_URL = "/data/hr-volume-companion.json";
const PORTFOLIO_URL = "/data/hr-portfolio.json";
const EXPERIMENTAL_URL = "/data/hr-companion.json";
const DYNAMIC_URL = "/data/hr-dynamic-daily.json";
const LIVE_URL = "/api/hr-picks-live";

const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[c]));
const pct = (value, digits = 1) => value == null ? "-" : (Number(value) >= 0 ? "+" : "") + (Number(value) * 100).toFixed(digits) + "%";
const units = (value) => value == null ? "-" : (Number(value) >= 0 ? "+" : "") + Number(value).toFixed(2) + "u";
const odds = (value) => value == null ? "-" : (Number(value) > 0 ? "+" : "") + Math.round(Number(value));
const record = (summary = {}) => Number(summary.wins || 0) + "-" + Number(summary.losses || 0) + (Number(summary.voids || 0) ? " | " + Number(summary.voids || 0) + "V" : "");
const gameTimeEt = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date) + " ET";
};
const cellWeightedRoi = (row) => {
  const evidence = ((row || {}).cell || {}).evidence || {};
  const horizons = ["all_time", "trailing_30d", "trailing_14d"];
  let settled = 0;
  let net = 0;
  for (const key of horizons) {
    const stats = evidence[key] || {};
    settled += Number(stats.settled || 0);
    net += Number(stats.net_units || 0);
  }
  return settled > 0 ? net / settled : null;
};
const cellRoiDetail = (row) => {
  const evidence = ((row || {}).cell || {}).evidence || {};
  const all = (evidence.all_time || {}).roi;
  const d30 = (evidence.trailing_30d || {}).roi;
  const d14 = (evidence.trailing_14d || {}).roi;
  if (all == null && d30 == null && d14 == null) return "";
  return "14d " + pct(d14) + " · 30d " + pct(d30) + " · all " + pct(all);
};

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
      fetchJson(DYNAMIC_URL, false),
      fetchJson(LIVE_URL, false),
    ]).then(([primary, companion, portfolio, experimental, dynamic, live]) => {
      const current = (live || {}).current || {};
      if (primary && current.primary) primary = { ...primary, current: current.primary };
      if (companion && current.companion) companion = { ...companion, current: current.companion };
      if (portfolio && current.portfolio) portfolio = { ...portfolio, current: current.portfolio };
      if (dynamic && current.dynamic) dynamic = { ...dynamic, current: current.dynamic };
      bundle = { primary, companion, portfolio, experimental, dynamic, live };
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
  const ruleRoi = options.ruleRoi == null ? null : Number(options.ruleRoi);
  const showRoi = options.showRoi == null ? (showCell || Number.isFinite(ruleRoi)) : !!options.showRoi;
  let head = '<thead><tr><th>#</th><th>Player</th>';
  if (showStrategy) head += '<th>Strategy</th>';
  head += '<th>Score</th><th>Price</th><th>Book</th>';
  if (showCell) head += '<th>Trigger cell</th>';
  if (showRoi) head += '<th>Underlying ROI</th>';
  head += '<th>Game time (ET)</th><th>Status</th></tr></thead>';
  const body = rows.map((row, index) => {
    let html = '<tr><td>' + (index + 1) + '</td><td><b>' + esc(row.player) + '</b><div class="muted">' +
      esc(row.team || "") + (row.matchup ? ' | ' + esc(row.matchup) : '') + '</div></td>';
    if (showStrategy) html += '<td><span class="pill">' + esc(row.strategy || row.mode || "-") + '</span></td>';
    html += '<td>' + (row.score == null ? "-" : Number(row.score).toFixed(4)) + '</td>' +
      '<td class="plus"><b>' + odds(row.odds) + '</b></td><td>' + esc(row.book || "-") + '</td>';
    if (showCell) html += '<td>' + esc((row.cell || {}).label || "-") + '</td>';
    if (showRoi) {
      const weighted = cellWeightedRoi(row);
      const value = weighted == null ? ruleRoi : weighted;
      const detail = weighted == null
        ? (options.ruleRoiLabel || "Fixed-rule calibration ROI")
        : cellRoiDetail(row);
      html += '<td><b class="' + (Number(value || 0) >= 0 ? "plus" : "loss") + '">' +
        pct(value) + '</b><div class="muted">' + esc(detail) + '</div></td>';
    }
    html += '<td>' + esc(gameTimeEt(row.game_start_at)) + '</td><td><span class="pill">' +
      esc(row.result || "PENDING") + '</span></td></tr>';
    return html;
  }).join("");
  return '<div class="tablewrap"><table class="hrp-table">' + head + '<tbody>' + body + '</tbody></table></div>';
}

function ledgerTable(daily, mode, options) {
  options = options || {};
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
        selections.length + '</summary>' + picksTable(selections, {
          showStrategy: mode === "combined",
          showCell: mode === "dynamic" || mode === "dynamic-validation" || mode === "experimental",
          ruleRoi: options.ruleRoi,
          ruleRoiLabel: options.ruleRoiLabel,
        }) + '</details></td></tr>'
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

function renderBody(primary, companion, portfolio, experimental, dynamic, live) {
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
  const pCal = ((primary.calibration || {}).winner || {}).full || {};
  const pRetro = (primary.retrospective || {}).summary || {};

  const cRule = (companion || {}).rule || {};
  const cForward = ((companion || {}).forward || {}).summary || {};
  const cCurrent = (companion || {}).current || {};
  const cGate = (companion || {}).promotion_gate || {};
  const cCal = (companion || {}).calibration || {};
  const cRetro = (((companion || {}).retrospective || {}).summary || {});

  const portForward = ((portfolio || {}).forward || {}).summary || {};
  const portCurrent = (portfolio || {}).current || {};

  const dynForward = ((dynamic || {}).forward || {}).summary || {};
  const dynCurrent = (dynamic || {}).current || {};
  const dynValidation = ((dynamic || {}).research || {}).validation || {};
  const dynValidationSummary = dynValidation.summary || {};
  const dynRule = (dynamic || {}).rule || {};

  const expForward = ((experimental || {}).forward || {}).summary || {};
  const expCurrent = (experimental || {}).current || {};

  const liveCheckpoints = (live || {}).checkpoints || {};
  const readyCheckpoints = Object.values(liveCheckpoints).filter((row) => row && row.status === "ready").length;
  const slate = dynCurrent.slate_date || pCurrent.slate_date || (live || {}).slate_date || "Today";
  const liveSource = (live || {}).source === "canonical-redis-checkpoints";

  let html = '';

  html += '<section class="card hrp-overview" id="picks-today">' +
    '<div class="hrp-overview-head"><div><div class="eyebrow">HR PICKS · TODAY</div><h1>' + esc(slate) + '</h1>' +
    '<p class="muted">Current selections first. Historical ledgers and research are collapsed below.</p></div>' +
    '<div class="hrp-live-badge ' + (liveSource ? 'is-live' : '') + '">' +
    (liveSource ? 'LIVE · canonical checkpoint data' : 'Static fallback') + '</div></div>' +
    '<nav class="hrp-section-nav" aria-label="HR picks sections">' +
    '<a href="#picks-today">Today</a><a href="#picks-ledgers">Ledgers</a><a href="#picks-rules">Rules & evidence</a><a href="#picks-research">Research</a></nav>' +
    '<div class="hrp-stats">' +
    '<article class="hrp-stat"><span>Dynamic picks now</span><strong>' + Number((dynCurrent.picks || []).length) + '</strong><small>' + readyCheckpoints + ' checkpoint' + (readyCheckpoints === 1 ? '' : 's') + ' captured</small></article>' +
    '<article class="hrp-stat"><span>Primary · 17:17</span><strong>' + (pCurrent.status === "active" ? Number((pCurrent.picks || []).length) : 'PENDING') + '</strong><small>Selective fixed rule</small></article>' +
    '<article class="hrp-stat"><span>Companion · 17:17</span><strong>' + (cCurrent.status === "active" ? Number((cCurrent.picks || []).length) : 'PENDING') + '</strong><small>Higher-volume fixed rule</small></article>' +
    '<article class="hrp-stat"><span>Dynamic validation ROI</span><strong class="' + (Number(dynValidationSummary.roi || 0) >= 0 ? 'plus' : 'loss') + '">' + pct(dynValidationSummary.roi) + '</strong><small>' + esc(record(dynValidationSummary)) + '</small></article>' +
    '</div>' +
    (liveSource
      ? '<div class="notice"><b>Live path:</b> today’s picks are read directly from the exact Redis checkpoint. GitHub remains the permanent archive/ledger path, so a delayed Actions schedule no longer makes this Today view stale.</div>'
      : '<div class="notice"><b>Fallback:</b> live checkpoint data is temporarily unavailable; this page is showing the last generated static snapshot.</div>') +
    '</section>';

  html += '<section class="hrp-today-grid section">' +
    '<article class="card hrp-today-main"><div class="eyebrow">DYNAMIC DAILY · CURRENT</div><h2>' + esc(dynRule.name || "Dynamic Daily ROI") + '</h2>' +
    '<p class="muted">Runs at 08:17, 11:17, 17:17 and 20:17 ET. Exact checkpoint book and price are frozen.</p>' +
    experimentalCheckpointCards(dynCurrent) +
    picksTable((dynCurrent.picks || []), { showCell: true }) +
    '</article>' +
    '<article class="card hrp-fixed-stack"><div class="eyebrow">FIXED 17:17 RULES</div><h2>Primary + Companion</h2>' +
    '<div class="hrp-mini-rule"><div><b>Primary / Selective</b><span>' + esc(pRule.label || "17:17 · form 0.100–0.199 · +400–499 · top 3") + '</span></div>' +
    '<div class="hrp-mini-status">' + (pCurrent.status === "active" ? Number((pCurrent.picks || []).length) + ' picks' : '17:17 pending') + '</div></div>' +
    '<p class="muted">' + currentStatusMessage(pCurrent, "Primary selections are frozen.") + '</p>' +
    picksTable((pCurrent.picks || []), { ruleRoi: pCal.roi, ruleRoiLabel: "Calibration ROI · fixed Primary rule" }) +
    '<div class="hrp-divider"></div>' +
    '<div class="hrp-mini-rule"><div><b>Companion / Volume</b><span>' + esc(cRule.label || "17:17 · form ≥0.200 · DK best below +400 · top 10") + '</span></div>' +
    '<div class="hrp-mini-status">' + (cCurrent.status === "active" ? Number((cCurrent.picks || []).length) + ' picks' : '17:17 pending') + '</div></div>' +
    '<p class="muted">' + (!companion ? "Companion data unavailable." : currentStatusMessage(cCurrent, "Companion selections are frozen.")) + '</p>' +
    (companion ? picksTable((cCurrent.picks || []), { ruleRoi: (cCal.full || {}).roi, ruleRoiLabel: "Calibration ROI · fixed Companion rule" }) : '<div class="empty">Companion data unavailable.</div>') +
    '<details class="hrp-inline-details"><summary>Combined current selections</summary>' +
    (portfolio ? picksTable((portCurrent.picks || []), { showStrategy: true }) : '<div class="empty">Combined data unavailable.</div>') +
    '</details></article></section>';

  html += '<section class="card section" id="picks-ledgers"><div class="eyebrow">LEDGERS</div><h2>Forward tracking</h2>' +
    '<p class="muted">Open only the record you want to inspect. Player-level picks remain inside each daily dropdown.</p>' +
    '<div class="hrp-stats">' + metricCard("Dynamic forward", dynForward) + metricCard("Primary forward", pForward) +
    metricCard("Companion forward", cForward) + metricCard("Combined portfolio", portForward) + '</div>' +
    '<details open><summary>Dynamic Daily · prospective ledger</summary>' +
    (dynamic ? ledgerTable(((dynamic.forward || {}).daily || []), "dynamic") : '<div class="empty">Dynamic ledger unavailable.</div>') + '</details>' +
    '<details><summary>Primary / Selective · daily ledger</summary>' +
    ledgerTable((primary.forward || {}).daily || [], "primary", { ruleRoi: pCal.roi, ruleRoiLabel: "Calibration ROI · fixed Primary rule" }) + '</details>' +
    '<details><summary>Companion / Volume · daily ledger</summary>' +
    (companion ? ledgerTable(((companion.forward || {}).daily || []), "companion", { ruleRoi: (cCal.full || {}).roi, ruleRoiLabel: "Calibration ROI · fixed Companion rule" }) : '<div class="empty">Companion ledger unavailable.</div>') + '</details>' +
    '<details><summary>Combined Primary + Companion portfolio</summary>' +
    (portfolio ? ledgerTable(((portfolio.forward || {}).daily || []), "combined") : '<div class="empty">Combined ledger unavailable.</div>') + '</details>' +
    '</section>';

  html += '<details class="card section hrp-section-details" id="picks-rules"><summary><span><span class="eyebrow">RULES & EVIDENCE</span><b>Definitions, calibration and guardrails</b></span></summary>' +
    '<div class="hrp-details-body"><div class="hrp-rule-cards">' +
    '<article><h3>Primary / Selective</h3><div class="hrp-rule-grid"><div><span>Checkpoint</span><b>17:17 ET</b></div><div><span>Form</span><b>0.100–0.199</b></div><div><span>Odds</span><b>+400–499</b></div><div><span>Cap</span><b>Top 3</b></div></div>' +
    '<div class="hrp-stats">' + metricCard("Calibration", pCal) + metricCard("Sep. 6–20", pRetro) + '</div>' +
    '<p class="muted">Any archived best-price book is allowed. Rank by HR Form score, then archived price.</p></article>' +
    '<article><h3>Companion / Volume</h3><div class="hrp-rule-grid"><div><span>Checkpoint</span><b>17:17 ET</b></div><div><span>Form</span><b>≥0.200</b></div><div><span>Odds</span><b>Below +400</b></div><div><span>Book / cap</span><b>DK best · Top 10</b></div></div>' +
    '<div class="hrp-stats">' + metricCard("Calibration", cCal.full || {}) + metricCard("Sep. 6–20", cRetro) + '</div>' +
    '<p class="muted">DraftKings must be the archived best-price book; its exact 17:17 price is frozen.</p></article></div>' +
    '<div class="notice"><b>Execution:</b> 1 flat unit per unique HR prop. No plate appearance is void. Settlement changes only result/profit; the original checkpoint book and price never change.</div>' +
    '<div class="hrp-stats"><article class="hrp-stat"><span>Primary promotion gate</span><strong>' + (pGate.passed ? "PASS" : "TRACKING") + '</strong><small>Independent forward gate</small></article>' +
    '<article class="hrp-stat"><span>Companion promotion gate</span><strong>' + (cGate.passed ? "PASS" : "TRACKING") + '</strong><small>Independent forward gate</small></article></div>' +
    '</div></details>';

  html += '<details class="card section hrp-section-details" id="picks-research"><summary><span><span class="eyebrow">RESEARCH</span><b>Validation and experimental tracks</b></span></summary>' +
    '<div class="hrp-details-body"><h3>Dynamic Daily validation</h3>' +
    '<div class="hrp-stats">' + metricCard("Sep 12–25 validation", dynValidationSummary) +
    '<article class="hrp-stat"><span>Profitable slates</span><strong>' + Number(dynValidationSummary.profitable_slates || 0) + '/' + Number(dynValidationSummary.slates || 0) + '</strong><small>Untouched validation period</small></article></div>' +
    '<div class="notice"><b>Dynamic evidence gate:</b> all-time ≥40 settled / 4 wins / 5 slates / positive net; trailing 14d ≥20 bets and ≥10% ROI; trailing 30d ≥5 bets and positive net. Top 3 cells per checkpoint, max 2 players.</div>' +
    '<details><summary>14-day validation ledger</summary>' + (dynamic ? ledgerTable((dynValidation.daily || []), "dynamic-validation") : '') + '</details>' +
    '<h3>Experimental adaptive discovery</h3><p class="muted">Tracked separately and excluded from the official Primary + Companion portfolio.</p>' +
    '<div class="hrp-stats">' + metricCard("Experimental forward", expForward) +
    '<article class="hrp-stat"><span>Portfolio impact</span><strong>NONE</strong><small>Research only</small></article></div>' +
    (experimental ? experimentalCheckpointCards(expCurrent) + currentPicksTable(expCurrent, ((experimental.forward || {}).daily || []), { showCell: true }) : '<div class="empty">Experimental data unavailable.</div>') +
    '<details><summary>Experimental daily ledger</summary>' + (experimental ? ledgerTable(((experimental.forward || {}).daily || []), "experimental") : '') + '</details>' +
    '</div></details>';

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
    renderBody(data.primary, data.companion, data.portfolio, data.experimental, data.dynamic, data.live);
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
  ".hrp-overview{margin-top:0}",
  ".hrp-overview-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}",
  ".hrp-overview h1{font-size:clamp(28px,5vw,48px);margin:8px 0 10px}",
  ".hrp-live-badge{border:1px solid var(--line,#e5e7eb);border-radius:999px;padding:8px 12px;color:var(--muted,#8492a6);font-size:.78rem;font-weight:800;white-space:nowrap}",
  ".hrp-live-badge.is-live{color:var(--accent)}",
  ".hrp-section-nav{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 4px}",
  ".hrp-section-nav a{border:1px solid var(--line,#e5e7eb);border-radius:999px;padding:7px 11px;text-decoration:none;color:var(--muted,#8492a6);font-size:.82rem}",
  ".hrp-section-nav a:hover{color:var(--text)}",
  ".hrp-today-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:18px}",
  ".hrp-today-main,.hrp-fixed-stack{min-width:0}",
  ".hrp-mini-rule{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin:14px 0 6px}",
  ".hrp-mini-rule span{display:block;color:var(--muted,#8492a6);font-size:.78rem;margin-top:3px}",
  ".hrp-mini-status{border:1px solid var(--line,#e5e7eb);border-radius:999px;padding:5px 9px;font-size:.75rem;white-space:nowrap}",
  ".hrp-divider{height:1px;background:var(--line,#e5e7eb);margin:22px 0}",
  ".hrp-inline-details{margin-top:20px}",
  ".hrp-section-details>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;cursor:pointer}",
  ".hrp-section-details>summary::-webkit-details-marker{display:none}",
  ".hrp-section-details>summary>span>b{display:block;font-size:1.15rem;margin-top:3px}",
  ".hrp-section-details>summary:after{content:'Open';border:1px solid var(--line,#e5e7eb);border-radius:999px;padding:5px 10px;color:var(--muted,#8492a6);font-size:.75rem}",
  ".hrp-section-details[open]>summary:after{content:'Close'}",
  ".hrp-details-body{margin-top:18px}",
  ".hrp-rule-cards{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
  ".hrp-rule-cards>article{border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:16px}",
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
  "@media(max-width:900px){.hrp-today-grid,.hrp-rule-cards{grid-template-columns:1fr}}",
  "@media(max-width:800px){.hrp-stats,.hrp-checkpoint-grid,.hrp-rule-grid,.hrp-evidence-grid{grid-template-columns:1fr 1fr}.hrp-overview-head{display:block}.hrp-live-badge{display:inline-block;margin-top:8px}}",
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
