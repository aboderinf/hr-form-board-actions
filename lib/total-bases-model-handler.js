const { normalizeCheckpoint, playerKey, redisCommand } = require('./checkpoint-runtime');
const { readTotalBasesCheckpoint, TARGET_LINE } = require('./total-bases-runtime');

const MLB = 'https://statsapi.mlb.com/api/v1';
const ARCHIVE_START = '2026-08-02';
const CHECKPOINTS = ['2017', '1717', '1117', '0817'];
const CHECKPOINT_ASC = ['0817', '1117', '1717', '2017'];
const BULK_SIZE = 28;
const MODEL_VERSION = 'v1.1';
const CACHE_TTL_SECONDS = 21600;
const MAX_BASE_ROWS = 18000;
const FEATURE_NAMES = [
  'seasonHit2', 'recent5Hit2', 'recent10Hit2', 'recent15Hit2',
  'seasonTbPa', 'recent15TbPa', 'recent15HitsPa', 'recent15XbhPa',
  'recent15HrPa', 'recent15KPa', 'recent15BbPa', 'paPerGame',
  'trend5Season', 'restDays', 'logBatterGames',
  'starterHitsPerBf', 'starterRecentHitsPerBf', 'starterHrPerBf',
  'starterKPerBf', 'starterBbPerBf', 'starterExpectedBf', 'logStarterGames',
  'parkHit2Rate', 'opponentAllowedHit2Rate', 'teamOffenseHit2Rate',
  'home', 'platoonAdv',
];

function etDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const out = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) out.push(cursor);
  return out;
}

function monthStart(iso) {
  return `${String(iso).slice(0, 7)}-01`;
}

function previousMonthEnd(iso) {
  return addDays(monthStart(iso), -1);
}

function seasonStart(season) {
  return `${season}-03-15`;
}

async function fetchJson(url, timeout = 30000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MLBTotalBasesModel/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`MLB Stats API HTTP ${response.status}`);
  return response.json();
}

async function mapWithConcurrency(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function avg(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function totalBases(stat) {
  if (stat?.totalBases != null && Number.isFinite(Number(stat.totalBases))) return Number(stat.totalBases);
  const hits = num(stat?.hits);
  const doubles = num(stat?.doubles);
  const triples = num(stat?.triples);
  const homeRuns = num(stat?.homeRuns);
  const singles = Math.max(0, hits - doubles - triples - homeRuns);
  return singles + 2 * doubles + 3 * triples + 4 * homeRuns;
}

function parseIsoDay(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function daysBetween(a, b) {
  const x = Date.parse(`${a}T12:00:00Z`);
  const y = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 4;
  return Math.max(0, Math.round((y - x) / 86400000));
}

function teamCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
  const aliases = {
    AZ: 'ARI', ARI: 'ARI', CWS: 'CHW', CHW: 'CHW', KC: 'KCR', KCR: 'KCR',
    SD: 'SDP', SDP: 'SDP', SF: 'SFG', SFG: 'SFG', TB: 'TBR', TBR: 'TBR',
    WSH: 'WSH', WAS: 'WSH', NYY: 'NYY', NYM: 'NYM', LAD: 'LAD', LAA: 'LAA',
  };
  return aliases[raw] || raw;
}

function matchupKey(value) {
  const parts = String(value || '').split('@').map((part) => teamCode(part.trim()));
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[0]}@${parts[1]}` : null;
}

async function resolveCheckpoint(date, requested) {
  if (requested) {
    const checkpoint = normalizeCheckpoint(requested);
    return checkpoint ? { checkpoint, payload: await readTotalBasesCheckpoint(date, checkpoint) } : null;
  }
  for (const checkpoint of CHECKPOINTS) {
    const payload = await readTotalBasesCheckpoint(date, checkpoint);
    if (payload?.status === 'ready') return { checkpoint, payload };
  }
  return null;
}

async function archiveCaptures(start, through) {
  if (through < start) return [];
  const requests = dateRange(start, through).flatMap((date) => CHECKPOINT_ASC.map((checkpoint) => ({ date, checkpoint })));
  const values = await mapWithConcurrency(requests, 14, async ({ date, checkpoint }) => {
    try {
      const payload = await readTotalBasesCheckpoint(date, checkpoint);
      return payload?.status === 'ready' ? payload : null;
    } catch {
      return null;
    }
  });
  return values.filter(Boolean);
}

async function playerDirectory(season) {
  const cacheKey = `mlbtb2:model:directory:${season}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) return JSON.parse(cached);
  } catch (_) {}
  const payload = await fetchJson(`${MLB}/sports/1/players?season=${season}&gameType=R`, 25000);
  const raw = payload?.people || payload?.players || [];
  const rows = raw.map((row) => row?.person || row)
    .filter((row) => Number.isFinite(Number(row?.id)) && row?.fullName)
    .map((row) => ({
      id: Number(row.id),
      fullName: String(row.fullName),
      playerKey: playerKey(row.fullName),
      batSide: row?.batSide?.code || null,
      pitchHand: row?.pitchHand?.code || null,
      currentTeamId: Number(row?.currentTeam?.id || 0) || null,
      currentTeamCode: teamCode(row?.currentTeam?.abbreviation || row?.currentTeam?.name || ''),
    }));
  try { await redisCommand(['SET', cacheKey, JSON.stringify(rows), 'EX', 21600]); } catch (_) {}
  return rows;
}

function directoryIndex(directory) {
  const byKey = new Map();
  for (const player of directory) {
    if (!byKey.has(player.playerKey)) byKey.set(player.playerKey, []);
    byKey.get(player.playerKey).push(player);
  }
  return byKey;
}

function hydrateOddsRows(rows, byKey) {
  const hydrated = [];
  const missing = new Set();
  const ambiguous = new Set();
  for (const row of rows || []) {
    const matches = byKey.get(row.playerKey) || [];
    if (matches.length === 1) hydrated.push({ ...row, batterId: matches[0].id, playerInfo: matches[0] });
    else if (matches.length > 1) ambiguous.add(row.batterName);
    else missing.add(row.batterName);
  }
  return { rows: hydrated, missing, ambiguous };
}

function extractGameLog(person) {
  for (const stat of person?.stats || []) if (Array.isArray(stat?.splits)) return stat.splits;
  return [];
}

async function bulkPeopleLogs(ids, season, group) {
  const unique = [...new Set(ids.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const groups = chunks(unique, BULK_SIZE);
  const responses = await mapWithConcurrency(groups, 6, async (groupIds) => {
    const params = new URLSearchParams({
      personIds: groupIds.join(','),
      hydrate: `stats(group=[${group}],type=[gameLog],season=${season})`,
    });
    const payload = await fetchJson(`${MLB}/people?${params.toString()}`, 35000);
    return payload?.people || [];
  });
  const logs = new Map();
  const info = new Map();
  for (const people of responses) {
    for (const person of people) {
      const id = Number(person?.id);
      if (!Number.isFinite(id)) continue;
      logs.set(id, extractGameLog(person));
      info.set(id, {
        id,
        fullName: person?.fullName || null,
        batSide: person?.batSide?.code || null,
        pitchHand: person?.pitchHand?.code || null,
        currentTeamId: Number(person?.currentTeam?.id || 0) || null,
      });
    }
  }
  return { logs, info, requestCount: groups.length };
}

async function scheduleRange(start, end) {
  const params = new URLSearchParams({
    sportId: '1', gameType: 'R', startDate: start, endDate: end,
    hydrate: 'team,probablePitcher,venue',
  });
  return fetchJson(`${MLB}/schedule?${params.toString()}`, 35000);
}

function scheduleGames(payload) {
  const games = [];
  for (const dateRow of payload?.dates || []) {
    const date = parseIsoDay(dateRow?.date);
    if (!date) continue;
    for (const game of dateRow?.games || []) {
      const home = game?.teams?.home || {};
      const away = game?.teams?.away || {};
      const homeTeam = home?.team || {};
      const awayTeam = away?.team || {};
      const homeCode = teamCode(homeTeam?.abbreviation || homeTeam?.teamCode || homeTeam?.name || '');
      const awayCode = teamCode(awayTeam?.abbreviation || awayTeam?.teamCode || awayTeam?.name || '');
      games.push({
        date,
        gamePk: Number(game?.gamePk || 0) || null,
        gameStartAt: game?.gameDate || null,
        homeTeamId: Number(homeTeam?.id || 0) || null,
        awayTeamId: Number(awayTeam?.id || 0) || null,
        homeCode,
        awayCode,
        matchupKey: homeCode && awayCode ? `${awayCode}@${homeCode}` : null,
        homeStarterId: Number(home?.probablePitcher?.id || 0) || null,
        awayStarterId: Number(away?.probablePitcher?.id || 0) || null,
        venueId: Number(game?.venue?.id || 0) || null,
        venueName: game?.venue?.name || null,
      });
    }
  }
  return games;
}

function normalizeBatterLogs(logs) {
  return (logs || []).map((split) => {
    const stat = split?.stat || {};
    const pa = num(stat?.plateAppearances);
    const gamesStartedRaw = Number(stat?.gamesStarted);
    const started = Number.isFinite(gamesStartedRaw) ? gamesStartedRaw > 0 : pa > 0;
    const hits = num(stat?.hits);
    const doubles = num(stat?.doubles);
    const triples = num(stat?.triples);
    const homeRuns = num(stat?.homeRuns);
    return {
      date: parseIsoDay(split?.date),
      gamePk: Number(split?.game?.gamePk || split?.gamePk || 0) || null,
      teamId: Number(split?.team?.id || 0) || null,
      started,
      plateAppearances: pa,
      hits,
      doubles,
      triples,
      homeRuns,
      xbh: doubles + triples + homeRuns,
      strikeOuts: num(stat?.strikeOuts),
      baseOnBalls: num(stat?.baseOnBalls),
      totalBases: totalBases(stat),
    };
  }).filter((row) => row.date && row.gamePk && row.started && row.plateAppearances > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.gamePk - b.gamePk);
}

function normalizePitcherLogs(logs) {
  return (logs || []).map((split) => {
    const stat = split?.stat || {};
    const gamesStartedRaw = Number(stat?.gamesStarted);
    const bf = num(stat?.battersFaced);
    const started = Number.isFinite(gamesStartedRaw) ? gamesStartedRaw > 0 : bf > 0;
    return {
      date: parseIsoDay(split?.date),
      gamePk: Number(split?.game?.gamePk || split?.gamePk || 0) || null,
      started,
      battersFaced: bf,
      hits: num(stat?.hits),
      homeRuns: num(stat?.homeRuns),
      baseOnBalls: num(stat?.baseOnBalls),
      strikeOuts: num(stat?.strikeOuts),
    };
  }).filter((row) => row.date && row.started && row.battersFaced > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.gamePk || 0) - (b.gamePk || 0));
}

function rate(rows, numerator, denominator, prior, priorWeight) {
  let n = 0;
  let d = 0;
  for (const row of rows) {
    n += num(row[numerator]);
    d += num(row[denominator]);
  }
  return (n + prior * priorWeight) / (d + priorWeight);
}

function batterMetrics(priorRows, leagueHit2 = 0.40) {
  const n = priorRows.length;
  const recent5 = priorRows.slice(-5);
  const recent10 = priorRows.slice(-10);
  const recent15 = priorRows.slice(-15);
  const wins = priorRows.reduce((sum, row) => sum + Number(row.totalBases >= 2), 0);
  const seasonHit2 = (wins + leagueHit2 * 12) / (n + 12);
  const hitRate = (rows, shrink) => {
    const h = rows.reduce((sum, row) => sum + Number(row.totalBases >= 2), 0);
    return (h + seasonHit2 * shrink) / (rows.length + shrink);
  };
  const ratio = (rows, field, fallback, priorWeight = 20) => {
    let numerator = 0;
    let pa = 0;
    for (const row of rows) {
      numerator += num(row[field]);
      pa += num(row.plateAppearances);
    }
    return (numerator + fallback * priorWeight) / (pa + priorWeight);
  };
  const paPerGame = recent15.length ? avg(recent15.map((row) => row.plateAppearances)) : 4.1;
  return {
    seasonHit2,
    recent5Hit2: hitRate(recent5, 4),
    recent10Hit2: hitRate(recent10, 5),
    recent15Hit2: hitRate(recent15, 6),
    seasonTbPa: ratio(priorRows, 'totalBases', 0.34, 45),
    recent15TbPa: ratio(recent15, 'totalBases', 0.34, 25),
    recent15HitsPa: ratio(recent15, 'hits', 0.235, 25),
    recent15XbhPa: ratio(recent15, 'xbh', 0.080, 25),
    recent15HrPa: ratio(recent15, 'homeRuns', 0.030, 25),
    recent15KPa: ratio(recent15, 'strikeOuts', 0.225, 25),
    recent15BbPa: ratio(recent15, 'baseOnBalls', 0.085, 25),
    paPerGame: paPerGame ?? 4.1,
    trend5Season: hitRate(recent5, 4) - seasonHit2,
    restDays: n ? Math.min(10, daysBetween(priorRows.at(-1).date, priorRows.at(-1).predictionDate || priorRows.at(-1).date)) : 4,
    logBatterGames: Math.log1p(n),
    formProbability: 0.5 * hitRate(recent5, 4) + 0.3 * hitRate(recent10, 5) + 0.2 * hitRate(recent15, 6),
    games: n,
  };
}

function pitcherMetrics(priorRows) {
  const season = priorRows;
  const recent5 = priorRows.slice(-5);
  const expectedBf = recent5.length ? avg(recent5.map((row) => row.battersFaced)) : 22;
  return {
    starterHitsPerBf: rate(season, 'hits', 'battersFaced', 0.225, 100),
    starterRecentHitsPerBf: rate(recent5, 'hits', 'battersFaced', 0.225, 60),
    starterHrPerBf: rate(season, 'homeRuns', 'battersFaced', 0.030, 120),
    starterKPerBf: rate(season, 'strikeOuts', 'battersFaced', 0.225, 100),
    starterBbPerBf: rate(season, 'baseOnBalls', 'battersFaced', 0.085, 100),
    starterExpectedBf: expectedBf ?? 22,
    logStarterGames: Math.log1p(season.length),
    games: season.length,
  };
}

function shrunkBinary(bucket, leagueRate, priorN = 100) {
  const n = Number(bucket?.n || 0);
  const wins = Number(bucket?.wins || 0);
  return (wins + leagueRate * priorN) / (n + priorN);
}

function contextState() {
  return { league: { n: 0, wins: 0 }, venue: new Map(), teamFor: new Map(), teamAgainst: new Map() };
}

function bucket(map, key) {
  if (!key) return null;
  if (!map.has(key)) map.set(key, { n: 0, wins: 0 });
  return map.get(key);
}

function contextFeatures(state, venueId, teamId, opponentId) {
  const leagueRate = state.league.n ? state.league.wins / state.league.n : 0.40;
  return {
    leagueHit2Rate: leagueRate,
    parkHit2Rate: shrunkBinary(venueId ? state.venue.get(venueId) : null, leagueRate, 120),
    teamOffenseHit2Rate: shrunkBinary(teamId ? state.teamFor.get(teamId) : null, leagueRate, 100),
    opponentAllowedHit2Rate: shrunkBinary(opponentId ? state.teamAgainst.get(opponentId) : null, leagueRate, 100),
  };
}

function updateContext(state, row) {
  const hit = Number(row.totalBases >= 2);
  state.league.n += 1;
  state.league.wins += hit;
  for (const target of [
    bucket(state.venue, row.venueId),
    bucket(state.teamFor, row.teamId),
    bucket(state.teamAgainst, row.opponentId),
  ]) {
    if (!target) continue;
    target.n += 1;
    target.wins += hit;
  }
}

function starterForGame(game, teamId) {
  if (!game || !teamId) return { starterId: null, home: 0, opponentId: null };
  if (Number(teamId) === Number(game.homeTeamId)) {
    return { starterId: game.awayStarterId, home: 1, opponentId: game.awayTeamId };
  }
  if (Number(teamId) === Number(game.awayTeamId)) {
    return { starterId: game.homeStarterId, home: 0, opponentId: game.homeTeamId };
  }
  return { starterId: null, home: 0, opponentId: null };
}

function platoonAdvantage(batSide, pitchHand) {
  const bat = String(batSide || '').toUpperCase();
  const pitch = String(pitchHand || '').toUpperCase();
  if (bat === 'S') return 1;
  if (!['L', 'R'].includes(bat) || !['L', 'R'].includes(pitch)) return 0.5;
  return bat === pitch ? 0 : 1;
}

function buildFeatureObject(batter, pitcher, context, extra) {
  return {
    seasonHit2: batter.seasonHit2,
    recent5Hit2: batter.recent5Hit2,
    recent10Hit2: batter.recent10Hit2,
    recent15Hit2: batter.recent15Hit2,
    seasonTbPa: batter.seasonTbPa,
    recent15TbPa: batter.recent15TbPa,
    recent15HitsPa: batter.recent15HitsPa,
    recent15XbhPa: batter.recent15XbhPa,
    recent15HrPa: batter.recent15HrPa,
    recent15KPa: batter.recent15KPa,
    recent15BbPa: batter.recent15BbPa,
    paPerGame: batter.paPerGame,
    trend5Season: batter.trend5Season,
    restDays: extra.restDays,
    logBatterGames: batter.logBatterGames,
    starterHitsPerBf: pitcher.starterHitsPerBf,
    starterRecentHitsPerBf: pitcher.starterRecentHitsPerBf,
    starterHrPerBf: pitcher.starterHrPerBf,
    starterKPerBf: pitcher.starterKPerBf,
    starterBbPerBf: pitcher.starterBbPerBf,
    starterExpectedBf: pitcher.starterExpectedBf,
    logStarterGames: pitcher.logStarterGames,
    parkHit2Rate: context.parkHit2Rate,
    opponentAllowedHit2Rate: context.opponentAllowedHit2Rate,
    teamOffenseHit2Rate: context.teamOffenseHit2Rate,
    home: extra.home,
    platoonAdv: extra.platoonAdv,
  };
}

function buildSeasonExamples(batterIds, batterLogs, batterInfo, pitcherLogs, pitcherInfo, games) {
  const gameByPk = new Map(games.filter((g) => g.gamePk).map((g) => [Number(g.gamePk), g]));
  const normalizedBatters = new Map();
  for (const id of batterIds) normalizedBatters.set(Number(id), normalizeBatterLogs(batterLogs.get(Number(id)) || []));
  const normalizedPitchers = new Map();
  for (const [id, logs] of pitcherLogs.entries()) normalizedPitchers.set(Number(id), normalizePitcherLogs(logs));

  const rawByDate = new Map();
  for (const [batterId, logs] of normalizedBatters.entries()) {
    for (const row of logs) {
      const game = gameByPk.get(Number(row.gamePk));
      if (!game) continue;
      const teamId = row.teamId || (game.homeTeamId === batterInfo.get(batterId)?.currentTeamId ? game.homeTeamId : null);
      const matchup = starterForGame(game, teamId);
      const raw = { ...row, batterId, teamId, game, ...matchup, venueId: game.venueId };
      if (!rawByDate.has(row.date)) rawByDate.set(row.date, []);
      rawByDate.get(row.date).push(raw);
    }
  }

  const context = contextState();
  const historyByBatter = new Map();
  const examples = [];
  const dates = [...rawByDate.keys()].sort();
  for (const date of dates) {
    const dayRows = rawByDate.get(date) || [];
    for (const row of dayRows) {
      if (!historyByBatter.has(row.batterId)) historyByBatter.set(row.batterId, []);
      const batterHistory = historyByBatter.get(row.batterId);
      if (batterHistory.length < 3) continue;
      const ctx = contextFeatures(context, row.venueId, row.teamId, row.opponentId);
      const batter = batterMetrics(batterHistory, ctx.leagueHit2Rate);
      const pitcherHistory = row.starterId
        ? (normalizedPitchers.get(Number(row.starterId)) || []).filter((item) => item.date < date)
        : [];
      const pitcher = pitcherMetrics(pitcherHistory);
      const batSide = batterInfo.get(row.batterId)?.batSide;
      const pitchHand = row.starterId ? pitcherInfo.get(Number(row.starterId))?.pitchHand : null;
      const restDays = batterHistory.length ? Math.min(10, daysBetween(batterHistory.at(-1).date, date)) : 4;
      const features = buildFeatureObject(batter, pitcher, ctx, {
        restDays,
        home: row.home,
        platoonAdv: platoonAdvantage(batSide, pitchHand),
      });
      examples.push({
        date,
        gamePk: row.gamePk,
        batterId: row.batterId,
        teamId: row.teamId,
        opponentId: row.opponentId,
        starterId: row.starterId,
        venueId: row.venueId,
        totalBases: row.totalBases,
        hit: row.totalBases >= 2 ? 1 : 0,
        formProbability: batter.formProbability,
        batterGames: batter.games,
        starterGames: pitcher.games,
        features,
      });
    }
    for (const row of dayRows) {
      if (!historyByBatter.has(row.batterId)) historyByBatter.set(row.batterId, []);
      historyByBatter.get(row.batterId).push(row);
      updateContext(context, row);
    }
  }
  return { examples, context, normalizedBatters, normalizedPitchers, gameByPk };
}

function sampleRows(rows, maxRows) {
  if (rows.length <= maxRows) return rows;
  const out = [];
  const step = rows.length / maxRows;
  for (let i = 0; i < maxRows; i += 1) out.push(rows[Math.floor(i * step)]);
  return out;
}

function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-Math.min(40, z));
    return 1 / (1 + e);
  }
  const e = Math.exp(Math.max(-40, z));
  return e / (1 + e);
}

function logit(p) {
  const x = Math.max(0.001, Math.min(0.999, Number(p)));
  return Math.log(x / (1 - x));
}

function fitLogistic(rows, featureNames = FEATURE_NAMES, options = {}) {
  const usable = rows.filter((row) => featureNames.every((name) => Number.isFinite(Number(row.features?.[name]))) && [0, 1].includes(Number(row.hit)));
  if (usable.length < 100) return { ready: false, n: usable.length, featureNames };
  const sampled = sampleRows(usable, Number(options.maxRows || MAX_BASE_ROWS));
  const means = [];
  const scales = [];
  for (const name of featureNames) {
    const values = sampled.map((row) => Number(row.features[name]));
    const mean = avg(values) || 0;
    const variance = avg(values.map((value) => (value - mean) ** 2)) || 0;
    means.push(mean);
    scales.push(Math.sqrt(variance) > 1e-6 ? Math.sqrt(variance) : 1);
  }
  const d = featureNames.length + 1;
  const beta = new Array(d).fill(0);
  const m = new Array(d).fill(0);
  const v = new Array(d).fill(0);
  const lambda = Number(options.lambda ?? 1.5);
  const iterations = Number(options.iterations ?? 70);
  const lr = Number(options.lr ?? 0.035);
  for (let iter = 1; iter <= iterations; iter += 1) {
    const grad = new Array(d).fill(0);
    for (const row of sampled) {
      let z = beta[0];
      for (let j = 0; j < featureNames.length; j += 1) z += beta[j + 1] * ((Number(row.features[featureNames[j]]) - means[j]) / scales[j]);
      const error = sigmoid(z) - Number(row.hit);
      grad[0] += error;
      for (let j = 0; j < featureNames.length; j += 1) grad[j + 1] += error * ((Number(row.features[featureNames[j]]) - means[j]) / scales[j]);
    }
    for (let j = 0; j < d; j += 1) {
      grad[j] /= sampled.length;
      if (j > 0) grad[j] += (lambda / sampled.length) * beta[j];
      m[j] = 0.9 * m[j] + 0.1 * grad[j];
      v[j] = 0.999 * v[j] + 0.001 * grad[j] * grad[j];
      const mh = m[j] / (1 - 0.9 ** iter);
      const vh = v[j] / (1 - 0.999 ** iter);
      beta[j] -= lr * mh / (Math.sqrt(vh) + 1e-8);
    }
  }
  return { ready: true, n: usable.length, sampledN: sampled.length, featureNames, means, scales, beta, lambda };
}

function predictFit(fit, features) {
  if (!fit?.ready) return null;
  let z = Number(fit.beta?.[0] || 0);
  for (let j = 0; j < fit.featureNames.length; j += 1) {
    const value = Number(features?.[fit.featureNames[j]]);
    if (!Number.isFinite(value)) return null;
    z += Number(fit.beta[j + 1] || 0) * ((value - Number(fit.means[j])) / Number(fit.scales[j] || 1));
  }
  return sigmoid(z);
}

function fitPlatt(rows, rawField) {
  const usable = rows.filter((row) => Number.isFinite(Number(row[rawField])) && [0, 1].includes(Number(row.hit)));
  if (usable.length < 50) return { ready: false, n: usable.length, a: 0, b: 1 };
  let a = 0;
  let b = 1;
  let ma = 0; let mb = 0; let va = 0; let vb = 0;
  for (let iter = 1; iter <= 140; iter += 1) {
    let ga = 0; let gb = 0;
    for (const row of usable) {
      const x = logit(row[rawField]);
      const error = sigmoid(a + b * x) - Number(row.hit);
      ga += error;
      gb += error * x;
    }
    ga /= usable.length; gb /= usable.length;
    ma = 0.9 * ma + 0.1 * ga; mb = 0.9 * mb + 0.1 * gb;
    va = 0.999 * va + 0.001 * ga * ga; vb = 0.999 * vb + 0.001 * gb * gb;
    const step = 0.03;
    a -= step * (ma / (1 - 0.9 ** iter)) / (Math.sqrt(va / (1 - 0.999 ** iter)) + 1e-8);
    b -= step * (mb / (1 - 0.9 ** iter)) / (Math.sqrt(vb / (1 - 0.999 ** iter)) + 1e-8);
  }
  return { ready: true, n: usable.length, a, b };
}

function applyPlatt(calibrator, raw) {
  if (!Number.isFinite(Number(raw))) return null;
  if (!calibrator?.ready) return Number(raw);
  return sigmoid(Number(calibrator.a) + Number(calibrator.b) * logit(raw));
}

function probabilityMetrics(rows, field) {
  const usable = rows.filter((row) => Number.isFinite(Number(row[field])) && [0, 1].includes(Number(row.hit)));
  if (!usable.length) return { n: 0, brier: null, logLoss: null, averageProbability: null, hitRate: null, calibrationGap: null };
  let brier = 0; let logLoss = 0; let wins = 0;
  for (const row of usable) {
    const y = Number(row.hit);
    const p = Math.max(0.001, Math.min(0.999, Number(row[field])));
    wins += y;
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  const avgP = avg(usable.map((row) => Number(row[field])));
  const hitRate = wins / usable.length;
  return {
    n: usable.length,
    brier: Number((brier / usable.length).toFixed(5)),
    logLoss: Number((logLoss / usable.length).toFixed(5)),
    averageProbability: Number(avgP.toFixed(4)),
    hitRate: Number(hitRate.toFixed(4)),
    calibrationGap: Number((avgP - hitRate).toFixed(4)),
  };
}

function quoteSummary(odds) {
  const quotes = [];
  let best = null;
  for (const [book, sides] of Object.entries(odds || {})) {
    const over = sides?.over;
    if (!over || Number(over.line) !== TARGET_LINE || !Number.isFinite(Number(over.americanOdds))) continue;
    const quote = { book, ...over, americanOdds: Number(over.americanOdds) };
    quotes.push(quote);
    if (!best || quote.americanOdds > best.americanOdds) best = quote;
  }
  return { quotes, best };
}

function impliedProbability(americanOdds) {
  const odds = Number(americanOdds);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : (-odds) / ((-odds) + 100);
}

function winProfit(americanOdds) {
  const odds = Number(americanOdds);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function expectedValue(probability, americanOdds) {
  const p = Number(probability);
  const win = winProfit(americanOdds);
  if (!Number.isFinite(p) || win == null) return null;
  return p * win - (1 - p);
}

function fairAmerican(probability) {
  const p = Number(probability);
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

function settle(hit, odds) {
  if (!hit) return -1;
  return winProfit(odds) ?? -1;
}

function strategySummary(rows) {
  const bets = rows.length;
  const wins = rows.filter((row) => row.hit).length;
  const netUnits = rows.reduce((sum, row) => sum + settle(row.hit, row.odds), 0);
  return {
    bets,
    slates: new Set(rows.map((row) => row.date)).size,
    wins,
    losses: bets - wins,
    hitRate: bets ? Number((wins / bets).toFixed(4)) : null,
    averageOdds: avg(rows.map((row) => row.odds)),
    averageEdge: avg(rows.map((row) => row.modelEdge)),
    averageEv: avg(rows.map((row) => row.modelEv)),
    netUnits: Number(netUnits.toFixed(3)),
    roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
  };
}

function tuneStrategy(rows) {
  const edges = [0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.10];
  const evs = [0.01, 0.03, 0.05, 0.07, 0.10];
  let best = null;
  for (const minEdge of edges) {
    for (const minEv of evs) {
      const selected = rows.filter((row) => Number(row.modelEdge) >= minEdge && Number(row.modelEv) >= minEv);
      if (selected.length < 25 || new Set(selected.map((row) => row.date)).size < 5) continue;
      const stats = strategySummary(selected);
      if (!(stats.roi > 0)) continue;
      const score = stats.netUnits + 0.25 * stats.bets * stats.roi;
      if (!best || score > best.score) best = { minEdge, minEv, score, stats };
    }
  }
  return best ? { ...best, ready: true } : { ready: false, minEdge: null, minEv: null, score: null, stats: strategySummary([]) };
}

function compactFit(fit) {
  if (!fit?.ready) return { ready: false, n: Number(fit?.n || 0) };
  return {
    ready: true,
    n: fit.n,
    sampledN: fit.sampledN,
    lambda: fit.lambda,
    featureNames: fit.featureNames,
    coefficients: fit.featureNames.map((name, index) => ({ name, standardizedCoefficient: Number(fit.beta[index + 1].toFixed(4)) }))
      .sort((a, b) => Math.abs(b.standardizedCoefficient) - Math.abs(a.standardizedCoefficient)),
  };
}

function currentFeatureRow(oddsRow, game, playerInfoRow, normalizedBatters, normalizedPitchers, pitcherInfo, context, date) {
  const batterId = Number(oddsRow.batterId);
  const allBatter = normalizedBatters.get(batterId) || [];
  const prior = allBatter.filter((row) => row.date < date);
  if (prior.length < 3) return null;
  const recentTeamId = prior.at(-1)?.teamId || null;
  const directoryTeamId = playerInfoRow?.currentTeamId || null;
  const teamId = [recentTeamId, directoryTeamId].find((id) =>
    Number(id) === Number(game?.homeTeamId) || Number(id) === Number(game?.awayTeamId)
  ) || recentTeamId || directoryTeamId || null;
  const matchup = starterForGame(game, teamId);
  const ctx = contextFeatures(context, game?.venueId, teamId, matchup.opponentId);
  const batter = batterMetrics(prior, ctx.leagueHit2Rate);
  const pitcherHistory = matchup.starterId
    ? (normalizedPitchers.get(Number(matchup.starterId)) || []).filter((row) => row.date < date)
    : [];
  const pitcher = pitcherMetrics(pitcherHistory);
  const pitchHand = matchup.starterId ? pitcherInfo.get(Number(matchup.starterId))?.pitchHand : null;
  const restDays = prior.length ? Math.min(10, daysBetween(prior.at(-1).date, date)) : 4;
  return {
    features: buildFeatureObject(batter, pitcher, ctx, {
      restDays,
      home: matchup.home,
      platoonAdv: platoonAdvantage(playerInfoRow?.batSide, pitchHand),
    }),
    formProbability: batter.formProbability,
    batterGames: batter.games,
    starterGames: pitcher.games,
    starterId: matchup.starterId,
    opponentId: matchup.opponentId,
    home: matchup.home,
  };
}

module.exports = async function totalBasesModelHandler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  const date = String(request.query?.date || etDate());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return response.status(400).json({ status: 'error', message: 'Invalid date' });

  const resolved = await resolveCheckpoint(date, request.query?.checkpoint);
  if (!resolved?.payload) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
    return response.status(404).json({
      status: 'pending', date, checkpoint: resolved?.checkpoint || null,
      message: 'No archived 2+ Total Bases checkpoint is available for this slate yet',
      providerRequests: 0, quotaObjectsAdded: 0,
    });
  }

  const through = addDays(date, -1);
  const cacheKey = `mlbtb2:model:${MODEL_VERSION}:${date}:${resolved.checkpoint}:${through}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) {
      const output = JSON.parse(cached);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
      response.setHeader('X-Total-Bases-Model-Cache', 'HIT');
      if (request.method === 'HEAD') return response.status(200).end();
      return response.status(200).json(output);
    }

    const season = Number(date.slice(0, 4));
    const archiveStart = monthStart(date) > ARCHIVE_START ? monthStart(date) : ARCHIVE_START;
    const [captures, directory, schedulePayload] = await Promise.all([
      archiveCaptures(archiveStart, through),
      playerDirectory(season),
      scheduleRange(seasonStart(season), date),
    ]);
    const byKey = directoryIndex(directory);
    const missingNames = new Set();
    const ambiguousNames = new Set();
    const allOddsRows = [...(resolved.payload.rows || [])];
    for (const capture of captures) allOddsRows.push(...(capture.rows || []));
    const hydrated = hydrateOddsRows(allOddsRows, byKey);
    hydrated.missing.forEach((name) => missingNames.add(name));
    hydrated.ambiguous.forEach((name) => ambiguousNames.add(name));
    const batterIds = [...new Set(hydrated.rows.map((row) => Number(row.batterId)).filter(Number.isFinite))];
    const games = scheduleGames(schedulePayload);
    const starterIds = [...new Set(games.flatMap((game) => [game.homeStarterId, game.awayStarterId]).filter(Boolean))];

    const [batterPack, pitcherPack] = await Promise.all([
      bulkPeopleLogs(batterIds, season, 'hitting'),
      bulkPeopleLogs(starterIds, season, 'pitching'),
    ]);
    const batterInfo = new Map(directory.map((row) => [Number(row.id), row]));
    for (const [id, info] of batterPack.info.entries()) batterInfo.set(Number(id), { ...(batterInfo.get(Number(id)) || {}), ...info });
    const built = buildSeasonExamples(batterIds, batterPack.logs, batterInfo, pitcherPack.logs, pitcherPack.info, games);
    const baseThrough = previousMonthEnd(date);
    const settledDates = [...new Set(captures.map((row) => row.date).filter((d) => d <= through))].sort();
    const splitIndex = settledDates.length >= 2 ? Math.max(1, Math.min(settledDates.length - 1, Math.floor(settledDates.length * 0.60))) : null;
    const holdoutStart = splitIndex == null ? null : settledDates[splitIndex];
    const calibrationStart = archiveStart;

    const baseRows = built.examples.filter((row) => row.date <= baseThrough && row.batterGames >= 5);
    const modelFit = fitLogistic(baseRows);
    if (!modelFit.ready) throw new Error(`Insufficient base rows for Total Bases model: ${modelFit.n}`);
    const withRaw = built.examples.map((row) => ({ ...row, rawModelProbability: predictFit(modelFit, row.features), rawFormProbability: row.formProbability }));
    const calibrationRows = holdoutStart
      ? withRaw.filter((row) => row.date >= calibrationStart && row.date < holdoutStart)
      : [];
    const holdoutRows = holdoutStart
      ? withRaw.filter((row) => row.date >= holdoutStart && row.date <= through)
      : [];
    const modelCalibrator = fitPlatt(calibrationRows, 'rawModelProbability');
    const formCalibrator = fitPlatt(calibrationRows, 'rawFormProbability');
    for (const row of withRaw) {
      row.modelProbability = applyPlatt(modelCalibrator, row.rawModelProbability);
      row.formCalibratedProbability = applyPlatt(formCalibrator, row.rawFormProbability);
    }
    const calibratedHoldout = holdoutRows.map((row) => ({
      ...row,
      modelProbability: applyPlatt(modelCalibrator, row.rawModelProbability),
      formCalibratedProbability: applyPlatt(formCalibrator, row.rawFormProbability),
    }));

    const exampleByDateBatter = new Map();
    for (const row of withRaw) {
      const key = `${row.date}|${row.batterId}`;
      if (!exampleByDateBatter.has(key)) exampleByDateBatter.set(key, []);
      exampleByDateBatter.get(key).push(row);
    }
    const archiveEvaluation = [];
    for (const capture of captures) {
      const hydratedCapture = hydrateOddsRows(capture.rows || [], byKey).rows;
      for (const oddsRow of hydratedCapture) {
        const matches = exampleByDateBatter.get(`${capture.date}|${Number(oddsRow.batterId)}`) || [];
        if (matches.length !== 1) continue;
        const example = matches[0];
        const quotes = quoteSummary(oddsRow.odds);
        if (!quotes.best) continue;
        const p = applyPlatt(modelCalibrator, example.rawModelProbability);
        const implied = impliedProbability(quotes.best.americanOdds);
        const ev = expectedValue(p, quotes.best.americanOdds);
        archiveEvaluation.push({
          date: capture.date,
          checkpoint: capture.checkpoint,
          batterId: Number(oddsRow.batterId),
          batterName: oddsRow.batterName,
          hit: example.hit,
          modelProbability: p,
          formProbability: applyPlatt(formCalibrator, example.rawFormProbability),
          odds: Number(quotes.best.americanOdds),
          book: quotes.best.book,
          impliedProbability: implied,
          modelEdge: p == null || implied == null ? null : p - implied,
          modelEv: ev,
        });
      }
    }
    const calibrationMarketRows = archiveEvaluation.filter((row) => holdoutStart && row.date >= calibrationStart && row.date < holdoutStart);
    const holdoutMarketRows = archiveEvaluation.filter((row) => holdoutStart && row.date >= holdoutStart && row.date <= through);
    const strategy = tuneStrategy(calibrationMarketRows);
    const selectRule = (rows) => strategy.ready ? rows.filter((row) => Number(row.modelEdge) >= strategy.minEdge && Number(row.modelEv) >= strategy.minEv) : [];
    const calibrationStrategy = strategySummary(selectRule(calibrationMarketRows));
    const holdoutStrategy = strategySummary(selectRule(holdoutMarketRows));
    const byCheckpoint = CHECKPOINT_ASC.map((checkpoint) => {
      const rows = selectRule(holdoutMarketRows.filter((row) => row.checkpoint === checkpoint));
      return { checkpoint, ...strategySummary(rows) };
    });

    const gameByMatchup = new Map(games.filter((game) => game.date === date && game.matchupKey).map((game) => [game.matchupKey, game]));
    const currentHydrated = hydrateOddsRows(resolved.payload.rows || [], byKey).rows;
    const liveRows = [];
    for (const oddsRow of currentHydrated) {
      const game = gameByMatchup.get(matchupKey(oddsRow.matchup));
      if (!game) continue;
      const playerInfoRow = batterInfo.get(Number(oddsRow.batterId)) || oddsRow.playerInfo;
      const featureRow = currentFeatureRow(
        oddsRow, game, playerInfoRow,
        built.normalizedBatters, built.normalizedPitchers, pitcherPack.info, built.context, date,
      );
      if (!featureRow) continue;
      const rawP = predictFit(modelFit, featureRow.features);
      const modelProbability = applyPlatt(modelCalibrator, rawP);
      const formProbability = applyPlatt(formCalibrator, featureRow.formProbability);
      const quotes = quoteSummary(oddsRow.odds);
      if (!quotes.best) continue;
      const implied = impliedProbability(quotes.best.americanOdds);
      const ev = expectedValue(modelProbability, quotes.best.americanOdds);
      liveRows.push({
        batterId: Number(oddsRow.batterId),
        batterName: oddsRow.batterName,
        matchup: oddsRow.matchup || null,
        gameStartAt: oddsRow.gameStartAt || game.gameStartAt,
        modelProbability: Number(modelProbability.toFixed(4)),
        formProbability: Number(formProbability.toFixed(4)),
        rawModelProbability: Number(rawP.toFixed(4)),
        fairAmerican: fairAmerican(modelProbability),
        bestOver: { book: quotes.best.book, americanOdds: Number(quotes.best.americanOdds), line: TARGET_LINE },
        impliedProbability: Number(implied.toFixed(4)),
        probabilityEdge: Number((modelProbability - implied).toFixed(4)),
        expectedValue: Number(ev.toFixed(4)),
        qualifies: Boolean(strategy.ready && Number(modelProbability - implied) >= strategy.minEdge && Number(ev) >= strategy.minEv),
        batterGames: featureRow.batterGames,
        starterGames: featureRow.starterGames,
        starterId: featureRow.starterId,
        features: Object.fromEntries(FEATURE_NAMES.map((name) => [name, Number(featureRow.features[name].toFixed(4))])),
      });
    }
    liveRows.sort((a, b) => Number(b.expectedValue) - Number(a.expectedValue) || Number(b.probabilityEdge) - Number(a.probabilityEdge));

    const modelHoldoutMetrics = probabilityMetrics(calibratedHoldout, 'modelProbability');
    const formHoldoutMetrics = probabilityMetrics(calibratedHoldout, 'formCalibratedProbability');
    const promoted = Boolean(
      holdoutStart
      && strategy.ready
      && modelHoldoutMetrics.n >= 500
      && modelHoldoutMetrics.brier != null && formHoldoutMetrics.brier != null
      && modelHoldoutMetrics.logLoss != null && formHoldoutMetrics.logLoss != null
      && modelHoldoutMetrics.brier < formHoldoutMetrics.brier
      && modelHoldoutMetrics.logLoss < formHoldoutMetrics.logLoss
      && holdoutStrategy.bets >= 25
      && Number(holdoutStrategy.roi) > 0
    );

    const output = {
      schemaVersion: 1,
      kind: 'batter_two_plus_total_bases_model_v1_1',
      status: liveRows.length ? 'ready' : 'no_rows',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: resolved.checkpoint,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      promoted,
      modelStatus: promoted ? 'PROMOTED' : 'UNPROMOTED',
      methodology: {
        target: 'P(batter records at least 2 total bases in the game)',
        marketIndependent: 'Sportsbook odds, book identity, market movement, and implied probability are excluded from the probability fit. Archived prices are used only after prediction to calculate edge, EV, and executable ROI.',
        training: `Base logistic fit uses 2026 starting-batter games through ${baseThrough}; rolling features use only prior dates. Early-month archive dates calibrate the raw probability; dates from ${holdoutStart || 'N/A'} onward are held out.`,
        features: FEATURE_NAMES,
        context: 'Batter season/recent production and opportunity, opposing starter contact/HR/K/BB/workload, rolling park 2+ TB environment, team offense, opponent allowed rate, home/away, and platoon orientation.',
        starterSource: 'MLB schedule probable-pitcher listing. Historical late starter changes can therefore create some identity noise; no game outcome statistic from the prediction date is used as an input.',
        validation: 'Promotion requires lower holdout Brier and log loss than a separately calibrated form-only baseline plus positive holdout ROI for a threshold tuned only on the earlier calibration block.',
      },
      split: { seasonStart: seasonStart(season), baseThrough, calibrationStart, holdoutStart, through },
      dataQuality: {
        archiveCaptures: captures.length,
        archiveEvaluationRows: archiveEvaluation.length,
        batterUniverse: batterIds.length,
        starterUniverse: starterIds.length,
        seasonExamples: built.examples.length,
        baseRows: baseRows.length,
        calibrationRows: calibrationRows.length,
        holdoutRows: holdoutRows.length,
        batterBulkRequests: batterPack.requestCount,
        pitcherBulkRequests: pitcherPack.requestCount,
        missingPlayerNames: [...missingNames].sort(),
        ambiguousPlayerNames: [...ambiguousNames].sort(),
      },
      validation: {
        modelProbability: modelHoldoutMetrics,
        formBaseline: formHoldoutMetrics,
        improvement: {
          brier: modelHoldoutMetrics.brier == null || formHoldoutMetrics.brier == null ? null : Number((formHoldoutMetrics.brier - modelHoldoutMetrics.brier).toFixed(5)),
          logLoss: modelHoldoutMetrics.logLoss == null || formHoldoutMetrics.logLoss == null ? null : Number((formHoldoutMetrics.logLoss - modelHoldoutMetrics.logLoss).toFixed(5)),
        },
        strategyRule: { ready: strategy.ready, minProbabilityEdge: strategy.minEdge, minExpectedValue: strategy.minEv, tunedOn: 'calibration archive only' },
        calibrationStrategy,
        holdoutStrategy,
        holdoutByCheckpoint: byCheckpoint,
      },
      fit: compactFit(modelFit),
      rows: liveRows.slice(0, 100),
    };

    try { await redisCommand(['SET', cacheKey, JSON.stringify(output), 'EX', CACHE_TTL_SECONDS]); } catch (_) {}
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    response.setHeader('X-Total-Bases-Model-Cache', 'MISS');
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    return response.status(500).json({
      status: 'error', date, checkpoint: resolved?.checkpoint || null,
      providerRequests: 0, quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
