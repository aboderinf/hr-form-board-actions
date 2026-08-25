const { normalizeCheckpoint } = require('../lib/checkpoint-runtime');
const { readStrikeoutsCheckpoint } = require('../lib/strikeouts-runtime');
const {
  LEAGUE_K_PA_FALLBACK,
  fairAmerican,
  fetchSchedule,
  formMetrics,
  mapWithConcurrency,
  noVigProbabilities,
  outcomeProbabilities,
  pitcherGameLog,
  pitcherProjection,
  probablePitchers,
  startsBefore,
  teamHittingGameLog,
  teamKRateBefore,
} = require('../lib/strikeouts-analysis');
const { repriceCandidate } = require('../lib/strikeouts-market-anchor');

const CHECKPOINTS = ['2017', '1717', '1117', '0817'];
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

async function resolveCheckpoint(date, requested) {
  if (requested) {
    const checkpoint = normalizeCheckpoint(requested);
    return checkpoint ? { checkpoint, payload: await readStrikeoutsCheckpoint(date, checkpoint) } : null;
  }
  for (const checkpoint of CHECKPOINTS) {
    const payload = await readStrikeoutsCheckpoint(date, checkpoint);
    if (payload?.status === 'ready') return { checkpoint, payload };
  }
  return null;
}

function confidence(sampleStarts) {
  if (sampleStarts >= 12) return 'higher';
  if (sampleStarts >= 8) return 'medium';
  return 'limited';
}

async function fetchValidation(request) {
  const host = request.headers?.host;
  if (!host) return null;
  const proto = String(request.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  try {
    const result = await fetch(`${proto}://${host}/api/strikeouts-v2-validation`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(55000),
    });
    if (!result.ok) return null;
    return result.json();
  } catch {
    return null;
  }
}

function isPregame(row, now = Date.now()) {
  if (!row?.gameStartAt) return false;
  const start = Date.parse(row.gameStartAt);
  if (!Number.isFinite(start) || start <= now) return false;
  const state = String(row.gameStatus || '').toLowerCase();
  return !state.includes('final') && !state.includes('progress') && !state.includes('review');
}

module.exports = async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const date = String(request.query?.date || etDate());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return response.status(400).json({ status: 'error', message: 'Invalid date' });
  }

  try {
    const [resolved, validation] = await Promise.all([
      resolveCheckpoint(date, request.query?.checkpoint),
      fetchValidation(request),
    ]);
    if (!resolved?.payload) {
      response.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
      return response.status(404).json({
        status: 'pending', date, checkpoint: resolved?.checkpoint || null,
        message: 'No archived strikeout checkpoint is available for this slate yet',
        providerRequests: 0, quotaObjectsAdded: 0,
      });
    }

    const finalFit = validation?.finalFit || null;
    const beta = finalFit?.ready ? Number(finalFit.beta || 0) : 0;
    const promoted = Boolean(validation?.promoted);
    const schedule = await fetchSchedule(date);
    const probables = probablePitchers(schedule);
    const probableByKey = new Map(probables.map((row) => [row.playerKey, row]));
    const matched = (resolved.payload.rows || [])
      .map((oddsRow) => ({ oddsRow, probable: probableByKey.get(oddsRow.playerKey) }))
      .filter((row) => row.probable);
    const season = Number(date.slice(0, 4));
    const uniquePitchers = [...new Map(matched.map((row) => [row.probable.mlbamId, row.probable])).values()];
    const opponentIds = [...new Set(uniquePitchers.map((row) => row.opponentId).filter(Boolean))];

    const pitcherResults = await mapWithConcurrency(uniquePitchers, 12, async (pitcher) => {
      try {
        return [pitcher.mlbamId, await pitcherGameLog(pitcher.mlbamId, season)];
      } catch (error) {
        return [pitcher.mlbamId, { error: error instanceof Error ? error.message : String(error) }];
      }
    });
    const teamResults = await mapWithConcurrency(opponentIds, 10, async (teamId) => {
      try {
        return [teamId, await teamHittingGameLog(teamId, season)];
      } catch (error) {
        return [teamId, { error: error instanceof Error ? error.message : String(error) }];
      }
    });
    const pitcherLogs = new Map(pitcherResults);
    const teamLogs = new Map(teamResults);

    const bets = [];
    const pitcherRows = [];
    const diagnostics = [];

    for (const { oddsRow, probable } of matched) {
      const rawPitcherLog = pitcherLogs.get(probable.mlbamId);
      if (rawPitcherLog?.error) {
        diagnostics.push(`${probable.pitcherName}: ${rawPitcherLog.error}`);
        continue;
      }
      const starts = startsBefore(rawPitcherLog || [], date);
      if (!starts.length) continue;
      const rawTeamLog = teamLogs.get(probable.opponentId);
      const opponentKRate = rawTeamLog?.error ? null : teamKRateBefore(rawTeamLog || [], date);
      const projection = pitcherProjection(starts, opponentKRate, LEAGUE_K_PA_FALLBACK, date);
      if (!projection) continue;

      const pitcherBets = [];
      for (const [book, sides] of Object.entries(oddsRow.odds || {})) {
        const over = sides?.over;
        const under = sides?.under;
        if (!over || !Number.isFinite(Number(over.line))) continue;
        const line = Number(over.line);
        const pairedUnder = under && Number(under.line) === line ? under : null;
        const probabilities = outcomeProbabilities(projection.expectedKs, projection.variance, line);
        const market = noVigProbabilities(over, pairedUnder);
        const form = formMetrics(starts, line);
        const common = {
          pitcherName: probable.pitcherName,
          mlbamId: probable.mlbamId,
          team: probable.team,
          opponent: probable.opponent,
          matchup: oddsRow.matchup,
          gamePk: probable.gamePk,
          gameStartAt: probable.gameStartAt,
          gameStatus: probable.gameStatus,
          book,
          line,
          formScore: form.formScore,
          expectedKs: projection.expectedKs,
          projection,
          confidence: confidence(projection.sampleStarts),
          marketMethod: market.method,
          pushProbability: Number(probabilities.push.toFixed(4)),
        };

        const rawOver = {
          ...common,
          side: 'over',
          odds: Number(over.americanOdds),
          modelProbability: Number(probabilities.fairOver.toFixed(4)),
          marketProbability: market.over == null ? null : Number(market.over.toFixed(4)),
        };
        const v2Over = repriceCandidate(rawOver, beta);
        const overBet = {
          ...rawOver,
          v1Probability: rawOver.modelProbability,
          v2Beta: v2Over?.v2Beta ?? beta,
          v2Probability: v2Over ? Number(v2Over.v2Probability.toFixed(4)) : null,
          v2FairOdds: v2Over ? fairAmerican(v2Over.v2Probability) : null,
          v2ProbabilityEdge: v2Over ? Number(v2Over.v2ProbabilityEdge.toFixed(4)) : null,
          v2ExpectedValue: v2Over?.v2ExpectedValue == null ? null : Number(v2Over.v2ExpectedValue.toFixed(4)),
        };
        bets.push(overBet);
        pitcherBets.push(overBet);

        if (pairedUnder) {
          const rawUnder = {
            ...common,
            side: 'under',
            odds: Number(pairedUnder.americanOdds),
            modelProbability: Number(probabilities.fairUnder.toFixed(4)),
            marketProbability: market.under == null ? null : Number(market.under.toFixed(4)),
          };
          const v2Under = repriceCandidate(rawUnder, beta);
          const underBet = {
            ...rawUnder,
            v1Probability: rawUnder.modelProbability,
            v2Beta: v2Under?.v2Beta ?? beta,
            v2Probability: v2Under ? Number(v2Under.v2Probability.toFixed(4)) : null,
            v2FairOdds: v2Under ? fairAmerican(v2Under.v2Probability) : null,
            v2ProbabilityEdge: v2Under ? Number(v2Under.v2ProbabilityEdge.toFixed(4)) : null,
            v2ExpectedValue: v2Under?.v2ExpectedValue == null ? null : Number(v2Under.v2ExpectedValue.toFixed(4)),
          };
          bets.push(underBet);
          pitcherBets.push(underBet);
        }
      }

      pitcherBets.sort((a, b) => Number(b.v2ExpectedValue ?? -999) - Number(a.v2ExpectedValue ?? -999));
      pitcherRows.push({
        pitcherName: probable.pitcherName,
        mlbamId: probable.mlbamId,
        team: probable.team,
        opponent: probable.opponent,
        matchup: oddsRow.matchup,
        gameStartAt: probable.gameStartAt,
        gameStatus: probable.gameStatus,
        expectedKs: projection.expectedKs,
        projection,
        bestBet: pitcherBets[0] || null,
        availableBets: pitcherBets.length,
      });
    }

    bets.sort((a, b) => Number(b.v2ExpectedValue ?? -999) - Number(a.v2ExpectedValue ?? -999));
    pitcherRows.sort((a, b) => Number(b.bestBet?.v2ExpectedValue ?? -999) - Number(a.bestBet?.v2ExpectedValue ?? -999));
    const researchCandidates = bets.filter((row) =>
      row.marketMethod === 'two-way de-vig'
      && row.v2ExpectedValue != null
      && row.v2ExpectedValue >= MIN_V2_EV
      && row.v2ProbabilityEdge != null
      && row.v2ProbabilityEdge >= MIN_V2_EDGE
      && row.projection.sampleStarts >= MIN_SAMPLE_STARTS
      && isPregame(row)
    );
    const candidates = promoted ? researchCandidates : [];

    const output = {
      schemaVersion: 1,
      kind: 'pitcher_strikeouts_market_anchored_model',
      modelVersion: 'k-market-anchor-v2.0',
      status: pitcherRows.length ? 'ready' : 'no_rows',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: resolved.checkpoint,
      checkpointAsOf: resolved.payload.asOf,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      promoted,
      promotionReason: validation?.promotionReason || 'Validation unavailable; v2 cannot be promoted.',
      validation: validation ? {
        archiveThrough: validation.archive?.through || null,
        calibration: validation.calibration || null,
        finalFit,
        strategy: validation.strategy || null,
      } : null,
      methodology: {
        target: 'Full-game starting-pitcher strikeout count against each exact sportsbook line.',
        prior: 'Each paired book/line begins at its two-way de-vigged market probability.',
        structuralModel: 'v1 pitcher K/BF + projected batters faced + opponent K tendency + rest count distribution.',
        anchor: 'v2 blends market and structural log-odds using beta fitted only from settled historical dates. beta=0 is market-only; beta=1 is full v1.',
        candidateGate: `Two-way de-vig only, at least ${MIN_SAMPLE_STARTS} prior starts, v2 edge >= ${(MIN_V2_EDGE * 100).toFixed(1)} points, EV >= ${(MIN_V2_EV * 100).toFixed(1)}%, and game not yet started.`,
        promotion: 'Research candidates become promoted candidates only after the independent walk-forward validator passes calibration and ROI gates.',
      },
      dataQuality: {
        probablePitchers: probables.length,
        archivedPropRows: resolved.payload.rows?.length || 0,
        matchedPitchers: matched.length,
        modeledPitchers: pitcherRows.length,
        modeledQuotes: bets.length,
        researchCandidateQuotes: researchCandidates.length,
        promotedCandidateQuotes: candidates.length,
        diagnostics,
      },
      candidates: candidates.slice(0, 40),
      researchCandidates: researchCandidates.slice(0, 40),
      pitchers: pitcherRows,
      bets: bets.slice(0, 120),
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

module.exports.config = { maxDuration: 60 };
