const state = { route: location.hash.slice(1) || "today", portfolio: "top10" };
const nav = [["today", "Today"], ["tracker", "Tracker"], ["data", "Data"], ["method", "Method"]];
let D = { checkpoints_et: ["08:17", "11:17", "17:17", "20:17"], aggregate: { top10: {}, top20: {} }, snapshots: [] };

try {
  const response = await fetch("/data/index.json", { cache: "no-store" });
  if (response.ok) D = await response.json();
} catch (error) {
  console.error(error);
}

addEventListener("hashchange", () => {
  state.route = location.hash.slice(1) || "today";
  render();
});

const safe = (value) => value == null || value === "" ? "—" : String(value);
const odds = (value) => value == null ? "—" : value > 0 ? `+${value}` : String(value);
const pct = (value) => value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const units = (value) => value == null ? "—" : `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)}u`;

function layout(body) {
  return `<div class="shell">
    <header class="top">
      <div><div class="brand">HR <span>Form Board</span> <span class="pill">GitHub Actions edition</span></div><div class="muted">Independent from ChatGPT Scheduled Tasks</div></div>
      <nav>${nav.map(([route, label]) => `<a class="nav ${state.route === route ? "active" : ""}" href="#${route}">${label}</a>`).join("")}</nav>
    </header>
    ${body}
    <footer class="footer">Prices come only from the user-owned MLB HR Edge database. No sportsbook or odds provider is queried by this site.</footer>
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

function tabs() {
  return `<div class="tabs"><button data-p="top10" class="${state.portfolio === "top10" ? "active" : ""}">Top 10</button><button data-p="top20" class="${state.portfolio === "top20" ? "active" : ""}">Top 20</button></div>`;
}

function bindTabs() {
  document.querySelectorAll("[data-p]").forEach((button) => {
    button.onclick = () => {
      state.portfolio = button.dataset.p;
      render();
    };
  });
}

function sourceOf(snapshot) {
  return snapshot?.sources?.mlb_hr_edge || {};
}

function snapshots() {
  return [...(D.snapshots || [])].sort((a, b) => `${b.slate_date}_${b.checkpoint_et}`.localeCompare(`${a.slate_date}_${a.checkpoint_et}`));
}

function allPriceText(pick) {
  return (pick.all_prices || []).map((price) => `${safe(price.book)} ${odds(price.odds)} @ ${safe(price.captured_at)}`).join(" | ") || "—";
}

function pickRows(picks = []) {
  return picks.map((pick) => `<tr>
    <td>${safe(pick.rank)}</td>
    <td><b>${safe(pick.player)}</b><div class="muted">${safe(pick.batter_team)} · ${safe(pick.opponent)}</div></td>
    <td>${Number(pick.score || 0).toFixed(4)}</td>
    <td>${safe(pick.hr_games_l5)} / ${safe(pick.hr_games_l7)} / ${safe(pick.hr_games_l15)}</td>
    <td class="plus">${odds(pick.odds)}</td>
    <td>${safe(pick.sportsbook)}</td>
    <td>${pick.dk_odds == null ? "Unavailable" : odds(pick.dk_odds)}</td>
    <td>${safe(pick.game_time_et)}</td>
    <td><span class="${pick.result === "WIN" ? "win" : pick.result === "LOSS" ? "loss" : ""}">${safe(pick.result || "PENDING")}</span></td>
    <td>${pick.profit_units == null ? "—" : units(pick.profit_units)}</td>
    <td>${safe(pick.best_price_captured_at)}</td>
    <td>${safe(pick.best_source_event_id)} / ${safe(pick.best_source_odd_id)}</td>
    <td>${allPriceText(pick)}</td>
  </tr>`).join("");
}

function pickTable(picks = []) {
  if (!picks.length) return '<div class="empty">No selections were frozen for this portfolio.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>#</th><th>Player</th><th>Score</th><th>L5/L7/L15</th><th>Best odds</th><th>Best book</th><th>DK</th><th>Game ET</th><th>Result</th><th>P/L</th><th>Captured</th><th>Source IDs</th><th>All shared prices</th></tr></thead><tbody>${pickRows(picks)}</tbody></table></div>`;
}

function todayPage() {
  const ordered = snapshots();
  const latestDate = ordered[0]?.slate_date || null;
  const today = ordered.filter((snapshot) => snapshot.slate_date === latestDate);
  const aggregate = D.aggregate?.[state.portfolio] || {};
  const latest = today[0];
  const latestSource = sourceOf(latest);

  return layout(`<section class="hero">
    <div class="card"><div class="eyebrow">Cloud-run free tracker</div><h1>Today’s frozen<br>HR form board.</h1><p class="muted">Corrected cumulative form is combined with the same persisted FanDuel, DraftKings, and BetMGM snapshot used by your MLB HR Edge site.</p><div class="notice"><b>Single external request:</b> MLB HR Edge refreshes at 8:00 AM, 11:00 AM, 5:00 PM and 8:00 PM ET. Both form trackers read that shared snapshot at 8:17 AM, 11:17 AM, 5:17 PM and 8:17 PM ET.</div></div>
    <div class="card"><h2>All-time ${state.portfolio === "top10" ? "Top 10" : "Top 20"}</h2>${tabs()}${metrics(aggregate)}</div>
  </section>
  <section class="card section"><div class="eyebrow">Today</div><h2>${latestDate ? `Slate ${latestDate}` : "Checkpoint status"}</h2><div class="grid4">${(D.checkpoints_et || []).map((checkpoint) => {
    const snapshot = today.find((row) => row.checkpoint_et === checkpoint);
    const source = sourceOf(snapshot);
    const portfolio = snapshot?.portfolios?.[state.portfolio];
    return `<div class="card checkpoint"><h2>${checkpoint} ET</h2>${snapshot ? `<p><span class="pill">${safe(snapshot.status)}</span></p><p class="muted">Shared rows: ${safe(source.row_count ?? 0)}</p><p class="muted">Source capture: ${safe(source.generated_at)}</p><p><b>${portfolio?.picks?.length || 0}</b> frozen selections</p>` : '<p><span class="pill">Pending</span></p><p class="muted">No immutable snapshot committed yet.</p>'}</div>`;
  }).join("")}</div></section>
  <section class="card section"><div class="eyebrow">Latest shared snapshot</div><h2>${latest ? `${latest.slate_date} · ${latest.checkpoint_et} ET` : "No source snapshot yet"}</h2><p class="muted">Source: ${safe(latestSource.source)} · As-of: ${safe(latestSource.as_of)} · Generated: ${safe(latestSource.generated_at)} · Rows: ${safe(latestSource.row_count ?? 0)}</p>${latest ? pickTable(latest.portfolios?.[state.portfolio]?.picks || []) : '<div class="empty">No Action-generated snapshot has been committed yet.</div>'}</section>`);
}

function trackerPage() {
  const ordered = snapshots();
  const aggregate = D.aggregate?.[state.portfolio] || {};
  return layout(`<section class="card"><div class="eyebrow">Tracked performance</div><h2>${state.portfolio === "top10" ? "Top 10" : "Top 20"} portfolio</h2>${tabs()}${metrics(aggregate)}</section>
  <section class="card section"><div class="eyebrow">Immutable checkpoint ledger</div><h2>All tracked snapshots</h2>${ordered.length ? ordered.map((snapshot) => {
    const source = sourceOf(snapshot);
    const portfolio = snapshot.portfolios?.[state.portfolio];
    return `<article class="card section"><h2>${snapshot.slate_date} · ${snapshot.checkpoint_et} ET</h2><p class="muted">Status: ${safe(snapshot.status)} · Captured ${safe(snapshot.observed_at_et)} · Shared source ${safe(source.generated_at)} · As-of ${safe(source.as_of)}</p>${portfolio ? metrics(portfolio.summary || {}) : '<div class="notice">No portfolio was frozen at this checkpoint.</div>'}${pickTable(portfolio?.picks || [])}</article>`;
  }).join("") : '<div class="empty">No tracked snapshots yet.</div>'}</section>`);
}

function dataPage() {
  const ordered = snapshots();
  return layout(`<section class="grid2">
    <div class="card"><div class="eyebrow">Odds data</div><h2>One shared market snapshot</h2><p class="muted">Only `mlb-hr-fair-odds-v1` calls the external provider. It stores timestamped FanDuel, DraftKings, and BetMGM 1+ HR prices in MLB HR Edge. This site reads that database only.</p></div>
    <div class="card"><div class="eyebrow">MLB data</div><h2>Form and settlement</h2><p class="muted">Exact MLB batter IDs, game IDs, schedules and prior PA-games produce the cumulative form score. Official MLB game logs settle each frozen selection.</p></div>
  </section>
  <section class="card section"><h2>Validation gates</h2><table><tbody>
    <tr><td>Database-backed MLB HR Edge response</td><td class="plus">Required</td></tr>
    <tr><td>Shared capture no more than 60 minutes old</td><td class="plus">Required</td></tr>
    <tr><td>Price captured at or before checkpoint `asOf`</td><td class="plus">Required</td></tr>
    <tr><td>Price captured before first pitch</td><td class="plus">Required</td></tr>
    <tr><td>Confirmed lineup and exact MLB batter ID</td><td class="plus">Required</td></tr>
    <tr><td>At least 15 prior PA-games</td><td class="plus">Required</td></tr>
    <tr><td>Correct cumulative L5/L7/L15 score</td><td class="plus">Required</td></tr>
    <tr><td>Best verified FD/DK/MGM price at +500 or longer</td><td class="plus">Required</td></tr>
    <tr><td>Book, capture time, event ID and odd ID preserved</td><td class="plus">Required</td></tr>
    <tr><td>Missing or stale shared price</td><td class="plus">No fallback</td></tr>
  </tbody></table></section>
  <section class="card section"><div class="eyebrow">Source log</div><h2>Checkpoint source status</h2>${ordered.length ? `<div class="tablewrap"><table><thead><tr><th>Slate</th><th>Checkpoint</th><th>Status</th><th>Shared rows</th><th>Source generated</th><th>As-of cutoff</th><th>Captured ET</th></tr></thead><tbody>${ordered.map((snapshot) => {
    const source = sourceOf(snapshot);
    return `<tr><td>${safe(snapshot.slate_date)}</td><td>${safe(snapshot.checkpoint_et)}</td><td>${safe(snapshot.status)}</td><td>${safe(source.row_count ?? 0)}</td><td>${safe(source.generated_at)}</td><td>${safe(source.as_of)}</td><td>${safe(snapshot.observed_at_et)}</td></tr>`;
  }).join("")}</tbody></table></div>` : '<div class="empty">No source runs have been committed yet.</div>'}</section>`);
}

function methodPage() {
  return layout(`<section class="hero">
    <div class="card"><div class="eyebrow">Locked benchmark</div><h2>Cumulative form score</h2><p><b>Score = 0.50 × (HR games L5 ÷ 5) + 0.30 × (HR games L7 ÷ 7) + 0.20 × (HR games L15 ÷ 15).</b></p><p class="muted">The L7 window includes the L5 games and the L15 window includes the L7 games. A multi-HR game counts as one HR game.</p></div>
    <div class="card"><div class="eyebrow">Eligibility</div><h2>Price after form</h2><p class="muted">Players are ranked by form first. Only confirmed-lineup players with 15 prior PA-games, an unstarted game, and a shared verified 1+ HR price of +500 or longer are eligible.</p></div>
  </section>
  <section class="grid2 section">
    <div class="card"><h2>Single-call architecture</h2><p>MLB HR Edge makes one provider request per refresh and stores all three books. The two form trackers only read the persisted result.</p></div>
    <div class="card"><h2>Checkpoint integrity</h2><p>Every read includes the exact checkpoint timestamp as `asOf`; later or stale prices cannot enter an earlier snapshot.</p></div>
    <div class="card"><h2>Separate portfolios</h2><p>Top 10 and Top 20 maintain separate record, units, ROI, hit rate and checkpoint history.</p></div>
    <div class="card"><h2>Audit trail</h2><p>Every selected price preserves bookmaker, odds, capture time, provider event ID, provider odd ID, MLB batter ID, MLB game ID and game start.</p></div>
    <div class="card"><h2>Four immutable checks</h2><p>8:17 AM, 11:17 AM, 5:17 PM and 8:17 PM ET. Later checkpoints never overwrite earlier selections.</p></div>
    <div class="card"><h2>Settlement</h2><p>Every pick is tracked at one flat unit and settled from official MLB game logs.</p></div>
  </section>`);
}

function render() {
  const page = { today: todayPage, tracker: trackerPage, data: dataPage, method: methodPage }[state.route] || todayPage;
  document.querySelector("#app").innerHTML = page();
  bindTabs();
}

render();
