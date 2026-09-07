const UNIFIED_TRACKER_ROUTE = "tracker";

let unifiedTrackerCache = null;
let unifiedTrackerFilter = "all";

const trackerSafe = (value) => value == null || value === "" ? "—" : String(value);
const trackerOdds = (value) => value == null ? "—" : Number(value) > 0 ? `+${Math.round(Number(value))}` : `${Math.round(Number(value))}`;
const trackerPct = (value) => value == null ? "—" : `${Number(value) >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(1)}%`;
const trackerUnits = (value) => value == null ? "—" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}u`;
const trackerScore = (value) => value == null ? "—" : Number(value).toFixed(4);

function trackerRouteActive() {
  return (location.hash.slice(1) || "today") === UNIFIED_TRACKER_ROUTE;
}

async function trackerJson(path) {
  const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

async function loadUnifiedTracker(force = false) {
  if (unifiedTrackerCache && !force) return unifiedTrackerCache;
  const [discovery, recent, board] = await Promise.all([
    trackerJson("/data/discovery.json"),
    trackerJson("/data/recent-hr-rule/ledger.json").catch(() => ({ entries: [], summary: {}, rule: {} })),
    trackerJson("/data/index.json"),
  ]);
  unifiedTrackerCache = { discovery, recent, board };
  return unifiedTrackerCache;
}

function trackerSummary(summary = {}) {
  return `<div class="tracker-metrics">
    <div><strong>${summary.wins || 0}–${summary.losses || 0}</strong><span>Record</span></div>
    <div><strong>${trackerPct(summary.hit_rate)}</strong><span>Hit rate</span></div>
    <div><strong>${trackerUnits(summary.net_units || 0)}</strong><span>Net</span></div>
    <div><strong>${trackerPct(summary.roi)}</strong><span>ROI</span></div>
  </div>`;
}

function activeRuleCard(rule, tone = "") {
  const summary = rule?.summary || {};
  return `<article class="card tracker-rule-card ${tone}">
    <div class="eyebrow">${trackerSafe(rule?.checkpoint)} ET</div>
    <h2>${trackerSafe(rule?.name)}</h2>
    <p class="muted tracker-definition">${trackerSafe(rule?.definition)}</p>
    ${trackerSummary(summary)}
    <p class="muted tracker-small">${summary.pending || 0} pending · ${summary.voids || 0} void · ${summary.selections ?? summary.bets ?? 0} total selections</p>
  </article>`;
}

function recentRuleCard(recent = {}) {
  const summary = recent.summary || {};
  return `<article class="card tracker-rule-card recent">
    <div class="eyebrow">11:17 ET</div>
    <h2>Recent HR Rule</h2>
    <p class="muted tracker-definition">Top-3 form rank · no HR last PA-game · HR exactly two PA-games ago · best available price · 1u flat.</p>
    ${trackerSummary(summary)}
    <p class="muted tracker-small">${summary.pending || 0} pending · forward tracking since ${trackerSafe(recent.started_forward_tracking || "2026-09-07")}</p>
  </article>`;
}

function legacyCard(name, summary = {}, detail = "") {
  return `<article class="card tracker-rule-card legacy">
    <div class="eyebrow">Legacy checkpoint strategy</div>
    <h2>${name}</h2>
    <p class="muted tracker-definition">${detail}</p>
    ${trackerSummary(summary)}
  </article>`;
}

function normalizeActiveEntries(data) {
  const early = data.discovery?.rule_tracking?.rules?.["early-hr"]?.entries || [];
  const late = data.discovery?.rule_tracking?.rules?.["late-hr"]?.entries || [];
  const recent = (data.recent?.entries || []).map((row) => ({
    ...row,
    rule_id: "recent-hr",
    rule_name: "Recent HR Rule",
    checkpoint: row.checkpoint === "1117" ? "11:17" : row.checkpoint,
    team: row.team,
    matchup: row.matchup,
    home_runs: row.home_runs,
  }));
  return [...early, ...late, ...recent];
}

function normalizeLegacyEntries(board = {}) {
  const rows = [];
  for (const snapshot of board.snapshots || []) {
    for (const [portfolioKey, ruleName] of [["top10", "Legacy Top 10"], ["top20", "Legacy Top 20"]]) {
      for (const pick of snapshot.portfolios?.[portfolioKey]?.picks || []) {
        rows.push({
          rule_id: portfolioKey,
          rule_name: ruleName,
          slate_date: snapshot.slate_date,
          checkpoint: snapshot.checkpoint_et,
          player: pick.player,
          team: pick.batter_team,
          matchup: pick.opponent,
          rank: pick.rank,
          score: pick.score,
          odds: pick.odds,
          book: pick.sportsbook,
          result: pick.result || "PENDING",
          profit_units: pick.profit_units,
          home_runs: pick.home_runs,
          game_time_et: pick.game_time_et,
        });
      }
    }
  }
  return rows;
}

function trackerCheckpointSort(value) {
  return String(value || "").replace(/\D/g, "").padStart(4, "0");
}

function combinedLedger(data) {
  return [...normalizeActiveEntries(data), ...normalizeLegacyEntries(data.board)]
    .sort((a, b) => {
      const byDate = String(b.slate_date || "").localeCompare(String(a.slate_date || ""));
      if (byDate) return byDate;
      const byCheckpoint = trackerCheckpointSort(b.checkpoint).localeCompare(trackerCheckpointSort(a.checkpoint));
      if (byCheckpoint) return byCheckpoint;
      return Number(a.rank || 999) - Number(b.rank || 999);
    });
}

function trackerFilters() {
  const options = [
    ["all", "All rules"],
    ["early-hr", "Early HR"],
    ["late-hr", "Late HR"],
    ["recent-hr", "Recent HR"],
    ["top10", "Legacy Top 10"],
    ["top20", "Legacy Top 20"],
  ];
  return `<div class="tabs tracker-tabs">${options.map(([key, label]) => `<button data-tracker-rule="${key}" class="${unifiedTrackerFilter === key ? "active" : ""}">${label}</button>`).join("")}</div>`;
}

function trackerLedger(data) {
  const rows = combinedLedger(data).filter((row) => unifiedTrackerFilter === "all" || row.rule_id === unifiedTrackerFilter);
  if (!rows.length) return '<div class="empty">No selections are recorded for this rule yet.</div>';
  return `<div class="tablewrap"><table class="tracker-ledger">
    <thead><tr><th>Date</th><th>Rule</th><th>Checkpoint</th><th>Player</th><th>Rank</th><th>Score</th><th>Odds</th><th>Book</th><th>Result</th><th>HR</th><th>P/L</th><th>Game</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td>${trackerSafe(row.slate_date)}</td>
      <td><span class="pill">${trackerSafe(row.rule_name)}</span></td>
      <td>${trackerSafe(row.checkpoint)}</td>
      <td><b>${trackerSafe(row.player)}</b><div class="muted">${trackerSafe(row.team)}</div></td>
      <td>${trackerSafe(row.rank)}</td>
      <td>${trackerScore(row.score)}</td>
      <td class="plus">${trackerOdds(row.odds)}</td>
      <td>${trackerSafe(row.book)}</td>
      <td class="${String(row.result || "").toUpperCase() === "WIN" ? "win" : String(row.result || "").toUpperCase() === "LOSS" ? "loss" : ""}"><b>${trackerSafe(row.result)}</b></td>
      <td>${trackerSafe(row.home_runs)}</td>
      <td class="${Number(row.profit_units || 0) >= 0 ? "plus" : "loss"}">${trackerUnits(row.profit_units)}</td>
      <td>${trackerSafe(row.game_time_et || row.matchup)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function unifiedTrackerMarkup(data) {
  const early = data.discovery?.rule_tracking?.rules?.["early-hr"];
  const late = data.discovery?.rule_tracking?.rules?.["late-hr"];
  const trackingStart = data.discovery?.rule_tracking?.started_forward_tracking || "2026-08-31";
  const top10 = data.board?.aggregate?.top10 || {};
  const top20 = data.board?.aggregate?.top20 || {};

  return `<style>
    .tracker-rule-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.tracker-legacy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.tracker-rule-card{min-height:245px}.tracker-definition{min-height:68px}.tracker-metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:14px}.tracker-metrics>div{border:1px solid var(--line);border-radius:12px;padding:10px}.tracker-metrics strong{display:block;font-size:20px}.tracker-metrics span,.tracker-small{font-size:11px;color:var(--muted)}.tracker-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.tracker-ledger th{position:sticky;top:0;background:#0d1a24;z-index:2}@media(max-width:980px){.tracker-rule-grid,.tracker-legacy-grid{grid-template-columns:1fr}.tracker-definition{min-height:0}}
  </style>
  <div class="shell">
    <header class="top">
      <div><div class="brand">HR <span>Form Board</span> <span class="pill">All-rule tracker</span></div><div class="muted">Forward performance across every published HR rule</div></div>
      <nav><a class="nav" href="#today">Today</a><a class="nav" href="#scores">Top 100 Scores</a><a class="nav" href="#discovery">Discovery</a><a class="nav active" href="#tracker">Tracker</a><a class="nav" href="#data">Data</a><a class="nav" href="#method">Method</a></nav>
    </header>

    <section class="hero">
      <div class="card"><div class="eyebrow">Unified forward tracker</div><h1>Every rule.<br>One ledger.</h1><p class="muted">Early HR, Late HR, Recent HR, and the original Top-10/Top-20 checkpoint strategies are tracked separately and together. Discovery/backtest ROI is not mixed into these forward records.</p><div class="notice"><b>Early/Late forward start:</b> ${trackerSafe(trackingStart)}. <b>Recent HR forward start:</b> ${trackerSafe(data.recent?.started_forward_tracking || "2026-09-07")}.</div></div>
      <div class="card"><div class="eyebrow">Current tracker state</div><h2>${combinedLedger(data).length} recorded selections</h2><p class="muted">Pending bets remain visible but do not enter ROI until settled. Voids do not count as bets.</p><button id="trackerRefresh">Refresh tracker</button></div>
    </section>

    <section class="section"><div class="tracker-rule-grid">
      ${early ? activeRuleCard(early, "early") : '<article class="card tracker-rule-card"><h2>Early HR</h2><div class="empty">Rule ledger is rebuilding.</div></article>'}
      ${late ? activeRuleCard(late, "late") : '<article class="card tracker-rule-card"><h2>Late HR</h2><div class="empty">Rule ledger is rebuilding.</div></article>'}
      ${recentRuleCard(data.recent)}
    </div></section>

    <section class="card section"><div class="eyebrow">Original tracker strategies</div><h2>Legacy Top-10 / Top-20 portfolios</h2><p class="muted">These are preserved so the old tracker history is not lost; they are no longer the only strategies shown on this page.</p><div class="tracker-legacy-grid">${legacyCard("Legacy Top 10", top10, "Original checkpoint Top-10 portfolio across 8:17, 11:17, 17:17 and 20:17 ET.")}${legacyCard("Legacy Top 20", top20, "Original checkpoint Top-20 portfolio across 8:17, 11:17, 17:17 and 20:17 ET.")}</div></section>

    <section class="card section"><div class="tracker-actions"><div><div class="eyebrow">Combined forward ledger</div><h2>All rule selections</h2></div>${trackerFilters()}</div>${trackerLedger(data)}</section>
    <footer class="footer">Active-rule results use immutable checkpoint prices and official MLB outcomes. Discovery evidence remains on the Discovery and Recent HR pages and is not counted as forward tracker performance.</footer>
  </div>`;
}

async function renderUnifiedTracker(force = false) {
  if (!trackerRouteActive()) return;
  const app = document.querySelector("#app");
  if (!app) return;
  app.innerHTML = '<div class="shell"><div class="card empty">Loading all rule ledgers…</div></div>';
  try {
    const data = await loadUnifiedTracker(force);
    if (!trackerRouteActive()) return;
    app.innerHTML = unifiedTrackerMarkup(data);
    document.querySelectorAll("[data-tracker-rule]").forEach((button) => {
      button.onclick = () => {
        unifiedTrackerFilter = button.dataset.trackerRule || "all";
        app.innerHTML = unifiedTrackerMarkup(data);
        bindUnifiedTrackerControls(data);
      };
    });
    bindUnifiedTrackerControls(data);
  } catch (error) {
    console.error(error);
    app.innerHTML = `<div class="shell"><div class="card"><h2>Tracker unavailable</h2><p class="loss">${trackerSafe(error.message)}</p></div></div>`;
  }
}

function bindUnifiedTrackerControls(data) {
  document.querySelectorAll("[data-tracker-rule]").forEach((button) => {
    button.onclick = () => {
      unifiedTrackerFilter = button.dataset.trackerRule || "all";
      const app = document.querySelector("#app");
      if (!app) return;
      app.innerHTML = unifiedTrackerMarkup(data);
      bindUnifiedTrackerControls(data);
    };
  });
  const refresh = document.querySelector("#trackerRefresh");
  if (refresh) refresh.onclick = () => renderUnifiedTracker(true);
}

addEventListener("hashchange", () => {
  if (trackerRouteActive()) queueMicrotask(() => renderUnifiedTracker(false));
});

if (trackerRouteActive()) queueMicrotask(() => renderUnifiedTracker(false));
