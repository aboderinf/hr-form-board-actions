const state = {
  route: location.hash.slice(1) || "today",
  portfolio: "top10",
  discoveryPeriod: "rolling_14d",
};

const nav = [
  ["today", "Today"],
  ["scores", "Top 100 Scores"],
  ["discovery", "Discovery"],
  ["tracker", "Tracker"],
  ["data", "Data"],
  ["method", "Method"],
];

let D = {
  checkpoints_et: ["08:17", "11:17", "17:17", "20:17"],
  aggregate: { top10: {}, top20: {} },
  latest: null,
  snapshots: [],
};
let T = { status: "loading", players: [], player_pool_count: 0, scored_player_count: 0 };
let X = { status: "collecting", reports: {}, recent_captures: [], methodology: {} };

try {
  const [board, scores, discovery] = await Promise.all([
    fetch("/data/index.json", { cache: "no-store" }),
    fetch("/data/top100.json", { cache: "no-store" }),
    fetch("/data/discovery.json", { cache: "no-store" }),
  ]);
  if (board.ok) D = await board.json();
  if (scores.ok) T = await scores.json();
  if (discovery.ok) X = await discovery.json();
} catch (error) {
  console.error(error);
}

addEventListener("hashchange", () => {
  state.route = location.hash.slice(1) || "today";
  render();
});

const safe = (value) => value == null || value === "" ? "—" : String(value);
const odds = (value) => value == null ? "—" : Number(value) > 0 ? `+${Math.round(Number(value))}` : `${Math.round(Number(value))}`;
const pct = (value) => value == null ? "—" : `${Number(value) >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(1)}%`;
const units = (value) => value == null ? "—" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}u`;
const score = (value) => value == null ? "—" : Number(value).toFixed(4);

function layout(body) {
  return `<div class="shell">
    <header class="top">
      <div>
        <div class="brand">HR <span>Form Board</span> <span class="pill">GitHub Actions edition</span></div>
        <div class="muted">Independent from ChatGPT Scheduled Tasks</div>
      </div>
      <nav>${nav.map(([route, label]) => `<a class="nav ${state.route === route ? "active" : ""}" href="#${route}">${label}</a>`).join("")}</nav>
    </header>
    ${body}
    <footer class="footer">Odds-based views read MLB HR Edge only. Top 100 Scores and settlement use official MLB data. This site never calls SportsGameOdds directly.</footer>
  </div>`;
}

function metrics(summary = {}) {
  return `<div class="grid">
    <div class="card"><div class="metric"><strong>${summary.wins || 0}–${summary.losses || 0}${summary.pushes ? `–${summary.pushes}P` : ""}</strong><span>Record</span></div></div>
    <div class="card"><div class="metric"><strong>${pct(summary.hit_rate)}</strong><span>Hit rate</span></div></div>
    <div class="card"><div class="metric"><strong>${units(summary.net_units || 0)}</strong><span>Net units</span></div></div>
    <div class="card"><div class="metric"><strong>${pct(summary.roi)}</strong><span>ROI</span></div></div>
  </div>`;
}

function portfolioTabs() {
  return `<div class="tabs">
    <button data-p="top10" class="${state.portfolio === "top10" ? "active" : ""}">Top 10</button>
    <button data-p="top20" class="${state.portfolio === "top20" ? "active" : ""}">Top 20</button>
  </div>`;
}

function bindControls() {
  document.querySelectorAll("[data-p]").forEach((button) => {
    button.onclick = () => {
      state.portfolio = button.dataset.p;
      render();
    };
  });
  document.querySelectorAll("[data-period]").forEach((button) => {
    button.onclick = () => {
      state.discoveryPeriod = button.dataset.period;
      render();
    };
  });
}

function orderedSnapshots() {
  return [...(D.snapshots || [])].sort((a, b) => `${b.slate_date}_${b.checkpoint_et}`.localeCompare(`${a.slate_date}_${a.checkpoint_et}`));
}

function sourceOf(snapshot) {
  return snapshot?.sources?.mlb_hr_edge || {};
}

function allPrices(pick) {
  return (pick.all_prices || []).map((row) => `${safe(row.book)} ${odds(row.odds)} @ ${safe(row.captured_at)}`).join(" | ") || "—";
}

function pickRows(picks = []) {
  return picks.map((pick) => `<tr>
    <td>${safe(pick.rank)}</td>
    <td><b>${safe(pick.player)}</b><div class="muted">${safe(pick.batter_team)} · ${safe(pick.opponent)}</div></td>
    <td>${score(pick.score)}</td>
    <td>${safe(pick.hr_games_l5)} / ${safe(pick.hr_games_l7)} / ${safe(pick.hr_games_l15)}</td>
    <td class="plus">${odds(pick.odds)}</td>
    <td>${safe(pick.sportsbook)}</td>
    <td>${pick.dk_odds == null ? "Unavailable" : odds(pick.dk_odds)}</td>
    <td>${safe(pick.game_time_et)}</td>
    <td>${safe(pick.result)}</td>
    <td>${safe(pick.best_price_captured_at)}</td>
    <td>${allPrices(pick)}</td>
  </tr>`).join("");
}

function pickTable(picks = []) {
  if (!picks.length) return '<div class="empty">No eligible players are currently available.</div>';
  return `<div class="tablewrap"><table>
    <thead><tr><th>#</th><th>Player</th><th>Score</th><th>L5/L7/L15</th><th>Best odds</th><th>Best book</th><th>DK</th><th>Game ET</th><th>Status</th><th>Captured</th><th>All shared prices</th></tr></thead>
    <tbody>${pickRows(picks)}</tbody>
  </table></div>`;
}

function latestSection() {
  const latest = D.latest;
  const source = sourceOf(latest);
  const portfolio = latest?.portfolios?.[state.portfolio];
  if (!latest) {
    return `<section class="card section"><div class="eyebrow">Latest MLB HR Edge slate</div><h2>Refresh pending</h2><div class="empty">No latest-slate refresh has been committed yet.</div></section>`;
  }
  return `<section class="card section">
    <div class="eyebrow">Current board · not added to tracked results</div>
    <h2>Latest MLB HR Edge slate: ${safe(latest.slate_date)}</h2>
    <p><span class="pill">${safe(latest.status)}</span></p>
    <p class="muted">HR Edge capture: ${safe(source.generated_at)} · Form Board refresh: ${safe(latest.refreshed_at_et)} · Shared rows: ${safe(source.row_count ?? 0)} · Eligible: ${safe(latest.eligible_candidates ?? 0)}</p>
    ${pickTable(portfolio?.picks || [])}
  </section>`;
}

function todayPage() {
  const snapshots = orderedSnapshots();
  const slateDate = snapshots[0]?.slate_date;
  const today = snapshots.filter((row) => row.slate_date === slateDate);
  const aggregate = D.aggregate?.[state.portfolio] || {};
  return layout(`<section class="hero">
    <div class="card">
      <div class="eyebrow">Current + tracked</div>
      <h1>Latest shared<br>HR form board.</h1>
      <p class="muted">The current panel uses the newest persisted MLB HR Edge slate. Scheduled checkpoints remain immutable and are tracked separately.</p>
      <div class="notice"><b>Shared fetches:</b> 8:17 AM, 11:17 AM, 5:17 PM and 8:17 PM ET.</div>
    </div>
    <div class="card"><h2>Tracked ${state.portfolio === "top10" ? "Top 10" : "Top 20"}</h2>${portfolioTabs()}${metrics(aggregate)}</div>
  </section>
  ${latestSection()}
  <section class="card section"><div class="eyebrow">Immutable checkpoint status</div><h2>${slateDate ? `Tracked slate ${slateDate}` : "No tracked slate yet"}</h2>
    <div class="grid4">${(D.checkpoints_et || []).map((checkpoint) => {
      const snapshot = today.find((row) => row.checkpoint_et === checkpoint);
      const portfolio = snapshot?.portfolios?.[state.portfolio];
      return `<div class="card checkpoint"><h2>${checkpoint} ET</h2>${snapshot ? `<p><span class="pill">${safe(snapshot.status)}</span></p><p><b>${portfolio?.picks?.length || 0}</b> frozen selections</p>` : '<p><span class="pill">Pending</span></p>'}</div>`;
    }).join("")}</div>
  </section>`);
}

function scoresPage() {
  const players = T.players || [];
  return layout(`<section class="hero">
    <div class="card">
      <div class="eyebrow">Odds-independent form scan</div>
      <h1>Top 100<br>form scores.</h1>
      <p class="muted">Every current-season MLB hitter can enter this list. No lineup confirmation or sportsbook price is required.</p>
      <div class="notice">Players with fewer than 15 prior PA-games can rank when they are in HR form. They are labeled <b>Provisional</b>, and missing pre-debut games contribute zero rather than inflating the score.</div>
    </div>
    <div class="card"><div class="grid"><div class="metric"><strong>${safe(T.player_pool_count || 0)}</strong><span>Hitters scanned</span></div><div class="metric"><strong>${safe(T.scored_player_count || 0)}</strong><span>In HR form</span></div><div class="metric"><strong>${safe(players.length)}</strong><span>Published</span></div><div class="metric"><strong>${safe(T.generated_at_et)}</strong><span>Updated ET</span></div></div></div>
  </section>
  <section class="card section">
    <div class="eyebrow">Current leaderboard</div><h2>${safe(T.slate_date)} · ${safe(T.status)}</h2>
    ${players.length ? `<div class="tablewrap"><table><thead><tr><th>#</th><th>Player</th><th>Team</th><th>Score</th><th>HR games L5</th><th>L7</th><th>L15</th><th>Total HR L15</th><th>Games available</th><th>Sample</th></tr></thead><tbody>${players.map((player) => `<tr><td>${safe(player.rank)}</td><td><b>${safe(player.player)}</b></td><td>${safe(player.team)}</td><td class="plus">${score(player.score)}</td><td>${safe(player.hr_games_l5)}</td><td>${safe(player.hr_games_l7)}</td><td>${safe(player.hr_games_l15)}</td><td>${safe(player.home_runs_l15)}</td><td>${safe(player.games_available)}</td><td><span class="pill">${safe(player.sample_status)}</span></td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">The leaderboard has not been generated yet.</div>'}
  </section>`);
}

function discoveryPeriodTabs() {
  const options = [
    ["rolling_14d", "Last 14 days"],
    ["calendar_month", "Current month"],
    ["all_time", "All time"],
  ];
  return `<div class="tabs">${options.map(([key, label]) => `<button data-period="${key}" class="${state.discoveryPeriod === key ? "active" : ""}">${label}</button>`).join("")}</div>`;
}

function discoveryMetrics(period = {}) {
  const overall = period.overall || {};
  return `<div class="grid">
    <div class="card"><div class="metric"><strong>${overall.wins || 0}–${overall.losses || 0}</strong><span>Record</span></div></div>
    <div class="card"><div class="metric"><strong>${units(overall.net_units || 0)}</strong><span>Net units</span></div></div>
    <div class="card"><div class="metric"><strong>${pct(overall.roi)}</strong><span>ROI</span></div></div>
    <div class="card"><div class="metric"><strong>${safe(period.unique_player_games || 0)}</strong><span>Unique player-games</span></div></div>
  </div>`;
}

function segmentTable(title, rows = []) {
  return `<section class="card section"><div class="eyebrow">Discovery segment</div><h2>${title}</h2>${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Segment</th><th>Bets</th><th>Record</th><th>Hit rate</th><th>Avg odds</th><th>Net units</th><th>ROI</th><th>Avg score</th></tr></thead><tbody>${rows.map((row) => `<tr><td><b>${safe(row.label)}</b></td><td>${safe(row.settled || 0)}</td><td>${row.wins || 0}–${row.losses || 0}</td><td>${pct(row.hit_rate)}</td><td>${odds(row.average_odds)}</td><td class="${Number(row.net_units || 0) >= 0 ? "plus" : "loss"}">${units(row.net_units || 0)}</td><td>${pct(row.roi)}</td><td>${score(row.average_score)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No settled priced player-games are available for this segment yet.</div>'}</section>`;
}

function playerDiscoveryTable(rows = []) {
  return `<section class="card section"><div class="eyebrow">Specific players</div><h2>Player-level opportunities and streaks</h2>${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Player</th><th>Team</th><th>Bets</th><th>Record</th><th>Hit rate</th><th>Avg odds</th><th>Net units</th><th>ROI</th><th>Current streak</th><th>Longest hit</th><th>Longest miss</th></tr></thead><tbody>${rows.map((row) => `<tr><td><b>${safe(row.player)}</b></td><td>${safe(row.team)}</td><td>${safe(row.settled || 0)}</td><td>${row.wins || 0}–${row.losses || 0}</td><td>${pct(row.hit_rate)}</td><td>${odds(row.average_odds)}</td><td class="${Number(row.net_units || 0) >= 0 ? "plus" : "loss"}">${units(row.net_units || 0)}</td><td>${pct(row.roi)}</td><td>${safe(row.current_streak)}</td><td>${safe(row.longest_hit_streak)}</td><td>${safe(row.longest_miss_streak)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">Player discovery statistics will appear after priced selections settle.</div>'}</section>`;
}

function archiveTable(rows = []) {
  return `<section class="card section"><div class="eyebrow">Audit trail</div><h2>Recent Top 100 odds captures</h2>${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Slate</th><th>Checkpoint</th><th>Captured ET</th><th>Top 100 rows</th><th>Priced rows</th><th>Coverage</th><th>Source</th><th>Source capture</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${safe(row.slate_date)}</td><td>${safe(row.checkpoint)}</td><td>${safe(row.captured_at_et)}</td><td>${safe(row.top100_rows)}</td><td>${safe(row.priced_rows)}</td><td>${pct(row.odds_coverage)}</td><td>${safe(row.source_status)}</td><td>${safe(row.source_generated_at)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">The archive is collecting its first checkpoint.</div>'}</section>`;
}

function discoveryPage() {
  const period = X.reports?.[state.discoveryPeriod] || {};
  const labels = { rolling_14d: "Last 14 days", calendar_month: "Current calendar month", all_time: "All archived data" };
  return layout(`<section class="hero">
    <div class="card">
      <div class="eyebrow">Prospective profitability research</div>
      <h1>Discover where<br>the edge lives.</h1>
      <p class="muted">Every Top 100 checkpoint is archived with all available FanDuel, DraftKings, and BetMGM prices. Outcomes are settled from official MLB game logs.</p>
      <div class="notice"><b>Anti-duplication rule:</b> all intraday line movement is preserved, but ROI reports use only the best archived price once per player-game.</div>
    </div>
    <div class="card">
      <h2>${safe(labels[state.discoveryPeriod])}</h2>
      ${discoveryPeriodTabs()}
      <p class="muted">${safe(period.start)} through ${safe(period.end)} · ${safe(period.raw_checkpoint_captures || 0)} priced checkpoint rows before daily de-duplication.</p>
      ${discoveryMetrics(period)}
    </div>
  </section>
  <section class="card section"><div class="eyebrow">Research status</div><h2>${safe(X.status)} · archive started ${safe(X.archive_started)}</h2><div class="grid4"><div class="card checkpoint"><h2>${safe(X.capture_count || 0)}</h2><p class="muted">Checkpoint captures</p></div><div class="card checkpoint"><h2>${safe(X.raw_top100_rows || 0)}</h2><p class="muted">Top 100 rows archived</p></div><div class="card checkpoint"><h2>${safe(X.raw_priced_rows || 0)}</h2><p class="muted">Rows with odds</p></div><div class="card checkpoint"><h2>${safe(X.unique_priced_player_games || 0)}</h2><p class="muted">Unique priced player-games</p></div></div><p class="muted">${safe(X.methodology?.warning)}</p></section>
  ${segmentTable("Profitability by odds range", period.odds_bands || [])}
  ${segmentTable("Profitability by form-score range", period.score_bands || [])}
  ${segmentTable("Profitability by Top 100 rank", period.rank_bands || [])}
  ${playerDiscoveryTable(period.players || [])}
  ${archiveTable(X.recent_captures || [])}
  <section class="card section"><div class="eyebrow">Method</div><h2>How Discovery evaluates an opportunity</h2><table><tbody><tr><td>Odds source</td><td>${safe(X.methodology?.odds_source)}</td></tr><tr><td>Analysis unit</td><td>${safe(X.methodology?.analysis_unit)}</td></tr><tr><td>Staking</td><td>${safe(X.methodology?.staking)}</td></tr><tr><td>Raw archive</td><td>${safe(X.methodology?.capture)}</td></tr></tbody></table></section>`);
}

function trackerPage() {
  const aggregate = D.aggregate?.[state.portfolio] || {};
  const snapshots = orderedSnapshots();
  return layout(`<section class="card"><div class="eyebrow">Tracked performance only</div><h2>${state.portfolio === "top10" ? "Top 10" : "Top 20"} portfolio</h2>${portfolioTabs()}${metrics(aggregate)}</section>
  <section class="card section"><h2>Immutable checkpoint ledger</h2>${snapshots.length ? snapshots.map((snapshot) => {
    const portfolio = snapshot.portfolios?.[state.portfolio];
    const source = sourceOf(snapshot);
    return `<article class="card section"><h2>${safe(snapshot.slate_date)} · ${safe(snapshot.checkpoint_et)} ET</h2><p class="muted">${safe(snapshot.status)} · Source ${safe(source.generated_at)} · As-of ${safe(source.as_of)}</p>${portfolio ? metrics(portfolio.summary || {}) : ""}${pickTable(portfolio?.picks || [])}</article>`;
  }).join("") : '<div class="empty">No tracked snapshots yet.</div>'}</section>`);
}

function dataPage() {
  const latest = D.latest;
  const source = sourceOf(latest);
  return layout(`<section class="grid2">
    <div class="card"><div class="eyebrow">Market source</div><h2>MLB HR Edge only</h2><p class="muted">The Actions site reads persisted FanDuel, DraftKings and BetMGM prices from MLB HR Edge. It makes no direct provider request.</p></div>
    <div class="card"><div class="eyebrow">Discovery archive</div><h2>${safe(X.capture_count || 0)} captures</h2><p class="muted">Top 100 score rows, all available prices, timestamps, source IDs and later MLB outcomes are retained for prospective analysis.</p></div>
  </section>
  <section class="card section"><h2>Data rules</h2><table><tbody>
    <tr><td>Latest board is informational/current</td><td class="plus">Not tracked</td></tr>
    <tr><td>Scheduled checkpoint portfolios</td><td class="plus">Immutable</td></tr>
    <tr><td>Top 100 leaderboard</td><td class="plus">No odds or lineup requirement</td></tr>
    <tr><td>Discovery raw archive</td><td class="plus">All Top 100 rows per checkpoint</td></tr>
    <tr><td>Discovery ROI unit</td><td class="plus">Best price once per player-game</td></tr>
    <tr><td>Outcome source</td><td class="plus">Official MLB game logs</td></tr>
    <tr><td>Direct SportsGameOdds calls</td><td class="plus">None</td></tr>
  </tbody></table></section>
  <section class="card section"><div class="eyebrow">Latest source state</div><h2>${safe(latest?.slate_date)}</h2><p class="muted">Status ${safe(latest?.status)} · Source capture ${safe(source.generated_at)} · Rows ${safe(source.row_count ?? 0)}</p></section>`);
}

function methodPage() {
  return layout(`<section class="hero">
    <div class="card"><div class="eyebrow">Locked formula</div><h2>Cumulative form score</h2><p><b>Score = 0.50 × (HR games L5 ÷ 5) + 0.30 × (HR games L7 ÷ 7) + 0.20 × (HR games L15 ÷ 15).</b></p><p class="muted">L7 contains L5 and L15 contains L7. A multi-HR game counts as one HR game. New hitters can rank provisionally with fixed denominators.</p></div>
    <div class="card"><div class="eyebrow">Three research layers</div><h2>Current, tracked, discovered</h2><p class="muted">Today shows current prices. Tracker measures the locked Top 10/20 strategy. Discovery prospectively tests the entire Top 100 across odds, score, rank and player segments.</p></div>
  </section>`);
}

function render() {
  const page = {
    today: todayPage,
    scores: scoresPage,
    discovery: discoveryPage,
    tracker: trackerPage,
    data: dataPage,
    method: methodPage,
  }[state.route] || todayPage;
  document.querySelector("#app").innerHTML = page();
  bindControls();
}

render();
