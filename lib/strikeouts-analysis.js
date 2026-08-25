const { playerKey } = require('./checkpoint-runtime');

const MLB = 'https://statsapi.mlb.com/api/v1';
const LEAGUE_K_PA_FALLBACK = 0.225;

async function fetchJson(url, timeoutMs = 15000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MLBStrikeoutsResearch/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`MLB Stats API HTTP ${response.status}`);
  return response.json();
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function average(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function variance(values) {
  const rows = values.filter(Number.isFinite);
  if (rows.length < 2) return null;
  const mean = average(rows);
  return rows.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (rows.length - 1);
}

function dateDiffDays(left, right) {
  return Math.round((Date.parse(`${left}T12:00:00Z`) - Date.parse(`${right}T12:00:00Z`)) / 86400000);
}

function probablePitchers(schedule) {
  const rows = [];
  for (const dateRow of schedule?.dates || []) {
    for (const game of dateRow.games || []) {
      const away = game?.teams?.away || {};
      const home = game?.teams?.home || {};
      for (const [side, teamRow, opponentRow] of [
        ['away', away, home], ['home', home, away],
      ]) {
        const pitcher = teamRow.probablePitcher;
        if (!pitcher?.id || !pitcher?.fullName) continue;
        rows.push({
          mlbamId: Number(pitcher.id),
          pitcherName: pitcher.fullName,
          playerKey: playerKey(pitcher.fullName),
          teamId: Number(teamRow?.team?.id || 0) || null,
          opponentId: Number(opponentRow?.team?.id || 0) || null,
          team: teamRow?.team?.name || null,
          opponent: opponentRow?.team?.name || null,
          side,
          gamePk: Number(game.gamePk || 0) || null,
          gameStartAt: game.gameDate || null,
          gameStatus: game?.status?.detailedState || null,
        });
      }
    }
  }
  return rows;
}

async function fetchSchedule(date) {
  return fetchJson(`${MLB}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,teams`);
}

async function pitcherGameLog(pitcherId, season) {
  const payload = await fetchJson(`${MLB}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`);
  return payload?.stats?.[0]?.splits || [];
}

async function teamHittingGameLog(teamId, season) {
  const payload = await fetchJson(`${MLB}/teams/${teamId}/stats?stats=gameLog&group=hitting&season=${season}`);
  return payload?.stats?.[0]?.splits || [];
}

function normalizePitcherStarts(logs) {
  return (logs || []).map((split) => ({
    date: String(split?.date || ''),
    opponent: split?.opponent?.name || null,
    opponentId: Number(split?.opponent?.id || 0) || null,
    gamesStarted: Number(split?.stat?.gamesStarted || 0),
    strikeouts: Number(split?.stat?.strikeOuts || 0),
    inningsPitched: Number(split?.stat?.inningsPitched || 0),
    pitches: Number(split?.stat?.numberOfPitches || split?.stat?.pitchesThrown || 0) || null,
    battersFaced: Number(split?.stat?.battersFaced || 0) || null,
  })).filter((row) => row.date && row.gamesStarted > 0);
}

function startsBefore(logs, slateDate) {
  return normalizePitcherStarts(logs)
    .filter((row) => row.date < slateDate)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function settledStart(logs, slateDate) {
  const rows = normalizePitcherStarts(logs).filter((row) => row.date === slateDate);
  if (!rows.length) return null;
  return rows.sort((a, b) => (b.battersFaced || 0) - (a.battersFaced || 0))[0];
}

function windowMetrics(starts, line, n) {
  const sample = starts.slice(0, n);
  if (!sample.length) return { games: 0, overs: 0, pushes: 0, overRate: null, avgKs: null };
  const overs = sample.filter((row) => row.strikeouts > line).length;
  const pushes = sample.filter((row) => row.strikeouts === line).length;
  return {
    games: sample.length,
    overs,
    pushes,
    overRate: overs / sample.length,
    avgKs: average(sample.map((row) => row.strikeouts)),
  };
}

function formMetrics(starts, line) {
  const l3 = windowMetrics(starts, line, 3);
  const l5 = windowMetrics(starts, line, 5);
  const l10 = windowMetrics(starts, line, 10);
  const rateParts = [[0.5, l3.overRate], [0.3, l5.overRate], [0.2, l10.overRate]].filter(([, value]) => value != null);
  const rateWeight = rateParts.reduce((sum, [weight]) => sum + weight, 0) || 1;
  const weightedOverRate = rateParts.reduce((sum, [weight, value]) => sum + weight * value, 0) / rateWeight;
  const avgParts = [[0.5, l3.avgKs], [0.3, l5.avgKs], [0.2, l10.avgKs]].filter(([, value]) => value != null);
  const avgWeight = avgParts.reduce((sum, [weight]) => sum + weight, 0) || 1;
  const weightedAvgKs = avgParts.reduce((sum, [weight, value]) => sum + weight * value, 0) / avgWeight;
  return {
    formScore: Number((100 * weightedOverRate).toFixed(1)),
    weightedOverRate: Number(weightedOverRate.toFixed(4)),
    weightedAvgKs: Number(weightedAvgKs.toFixed(2)),
    weightedMargin: Number((weightedAvgKs - line).toFixed(2)),
    l3, l5, l10,
    recentKs: starts.slice(0, 10).map((row) => row.strikeouts),
  };
}

function teamPlateAppearances(stat) {
  const direct = Number(stat?.plateAppearances);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Number(stat?.atBats || 0)
    + Number(stat?.baseOnBalls || 0)
    + Number(stat?.hitByPitch || 0)
    + Number(stat?.sacFlies || 0)
    + Number(stat?.sacBunts || 0);
}

function teamKRateBefore(logs, slateDate, recentGames = 10) {
  const rows = (logs || [])
    .filter((split) => String(split?.date || '') < slateDate)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!rows.length) return null;

  function rate(sample) {
    let strikeouts = 0;
    let pa = 0;
    for (const row of sample) {
      strikeouts += Number(row?.stat?.strikeOuts || 0);
      pa += teamPlateAppearances(row?.stat || {});
    }
    return pa > 0 ? strikeouts / pa : null;
  }

  const seasonRate = rate(rows);
  const recentRate = rate(rows.slice(0, recentGames));
  if (seasonRate == null) return recentRate;
  if (recentRate == null) return seasonRate;
  return 0.65 * seasonRate + 0.35 * recentRate;
}

function leagueKRateBefore(teamLogs, slateDate) {
  let strikeouts = 0;
  let pa = 0;
  for (const logs of teamLogs.values()) {
    for (const row of logs || []) {
      if (String(row?.date || '') >= slateDate) continue;
      strikeouts += Number(row?.stat?.strikeOuts || 0);
      pa += teamPlateAppearances(row?.stat || {});
    }
  }
  return pa > 0 ? strikeouts / pa : LEAGUE_K_PA_FALLBACK;
}

function totals(sample) {
  return sample.reduce((acc, row) => {
    acc.k += Number(row.strikeouts || 0);
    acc.bf += Number(row.battersFaced || 0);
    return acc;
  }, { k: 0, bf: 0 });
}

function pitcherProjection(starts, opponentKRate, leagueKRate, slateDate) {
  if (!starts.length) return null;
  const longSample = starts.slice(0, 20);
  const recentSample = starts.slice(0, 5);
  const longTotals = totals(longSample);
  const recentTotals = totals(recentSample);
  const longRate = longTotals.bf > 0 ? longTotals.k / longTotals.bf : null;
  const recentRate = recentTotals.bf > 0 ? recentTotals.k / recentTotals.bf : longRate;
  if (longRate == null) return null;

  const kRate = recentRate == null ? longRate : (0.55 * recentRate + 0.45 * longRate);
  const bf3 = average(starts.slice(0, 3).map((row) => row.battersFaced).filter(Boolean));
  const bf5 = average(starts.slice(0, 5).map((row) => row.battersFaced).filter(Boolean));
  const bf10 = average(starts.slice(0, 10).map((row) => row.battersFaced).filter(Boolean));
  const projectedBF = [bf3, bf5, bf10].every((value) => value == null)
    ? 22
    : (0.50 * (bf3 ?? bf5 ?? bf10 ?? 22)) + (0.30 * (bf5 ?? bf3 ?? bf10 ?? 22)) + (0.20 * (bf10 ?? bf5 ?? bf3 ?? 22));

  const oppRate = Number.isFinite(opponentKRate) ? opponentKRate : leagueKRate;
  const leagueRate = Number.isFinite(leagueKRate) && leagueKRate > 0 ? leagueKRate : LEAGUE_K_PA_FALLBACK;
  const opponentFactor = clamp(oppRate / leagueRate, 0.85, 1.15);
  const restDays = starts[0]?.date ? dateDiffDays(slateDate, starts[0].date) : null;
  const restFactor = restDays != null && restDays <= 4 ? 0.96 : restDays != null && restDays >= 7 ? 1.01 : 1.0;
  const expectedKs = clamp(projectedBF * kRate * opponentFactor * restFactor, 0.4, 14.5);

  const recentKs = starts.slice(0, 10).map((row) => Number(row.strikeouts || 0));
  const recentMean = average(recentKs) || expectedKs;
  const observedVariance = variance(recentKs);
  const scale = recentMean > 0 ? expectedKs / recentMean : 1;
  const projectedVariance = Math.max(expectedKs, Number.isFinite(observedVariance) ? observedVariance * scale * scale : expectedKs);
  return {
    expectedKs: Number(expectedKs.toFixed(3)),
    variance: Number(projectedVariance.toFixed(3)),
    projectedBF: Number(projectedBF.toFixed(2)),
    pitcherKRate: Number(kRate.toFixed(4)),
    opponentKRate: Number(oppRate.toFixed(4)),
    leagueKRate: Number(leagueRate.toFixed(4)),
    opponentFactor: Number(opponentFactor.toFixed(3)),
    restDays,
    sampleStarts: starts.length,
  };
}

function poissonDistribution(mean, maxK = 35) {
  const probs = new Array(maxK + 1).fill(0);
  probs[0] = Math.exp(-mean);
  for (let k = 0; k < maxK; k += 1) probs[k + 1] = probs[k] * mean / (k + 1);
  return probs;
}

function negBinDistribution(mean, varianceValue, maxK = 35) {
  if (!(varianceValue > mean + 1e-6)) return poissonDistribution(mean, maxK);
  const r = (mean * mean) / (varianceValue - mean);
  const p = r / (r + mean);
  const probs = new Array(maxK + 1).fill(0);
  probs[0] = p ** r;
  for (let k = 0; k < maxK; k += 1) {
    probs[k + 1] = probs[k] * ((k + r) / (k + 1)) * (1 - p);
  }
  return probs;
}

function outcomeProbabilities(mean, varianceValue, line) {
  const probs = negBinDistribution(mean, varianceValue, 40);
  let overWin = 0;
  let underWin = 0;
  let push = 0;
  for (let k = 0; k < probs.length; k += 1) {
    const probability = probs[k];
    if (k > line) overWin += probability;
    else if (k < line) underWin += probability;
    else push += probability;
  }
  const captured = overWin + underWin + push;
  if (captured < 0.999999) overWin += 1 - captured;
  const decisive = overWin + underWin;
  return {
    overWin,
    underWin,
    push,
    fairOver: decisive > 0 ? overWin / decisive : 0.5,
    fairUnder: decisive > 0 ? underWin / decisive : 0.5,
  };
}

function americanImplied(odds) {
  const american = Number(odds);
  if (!Number.isFinite(american) || american === 0) return null;
  return american > 0 ? 100 / (american + 100) : Math.abs(american) / (Math.abs(american) + 100);
}

function decimalOdds(odds) {
  const american = Number(odds);
  if (!Number.isFinite(american) || american === 0) return null;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function fairAmerican(probability) {
  const p = clamp(Number(probability), 0.0001, 0.9999);
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

function noVigProbabilities(overQuote, underQuote) {
  const over = americanImplied(overQuote?.americanOdds);
  const under = americanImplied(underQuote?.americanOdds);
  if (over == null) return { over: null, under: null, method: 'missing' };
  if (under == null || Number(overQuote?.line) !== Number(underQuote?.line)) {
    return { over, under: under ?? (1 - over), method: 'one-sided implied' };
  }
  const total = over + under;
  return { over: over / total, under: under / total, method: 'two-way de-vig' };
}

function expectedValue(probabilities, quote, side) {
  const decimal = decimalOdds(quote?.americanOdds);
  if (decimal == null) return null;
  const win = side === 'under' ? probabilities.underWin : probabilities.overWin;
  const loss = side === 'under' ? probabilities.overWin : probabilities.underWin;
  return win * (decimal - 1) - loss;
}

function settleOver(actualKs, line, odds) {
  if (!Number.isFinite(actualKs)) return { result: 'PENDING', profitUnits: 0 };
  if (actualKs === line) return { result: 'PUSH', profitUnits: 0 };
  if (actualKs > line) {
    const decimal = decimalOdds(odds);
    return { result: 'WIN', profitUnits: decimal == null ? 0 : decimal - 1 };
  }
  return { result: 'LOSS', profitUnits: -1 };
}

function settleSide(actualKs, line, odds, side) {
  if (!Number.isFinite(actualKs)) return { result: 'PENDING', profitUnits: 0 };
  if (actualKs === line) return { result: 'PUSH', profitUnits: 0 };
  const wins = side === 'under' ? actualKs < line : actualKs > line;
  if (wins) {
    const decimal = decimalOdds(odds);
    return { result: 'WIN', profitUnits: decimal == null ? 0 : decimal - 1 };
  }
  return { result: 'LOSS', profitUnits: -1 };
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function referenceLineQuote(odds) {
  const overQuotes = [];
  for (const [book, sides] of Object.entries(odds || {})) {
    if (sides?.over && Number.isFinite(Number(sides.over.line))) overQuotes.push({ book, ...sides.over });
  }
  if (!overQuotes.length) return null;
  const lines = overQuotes.map((quote) => Number(quote.line)).sort((a, b) => a - b);
  const referenceLine = lines[Math.floor((lines.length - 1) / 2)];
  const sameLine = overQuotes.filter((quote) => Number(quote.line) === referenceLine);
  sameLine.sort((a, b) => Number(b.americanOdds) - Number(a.americanOdds));
  return { referenceLine, best: sameLine[0], quotes: overQuotes };
}

module.exports = {
  LEAGUE_K_PA_FALLBACK,
  americanImplied,
  average,
  clamp,
  expectedValue,
  fairAmerican,
  fetchJson,
  fetchSchedule,
  formMetrics,
  leagueKRateBefore,
  mapWithConcurrency,
  noVigProbabilities,
  normalizePitcherStarts,
  outcomeProbabilities,
  pitcherGameLog,
  pitcherProjection,
  probablePitchers,
  referenceLineQuote,
  settleOver,
  settleSide,
  settledStart,
  startsBefore,
  teamHittingGameLog,
  teamKRateBefore,
  variance,
};
