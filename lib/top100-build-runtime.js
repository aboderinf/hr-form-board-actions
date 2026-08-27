const { currentEtDate, redisCommand } = require("./checkpoint-runtime");

const MLB = "https://statsapi.mlb.com/api/v1";
const TOP100_TTL_SECONDS = 34_560_000;
const TOP100_LOCK_SECONDS = 600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          "User-Agent": "HRFormBoardActions/3.0",
          "Accept-Language": "en-US,en;q=.9",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      last = error;
      if (attempt < attempts) await sleep(400 * attempt);
    }
  }
  throw new Error(`GET failed ${url}: ${last instanceof Error ? last.message : String(last)}`);
}

async function seasonHitterPool(season) {
  const params = new URLSearchParams({
    stats: "season",
    group: "hitting",
    season: String(season),
    playerPool: "ALL",
    sportIds: "1",
    limit: "2000",
  });
  const payload = await fetchJson(`${MLB}/stats?${params}`);
  const splits = payload?.stats?.[0]?.splits || [];
  const players = new Map();
  for (const row of splits) {
    const person = row?.player || row?.person || {};
    const playerId = Number(person?.id);
    const name = String(person?.fullName || "").trim();
    if (!Number.isFinite(playerId) || !name) continue;
    const plateAppearances = Number(row?.stat?.plateAppearances || 0);
    if (!Number.isFinite(plateAppearances) || plateAppearances <= 0) continue;
    const team = row?.team || {};
    players.set(playerId, {
      mlbam_id: playerId,
      player: name,
      team_id: team?.id ?? null,
      team: team?.name || null,
      season_plate_appearances: Math.trunc(plateAppearances),
    });
  }
  return [...players.values()].sort((a, b) => a.player.localeCompare(b.player));
}

async function gameLog(playerId, season) {
  const params = new URLSearchParams({
    stats: "gameLog",
    group: "hitting",
    season: String(season),
    gameType: "R",
  });
  const payload = await fetchJson(`${MLB}/people/${playerId}/stats?${params}`);
  const splits = payload?.stats?.[0]?.splits || [];
  return splits.map((row) => ({
    date: row?.date || null,
    gamePk: row?.game?.gamePk ?? null,
    opponent: row?.opponent?.name || null,
    homeRuns: Math.trunc(Number(row?.stat?.homeRuns || 0)),
    plateAppearances: Math.trunc(Number(row?.stat?.plateAppearances || 0)),
  }));
}

function displayGame(game) {
  const homeRuns = Math.trunc(Number(game?.homeRuns || 0));
  return {
    date: game?.date || null,
    game_pk: game?.gamePk ?? null,
    opponent: game?.opponent || null,
    home_runs: homeRuns,
    plate_appearances: Math.trunc(Number(game?.plateAppearances || 0)),
    hr_game: homeRuns > 0,
  };
}

function calculateFormOpenPool(games, slateDate) {
  const prior = (games || [])
    .filter((game) => game?.date && String(game.date) < slateDate && Number(game?.plateAppearances || 0) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.gamePk || 0) - Number(b.gamePk || 0))
    .slice(-15);
  if (!prior.length) return null;

  const recent = [...prior].reverse();
  const indicators = recent.map((game) => Number(game?.homeRuns || 0) > 0 ? 1 : 0);
  const h5 = indicators.slice(0, 5).reduce((a, b) => a + b, 0);
  const h7 = indicators.slice(0, 7).reduce((a, b) => a + b, 0);
  const h15 = indicators.slice(0, 15).reduce((a, b) => a + b, 0);
  if (h15 === 0) return null;

  return {
    score: 0.50 * h5 / 5 + 0.30 * h7 / 7 + 0.20 * h15 / 15,
    hr_games_l5: h5,
    hr_games_l7: h7,
    hr_games_l15: h15,
    home_runs_l15: recent.reduce((sum, game) => sum + Math.trunc(Number(game?.homeRuns || 0)), 0),
    games_available: recent.length,
    provisional: recent.length < 15,
    recent_games: recent.map(displayGame),
  };
}

function compareRank(a, b) {
  return (
    Number(b.score) - Number(a.score)
    || Number(b.hr_games_l5) - Number(a.hr_games_l5)
    || Number(b.hr_games_l7) - Number(a.hr_games_l7)
    || Number(b.hr_games_l15) - Number(a.hr_games_l15)
    || Number(b.home_runs_l15) - Number(a.home_runs_l15)
    || Number(b.games_available) - Number(a.games_available)
    || String(a.player).localeCompare(String(b.player))
  );
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function etIso(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  const offset = String(parts.timeZoneName || "GMT+00:00").replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

async function buildTop100Payload(slateDate) {
  const now = new Date();
  const season = Number(slateDate.slice(0, 4));
  const pool = await seasonHitterPool(season);
  const fetched = await mapConcurrent(pool, 24, (player) => gameLog(player.mlbam_id, season));
  const rows = [];
  let failures = 0;

  for (let index = 0; index < pool.length; index += 1) {
    const player = pool[index];
    const result = fetched[index];
    if (!result?.ok || !Array.isArray(result.value)) {
      failures += 1;
      continue;
    }
    const form = calculateFormOpenPool(result.value, slateDate);
    if (!form) continue;
    rows.push({
      player: player.player,
      mlbam_id: player.mlbam_id,
      team: player.team,
      team_id: player.team_id,
      season_plate_appearances: player.season_plate_appearances,
      ...form,
    });
  }

  rows.sort(compareRank);
  const published = rows.slice(0, 100).map((row, index) => ({
    ...row,
    rank: index + 1,
    sample_status: row.provisional ? "Provisional" : "Established",
  }));
  const diagnostics = failures ? [`Game logs failed for ${failures} players`] : [];

  return {
    schema_version: 3,
    kind: "top_100_form_scores",
    slate_date: slateDate,
    generated_at: now.toISOString(),
    generated_at_et: etIso(now),
    status: rows.length ? "ready" : "no_players_in_form",
    delivery: "qstash-vercel-redis",
    method: "0.50*(HR games L5/5) + 0.30*(HR games L7/7) + 0.20*(HR games L15/15)",
    eligibility: "Every MLB hitter with a current-season batting appearance and at least one prior PA-game containing a home run; no lineup or odds requirement.",
    short_history_policy: "Fixed 5/7/15 denominators. Missing pre-debut games contribute zero. Fewer than 15 prior PA-games is labeled provisional.",
    odds_policy: "Odds are joined from immutable Redis checkpoints for Discovery and never affect form ranking or eligibility.",
    player_pool_count: pool.length,
    scored_player_count: rows.length,
    players: published,
    odds: {
      source: "MLB HR Edge checkpoint database",
      status: "separate_checkpoint_join",
      priced_players: 0,
      coverage: null,
    },
    diagnostics,
  };
}

async function readTop100(slateDate) {
  const raw = await redisCommand(["GET", `mlbhr:top100:${slateDate}`]);
  if (!raw) return null;
  const payload = JSON.parse(raw);
  return payload?.slate_date === slateDate && Array.isArray(payload?.players) ? payload : null;
}

async function refreshTop100() {
  const slateDate = currentEtDate();
  const existing = await readTop100(slateDate);
  if (existing && ["ready", "no_players_in_form"].includes(existing.status)) {
    return { outcome: "reused", payload: existing };
  }

  const lockKey = `mlbhr:top100-lock:${slateDate}`;
  const lock = await redisCommand(["SET", lockKey, new Date().toISOString(), "NX", "EX", TOP100_LOCK_SECONDS]);
  if (lock !== "OK") {
    const raced = await readTop100(slateDate);
    return raced
      ? { outcome: "reused_after_race", payload: raced }
      : { outcome: "build_in_progress", payload: null };
  }

  try {
    const payload = await buildTop100Payload(slateDate);
    const text = JSON.stringify(payload);
    const score = Math.floor(Date.parse(payload.generated_at) / 1000) || Math.floor(Date.now() / 1000);
    await redisCommand(["SET", `mlbhr:top100:${slateDate}`, text, "EX", TOP100_TTL_SECONDS]);
    await redisCommand(["SET", "mlbhr:top100:latest", text, "EX", TOP100_TTL_SECONDS]);
    await redisCommand(["ZADD", "mlbhr:top100-history", score, `mlbhr:top100:${slateDate}`]);
    return { outcome: "built", payload };
  } finally {
    try { await redisCommand(["DEL", lockKey]); } catch { /* lock expires */ }
  }
}

module.exports = {
  buildTop100Payload,
  calculateFormOpenPool,
  compareRank,
  readTop100,
  refreshTop100,
};
