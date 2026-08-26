const fs = require("node:fs");
const path = require("node:path");
const {
  checkpointTargetUtc,
  normalizeCheckpoint,
  playerKey,
  readCheckpoint,
  redisCommand,
} = require("./checkpoint-runtime");

const DISCOVERY_SCHEMA_VERSION = 2;
const DISCOVERY_TTL_SECONDS = 34560000;
const BOOK_NAMES = {
  fanduel: "FanDuel",
  draftkings: "DraftKings",
  betmgm: "BetMGM",
};
const TOP100_RAW_URL = "https://raw.githubusercontent.com/aboderinf/hr-form-board-actions/main/data/top100.json";

function discoveryArchiveKey(date, checkpoint) {
  return `mlbhr:discovery:${date}:${checkpoint}`;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function localTop100() {
  try {
    const filePath = path.join(process.cwd(), "data", "top100.json");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadTop100(slateDate) {
  const local = localTop100();
  if (local?.slate_date === slateDate && Array.isArray(local?.players)) return local;

  const response = await fetch(`${TOP100_RAW_URL}?slate=${encodeURIComponent(slateDate)}&t=${Date.now()}`, {
    cache: "no-store",
    headers: { "User-Agent": "hr-form-discovery-projector/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Top 100 source HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.slate_date !== slateDate || !Array.isArray(payload?.players)) {
    throw new Error(`Top 100 slate mismatch: expected ${slateDate}, got ${payload?.slate_date || "none"}`);
  }
  return payload;
}

function marketByPlayer(checkpoint) {
  const out = new Map();
  for (const row of checkpoint?.rows || []) {
    const key = String(row?.playerKey || playerKey(row?.batterName || ""));
    if (key && !out.has(key)) out.set(key, row);
  }
  return out;
}

function pricesForMarket(row, providerCallId) {
  const prices = [];
  for (const [bookId, quote] of Object.entries(row?.odds || {})) {
    if (!BOOK_NAMES[bookId] || !quote || typeof quote !== "object") continue;
    const odds = Number(quote.americanOdds);
    if (!Number.isFinite(odds) || odds === 0 || !quote.capturedAt) continue;
    prices.push({
      book: BOOK_NAMES[bookId],
      book_id: bookId,
      odds: Math.trunc(odds),
      captured_at: String(quote.capturedAt),
      source: String(quote.source || "qstash-vercel-sportsgameodds"),
      source_event_id: quote.sourceEventId || row?.sourceEventId || null,
      source_odd_id: quote.sourceOddId || null,
      provider_call_id: quote.callId || providerCallId || null,
      verified: true,
      url: null,
    });
  }
  return prices.sort((a, b) => b.odds - a.odds || a.book.localeCompare(b.book));
}

function buildDiscoveryArchive(top100, checkpoint) {
  const slateDate = checkpoint.date;
  const cp = normalizeCheckpoint(checkpoint.checkpoint);
  const asOf = checkpoint.asOf || checkpointTargetUtc(slateDate, cp).toISOString();
  const checkpointMs = Date.parse(asOf);
  const markets = marketByPlayer(checkpoint);
  const entries = [];
  let pricedRows = 0;
  let pregamePricedRows = 0;

  for (const player of top100.players || []) {
    const market = markets.get(playerKey(player.player || "")) || null;
    const prices = pricesForMarket(market, checkpoint.providerCallId);
    const bestOdds = prices.length ? prices[0].odds : null;
    const bestBooks = bestOdds == null ? [] : prices.filter((row) => row.odds === bestOdds).map((row) => row.book);
    const gameStartMs = market?.gameStartAt ? Date.parse(market.gameStartAt) : NaN;
    const gameStartedAtCheckpoint = Number.isFinite(gameStartMs)
      && Number.isFinite(checkpointMs)
      && gameStartMs <= checkpointMs;

    if (bestOdds != null) pricedRows += 1;
    if (bestOdds != null && !gameStartedAtCheckpoint) pregamePricedRows += 1;

    entries.push({
      slate_date: slateDate,
      checkpoint: cp,
      captured_at: checkpoint.providerCompletedAt || checkpoint.generatedAt || new Date().toISOString(),
      captured_at_et: null,
      rank: Number(player.rank || 999),
      player: player.player || null,
      mlbam_id: Number(player.mlbam_id),
      team: player.team || null,
      team_id: player.team_id ?? null,
      score: Number(player.score || 0),
      hr_games_l5: Number(player.hr_games_l5 || 0),
      hr_games_l7: Number(player.hr_games_l7 || 0),
      hr_games_l15: Number(player.hr_games_l15 || 0),
      home_runs_l15: Number(player.home_runs_l15 || 0),
      games_available: Number(player.games_available || 0),
      sample_status: player.sample_status || null,
      game_pk: market?.gamePk ?? null,
      game_start_at: market?.gameStartAt || null,
      matchup: market?.matchup || null,
      game_started_at_checkpoint: gameStartedAtCheckpoint,
      all_prices: prices,
      best_book: bestBooks[0] || null,
      best_books: bestBooks,
      best_odds: bestOdds,
      best_odds_text: bestOdds == null ? null : `${bestOdds > 0 ? "+" : ""}${bestOdds}`,
      best_price_captured_at: prices[0]?.captured_at || null,
      source_event_id: prices[0]?.source_event_id || market?.sourceEventId || null,
      source_odd_id: prices[0]?.source_odd_id || null,
    });
  }

  return {
    schema_version: DISCOVERY_SCHEMA_VERSION,
    kind: "top_100_odds_capture",
    slate_date: slateDate,
    checkpoint: cp,
    captured_at: checkpoint.providerCompletedAt || checkpoint.generatedAt || new Date().toISOString(),
    captured_at_et: null,
    top100_generated_at: top100.generated_at || top100.generated_at_et || null,
    top100_rows: entries.length,
    priced_rows: pricedRows,
    pregame_priced_rows: pregamePricedRows,
    odds_coverage: entries.length ? pricedRows / entries.length : null,
    source: {
      name: "MLB HR Edge",
      status: checkpoint.status || "pending",
      slate_date: checkpoint.date,
      same_slate: checkpoint.date === slateDate,
      generated_at: checkpoint.generatedAt || null,
      row_count: Number(checkpoint.rowCount || 0),
      quote_count: Number(checkpoint.quoteCount || 0),
      books: (checkpoint.books || []).map((book) => BOOK_NAMES[book] || book),
      delivery: checkpoint.delivery || null,
      provider_call_id: checkpoint.providerCallId || null,
      provider_response_sha256: checkpoint.providerResponseSha256 || null,
      as_of: asOf,
    },
    entries,
  };
}

async function readDiscoveryArchive(date, checkpoint) {
  const cp = normalizeCheckpoint(checkpoint);
  if (!validDate(date) || !cp) return null;
  const raw = await redisCommand(["GET", discoveryArchiveKey(date, cp)]);
  return raw ? JSON.parse(raw) : null;
}

async function ensureDiscoveryArchive(date, checkpoint) {
  const cp = normalizeCheckpoint(checkpoint);
  if (!validDate(date) || !cp) throw new Error("Invalid discovery archive date/checkpoint");

  const existing = await readDiscoveryArchive(date, cp);
  if (existing) return existing;

  const checkpointPayload = await readCheckpoint(date, cp);
  if (!checkpointPayload) return null;
  if (checkpointPayload.date !== date || normalizeCheckpoint(checkpointPayload.checkpoint) !== cp) {
    throw new Error("Stored checkpoint identity mismatch");
  }

  const top100 = await loadTop100(date);
  const archive = buildDiscoveryArchive(top100, checkpointPayload);
  const key = discoveryArchiveKey(date, cp);
  const inserted = await redisCommand([
    "SET",
    key,
    JSON.stringify(archive),
    "NX",
    "EX",
    DISCOVERY_TTL_SECONDS,
  ]);
  if (inserted !== "OK") {
    const raced = await readDiscoveryArchive(date, cp);
    if (raced) return raced;
  }
  await redisCommand([
    "ZADD",
    "mlbhr:discovery-history",
    Math.floor(Date.parse(archive.captured_at) / 1000) || Math.floor(Date.now() / 1000),
    key,
  ]);
  return archive;
}

module.exports = {
  buildDiscoveryArchive,
  discoveryArchiveKey,
  ensureDiscoveryArchive,
  readDiscoveryArchive,
};
