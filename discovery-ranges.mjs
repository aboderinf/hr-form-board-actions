// Keep these boundaries aligned with odds_band / score_band in src/discovery.py.
export const ODDS_RANGES = [
  { value: "below-400", label: "Below +400", max: 400 },
  { value: "400-499", label: "+400 to +499", min: 400, max: 500 },
  { value: "500-599", label: "+500 to +599", min: 500, max: 600 },
  { value: "600-799", label: "+600 to +799", min: 600, max: 800 },
  { value: "800-999", label: "+800 to +999", min: 800, max: 1000 },
  { value: "1000-plus", label: "+1000 or longer", min: 1000 },
];

export const FORM_RANGES = [
  { value: "400-plus", label: "0.400+", min: 0.4 },
  { value: "300-399", label: "0.300–0.399", min: 0.3, max: 0.4 },
  { value: "200-299", label: "0.200–0.299", min: 0.2, max: 0.3 },
  { value: "100-199", label: "0.100–0.199", min: 0.1, max: 0.2 },
  { value: "below-100", label: "Below 0.100", max: 0.1 },
];

// Game start time is always evaluated in America/New_York so archived summer
// slates use EDT and late-season slates automatically switch to EST.
export const GAME_TIME_RANGES = [
  { value: "before-1300", label: "Before 1:00 PM ET", max: 13 * 60 },
  { value: "1300-1559", label: "1:00–3:59 PM ET", min: 13 * 60, max: 16 * 60 },
  { value: "1600-1859", label: "4:00–6:59 PM ET", min: 16 * 60, max: 19 * 60 },
  { value: "1900-2059", label: "7:00–8:59 PM ET", min: 19 * 60, max: 21 * 60 },
  { value: "2100-plus", label: "9:00 PM ET or later", min: 21 * 60 },
];

export const DISCOVERY_BOOKS = ["FanDuel", "DraftKings", "BetMGM"];

export function normalizeDiscoveryBook(value) {
  const raw = String(value || "").trim();
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const aliases = {
    fanduel: "FanDuel",
    draftkings: "DraftKings",
    betmgm: "BetMGM",
  };
  return aliases[key] || raw;
}

export function discoveryTodayMatches(players = [], options = {}) {
  const {
    form = "all",
    odds = "all",
    book = "all",
    gameTime = "all",
    now = null,
    liveOnly = false,
  } = options;
  const formRange = FORM_RANGES.find((range) => range.value === form) || {};
  const oddsRange = ODDS_RANGES.find((range) => range.value === odds) || {};
  const nowMs = now ? Date.parse(now) : NaN;

  return players
    .filter((player) => {
      if (!Number.isFinite(Number(player?.best_odds))) return false;
      if (!matchesRange(player?.score, formRange) || !matchesRange(player?.best_odds, oddsRange)) return false;
      if (book !== "all" && normalizeDiscoveryBook(player?.best_book) !== book) return false;
      if (!matchesGameTime(player?.game_start_at, gameTime)) return false;
      if (player?.game_started_at_checkpoint === true) return false;
      if (liveOnly && Number.isFinite(nowMs)) {
        const gameStartMs = Date.parse(String(player?.game_start_at || ""));
        if (Number.isFinite(gameStartMs) && gameStartMs <= nowMs) return false;
      }
      return true;
    })
    .sort((a, b) => Number(a?.rank || 999) - Number(b?.rank || 999)
      || Number(b?.score || 0) - Number(a?.score || 0)
      || Number(b?.best_odds || -Infinity) - Number(a?.best_odds || -Infinity));
}

export function resolveRange(ranges, value, customMin = "", customMax = "") {
  if (value !== "custom") return { ...(ranges.find((range) => range.value === value) || {}) };
  const min = String(customMin).trim() === "" ? undefined : Number(customMin);
  const max = String(customMax).trim() === "" ? undefined : Number(customMax);
  return { min, max, inclusiveMax: true };
}

export function rangeError(range, kind) {
  const bounds = [range.min, range.max].filter((value) => value !== undefined);
  if (bounds.some((value) => !Number.isFinite(value))) return "Enter a valid number for each bound.";
  if (kind === "odds" && bounds.some((value) => !Number.isInteger(value) || Math.abs(value) < 100)) {
    return "American odds must be whole numbers of +100 or higher, or −100 or lower.";
  }
  if (kind === "form" && bounds.some((value) => value < 0 || value > 1)) return "Form scores must be between 0 and 1.";
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) return "Minimum must be no greater than maximum.";
  return "";
}

export function matchesRange(value, range) {
  if (range.min === undefined && range.max === undefined) return true;
  if (value == null || value === "" || !Number.isFinite(Number(value))) return false;
  const number = Number(value);
  return (range.min === undefined || number >= range.min)
    && (range.max === undefined || (range.inclusiveMax ? number <= range.max : number < range.max));
}

export function gameStartMinutesET(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

export function matchesGameTime(value, rangeValue) {
  if (!rangeValue || rangeValue === "all") return true;
  const range = GAME_TIME_RANGES.find((item) => item.value === rangeValue);
  if (!range) return true;
  return matchesRange(gameStartMinutesET(value), range);
}

function decimalOdds(american) {
  const number = Number(american);
  if (!Number.isFinite(number) || number === 0) return null;
  return 1 + (number > 0 ? number / 100 : 100 / Math.abs(number));
}

function impliedProbability(american) {
  const number = Number(american);
  if (!Number.isFinite(number) || number === 0) return null;
  return number > 0 ? 100 / (number + 100) : Math.abs(number) / (Math.abs(number) + 100);
}

function mean(values) {
  const clean = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  return clean.length ? clean.reduce((total, value) => total + value, 0) / clean.length : null;
}

function summarizeRows(rows) {
  const settled = rows.filter((row) => row.result === "WIN" || row.result === "LOSS");
  const wins = settled.filter((row) => row.result === "WIN").length;
  const losses = settled.length - wins;
  const slates = new Set(settled.map((row) => String(row.slate_date || ""))).size;
  const netUnits = settled.reduce((total, row) => total + Number(row.profit_units || 0), 0);
  const hitRate = settled.length ? wins / settled.length : null;
  const breakEven = mean(settled.map((row) => impliedProbability(row.best_odds)));
  let sampleStatus = "small sample";
  if (settled.length >= 100 && wins >= 10 && slates >= 7) sampleStatus = "larger sample";
  else if (settled.length >= 40 && wins >= 4 && slates >= 5) sampleStatus = "provisional";
  return {
    captures: rows.length,
    settled: settled.length,
    slates,
    wins,
    losses,
    voids: rows.filter((row) => row.result === "VOID").length,
    pending: rows.filter((row) => row.result == null || row.result === "PENDING").length,
    hit_rate: hitRate,
    market_break_even_hit_rate: breakEven,
    hit_rate_edge: hitRate != null && breakEven != null ? hitRate - breakEven : null,
    net_units: netUnits,
    roi: settled.length ? netUnits / settled.length : null,
    average_odds: mean(settled.map((row) => row.best_odds)),
    average_score: mean(settled.map((row) => row.score)),
    sample_status: sampleStatus,
  };
}

function collapseBestRows(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = `${row.slate_date || ""}:${row.mlbam_id || ""}`;
    const current = selected.get(key);
    const nextPrice = decimalOdds(row.best_odds);
    const currentPrice = current ? decimalOdds(current.best_odds) : null;
    if (!current || (nextPrice != null && (currentPrice == null || nextPrice > currentPrice))) selected.set(key, row);
  }
  return [...selected.values()];
}

// Recompute a Discovery slice from immutable archived rows. Complete-slate
// exclusion is evaluated before checkpoint/time filtering to stay aligned with
// the server-side Discovery methodology.
export function discoveryRowsSummary(rows = [], options = {}) {
  const {
    start,
    end,
    view = "best",
    form = "all",
    odds = "all",
    book = "all",
    gameTime = "all",
  } = options;
  const periodRows = rows.filter((row) => (!start || String(row.slate_date) >= start) && (!end || String(row.slate_date) <= end));
  const incompleteSlates = new Set(
    periodRows
      .filter((row) => row.result == null || row.result === "PENDING")
      .map((row) => String(row.slate_date || "")),
  );
  let candidates = periodRows.filter((row) => !incompleteSlates.has(String(row.slate_date || "")));
  candidates = view === "best"
    ? collapseBestRows(candidates)
    : candidates.filter((row) => String(row.checkpoint || "") === String(view));

  const formRange = FORM_RANGES.find((range) => range.value === form) || {};
  const oddsRange = ODDS_RANGES.find((range) => range.value === odds) || {};
  candidates = candidates.filter((row) => (
    matchesRange(row.score, formRange)
    && matchesRange(row.best_odds, oddsRange)
    && (book === "all" || row.best_book === book)
    && matchesGameTime(row.game_start_at, gameTime)
  ));
  return candidates.length ? summarizeRows(candidates) : null;
}

export function parseDiscoverySlice(label) {
  const parts = String(label || "").split(" · ");
  return {
    form: FORM_RANGES.find((range) => parts.includes(range.label))?.value || "all",
    odds: ODDS_RANGES.find((range) => parts.includes(range.label))?.value || "all",
    book: DISCOVERY_BOOKS.find((book) => parts.includes(book)) || "all",
    checkpoint: parts.find((part) => ["0817", "1117", "1717", "2017"].includes(part)),
  };
}

// Use the published summaries directly so slice records, sample sizes, and
// settlement exclusions remain identical to the existing Discovery report.
export function discoverySliceSummary(detail, form, odds, book = "all") {
  const formLabel = FORM_RANGES.find((range) => range.value === form)?.label;
  const oddsLabel = ODDS_RANGES.find((range) => range.value === odds)?.label;
  let table;
  let label;
  if (book !== "all") {
    table = formLabel && oddsLabel ? "book_odds_score" : formLabel ? "book_score" : oddsLabel ? "book_odds" : "best_price_books";
    label = [book, oddsLabel, formLabel].filter(Boolean).join(" · ");
  } else if (formLabel || oddsLabel) {
    table = formLabel && oddsLabel ? "score_odds" : formLabel ? "score_bands" : "odds_bands";
    label = [formLabel, oddsLabel].filter(Boolean).join(" · ");
  } else {
    return detail?.overall || null;
  }
  return detail?.[table]?.find((row) => row.label === label) || null;
}
