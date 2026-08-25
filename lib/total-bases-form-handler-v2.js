const crypto = require('node:crypto');
const { normalizeCheckpoint, playerKey, redisCommand } = require('./checkpoint-runtime');
const { readTotalBasesCheckpoint, TARGET_LINE } = require('./total-bases-runtime');

const MLB = 'https://statsapi.mlb.com/api/v1';
const CHECKPOINTS = ['2017', '1717', '1117', '0817'];
const PRIOR_GAMES = 4;
const DEFAULT_PRIOR = 0.40;
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

async function fetchJson(url, timeout = 14000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MLBTotalBasesForm/2.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`MLB Stats API HTTP ${response.status}`);
  return response.json();
}

async function resolveCheckpoint(date, requested) {
  if (requested) {
    const cp = normalizeCheckpoint(requested);
    return cp ? { checkpoint: cp, payload: await readTotalBasesCheckpoint(date, cp) } : null;
  }
  for (const cp of CHECKPOINTS) {
    const payload = await readTotalBasesCheckpoint(date, cp);
    if (payload?.status === 'ready') return { checkpoint: cp, payload };
  }
  return null;
}

async function playerDirectory(season) {
  const cacheKey = `mlbtb2:player-directory:${season}`;
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
      id: Number(row.id),
      fullName: String(row.fullName),
      playerKey: playerKey(row.fullName),
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
    if (matches.length === 1) {
      rows.push({ ...row, batterId: matches[0].id, batterTeam: matches[0].currentTeam });
    } else if (matches.length > 1) {
      ambiguous.push({ batterName: row.batterName, candidateIds: matches.map((item) => item.id) });
    } else {
      missing.push(row.batterName);
    }
  }
  return { rows, missing, ambiguous };
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function extractHydratedGameLog(person) {
  for (const stat of person?.stats || []) {
    if (Array.isArray(stat?.splits)) return stat.splits;
  }
  return [];
}

async function bulkGameLogs(ids, season, slateDate) {
  const uniqueIds = [...new Set(ids.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const signature = crypto.createHash('sha1').update(uniqueIds.join(',')).digest('hex').slice(0, 16);
  const cacheKey = `mlbtb2:bulk-gamelog:${slateDate}:${signature}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) return new Map(JSON.parse(cached));
  } catch (_) {}

  const groups = chunks(uniqueIds, BULK_SIZE);
  const responses = await Promise.all(groups.map(async (group) => {
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
      if (!Number.isFinite(id)) continue;
      entries.push([id, extractHydratedGameLog(person)]);
    }
  }
  const map = new Map(entries);
  try { await redisCommand(['SET', cacheKey, JSON.stringify(entries), 'EX', 259200]); } catch (_) {}
  return map;
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function totalBases(stat) {
  if (stat?.totalBases != null && Number.isFinite(Number(stat.totalBases))) return Number(stat.totalBases);
  const hits = number(stat?.hits);
  const doubles = number(stat?.doubles);
  const triples = number(stat?.triples);
  const homeRuns = number(stat?.homeRuns);
  const singles = Math.max(0, hits - doubles - triples - homeRuns);
  return singles + 2 * doubles + 3 * triples + 4 * homeRuns;
}

function startsBefore(logs, slateDate) {
  return (logs || [])
    .filter((split) => String(split?.date || '') < slateDate)
    .filter((split) => {
      const pa = Number(split?.stat?.plateAppearances);
      if (Number.isFinite(pa) && pa <= 0) return false;
      const gs = Number(split?.stat?.gamesStarted);
      return Number.isFinite(gs) ? gs > 0 : true;
    })
    .map((split) => {
      const stat = split?.stat || {};
      const tb = totalBases(stat);
      const xbh = number(stat.doubles) + number(stat.triples) + number(stat.homeRuns);
      return {
        date: split.date,
        opponent: split?.opponent?.name || null,
        totalBases: tb,
        hit2Plus: tb >= 2 ? 1 : 0,
        hits: number(stat.hits),
        extraBaseHit: xbh > 0 ? 1 : 0,
        plateAppearances: number(stat.plateAppearances) || null,
      };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function avg(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null;
}

function windowMetrics(starts, n, prior) {
  const sample = starts.slice(0, n);
  if (!sample.length) {
    return { games: 0, hits2Plus: 0, hitRate: null, adjustedHitRate: prior, avgTb: null, xbhRate: null, paPerGame: null };
  }
  const hits2Plus = sample.reduce((sum, row) => sum + row.hit2Plus, 0);
  return {
    games: sample.length,
    hits2Plus,
    hitRate: hits2Plus / sample.length,
    adjustedHitRate: (hits2Plus + prior * PRIOR_GAMES) / (sample.length + PRIOR_GAMES),
    avgTb: avg(sample.map((row) => row.totalBases)),
    xbhRate: avg(sample.map((row) => row.extraBaseHit)),
    paPerGame: avg(sample.map((row) => row.plateAppearances).filter(Number.isFinite)),
  };
}

function formMetrics(starts, prior) {
  const l5 = windowMetrics(starts, 5, prior);
  const l10 = windowMetrics(starts, 10, prior);
  const l15 = windowMetrics(starts, 15, prior);
  const weightedAdjustedRate = 0.5 * l5.adjustedHitRate + 0.3 * l10.adjustedHitRate + 0.2 * l15.adjustedHitRate;
  const avgParts = [[0.5, l5.avgTb], [0.3, l10.avgTb], [0.2, l15.avgTb]].filter(([, value]) => value != null);
  const avgWeight = avgParts.reduce((sum, [w]) => sum + w, 0) || 1;
  const weightedAvgTb = avgParts.reduce((sum, [w, value]) => sum + w * value, 0) / avgWeight;
  return {
    formScore: Number((100 * weightedAdjustedRate).toFixed(1)),
    weightedAdjustedRate: Number(weightedAdjustedRate.toFixed(4)),
    weightedAvgTb: Number(weightedAvgTb.toFixed(2)),
    trend5v15: l5.hitRate == null || l15.hitRate == null ? null : Number((l5.hitRate - l15.hitRate).toFixed(4)),
    gamesAvailable: starts.length,
    l5, l10, l15,
    recentTb: starts.slice(0, 10).map((row) => row.totalBases),
    recentStarts: starts.slice(0, 15),
  };
}

function americanBetter(a, b) {
  if (a == null) return false;
  if (b == null) return true;
  return Number(a) > Number(b);
}

function quoteSummary(odds) {
  const quotes = [];
  let bestOver = null;
  for (const [book, sides] of Object.entries(odds || {})) {
    if (sides?.over && Number(sides.over.line) === TARGET_LINE) {
      const quote = { book, side: 'over', ...sides.over };
      quotes.push(quote);
      if (!bestOver || americanBetter(quote.americanOdds, bestOver.americanOdds)) bestOver = quote;
    }
    if (sides?.under && Number(sides.under.line) === TARGET_LINE) quotes.push({ book, side: 'under', ...sides.under });
  }
  return { quotes, bestOver };
}

function slatePrior(histories) {
  let games = 0;
  let hits = 0;
  for (const starts of histories.values()) {
    for (const row of starts.slice(0, 30)) {
      games += 1;
      hits += row.hit2Plus;
    }
  }
  return games ? hits / games : DEFAULT_PRIOR;
}

module.exports = async function totalBasesFormHandler(request, response) {
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
        message: 'No archived 2+ total-bases checkpoint is available for this slate yet',
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
      histories.set(Number(batter.batterId), startsBefore(rawHistories.get(Number(batter.batterId)) || [], date));
    }

    const prior = slatePrior(histories);
    const allRows = [];
    for (const oddsRow of hydrated.rows) {
      const starts = histories.get(Number(oddsRow.batterId)) || [];
      if (!starts.length) continue;
      const quote = quoteSummary(oddsRow.odds);
      if (!quote.bestOver) continue;
      allRows.push({
        batterId: Number(oddsRow.batterId),
        batterName: oddsRow.batterName,
        batterTeam: oddsRow.batterTeam || null,
        playerKey: oddsRow.playerKey,
        matchup: oddsRow.matchup || null,
        gameStartAt: oddsRow.gameStartAt || null,
        sourceEventId: oddsRow.sourceEventId || null,
        targetLine: TARGET_LINE,
        bestOver: quote.bestOver,
        quotes: quote.quotes,
        form: formMetrics(starts, prior),
      });
    }

    allRows.sort((a, b) =>
      (b.form.formScore - a.form.formScore)
      || (b.form.weightedAvgTb - a.form.weightedAvgTb)
      || ((b.form.l5.hitRate || 0) - (a.form.l5.hitRate || 0))
      || a.batterName.localeCompare(b.batterName));
    const rows = allRows.slice(0, FORM_LIMIT);

    const output = {
      schemaVersion: 2,
      kind: 'batter_two_plus_total_bases_form_board',
      status: rows.length ? 'ready' : 'no_rows',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: resolved.checkpoint,
      checkpointAsOf: resolved.payload.asOf,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      methodology: {
        market: 'Batter 2+ Total Bases (Over 1.5)',
        targetLine: TARGET_LINE,
        formScore: '50% last-5 + 30% last-10 + 20% last-15 empirical-Bayes 2+ TB hit rate. Each window is shrunk by four games toward the current offered-slate prior. Sportsbook price is not used.',
        tieBreak: 'Weighted recent total bases per start, then raw last-5 2+ TB hit rate.',
        samplePolicy: 'Players with fewer than 15 starts remain eligible; shrinkage prevents tiny hot samples from dominating.',
        history: 'Only games strictly before the slate date are used. MLB game logs are fetched in bulk rather than one request per batter.',
        execution: 'Only sportsbook Over 1.5 Total Bases quotes are treated as the 2+ TB bet. 0.5, 2.5 and other ladders are excluded.',
      },
      dataQuality: {
        archivedPropRows: resolved.payload.rows?.length || 0,
        playerDirectoryRows: directory.length,
        hydratedPropRows: hydrated.rows.length,
        uniqueBattersFetched: uniqueBatters.length,
        bulkRequests: Math.ceil(uniqueBatters.length / BULK_SIZE),
        rankedBeforeLimit: allRows.length,
        rankedRows: rows.length,
        formLimit: FORM_LIMIT,
        slatePriorTb2Rate: Number(prior.toFixed(4)),
        unmatchedArchivedNames: hydrated.missing,
        ambiguousArchivedNames: hydrated.ambiguous,
      },
      rows,
    };
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', '*');
    return response.status(500).json({
      status: 'error', date,
      providerRequests: 0, quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
