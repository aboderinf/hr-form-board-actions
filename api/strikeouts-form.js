const { normalizeCheckpoint, playerKey } = require('../lib/checkpoint-runtime');
const { readStrikeoutsCheckpoint } = require('../lib/strikeouts-runtime');
const totalBasesFormHandler = require('../lib/total-bases-form-handler');

const MLB = 'https://statsapi.mlb.com/api/v1';
const CHECKPOINTS = ['2017', '1717', '1117', '0817'];

function etDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MLBStrikeoutsForm/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`MLB Stats API HTTP ${response.status}`);
  return response.json();
}

async function resolveCheckpoint(date, requested) {
  if (requested) {
    const cp = normalizeCheckpoint(requested);
    return cp ? { checkpoint: cp, payload: await readStrikeoutsCheckpoint(date, cp) } : null;
  }
  for (const cp of CHECKPOINTS) {
    const payload = await readStrikeoutsCheckpoint(date, cp);
    if (payload?.status === 'ready') return { checkpoint: cp, payload };
  }
  return null;
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
          team: teamRow?.team?.name || null,
          opponent: opponentRow?.team?.name || null,
          side,
          gamePk: game.gamePk || null,
          gameStartAt: game.gameDate || null,
          gameStatus: game?.status?.detailedState || null,
        });
      }
    }
  }
  return rows;
}

async function pitcherGameLog(pitcherId, season) {
  const url = `${MLB}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`;
  const payload = await fetchJson(url);
  return payload?.stats?.[0]?.splits || [];
}

function startsBefore(logs, slateDate) {
  return logs
    .filter((split) => String(split?.date || '') < slateDate)
    .filter((split) => {
      const gs = Number(split?.stat?.gamesStarted);
      return Number.isFinite(gs) ? gs > 0 : true;
    })
    .map((split) => ({
      date: split.date,
      opponent: split?.opponent?.name || null,
      strikeouts: Number(split?.stat?.strikeOuts || 0),
      inningsPitched: Number(split?.stat?.inningsPitched || 0),
      pitches: Number(split?.stat?.numberOfPitches || split?.stat?.pitchesThrown || 0) || null,
      battersFaced: Number(split?.stat?.battersFaced || 0) || null,
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function lowerMedian(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function windowMetrics(starts, line, n) {
  const sample = starts.slice(0, n);
  if (!sample.length) return { games: 0, overs: 0, overRate: null, avgKs: null };
  const overs = sample.filter((row) => row.strikeouts > line).length;
  return {
    games: sample.length,
    overs,
    overRate: overs / sample.length,
    avgKs: avg(sample.map((row) => row.strikeouts)),
  };
}

function formMetrics(starts, line) {
  const l3 = windowMetrics(starts, line, 3);
  const l5 = windowMetrics(starts, line, 5);
  const l10 = windowMetrics(starts, line, 10);
  const parts = [[0.5, l3.overRate], [0.3, l5.overRate], [0.2, l10.overRate]]
    .filter(([, value]) => value != null);
  const weight = parts.reduce((sum, [w]) => sum + w, 0) || 1;
  const weightedOverRate = parts.reduce((sum, [w, value]) => sum + w * value, 0) / weight;
  const marginParts = [[0.5, l3.avgKs], [0.3, l5.avgKs], [0.2, l10.avgKs]]
    .filter(([, value]) => value != null);
  const marginWeight = marginParts.reduce((sum, [w]) => sum + w, 0) || 1;
  const weightedAvgKs = marginParts.reduce((sum, [w, value]) => sum + w * value, 0) / marginWeight;
  return {
    formScore: Number((100 * weightedOverRate).toFixed(1)),
    weightedOverRate: Number(weightedOverRate.toFixed(4)),
    weightedAvgKs: Number(weightedAvgKs.toFixed(2)),
    weightedMargin: Number((weightedAvgKs - line).toFixed(2)),
    l3, l5, l10,
    recentKs: starts.slice(0, 10).map((row) => row.strikeouts),
    recentStarts: starts.slice(0, 10),
  };
}

function americanBetter(a, b) {
  if (a == null) return false;
  if (b == null) return true;
  return Number(a) > Number(b);
}

function quoteSummary(odds) {
  const quotes = [];
  for (const [book, sides] of Object.entries(odds || {})) {
    if (!sides?.over) continue;
    quotes.push({ book, side: 'over', ...sides.over });
  }
  const referenceLine = lowerMedian(quotes.map((q) => Number(q.line)));
  let bestAtReference = null;
  for (const quote of quotes.filter((q) => Number(q.line) === referenceLine)) {
    if (!bestAtReference || americanBetter(quote.americanOdds, bestAtReference.americanOdds)) {
      bestAtReference = quote;
    }
  }
  return { quotes, referenceLine, bestAtReference };
}

module.exports = async function handler(request, response) {
  if (String(request.query?.market || '').toLowerCase() === 'total-bases') {
    return totalBasesFormHandler(request, response);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  const date = String(request.query?.date || etDate());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return response.status(400).json({ status: 'error', message: 'Invalid date' });
  }

  try {
    const resolved = await resolveCheckpoint(date, request.query?.checkpoint);
    if (!resolved?.payload) {
      response.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
      return response.status(404).json({
        status: 'pending', date, checkpoint: resolved?.checkpoint || null,
        message: 'No archived strikeout checkpoint is available for this slate yet',
        providerRequests: 0, quotaObjectsAdded: 0,
      });
    }

    const schedule = await fetchJson(`${MLB}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,teams`);
    const probables = probablePitchers(schedule);
    const probableByKey = new Map(probables.map((row) => [row.playerKey, row]));
    const oddsRows = resolved.payload.rows || [];
    const matched = oddsRows
      .map((row) => ({ oddsRow: row, probable: probableByKey.get(row.playerKey) }))
      .filter((row) => row.probable);

    const uniquePitchers = [...new Map(matched.map((row) => [row.probable.mlbamId, row.probable])).values()];
    const season = Number(date.slice(0, 4));
    const logs = new Map();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(10, uniquePitchers.length) }, async () => {
      while (cursor < uniquePitchers.length) {
        const index = cursor++;
        const pitcher = uniquePitchers[index];
        try {
          logs.set(pitcher.mlbamId, await pitcherGameLog(pitcher.mlbamId, season));
        } catch (error) {
          logs.set(pitcher.mlbamId, { error: error instanceof Error ? error.message : String(error), rows: [] });
        }
      }
    });
    await Promise.all(workers);

    const rows = [];
    const diagnostics = [];
    for (const { oddsRow, probable } of matched) {
      const quote = quoteSummary(oddsRow.odds);
      if (!Number.isFinite(quote.referenceLine)) continue;
      const rawLog = logs.get(probable.mlbamId);
      if (rawLog?.error) {
        diagnostics.push(`${probable.pitcherName}: ${rawLog.error}`);
        continue;
      }
      const starts = startsBefore(rawLog || [], date);
      if (!starts.length) continue;
      rows.push({
        ...probable,
        matchup: oddsRow.matchup || null,
        referenceLine: quote.referenceLine,
        bestAtReference: quote.bestAtReference,
        quotes: quote.quotes,
        form: formMetrics(starts, quote.referenceLine),
      });
    }

    rows.sort((a, b) =>
      (b.form.formScore - a.form.formScore)
      || (b.form.weightedMargin - a.form.weightedMargin)
      || (b.form.weightedAvgKs - a.form.weightedAvgKs)
      || a.pitcherName.localeCompare(b.pitcherName));

    const output = {
      schemaVersion: 1,
      kind: 'pitcher_strikeouts_form_board',
      status: rows.length ? 'ready' : 'no_rows',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: resolved.checkpoint,
      checkpointAsOf: resolved.payload.asOf,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      methodology: {
        market: 'Pitcher strikeouts — Over',
        referenceLine: 'Lower median of currently archived FanDuel, DraftKings, and BetMGM over lines; always an actually offered line.',
        formScore: '50% last-3 over rate + 30% last-5 over rate + 20% last-10 over rate against today’s reference line. Price is not used.',
        tieBreak: 'Weighted recent strikeouts above the reference line, then weighted recent strikeout average.',
        execution: 'Book quotes remain line-specific. Prices from different strikeout lines are never compared as if they were the same bet.',
      },
      dataQuality: {
        probablePitchers: probables.length,
        archivedPropRows: oddsRows.length,
        matchedProbablePitchers: matched.length,
        rankedRows: rows.length,
        unmatchedArchivedNames: oddsRows.filter((row) => !probableByKey.has(row.playerKey)).map((row) => row.pitcherName),
        diagnostics,
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
