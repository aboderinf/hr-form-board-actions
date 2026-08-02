const scoreTableState = {
  sortKey: "rank",
  sortDirection: "asc",
  filter: "all",
  query: "",
  data: null,
  loading: null,
};

const numericKeys = new Set([
  "rank",
  "score",
  "hr_games_l5",
  "hr_games_l7",
  "hr_games_l15",
  "home_runs_l15",
  "games_available",
  "best_odds",
]);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatOdds(value) {
  if (value == null || value === "") return "—";
  const number = Number(value);
  return number > 0 ? `+${Math.round(number)}` : `${Math.round(number)}`;
}

function formatScore(value) {
  return value == null ? "—" : Number(value).toFixed(4);
}

function shortDate(value) {
  if (!value) return "Unknown date";
  const parts = String(value).split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : String(value);
}

function formStrip(player) {
  const games = [...(player.recent_games || [])].slice(0, 15).reverse();
  const missing = Math.max(0, 15 - games.length);
  const cells = [
    ...Array.from({ length: missing }, () => '<span class="form-cell missing" title="No MLB PA-game available">·</span>'),
    ...games.map((game) => {
      const hrs = Number(game.home_runs || 0);
      const title = `${shortDate(game.date)} vs ${game.opponent || "opponent unknown"} · ${game.plate_appearances || 0} PA · ${hrs} HR`;
      return `<span class="form-cell ${hrs > 0 ? "hr" : "no-hr"}" title="${escapeHtml(title)}">${hrs > 0 ? hrs : "–"}</span>`;
    }),
  ];
  return `<div class="form-book" aria-label="Last 15 games, oldest to newest">${cells.join("")}</div><div class="form-caption">oldest → newest</div>`;
}

function priceStack(player) {
  const prices = player.all_prices || [];
  if (!player.odds_available) return '<span class="muted">No shared price</span>';
  const details = prices
    .map((price) => `${escapeHtml(price.book)} ${formatOdds(price.odds)}`)
    .join(" · ");
  return `<div class="price-stack"><strong>${formatOdds(player.best_odds)}</strong><span>${escapeHtml(player.best_book || "")}</span><small title="${escapeHtml(player.odds_captured_at || "")}">${details || "Best shared price"}</small></div>`;
}

function compareValues(a, b, key) {
  let left = a[key];
  let right = b[key];
  if (numericKeys.has(key)) {
    left = left == null ? Number.NEGATIVE_INFINITY : Number(left);
    right = right == null ? Number.NEGATIVE_INFINITY : Number(right);
    return left - right;
  }
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base" });
}

function visiblePlayers() {
  const players = [...(scoreTableState.data?.players || [])];
  const query = scoreTableState.query.trim().toLowerCase();
  const filtered = players.filter((player) => {
    if (scoreTableState.filter === "priced" && !player.odds_available) return false;
    if (scoreTableState.filter === "unpriced" && player.odds_available) return false;
    if (scoreTableState.filter === "provisional" && !player.provisional) return false;
    if (scoreTableState.filter === "established" && player.provisional) return false;
    if (!query) return true;
    return `${player.player || ""} ${player.team || ""}`.toLowerCase().includes(query);
  });
  filtered.sort((a, b) => {
    const compared = compareValues(a, b, scoreTableState.sortKey);
    const direction = scoreTableState.sortDirection === "asc" ? 1 : -1;
    return compared === 0 ? Number(a.rank || 999) - Number(b.rank || 999) : compared * direction;
  });
  return filtered;
}

function sortHeader(key, label) {
  const active = scoreTableState.sortKey === key;
  const arrow = active ? (scoreTableState.sortDirection === "asc" ? " ▲" : " ▼") : "";
  return `<th><button class="sort-button ${active ? "active-sort" : ""}" data-score-sort="${key}">${escapeHtml(label)}${arrow}</button></th>`;
}

function renderEnhancedScores(section) {
  if (!scoreTableState.data) return;
  const data = scoreTableState.data;
  const players = visiblePlayers();
  const oddsMeta = data.odds || {};
  section.dataset.scoreEnhancement = data.generated_at || "ready";
  section.innerHTML = `
    <div class="eyebrow">Current leaderboard</div>
    <div class="scores-heading-row">
      <div>
        <h2>${escapeHtml(data.slate_date || "—")} · ${escapeHtml(data.status || "—")}</h2>
        <p class="muted">Odds are optional and never affect rank. Shared coverage: ${Number(oddsMeta.priced_players || 0)} of ${Number((data.players || []).length)} players.</p>
      </div>
      <div class="scores-controls">
        <input id="score-search" type="search" value="${escapeHtml(scoreTableState.query)}" placeholder="Search player or team" aria-label="Search player or team">
        <select id="score-filter" aria-label="Filter Top 100 table">
          <option value="all" ${scoreTableState.filter === "all" ? "selected" : ""}>All players</option>
          <option value="priced" ${scoreTableState.filter === "priced" ? "selected" : ""}>Odds available</option>
          <option value="unpriced" ${scoreTableState.filter === "unpriced" ? "selected" : ""}>No odds</option>
          <option value="provisional" ${scoreTableState.filter === "provisional" ? "selected" : ""}>Provisional</option>
          <option value="established" ${scoreTableState.filter === "established" ? "selected" : ""}>Established</option>
        </select>
      </div>
    </div>
    <div class="table-note">Click any labeled column to sort. The 15-game strip runs oldest to newest; a highlighted cell is an HR game and its number is total HRs in that game.</div>
    ${players.length ? `<div class="tablewrap"><table class="scores-table">
      <thead><tr>
        ${sortHeader("rank", "Rank")}
        ${sortHeader("player", "Player")}
        ${sortHeader("team", "Team")}
        ${sortHeader("score", "Score")}
        ${sortHeader("hr_games_l5", "HR G L5")}
        ${sortHeader("hr_games_l7", "L7")}
        ${sortHeader("hr_games_l15", "L15")}
        ${sortHeader("home_runs_l15", "HR L15")}
        ${sortHeader("games_available", "Games")}
        <th>15-game form</th>
        ${sortHeader("best_odds", "Best odds")}
        ${sortHeader("sample_status", "Sample")}
      </tr></thead>
      <tbody>${players.map((player) => `<tr>
        <td>${escapeHtml(player.rank)}</td>
        <td><b>${escapeHtml(player.player)}</b>${player.matchup ? `<div class="muted">${escapeHtml(player.matchup)}</div>` : ""}</td>
        <td>${escapeHtml(player.team || "—")}</td>
        <td class="plus">${formatScore(player.score)}</td>
        <td>${escapeHtml(player.hr_games_l5)}</td>
        <td>${escapeHtml(player.hr_games_l7)}</td>
        <td>${escapeHtml(player.hr_games_l15)}</td>
        <td>${escapeHtml(player.home_runs_l15)}</td>
        <td>${escapeHtml(player.games_available)}</td>
        <td>${formStrip(player)}</td>
        <td>${priceStack(player)}</td>
        <td><span class="pill">${escapeHtml(player.sample_status || "—")}</span></td>
      </tr>`).join("")}</tbody>
    </table></div>` : '<div class="empty">No players match the current filters.</div>'}
  `;
}

function scoreSection() {
  if ((location.hash.slice(1) || "today") !== "scores") return null;
  return [...document.querySelectorAll("section.card.section")].find((section) =>
    section.querySelector(".eyebrow")?.textContent?.trim() === "Current leaderboard"
  ) || null;
}

async function loadScoreData() {
  if (scoreTableState.data) return scoreTableState.data;
  if (!scoreTableState.loading) {
    scoreTableState.loading = fetch("/data/top100.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Top 100 fetch failed: ${response.status}`);
        return response.json();
      })
      .then((data) => {
        scoreTableState.data = data;
        return data;
      })
      .catch((error) => {
        console.error(error);
        return null;
      });
  }
  return scoreTableState.loading;
}

async function enhanceScores(force = false) {
  const section = scoreSection();
  if (!section) return;
  const data = await loadScoreData();
  if (!data) return;
  if (!force && section.dataset.scoreEnhancement === (data.generated_at || "ready")) return;
  renderEnhancedScores(section);
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-score-sort]");
  if (!button) return;
  const key = button.dataset.scoreSort;
  if (scoreTableState.sortKey === key) {
    scoreTableState.sortDirection = scoreTableState.sortDirection === "asc" ? "desc" : "asc";
  } else {
    scoreTableState.sortKey = key;
    scoreTableState.sortDirection = numericKeys.has(key) && key !== "rank" ? "desc" : "asc";
  }
  const section = scoreSection();
  if (section) renderEnhancedScores(section);
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "score-search") return;
  scoreTableState.query = event.target.value;
  const section = scoreSection();
  if (section) renderEnhancedScores(section);
});

document.addEventListener("change", (event) => {
  if (event.target.id !== "score-filter") return;
  scoreTableState.filter = event.target.value;
  const section = scoreSection();
  if (section) renderEnhancedScores(section);
});

addEventListener("hashchange", () => setTimeout(() => enhanceScores(true), 0));
new MutationObserver(() => enhanceScores(false)).observe(document.querySelector("#app"), { childList: true, subtree: true });
setTimeout(() => enhanceScores(true), 0);
