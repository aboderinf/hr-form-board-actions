const { redisCommand } = require('../lib/checkpoint-runtime');
const { readStrikeoutsCheckpoint } = require('../lib/strikeouts-runtime');
const {
  LEAGUE_K_PA_FALLBACK,
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
const {
  repriceCandidate,
  walkForwardCalibration,
} = require('../lib/strikeouts-market-anchor');

const ARCHIVE_START = '2026-08-07';
const CHECKPOINTS = ['0817', '1117', '1717'];
const FIT_OPTIONS = { minRows: 120, minDates: 5, ridge: 0.0005 };
const MIN_SAMPLE_STARTS = 8;
const MIN_V2_EDGE = 0.015;
const MIN_V2_EV = 0.02;

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
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function summary(rows) {
  const settled = rows.filter((row) => ['WIN', 'LOSS', 'PUSH'].includes(row.result));
  const decisive = settled.filter((row) => row.result !== 'PUSH');
  const wins = decisive.filter((row) => row.result === 'WIN').length;
  const losses = decisive.length - wins;
  const pushes = settled.length - decisive.length;
  const netUnits = settled.reduce((sum, row) => sum + Number(row.profitUnits || 0), 0);
  return {
    bets: settled.length,
    decisive: decisive.length,
    slates: new Set(settled.map((row) => row.date)).size,
    wins,
    losses,
    pushes,
    hitRate: decisive.length ? wins / decisive.length : null,
    netUnits: Number(netUnits.toFixed(3)),
    roi: settled.length ? Number((netUnits / settled.length).toFixed(4)) : null,
    averageOdds: mean(settled.map((row) => row.odds)),
    averageLine: mean(settled.map((row) => row.line)),
    averageBeta: mean(settled.map((row) => row.v2Beta)),
    averageEdge: mean(settled.map((row) => row.v2ProbabilityEdge)),
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

function compactFit(fit) {
  return {
    ready: Boolean(fit?.ready),
    beta: Number(fit?.beta || 0),
    n: Number(fit?.n || 0),
    dates: Number(fit?.dates || 0),
    marketBrier: fit?.marketBrier == null ? null : Number(Number(fit.marketBrier).toFixed(5)),
    structuralBrier: fit?.structuralBrier == null ? null : Number(Number(fit.structuralBrier).toFixed(5)),
    anchoredBrier: fit?.anchoredBrier == null ? null : Number(Number(fit.anchoredBrier).toFixed(5)),
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const today = etDate();
  const latestSettled = addDays(today, -1);
  const through = String(request.query?.through || latestSettled);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through) || through < ARCHIVE_START || through > latestSettled) {
    return response.status(400).json({ status: 'error', message: `through must be between ${ARCHIVE_START} and ${latestSettled}` });
  }

  const cacheKey = `mlbstrikeouts:v2-validation:v1:${through}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) {
      const output = JSON.parse(cached);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
      response.setHeader('X-Strikeouts-V2-Cache', 'HIT');
      if (request.method === 'HEAD') return response.status(200).end();
      return response.status(200).json(output);
    }

    const dates = dateRange(ARCHIVE_START, through);
    const requests = dates.flatMap((date) => CHECKPOINTS.map((checkpoint) => ({ date, checkpoint })));
    const captureResults = await mapWithConcurrency(requests, 16, async ({ date, checkpoint }) => {
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
      const slate = schedules.get(capture.date);
      if (!Array.isArray(slate)) continue;
      const byKey = new Map(slate.map((row) => [row.playerKey, row]));
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

    const calibrationRows = [];
    const candidateSnapshots = [];
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

      for (const [book, sides] of Object.entries(oddsRow.odds || {})) {
        const over = sides?.over;
        const under = sides?.under;
        if (!over || !under) continue;
        const line = Number(over.line);
        if (!Number.isFinite(line) || Number(under.line) !== line) continue;
        const market = noVigProbabilities(over, under);
        if (market.method !== 'two-way de-vig') continue;
        const probabilities = outcomeProbabilities(projection.expectedKs, projection.variance, line);
        const form = formMetrics(starts, line);
        const overSettlement = settleOver(actual.strikeouts, line, over.americanOdds);
        const common = {
          date: capture.date,
          checkpoint: capture.checkpoint,
          pitcherName: probable.pitcherName,
          mlbamId: probable.mlbamId,
          matchup: oddsRow.matchup,
          book,
          line,
          actualKs: actual.strikeouts,
          formScore: form.formScore,
          expectedKs: projection.expectedKs,
          sampleStarts: projection.sampleStarts,
          pushProbability: probabilities.push,
          marketMethod: market.method,
        };
        calibrationRows.push({
          ...common,
          side: 'over',
          odds: Number(over.americanOdds),
          result: overSettlement.result,
          profitUnits: overSettlement.profitUnits,
          modelProbability: probabilities.fairOver,
          marketProbability: market.over,
        });
        candidateSnapshots.push({
          ...common,
          side: 'over',
          odds: Number(over.americanOdds),
          modelProbability: probabilities.fairOver,
          marketProbability: market.over,
        });
        candidateSnapshots.push({
          ...common,
          side: 'under',
          odds: Number(under.americanOdds),
          modelProbability: probabilities.fairUnder,
          marketProbability: market.under,
        });
      }
    }

    const walkForward = walkForwardCalibration(calibrationRows, FIT_OPTIONS);
    const fitByDate = new Map(walkForward.dailyFits.map((fit) => [fit.date, fit]));
    const groups = new Map();
    for (const candidate of candidateSnapshots) {
      const fit = fitByDate.get(candidate.date);
      if (!fit?.ready || candidate.sampleStarts < MIN_SAMPLE_STARTS) continue;
      const repriced = repriceCandidate(candidate, fit.beta);
      if (!repriced) continue;
      const key = `${candidate.date}|${candidate.checkpoint}|${candidate.mlbamId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(repriced);
    }

    const selections = [];
    for (const values of groups.values()) {
      values.sort((a, b) => Number(b.v2ExpectedValue ?? -999) - Number(a.v2ExpectedValue ?? -999));
      const best = values[0];
      if (
        !best
        || Number(best.v2ExpectedValue) < MIN_V2_EV
        || Number(best.v2ProbabilityEdge) < MIN_V2_EDGE
      ) continue;
      const settled = settleSide(best.actualKs, best.line, best.odds, best.side);
      selections.push({
        ...best,
        result: settled.result,
        profitUnits: settled.profitUnits,
      });
    }

    const strategy = summary(selections);
    const calibration = {
      n: walkForward.n,
      slates: walkForward.dates,
      firstEvaluatedDate: walkForward.firstEvaluatedDate,
      marketBrier: walkForward.marketBrier == null ? null : Number(walkForward.marketBrier.toFixed(5)),
      structuralBrier: walkForward.structuralBrier == null ? null : Number(walkForward.structuralBrier.toFixed(5)),
      anchoredBrier: walkForward.anchoredBrier == null ? null : Number(walkForward.anchoredBrier.toFixed(5)),
      marketLogLoss: walkForward.marketLogLoss == null ? null : Number(walkForward.marketLogLoss.toFixed(5)),
      structuralLogLoss: walkForward.structuralLogLoss == null ? null : Number(walkForward.structuralLogLoss.toFixed(5)),
      anchoredLogLoss: walkForward.anchoredLogLoss == null ? null : Number(walkForward.anchoredLogLoss.toFixed(5)),
    };
    const promoted = (
      calibration.n >= 300
      && calibration.slates >= 7
      && calibration.anchoredBrier != null
      && calibration.marketBrier != null
      && calibration.anchoredBrier < calibration.marketBrier
      && strategy.bets >= 50
      && Number(strategy.roi) > 0
    );

    const output = {
      schemaVersion: 1,
      kind: 'pitcher_strikeouts_market_anchored_v2_validation',
      modelVersion: 'k-market-anchor-v2.0',
      status: calibrationRows.length ? 'ready' : 'no_rows',
      generatedAt: new Date().toISOString(),
      archive: {
        start: ARCHIVE_START,
        through,
        checkpoints: CHECKPOINTS,
        checkpointFiles: captures.length,
        providerRequestsAdded: 0,
        quotaObjectsAdded: 0,
      },
      methodology: {
        prior: 'Each exact book/line starts at its own two-way de-vigged market probability.',
        adjustment: 'v1 structural probability may move the market log-odds only by beta. beta=0 means market only; beta=1 means full v1.',
        training: 'For each slate date, beta is fitted only on earlier dates. The current date is then scored strictly out-of-sample.',
        betaSearch: '0 to 1 in 0.025 steps, minimizing prior-date Brier score with a small ridge penalty toward beta=0.',
        warmup: `At least ${FIT_OPTIONS.minRows} prior exact-line rows across ${FIT_OPTIONS.minDates} prior slates before any adjustment is allowed.`,
        strategy: `One best exact book/line/side per pitcher/checkpoint; two-way de-vig only; at least ${MIN_SAMPLE_STARTS} prior starts; v2 edge >= ${(MIN_V2_EDGE * 100).toFixed(1)} points and EV >= ${(MIN_V2_EV * 100).toFixed(1)}%.`,
        promotionGate: 'At least 300 walk-forward calibration rows over 7 slates, v2 Brier better than market, and at least 50 strategy bets with positive ROI.',
      },
      dataQuality: {
        capturedDates: capturedDates.length,
        matchedRows: matches.length,
        unmatchedRows: unmatched.length,
        exactTwoWayCalibrationRows: calibrationRows.length,
        candidateSnapshots: candidateSnapshots.length,
        walkForwardSelections: selections.length,
        diagnostics: [...new Set(diagnostics)].slice(0, 50),
      },
      calibration,
      finalFit: compactFit(walkForward.finalFit),
      strategy,
      bySide: grouped(selections, (row) => row.side, ['over', 'under']),
      byBook: grouped(selections, (row) => row.book, ['fanduel', 'draftkings', 'betmgm']),
      byCheckpoint: grouped(selections, (row) => row.checkpoint, CHECKPOINTS),
      promoted,
      promotionReason: promoted
        ? 'PASS: walk-forward calibration and executable ROI both beat the required gate.'
        : 'HOLD: v2 remains research-only until both calibration and executable walk-forward ROI pass the promotion gate.',
      dailyFits: walkForward.dailyFits.map((fit) => ({
        date: fit.date,
        ready: fit.ready,
        beta: fit.beta,
        trainingRows: fit.n,
        trainingDates: fit.dates,
        testRows: fit.testRows,
      })),
      recentSelections: selections
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date) || Number(b.v2ExpectedValue) - Number(a.v2ExpectedValue))
        .slice(0, 40)
        .map((row) => ({
          date: row.date,
          checkpoint: row.checkpoint,
          pitcherName: row.pitcherName,
          matchup: row.matchup,
          book: row.book,
          side: row.side,
          line: row.line,
          odds: row.odds,
          actualKs: row.actualKs,
          result: row.result,
          profitUnits: row.profitUnits,
          v2Beta: row.v2Beta,
          v2Probability: row.v2Probability,
          marketProbability: row.marketProbability,
          v2ProbabilityEdge: row.v2ProbabilityEdge,
          v2ExpectedValue: row.v2ExpectedValue,
        })),
    };

    await redisCommand(['SET', cacheKey, JSON.stringify(output), 'EX', 21600]);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    response.setHeader('X-Strikeouts-V2-Cache', 'MISS');
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
