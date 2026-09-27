const PRIMARY_URL = "/data/hr-picks.json";
const COMPANION_URL = "/data/hr-volume-companion.json";
const PORTFOLIO_URL = "/data/hr-portfolio.json";
const EXPERIMENTAL_URL = "/data/hr-companion.json";
const DYNAMIC_URL = "/data/hr-dynamic-daily.json";
const LIVE_URL = "/api/central-odds?action=hr-picks-live";

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
  const fixedRoi = options.fixedRoi;
  const fixedRoiByStrategy = options.fixedRoiByStrategy || null;
  const showRoi = options.showRoi == null
    ? (showCell || fixedRoi != null || !!fixedRoiByStrategy)
    : !!options.showRoi;
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
      const strategy = String(row.strategy || row.mode || "").toLowerCase();
      const mapped = fixedRoiByStrategy ? fixedRoiByStrategy[strategy] : null;
      const weighted = row.cell ? cellWeightedRoi(row) : (mapped?.roi ?? fixedRoi ?? null);
      const detail = row.cell
        ? cellRoiDetail(row)
        : (mapped?.detail || options.fixedRoiDetail || "Historical rule evidence");
      html += '<td><b class="' + (Number(weighted || 0) >= 0 ? "plus" : "loss") + '">' +
        pct(weighted) + '</b><div class="muted">' + esc(detail) + '</div></td>';
    }
    html += '<td>' + esc(gameTimeEt(row.game_start_at)) + '</td><td><span class="pill">' +
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
        selections.length + '</summary>' + picksTable(selections, {
          showStrategy: mode === "combined",
          showCell: mode === "dynamic" || mode === "dynamic-validation" || mode === "experimental",
        }) + '</details></td></tr>'
      : '<tr class="hrp-ledger-detail"><td colspan="7"><details class="hrp-ledger-dropdown"><summary>Actual picks · 0</summary><div class="empty">No player-level selections were saved for this ledger row.</div></details></td></tr>';
    return summaryRow + detail;
  }).join("");
  return '<div class="tablewrap"><table class="hrp-table"><thead><tr><th>Date</th><th>' + label +
    '</th><th>Bets</th><th>Record</th><th>Net</th><th>ROI</th><th>Cumulative</th></tr></thead><tbody>' +
    body + '</tbody></table></div>';
}

function checkpointLabel(value) {
  const cp = String(value || "");
  return /^\\d{4}$/.test(cp) ? cp.slice(0, 2) + ":" + cp.slice(2) + " ET" : cp;
}

function experimentalCheckpointCards(current) {
  current = current || {};
  const rows = current.checkpoints || [];
  if (!rows.length) return '<div class="empty">No checkpoint has been frozen for this slate yet.</div>';
  return '<div class="hrp-checkpoint-grid">' + rows.map((row) =>
    '<article class="hrp-stat"><span>' + esc(checkpointLabel(row.checkpoint)) + '</span><strong>' +
    Number((row.picks || []).length) + '</strong><small>' +
    Number((row.qualified_cells || []).length) + ' qualifying cell' +
    (Number((row.qualified_cells || []).length) === 1 ? '' : 's') + '</small></article>'
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
  const pGate = primary.promotion_gate || {};
  const pCal = ((primary.calibration || {}).winner || {}).full || {};
  const pRetro = (primary.retrospective || {}).summary || {};

  const cRule = (companion || {}).rule || {};
  const cForward = ((companion || {}).forward || {}).summary || {};
  const cGate = (companion || {}).promotion_gate || {};
  const cCal = (companion || {}).calibration || {};
  const cRetro = ((companion || {}).retrospective || {}).summary || {};

  const portForward = ((portfolio || {}).forward || {}).summary || {};
  const expForward = ((experimental || {}).forward || {}).summary || {};
  const dynForward = ((dynamic || {}).forward || {}).summary || {};
  const dynValidation = ((dynamic || {}).research || {}).validation || {};
  const dynValidationSummary = dynValidation.summary || {};
  const dynRule = (dynamic || {}).rule || {};

  const pCurrent = (live || {}).primary || primary.current || {};
  const cCurrent = (live || {}).companion || (companion || {}).current || {};
  const portCurrent = (live || {}).portfolio || (portfolio || {}).current || {};
  const dynCurrent = (live || {}).dynamic || (dynamic || {}).current || {};
  const expCurrent = (experimental || {}).current || {};
  const slateDate = (live || {}).slate_date || dynCurrent.slate_date || pCurrent.slate_date || "Today";

  const fixedRois = {
    primary: {
      roi: pCal.roi,
      detail: "Calibration · " + Number(pCal.bets || 0) + " bets · " + units(pCal.net_units),
    },
    companion: {
      roi: (cCal.full || {}).roi,
      detail: "Calibration · " + Number((cCal.full || {}).bets || 0) + " bets · " + units((cCal.full || {}).net_units),
    },
  };

  let html = "";

  html += '<section class="hero hrp-hero"><div class="card"><div class="eyebrow">HR PICKS · ' + esc(slateDate) + '</div>' +
    '<h1>Today first. History underneath.</h1><p class="muted">Current picks now read directly from the canonical checkpoint store. GitHub remains the permanent archive and ledger, but it is no longer required for today\'s picks to appear.</p>' +
    '<div class="hrp-stats">' + metricCard("Dynamic forward", dynForward) + metricCard("Primary forward", pForward) +
    metricCard("Companion forward", cForward) + metricCard("Combined", portForward) + '</div></div>' +
    '<div class="card"><div class="eyebrow">LIVE DATA PATH</div><h2>' +
    ((live || {}).status === "ok" ? "Canonical checkpoints connected" : "Static fallback active") + '</h2>' +
    '<p class="muted">' + ((live || {}).status === "ok"
      ? "Current-day selections are computed from exact Redis-backed checkpoint snapshots, including frozen book and price."
      : "Live checkpoint API is unavailable; the page is showing the most recent generated Git snapshot.") + '</p>' +
    '<div class="notice"><b>Freeze policy:</b> once a checkpoint pick exists, later odds never replace its original book or price.</div></div></section>';

  html += '<section class="card section hrp-today"><div class="eyebrow">TODAY · DYNAMIC DAILY</div>' +
    '<h2>' + esc(dynRule.name || "Dynamic Daily ROI") + '</h2>' +
    '<p class="muted">08:17 · 11:17 · 17:17 · 20:17 ET. New qualifying picks appear as each exact checkpoint becomes available.</p>' +
    experimentalCheckpointCards(dynCurrent) +
    currentPicksTable(dynCurrent, ((dynamic || {}).forward || {}).daily || [], { showCell: true }) + '</section>';

  html += '<section class="hrp-today-grid">' +
    '<article class="card section"><div class="eyebrow">PRIMARY · 17:17 ET</div><h2>Selective</h2>' +
    '<p class="muted">' + esc(pRule.label || "0.100–0.199 · +400–499 · any best-price book · top 3") + '</p>' +
    '<div class="hrp-rule-strip"><span>Underlying calibration ROI <b class="plus">' + pct(pCal.roi) + '</b></span>' +
    '<span>' + Number(pCal.bets || 0) + ' calibration bets</span></div>' +
    '<p class="muted">' + currentStatusMessage(pCurrent, "Primary selections are frozen.") + '</p>' +
    currentPicksTable(pCurrent, (primary.forward || {}).daily || [], {
      fixedRoi: pCal.roi,
      fixedRoiDetail: "Calibration · " + Number(pCal.bets || 0) + " bets · " + units(pCal.net_units),
    }) + '</article>' +
    '<article class="card section"><div class="eyebrow">COMPANION · 17:17 ET</div><h2>Higher volume</h2>' +
    '<p class="muted">' + esc(cRule.label || "0.200+ · below +400 · DraftKings best · top 10") + '</p>' +
    '<div class="hrp-rule-strip"><span>Underlying calibration ROI <b class="plus">' + pct((cCal.full || {}).roi) + '</b></span>' +
    '<span>' + Number((cCal.full || {}).bets || 0) + ' calibration bets</span></div>' +
    '<p class="muted">' + currentStatusMessage(cCurrent, "Companion selections are frozen.") + '</p>' +
    (companion ? currentPicksTable(cCurrent, ((companion.forward || {}).daily || []), {
      fixedRoi: (cCal.full || {}).roi,
      fixedRoiDetail: "Calibration · " + Number((cCal.full || {}).bets || 0) + " bets · " + units((cCal.full || {}).net_units),
    }) : '<div class="empty">Companion data unavailable.</div>') + '</article></section>';

  html += '<details class="card section hrp-panel"><summary>Forward ledgers & portfolio</summary>' +
    '<div class="hrp-panel-body"><h2>Combined portfolio</h2>' +
    '<div class="hrp-stats">' + metricCard("Combined ROI", portForward) +
    '<article class="hrp-stat"><span>Settled bets</span><strong>' + Number(portForward.bets || 0) + '</strong><small>' + esc(record(portForward)) + '</small></article>' +
    '<article class="hrp-stat"><span>Profitable slates</span><strong>' + Number(portForward.profitable_slates || 0) + '</strong><small>Forward only</small></article>' +
    '<article class="hrp-stat"><span>Current picks</span><strong>' + Number((portCurrent.picks || []).length) + '</strong><small>Primary + Companion</small></article></div>' +
    (portfolio ? ledgerTable(((portfolio.forward || {}).daily || []), "combined") : '') +
    '<h3>Primary ledger</h3><div class="hrp-stats">' + metricCard("Forward ROI", pForward) +
    '<article class="hrp-stat"><span>Promotion gate</span><strong>' + (pGate.passed ? "PASS" : "TRACKING") + '</strong><small>Independent gate</small></article></div>' +
    ledgerTable((primary.forward || {}).daily || [], "primary") +
    '<h3>Companion ledger</h3><div class="hrp-stats">' + metricCard("Forward ROI", cForward) +
    '<article class="hrp-stat"><span>Promotion gate</span><strong>' + (cGate.passed ? "PASS" : "TRACKING") + '</strong><small>Independent gate</small></article></div>' +
    (companion ? ledgerTable(((companion.forward || {}).daily || []), "companion") : '') + '</div></details>';

  html += '<details class="card section hrp-panel"><summary>Rule evidence</summary><div class="hrp-panel-body">' +
    '<p class="muted">Historical evidence explains why the fixed rules were selected; it does not change today\'s criteria.</p>' +
    '<div class="hrp-evidence-grid"><article><h3>Primary / Selective</h3><div class="hrp-stats">' +
    metricCard("Calibration", pCal) + metricCard("Sep. 6–20", pRetro) + '</div></article>' +
    '<article><h3>Companion / Volume</h3><div class="hrp-stats">' +
    metricCard("Calibration", cCal.full || {}) + metricCard("Early half", cCal.early || {}) +
    metricCard("Late half", cCal.late || {}) + metricCard("Sep. 6–20", cRetro) +
    '</div></article></div></div></details>';

  html += '<details class="card section hrp-panel"><summary>Dynamic validation & prospective ledger</summary><div class="hrp-panel-body">' +
    '<div class="hrp-stats">' + metricCard("Sep 12–25 validation", dynValidationSummary) +
    metricCard("Forward", dynForward) +
    '<article class="hrp-stat"><span>Validation profitable slates</span><strong>' + Number(dynValidationSummary.profitable_slates || 0) + '/' + Number(dynValidationSummary.slates || 0) + '</strong><small>Untouched holdout</small></article>' +
    '<article class="hrp-stat"><span>Selection</span><strong>Top 3 × 2</strong><small>3 cells / checkpoint · 2 players max</small></article></div>' +
    '<div class="notice"><b>Evidence gate:</b> all-time ≥40 settled / 4 wins / 5 slates / positive net; trailing 14d ≥20 bets and ≥10% ROI; trailing 30d positive.</div>' +
    '<h3>Prospective ledger</h3>' + (dynamic ? ledgerTable(((dynamic.forward || {}).daily || []), "dynamic") : '') +
    '<h3>Validation ledger</h3>' + (dynamic ? ledgerTable((dynValidation.daily || []), "dynamic-validation") : '') +
    '</div></details>';

  html += '<details class="card section hrp-panel hrp-experimental"><summary>Experimental adaptive track</summary><div class="hrp-panel-body">' +
    '<p class="muted">Separately tracked research system. It does not enter the official Primary + Companion portfolio.</p>' +
    '<div class="hrp-stats">' + metricCard("Experimental forward", expForward) +
    '<article class="hrp-stat"><span>Checkpoints</span><strong>4</strong><small>08:17 · 11:17 · 17:17 · 20:17</small></article>' +
    '<article class="hrp-stat"><span>Portfolio impact</span><strong>NONE</strong><small>Tracked separately</small></article></div>' +
    (experimental ? experimentalCheckpointCards(expCurrent) : '') +
    (experimental ? currentPicksTable(expCurrent, ((experimental.forward || {}).daily || []), { showCell: true }) : '') +
    (experimental ? ledgerTable(((experimental.forward || {}).daily || []), "experimental") : '') +
    '</div></details>';

  html += '<details class="card section hrp-panel"><summary>Execution guardrails</summary><div class="hrp-panel-body"><table><tbody>' +
    '<tr><td>Primary</td><td>17:17 ET · score 0.100–0.199 · +400–499 · any archived best-price book · top 3.</td></tr>' +
    '<tr><td>Companion</td><td>17:17 ET · score ≥0.200 · DraftKings is archived best price · odds below +400 · top 10.</td></tr>' +
    '<tr><td>Dynamic</td><td>Four checkpoints; evidence is prior-only; top 3 qualifying cells and top 2 players per checkpoint; first qualifying checkpoint per player wins.</td></tr>' +
    '<tr><td>Price handling</td><td>Original checkpoint book and price are permanent. Settlement only changes result and profit.</td></tr>' +
    '<tr><td>Stake</td><td>1 flat unit per unique HR prop. No plate appearance is void.</td></tr></tbody></table></div></details>';

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
  ".hrp-hero{margin-top:0}",
  ".hrp-today{border-width:2px}",
  ".hrp-today-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
  ".hrp-today-grid>.section{margin-top:0}",
  ".hrp-rule-strip{display:flex;flex-wrap:wrap;gap:8px 16px;margin:12px 0;font-size:.86rem;color:var(--muted,#8492a6)}",
  ".hrp-panel>summary{font-size:1.05rem;font-weight:800;cursor:pointer;padding:2px 0}",
  ".hrp-panel-body{margin-top:18px}",
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
  "@media(max-width:800px){.hrp-stats,.hrp-checkpoint-grid,.hrp-rule-grid,.hrp-evidence-grid,.hrp-today-grid{grid-template-columns:1fr 1fr}}",
  "@media(max-width:520px){.hrp-stats,.hrp-checkpoint-grid,.hrp-rule-grid,.hrp-evidence-grid,.hrp-today-grid{grid-template-columns:1fr}}"
].join("");

document.head.appendChild(style);

const observer = new MutationObserver(() => {
  ensureNav();
  void renderIfNeeded();
});
observer.observe(document.getElementById("app"), { childList: true, subtree: true });
addEventListener("hashchange", () => setTimeout(() => void renderIfNeeded(), 0));
setTimeout(() => void renderIfNeeded(), 0);
