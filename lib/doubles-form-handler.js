const crypto = require('node:crypto');
const { normalizeCheckpoint, playerKey, redisCommand } = require('./checkpoint-runtime');
const { readDoublesCheckpoint } = require('./doubles-runtime');

const MLB = 'https://statsapi.mlb.com/api/v1';
const CHECKPOINTS = ['2017', '1717', '1117', '0817'];
const FORM_LIMIT = 100;
const BULK_SIZE = 40;

function etDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function fetchJson(url, timeout = 15000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MLBDoublesForm/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`MLB Stats API HTTP ${response.status}`);
  return response.json();
}

async function resolveCheckpoint(date, requested) {
  if (requested) {
    const cp = normalizeCheckpoint(requested);
    return cp ? { checkpoint: cp, payload: await readDoublesCheckpoint(date, cp) } : null;
  }
  for (const cp of CHECKPOINTS) {
    const payload = await readDoublesCheckpoint(date, cp);
    if (payload?.status === 'ready') return { checkpoint: cp, payload };
  }
  return null;
}

async function playerDirectory(season) {
  const cacheKey = `mlbdoubles:player-directory:${season}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) return JSON.parse(cached);
  } catch (_) {}
  const payload = await fetchJson(`${MLB}/sports/1/players?season=${season}&gameType=R`);
  const rawRows = payload?.people || payload?.players || [];
  const rows = rawRows
    .map((row) => row?.person || row)
    .filter((row) => Number.isFinite(Number(row?.id)) && row?.fullName)
    .map((row) => ({
      id: Number(row.id), fullName: String(row.fullName), playerKey: playerKey(row.fullName),
      currentTeam: row?.currentTeam?.abbreviation || row?.currentTeam?.name || null,
    }));
  try { await redisCommand(['SET', cacheKey, JSON.stringify(rows), 'EX', 21600]); } catch (_) {}
  return rows;
}

function hydrateBatters(oddsRows, directory) {
  const byKey = new Map();
  for (const player of directory) {
    if (!byKey.has(player.playerKey)) byKey.set(player.playerKey, []);
    byKey.get(player.playerKey).push(player);
  }
  const rows = [];
  const missing = [];
  const ambiguous = [];
  for (const row of oddsRows) {
    const matches = byKey.get(row.playerKey) || [];
    if (matches.length === 1) rows.push({ ...row, batterId: matches[0].id, batterTeam: matches[0].currentTeam });
    else if (matches.length > 1) ambiguous.push({ batterName: row.batterName, candidateIds: matches.map((x) => x.id) });
    else missing.push(row.batterName);
  }
  return { rows, missing, ambiguous };
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function extractGameLog(person) {
  for (const stat of person?.stats || []) if (Array.isArray(stat?.splits)) return stat.splits;
  return [];
}

async function bulkGameLogs(ids, season, slateDate) {
  const uniqueIds = [...new Set(ids.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const signature = crypto.createHash('sha1').update(uniqueIds.join(',')).digest('hex').slice(0, 16);
  const cacheKey = `mlbdoubles:bulk-gamelog:${slateDate}:${signature}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) return new Map(JSON.parse(cached));
  } catch (_) {}

  const responses = await Promise.all(chunks(uniqueIds, BULK_SIZE).map(async (group) => {
    const params = new URLSearchParams({
      personIds: group.join(','),
      hydrate: `stats(group=[hitting],type=[gameLog],season=${season})`,
    });
    const payload = await fetchJson(`${MLB}/people?${params.toString()}`, 18000);
    return payload?.people || [];
  }));

  const entries = [];
  for (const people of responses) {
    for (const person of people) {
      const id = Number(person?.id);
      if (Number.isFinite(id)) entries.push([id, extractGameLog(person)]);
    }
  }
  try { await redisCommand(['SET', cacheKey, JSON.stringify(entries), 'EX', 259200]); } catch (_) {}
  return new Map(entries);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function priorGames(logs, slateDate) {
  return (logs || [])
    .filter((split) => String(split?.date || '') < slateDate)
    .filter((split) => num(split?.stat?.plateAppearances) > 0)
    .map((split) => ({
      date: split.date,
      gamePk: split?.game?.gamePk || null,
      opponent: split?.opponent?.name || null,
      doubles: num(split?.stat?.doubles),
      plateAppearances: num(split?.stat?.plateAppearances),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || num(b.gamePk) - num(a.gamePk))
    .slice(0, 15);
}

function windowMetrics(games, n) {
  const sample = games.slice(0, n);
  const hits = sample.reduce((sum, row) => sum + (row.doubles > 0 ? 1 : 0), 0);
  return {
    games: sample.length,
    doubleGames: hits,
    hitRate: sample.length ? hits / sample.length : null,
    fixedRate: hits / n,
  };
}

function formMetrics(games) {
  const l5 = windowMetrics(games, 5);
  const l7 = windowMetrics(games, 7);
  const l15 = windowMetrics(games, 15);
  const score = 0.50 * l5.fixedRate + 0.30 * l7.fixedRate + 0.20 * l15.fixedRate;
  return {
    formScore: Number((100 * score).toFixed(1)),
    gamesAvailable: games.length,
    provisional: games.length < 15,
    l5, l7, l15,
    doublesL15: games.reduce((sum, row) => sum + row.doubles, 0),
    recentDoubles: games.map((row) => row.doubles),
    recentGames: games,
  };
}

function americanBetter(a, b) {
  if (a == null) return false;
  if (b == null) return true;
  return Number(a) > Number(b);
}

function quoteSummary(odds) {
  const quotes = [];
  let bestYes = null;
  for (const [book, value] of Object.entries(odds || {})) {
    const quote = { book, ...value };
    quotes.push(quote);
    if (!bestYes || americanBetter(quote.americanOdds, bestYes.americanOdds)) bestYes = quote;
  }
  return { quotes, bestYes };
}

module.exports = async function doublesFormHandler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  const date = String(request.query?.date || etDate());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return response.status(400).json({ status: 'error', message: 'Invalid date' });

  try {
    const resolved = await resolveCheckpoint(date, request.query?.checkpoint);
    if (!resolved?.payload) {
      response.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
      return response.status(404).json({
        status: 'pending', date, checkpoint: resolved?.checkpoint || null,
        message: 'No archived doubles checkpoint is available for this slate yet',
        providerRequests: 0, quotaObjectsAdded: 0,
      });
    }

    const season = Number(date.slice(0, 4));
    const directory = await playerDirectory(season);
    const hydrated = hydrateBatters(resolved.payload.rows || [], directory);
    const uniqueBatters = [...new Map(hydrated.rows.map((row) => [Number(row.batterId), row])).values()];
    const rawHistories = await bulkGameLogs(uniqueBatters.map((row) => row.batterId), season, date);
    const histories = new Map();
    for (const batter of uniqueBatters) {
      histories.set(Number(batter.batterId), priorGames(rawHistories.get(Number(batter.batterId)) || [], date));
    }

    const rows = [];
    for (const oddsRow of hydrated.rows) {
      const games = histories.get(Number(oddsRow.batterId)) || [];
      const form = formMetrics(games);
      if (!games.length || form.doublesL15 < 1) continue;
      const quote = quoteSummary(oddsRow.odds);
      if (!quote.bestYes) continue;
      rows.push({
        batterId: Number(oddsRow.batterId),
        batterName: oddsRow.batterName,
        batterTeam: oddsRow.batterTeam || null,
        playerKey: oddsRow.playerKey,
        matchup: oddsRow.matchup || null,
        gameStartAt: oddsRow.gameStartAt || null,
        sourceEventId: oddsRow.sourceEventId || null,
        bestYes: quote.bestYes,
        quotes: quote.quotes,
        form,
      });
    }

    rows.sort((a, b) =>
      (b.form.formScore - a.form.formScore)
      || (b.form.l5.doubleGames - a.form.l5.doubleGames)
      || (b.form.l7.doubleGames - a.form.l7.doubleGames)
      || (b.form.l15.doubleGames - a.form.l15.doubleGames)
      || (b.form.doublesL15 - a.form.doublesL15)
      || a.batterName.localeCompare(b.batterName));

    const output = {
      schemaVersion: 1,
      kind: 'batter_doubles_form_board',
      status: rows.length ? 'ready' : 'no_rows',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: resolved.checkpoint,
      checkpointAsOf: resolved.payload.asOf,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      methodology: {
        market: 'Batter 1+ Double',
        formScore: '50% last-5 + 30% last-7 + 20% last-15 double-game rate using fixed 5/7/15 denominators. Sportsbook price is excluded.',
        eligibility: 'At least one double in the prior 15 plate-appearance games and a current archived doubles quote.',
        history: 'Only games strictly before the slate date are used. MLB game logs are fetched in bulk.',
        pricePolicy: 'DraftKings, FanDuel and BetMGM prices are display/execution inputs only and never affect form rank.',
      },
      coverage: {
        offeredRows: resolved.payload.rowCount || 0,
        quotedRowsHydrated: hydrated.rows.length,
        missingPlayerMatches: hydrated.missing,
        ambiguousPlayerMatches: hydrated.ambiguous,
      },
      rows: rows.slice(0, FORM_LIMIT),
    };
    response.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    return response.status(500).json({
      status: 'error', date, providerRequests: 0, quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
