const { redisCommand } = require('../lib/checkpoint-runtime');
const { readStrikeoutsCheckpoint } = require('../lib/strikeouts-runtime');
const {
  LEAGUE_K_PA_FALLBACK,
  expectedValue,
  fetchSchedule,
  formMetrics,
  mapWithConcurrency,
  noVigProbabilities,
  outcomeProbabilities,
  pitcherGameLog,
  pitcherProjection,
  probablePitchers,
  settleOver,
  settleSide,
  settledStart,
  startsBefore,
  teamHittingGameLog,
  teamKRateBefore,
} = require('../lib/strikeouts-analysis');

const ARCHIVE_START = '2026-08-07';
const CHECKPOINTS = ['0817', '1117', '1717'];

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
  const output = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) output.push(cursor);
  return output;
}

function mean(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function referenceQuote(odds) {
  const quotes = [];
  for (const [book, sides] of Object.entries(odds || {})) {
    if (sides?.over && Number.isFinite(Number(sides.over.line))) quotes.push({ book, ...sides.over });
  }
  if (!quotes.length) return null;
  const lines = quotes.map((quote) => Number(quote.line)).sort((a, b) => a - b);
  const referenceLine = lines[Math.floor((lines.length - 1) / 2)];
  const sameLine = quotes.filter((quote) => Number(quote.line) === referenceLine)
    .sort((a, b) => Number(b.americanOdds) - Number(a.americanOdds));
  return { referenceLine, best: sameLine[0] || null };
}

function oddsBand(odds) {
  const n = Number(odds);
  if (n <= -150) return '≤ -150';
  if (n <= -120) return '-149 to -120';
  if (n <= 100) return '-119 to +100';
  if (n <= 130) return '+101 to +130';
  return '+131 or longer';
}

function formBand(score) {
  const n = Number(score);
  if (n >= 75) return '75+';
  if (n >= 60) return '60–74.9';
  if (n >= 45) return '45–59.9';
  return 'Below 45';
}

function edgeBand(edge) {
  const n = Number(edge);
  if (n >= 0.10) return '10%+';
  if (n >= 0.05) return '5–9.9%';
  if (n >= 0.02) return '2–4.9%';
  if (n >= 0) return '0–1.9%';
  return 'Negative';
}

function summary(rows) {
  const resolved = rows.filter((row) => ['WIN', 'LOSS', 'PUSH'].includes(row.result));
  const decisive = resolved.filter((row) => row.result !== 'PUSH');
  const wins = decisive.filter((row) => row.result === 'WIN').length;
  const losses = decisive.length - wins;
  const pushes = resolved.length - decisive.length;
  const netUnits = resolved.reduce((sum, row) => sum + Number(row.profitUnits || 0), 0);
  const slates = new Set(resolved.map((row) => row.date)).size;
  return {
    bets: resolved.length,
    decisive: decisive.length,
    slates,
    wins,
    losses,
    pushes,
    hitRate: decisive.length ? wins / decisive.length : null,
    netUnits: Number(netUnits.toFixed(3)),
    roi: resolved.length ? Number((netUnits / resolved.length).toFixed(4)) : null,
    averageOdds: mean(resolved.map((row) => Number(row.odds))),
    averageLine: mean(resolved.map((row) => Number(row.line))),
    averageFormScore: mean(resolved.map((row) => Number(row.formScore))),
  };
}

function grouped(rows, keyFn, order = null) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const labels = order || [...buckets.keys()].sort();
  return labels.filter((label) => buckets.has(label)).map((label) => ({ label, ...summary(buckets.get(label)) }));
}

function calibration(rows, probabilityField) {
  const usable = rows.filter((row) =>
    ['WIN', 'LOSS'].includes(row.result) && Number.isFinite(Number(row[probabilityField]))
  );
  if (!usable.length) return { n: 0, brier: null, logLoss: null, averageProbability: null, hitRate: null };
  let brier = 0;
  let logLoss = 0;
  let wins = 0;
  for (const row of usable) {
    const y = row.result === 'WIN' ? 1 : 0;
    const p = Math.max(0.001, Math.min(0.999, Number(row[probabilityField])));
    wins += y;
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return {
    n: usable.length,
    brier: Number((brier / usable.length).toFixed(4)),
    logLoss: Number((logLoss / usable.length).toFixed(4)),
    averageProbability: Number(mean(usable.map((row) => Number(row[probabilityField]))).toFixed(4)),
    hitRate: Number((wins / usable.length).toFixed(4)),
  };
}

function edgeCandidates(rows) {
  const dimensions = [
    ['Checkpoint', (row) => row.checkpoint],
    ['Book', (row) => row.book],
    ['Line', (row) => `${row.line} Ks`],
    ['Odds', (row) => oddsBand(row.odds)],
    ['Form', (row) => formBand(row.formScore)],
    ['Form × odds', (row) => `${formBand(row.formScore)} · ${oddsBand(row.odds)}`],
    ['Form × line', (row) => `${formBand(row.formScore)} · ${row.line} Ks`],
    ['Book × line', (row) => `${row.book} · ${row.line} Ks`],
  ];
  const output = [];
  for (const [dimension, keyFn] of dimensions) {
    const buckets = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    for (const [rule, values] of buckets.entries()) {
      const stats = summary(values);
      if (stats.bets >= 20 && stats.slates >= 5 && stats.netUnits > 0 && stats.roi > 0) {
        output.push({ dimension, rule, ...stats });
      }
    }
  }
  return output.sort((a, b) => b.netUnits - a.netUnits || b.bets - a.bets || b.roi - a.roi).slice(0, 40);
}

function publicEntry(row) {
  return {
    date: row.date,
    checkpoint: row.checkpoint,
    pitcherName: row.pitcherName,
    matchup: row.matchup,
    book: row.book,
    side: row.side || 'over',
    line: row.line,
    odds: row.odds,
    actualKs: row.actualKs,
    result: row.result,
    profitUnits: row.profitUnits,
    formScore: row.formScore,
    expectedKs: row.expectedKs,
    modelProbability: row.modelProbability,
    marketProbability: row.marketProbability,
    modelEdge: row.modelEdge,
    modelEV: row.modelEV,
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const today = etDate();
  const defaultThrough = addDays(today, -1);
  const through = String(request.query?.through || defaultThrough);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through) || through < ARCHIVE_START || through > defaultThrough) {
    return response.status(400).json({ status: 'error', message: `through must be between ${ARCHIVE_START} and ${defaultThrough}` });
  }

  const cacheKey = `mlbstrikeouts:discovery:v2:${through}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) {
      const output = JSON.parse(cached);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
      response.setHeader('X-Strikeouts-Discovery-Cache', 'HIT');
      if (request.method === 'HEAD') return response.status(200).end();
      return response.status(200).json(output);
    }

    const dates = dateRange(ARCHIVE_START, through);
    const captureRequests = dates.flatMap((date) => CHECKPOINTS.map((checkpoint) => ({ date, checkpoint })));
    const captureResults = await mapWithConcurrency(captureRequests, 16, async ({ date, checkpoint }) => {
      try {
        const payload = await readStrikeoutsCheckpoint(date, checkpoint);
        return payload?.status === 'ready' ? payload : null;
      } catch {
        return null;
      }
    });
    const captures = captureResults.filter(Boolean);
    const capturedDates = [...new Set(captures.map((row) => row.date))].sort();

    const scheduleResults = await mapWithConcurrency(capturedDates, 8, async (date) => {
      try {
        return [date, probablePitchers(await fetchSchedule(date))];
      } catch (error) {
        return [date, { error: error instanceof Error ? error.message : String(error) }];
      }
    });
    const schedules = new Map(scheduleResults);
    const matches = [];
    const unmatched = [];
    for (const capture of captures) {
      const slateRows = schedules.get(capture.date);
      if (!Array.isArray(slateRows)) continue;
      const byKey = new Map(slateRows.map((row) => [row.playerKey, row]));
      for (const oddsRow of capture.rows || []) {
        const probable = byKey.get(oddsRow.playerKey);
        if (probable) matches.push({ capture, oddsRow, probable });
        else unmatched.push({ date: capture.date, checkpoint: capture.checkpoint, pitcherName: oddsRow.pitcherName });
      }
    }

    const uniquePitchers = [...new Map(matches.map((row) => [row.probable.mlbamId, row.probable])).values()];
    const opponentIds = [...new Set(uniquePitchers.map((row) => row.opponentId).filter(Boolean))];
    const season = Number(ARCHIVE_START.slice(0, 4));
    const pitcherResults = await mapWithConcurrency(uniquePitchers, 14, async (pitcher) => {
      try {
        return [pitcher.mlbamId, await pitcherGameLog(pitcher.mlbamId, season)];
      } catch (error) {
        return [pitcher.mlbamId, { error: error instanceof Error ? error.message : String(error) }];
      }
    });
    const teamResults = await mapWithConcurrency(opponentIds, 12, async (teamId) => {
      try {
        return [teamId, await teamHittingGameLog(teamId, season)];
      } catch (error) {
        return [teamId, { error: error instanceof Error ? error.message : String(error) }];
      }
    });
    const pitcherLogs = new Map(pitcherResults);
    const teamLogs = new Map(teamResults);

    const referenceEntries = [];
    const modelSelections = [];
    const diagnostics = [];

    for (const { capture, oddsRow, probable } of matches) {
      const rawPitcherLog = pitcherLogs.get(probable.mlbamId);
      if (rawPitcherLog?.error) {
        diagnostics.push(`${probable.pitcherName}: ${rawPitcherLog.error}`);
        continue;
      }
      const actual = settledStart(rawPitcherLog || [], capture.date);
      if (!actual) continue;
      const starts = startsBefore(rawPitcherLog || [], capture.date);
      if (!starts.length) continue;
      const rawTeamLog = teamLogs.get(probable.opponentId);
      const opponentKRate = rawTeamLog?.error ? null : teamKRateBefore(rawTeamLog || [], capture.date);
      const projection = pitcherProjection(starts, opponentKRate, LEAGUE_K_PA_FALLBACK, capture.date);
      if (!projection) continue;

      const reference = referenceQuote(oddsRow.odds);
      if (reference?.best) {
        const line = Number(reference.referenceLine);
        const best = reference.best;
        const form = formMetrics(starts, line);
        const probabilities = outcomeProbabilities(projection.expectedKs, projection.variance, line);
        const sides = oddsRow.odds?.[best.book] || {};
        const under = sides.under && Number(sides.under.line) === line ? sides.under : null;
        const market = noVigProbabilities(best, under);
        const settled = settleOver(actual.strikeouts, line, best.americanOdds);
        referenceEntries.push({
          date: capture.date,
          checkpoint: capture.checkpoint,
          pitcherName: probable.pitcherName,
          mlbamId: probable.mlbamId,
          matchup: oddsRow.matchup,
          book: best.book,
          side: 'over',
          line,
          odds: Number(best.americanOdds),
          actualKs: actual.strikeouts,
          result: settled.result,
          profitUnits: settled.profitUnits,
          formScore: form.formScore,
          expectedKs: projection.expectedKs,
          modelProbability: probabilities.fairOver,
          marketProbability: market.over,
          modelEdge: market.over == null ? null : probabilities.fairOver - market.over,
          modelEV: expectedValue(probabilities, best, 'over'),
          sampleStarts: projection.sampleStarts,
        });
      }

      const candidates = [];
      for (const [book, sides] of Object.entries(oddsRow.odds || {})) {
        const over = sides?.over;
        if (!over || !Number.isFinite(Number(over.line))) continue;
        const line = Number(over.line);
        const under = sides?.under && Number(sides.under.line) === line ? sides.under : null;
        const probabilities = outcomeProbabilities(projection.expectedKs, projection.variance, line);
        const market = noVigProbabilities(over, under);
        const overEv = expectedValue(probabilities, over, 'over');
        candidates.push({
          book, side: 'over', line, quote: over,
          modelProbability: probabilities.fairOver,
          marketProbability: market.over,
          modelEdge: market.over == null ? null : probabilities.fairOver - market.over,
          modelEV: overEv,
          probabilities,
        });
        if (under) {
          const underEv = expectedValue(probabilities, under, 'under');
          candidates.push({
            book, side: 'under', line, quote: under,
            modelProbability: probabilities.fairUnder,
            marketProbability: market.under,
            modelEdge: market.under == null ? null : probabilities.fairUnder - market.under,
            modelEV: underEv,
            probabilities,
          });
        }
      }
      candidates.sort((a, b) => Number(b.modelEV ?? -999) - Number(a.modelEV ?? -999));
      const bestModel = candidates[0];
      if (
        bestModel
        && bestModel.modelEV != null && bestModel.modelEV >= 0.04
        && bestModel.modelEdge != null && bestModel.modelEdge >= 0.025
        && projection.sampleStarts >= 5
      ) {
        const settled = settleSide(actual.strikeouts, bestModel.line, bestModel.quote.americanOdds, bestModel.side);
        const form = formMetrics(starts, bestModel.line);
        modelSelections.push({
          date: capture.date,
          checkpoint: capture.checkpoint,
          pitcherName: probable.pitcherName,
          mlbamId: probable.mlbamId,
          matchup: oddsRow.matchup,
          book: bestModel.book,
          side: bestModel.side,
          line: bestModel.line,
          odds: Number(bestModel.quote.americanOdds),
          actualKs: actual.strikeouts,
          result: settled.result,
          profitUnits: settled.profitUnits,
          formScore: form.formScore,
          expectedKs: projection.expectedKs,
          modelProbability: bestModel.modelProbability,
          marketProbability: bestModel.marketProbability,
          modelEdge: bestModel.modelEdge,
          modelEV: bestModel.modelEV,
          sampleStarts: projection.sampleStarts,
        });
      }
    }

    const formScoreOrder = ['75+', '60–74.9', '45–59.9', 'Below 45'];
    const oddsOrder = ['≤ -150', '-149 to -120', '-119 to +100', '+101 to +130', '+131 or longer'];
    const modelEdgeOrder = ['10%+', '5–9.9%', '2–4.9%', '0–1.9%', 'Negative'];
    const output = {
      schemaVersion: 2,
      kind: 'pitcher_strikeouts_historical_discovery',
      status: referenceEntries.length ? 'ready' : 'no_rows',
      generatedAt: new Date().toISOString(),
      archive: {
        start: ARCHIVE_START,
        through,
        checkpointFiles: captures.length,
        checkpoints: CHECKPOINTS,
        providerRequestsAdded: 0,
        quotaObjectsAdded: 0,
      },
      methodology: {
        formStrategy: 'At each fixed checkpoint, use the lower median of FD/DK/MGM over lines (including duplicate book lines), then take the best price available at that exact line. One over bet per pitcher/checkpoint.',
        settlement: 'Official MLB pitcher game logs. Over wins only when final strikeouts exceed the exact quoted line; integer ties push.',
        formScore: '50% L3 + 30% L5 + 20% L10 over-rate using only starts before the slate and the exact selected line.',
        model: 'k-count-v1.0 uses pregame-only pitcher K/BF, projected batters faced, opponent K tendency, rest, and a Poisson/negative-binomial count distribution.',
        modelStrategy: 'One highest-EV side/book/line per pitcher/checkpoint only when model EV ≥4%, probability edge ≥2.5 points, and at least five prior starts.',
        warning: 'The archive is still short. Positive slices are hypothesis-generating until they persist over materially larger forward samples.',
      },
      dataQuality: {
        capturedDates: capturedDates.length,
        archivedPitcherRows: captures.reduce((sum, row) => sum + Number(row.rowCount || row.rows?.length || 0), 0),
        matchedRows: matches.length,
        unmatchedRows: unmatched.length,
        settledReferenceBets: referenceEntries.length,
        modelSelections: modelSelections.length,
        unmatchedNames: unmatched.slice(0, 50),
        diagnostics: [...new Set(diagnostics)].slice(0, 50),
      },
      form: {
        overall: summary(referenceEntries),
        byCheckpoint: grouped(referenceEntries, (row) => row.checkpoint, CHECKPOINTS),
        byBook: grouped(referenceEntries, (row) => row.book, ['fanduel', 'draftkings', 'betmgm']),
        byLine: grouped(referenceEntries, (row) => `${row.line} Ks`),
        byOdds: grouped(referenceEntries, (row) => oddsBand(row.odds), oddsOrder),
        byFormScore: grouped(referenceEntries, (row) => formBand(row.formScore), formScoreOrder),
        byModelEdge: grouped(referenceEntries, (row) => edgeBand(row.modelEdge), modelEdgeOrder),
        edgeCandidates: edgeCandidates(referenceEntries),
      },
      model: {
        referenceLineCalibration: calibration(referenceEntries, 'modelProbability'),
        marketCalibration: calibration(referenceEntries, 'marketProbability'),
        selectedStrategy: summary(modelSelections),
        bySide: grouped(modelSelections, (row) => row.side, ['over', 'under']),
        byBook: grouped(modelSelections, (row) => row.book, ['fanduel', 'draftkings', 'betmgm']),
        byCheckpoint: grouped(modelSelections, (row) => row.checkpoint, CHECKPOINTS),
      },
      recentReferenceBets: referenceEntries
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date) || a.pitcherName.localeCompare(b.pitcherName))
        .slice(0, 40)
        .map(publicEntry),
      recentModelSelections: modelSelections
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date) || Number(b.modelEV) - Number(a.modelEV))
        .slice(0, 40)
        .map(publicEntry),
    };

    await redisCommand(['SET', cacheKey, JSON.stringify(output), 'EX', 21600]);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    response.setHeader('X-Strikeouts-Discovery-Cache', 'MISS');
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', '*');
    return response.status(500).json({
      status: 'error',
      providerRequestsAdded: 0,
      quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

module.exports.config = { maxDuration: 60 };
