const TZ = "America/New_York";
const EARLY_CUTOFF_MINUTES = 17 * 60 + 17;

const $ = (id) => document.getElementById(id);
const safe = (value) => value == null || value === "" ? "—" : String(value);
const formatOdds = (value) => {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Math.round(Number(value));
  return n > 0 ? `+${n}` : String(n);
};
const formatScore = (value) => value == null ? "—" : Number(value).toFixed(4);

let boardIndex = null;
let activeDate = null;

function escapeHtml(value) {
  return safe(value).replace(/[&<>'"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[ch]));
}

function etMinutes(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function formatGameTime(iso) {
  if (!iso) return "Time unavailable";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function bookPrices(entry) {
  const prices = [...(entry.all_prices || [])].sort((a, b) => Number(b.odds ?? -Infinity) - Number(a.odds ?? -Infinity));
  if (!prices.length) return '<span class="picks-meta">No shared prices</span>';
  const best = Number(entry.best_odds);
  return prices.map((row) => {
    const isBest = Number(row.odds) === best;
    return `<span class="book-price ${isBest ? "best" : ""}">${escapeHtml(row.book)} ${formatOdds(row.odds)}</span>`;
  }).join("");
}

function isPregame(entry) {
  return entry.game_started_at_checkpoint !== true;
}

function isEarlyGame(entry) {
  const mins = etMinutes(entry.game_start_at);
  return mins != null && mins < EARLY_CUTOFF_MINUTES;
}

function isLateGame(entry) {
  const mins = etMinutes(entry.game_start_at);
  return mins != null && mins >= EARLY_CUTOFF_MINUTES;
}

function dkIsBest(entry) {
  const books = Array.isArray(entry.best_books) ? entry.best_books : [entry.best_book];
  return books.some((book) => String(book || "").toLowerCase() === "draftkings");
}

function qualifiesEarly(entry) {
  const s = Number(entry.score);
  const price = Number(entry.best_odds);
  const scoreOk = s >= 0.1 && s < 0.2;
  const oddsOk = (price < 400) || (price >= 500 && price < 600);
  return scoreOk && oddsOk && dkIsBest(entry) && isPregame(entry) && isEarlyGame(entry);
}

function qualifiesLate(entry) {
  const s = Number(entry.score);
  const price = Number(entry.best_odds);
  return s >= 0.1 && s < 0.2 && price >= 600 && price < 800 && isPregame(entry) && isLateGame(entry);
}

function sortPicks(rows) {
  return [...rows].sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.best_odds || 0) - Number(a.best_odds || 0));
}

function pickMarkup(entry, kind) {
  const betBook = kind === "early" ? "DraftKings" : safe(entry.best_book);
  const betOdds = kind === "early"
    ? (entry.all_prices || []).find((row) => String(row.book || "").toLowerCase() === "draftkings")?.odds ?? entry.best_odds
    : entry.best_odds;
  return `<article class="pick-item">
    <div>
      <div class="pick-player">${escapeHtml(entry.player)}</div>
      <div class="pick-sub">${escapeHtml(entry.team)} · ${escapeHtml(entry.matchup)}</div>
    </div>
    <div>
      <div><b>${formatGameTime(entry.game_start_at)}</b></div>
      <div class="pick-sub">Form score ${formatScore(entry.score)} · Rank ${safe(entry.rank)}</div>
    </div>
    <div>
      <div class="pick-bet">${escapeHtml(betBook)} ${formatOdds(betOdds)}</div>
      <div class="pick-market">1u HR yes</div>
    </div>
    <div class="book-prices" aria-label="Captured sportsbook prices">${bookPrices(entry)}</div>
  </article>`;
}

function renderSection(kind, capture, error = null) {
  const isEarly = kind === "early";
  const countEl = $(isEarly ? "earlyCount" : "lateCount");
  const metaEl = $(isEarly ? "earlyMeta" : "lateMeta");
  const picksEl = $(isEarly ? "earlyPicks" : "latePicks");

  if (error || !capture) {
    countEl.textContent = "0 picks";
    const checkpoint = isEarly ? "8:17 AM" : "5:17 PM";
    const pendingCopy = isEarly
      ? `${checkpoint} archive is not available for ${activeDate}.`
      : `${checkpoint} archive is not available yet for ${activeDate}. Late picks will populate after that checkpoint.`;
    metaEl.textContent = pendingCopy;
    picksEl.innerHTML = `<div class="status-box ${error && !String(error).includes("404") ? "error" : ""}">${escapeHtml(pendingCopy)}</div>`;
    return;
  }

  const entries = capture.entries || [];
  const qualified = sortPicks(entries.filter(isEarly ? qualifiesEarly : qualifiesLate));
  countEl.textContent = `${qualified.length} ${qualified.length === 1 ? "pick" : "picks"}`;
  metaEl.textContent = `${capture.slate_date} · ${isEarly ? "08:17" : "17:17"} ET archive · ${capture.priced_rows ?? 0} priced Top-100 rows`;
  picksEl.innerHTML = qualified.length
    ? qualified.map((entry) => pickMarkup(entry, kind)).join("")
    : `<div class="status-box">No ${isEarly ? "early" : "late"} games satisfy every rule condition for this slate.</div>`;
}

async function fetchJson(url) {
  const response = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function loadCapture(date, checkpoint) {
  try {
    return { data: await fetchJson(`/data/discovery/archive/${date}_${checkpoint}.json`), error: null };
  } catch (error) {
    return { data: null, error };
  }
}

function availableDates(index) {
  const dates = new Set();
  if (index?.latest?.slate_date) dates.add(index.latest.slate_date);
  for (const row of index?.snapshots || []) {
    if (row?.slate_date) dates.add(row.slate_date);
  }
  return [...dates].sort().reverse();
}

function syncDateSelect(dates) {
  const select = $("slateDate");
  const requested = new URLSearchParams(location.search).get("date");
  const preferred = requested && dates.includes(requested) ? requested : dates[0];
  select.innerHTML = dates.map((date) => `<option value="${date}">${date}</option>`).join("");
  activeDate = preferred || new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  select.value = activeDate;
}

async function loadPicks() {
  if (!activeDate) return;
  $("pageStatus").innerHTML = '<span class="loading-dot"></span>Loading immutable checkpoint archives…';
  $("refreshPicks").disabled = true;

  const [early, late] = await Promise.all([
    loadCapture(activeDate, "0817"),
    loadCapture(activeDate, "1717"),
  ]);

  renderSection("early", early.data, early.error);
  renderSection("late", late.data, late.error);

  const ready = [early.data, late.data].filter(Boolean).length;
  $("pageStatus").textContent = `${activeDate} · ${ready}/2 rule checkpoints available`;
  $("refreshPicks").disabled = false;
}

async function init() {
  try {
    boardIndex = await fetchJson("/data/index.json");
    const dates = availableDates(boardIndex);
    syncDateSelect(dates);
    $("slateDate").addEventListener("change", async (event) => {
      activeDate = event.target.value;
      const url = new URL(location.href);
      url.searchParams.set("date", activeDate);
      history.replaceState(null, "", url);
      await loadPicks();
    });
    $("refreshPicks").addEventListener("click", loadPicks);
    await loadPicks();
  } catch (error) {
    console.error(error);
    $("pageStatus").innerHTML = '<span class="error">Could not load the Form Board index.</span>';
    $("earlyPicks").innerHTML = '<div class="status-box error">Checkpoint data could not be loaded.</div>';
    $("latePicks").innerHTML = '<div class="status-box error">Checkpoint data could not be loaded.</div>';
  }
}

init();
