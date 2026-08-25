const { normalizeCheckpoint, redisCommand } = require('../lib/checkpoint-runtime');
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
const {
  candidateSidesFromOver,
  decorateOverRows,
  predictResidualProbability,
  rawFeatureObject,
} = require('../lib/strikeouts-market-residual');

const CHECKPOINTS = ['2017', '1717', '1117', '0817'];
const CHECKPOINT_ORDER = ['0817', '1117', '1717', '2017'];
const VALIDATED_CHECKPOINTS = new Set(['0817', '1117', '1717']);
const MIN_SAMPLE_STARTS = 8;
const MIN_V3_EDGE = 0.0125;
const MIN_V3_EV = 0.015;

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

function earlierCheckpoints(checkpoint) {
  const index = CHECKPOINT_ORDER.indexOf(String(checkpoint));
  return index > 0 ? CHECKPOINT_ORDER.slice(0, index) : [];
}

function confidence(sampleStarts) {
  if (sampleStarts >= 12) return 'higher';
  if (sampleStarts >= 8) return 'medium';
  return 'limited';
}

async function readValidationFromCache(request) {
  const through = addDays(etDate(), -1);
  const cacheKey = `mlbstrikeouts:discovery:v4:${through}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) return JSON.parse(cached)?.modelV3 || null;
  } catch {
    // Fall through to the read-only Discovery endpoint.
  }

  const host = request.headers?.host;
  if (!host) return null;
  const proto = String(request.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  try {
    const result = await fetch(`${proto}://${host}/api/strikeouts-discovery`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(55000),
    });
    if (!result.ok) return null;
    const payload = await result.json();
    return payload?.modelV3 || null;
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

function priorMarketRows(payload, checkpoint, date, probableByKey) {
  const rows = [];
  if (payload?.status !== 'ready') return rows;
  for (const oddsRow of payload.rows || []) {
    const probable = probableByKey.get(oddsRow.playerKey);
    if (!probable) continue;
    for (const [book, sides] of Object.entries(oddsRow.odds || {})) {
      const over = sides?.over;
      const under = sides?.under;
      if (!over || !under || Number(over.line) !== Number(under.line)) continue;
      const market = noVigProbabilities(over, under);
      if (market.method !== 'two-way de-vig' || !Number.isFinite(Number(market.over))) continue;
      rows.push({
        date,
        checkpoint,
        mlbamId: probable.mlbamId,
        book,
        line: Number(over.line),
        marketProbability: Number(market.over),
      });
    }
  }
  return rows;
}

function orientCandidate(candidate) {
  if (candidate.side !== 'under') {
    return {
      ...candidate,
      marketProbability: Number(candidate.marketProbability),
      v1Probability: Number(candidate.modelProbability),
    };
  }
  return {
    ...candidate,
    marketProbability: 1 - Number(candidate.marketProbability),
    v1Probability: Number.isFinite(Number(candidate.modelProbability)) ? 1 - Number(candidate.modelProbability) : null,
  };
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
      readValidationFromCache(request),
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
    const fitReady = Boolean(finalFit?.ready && Array.isArray(finalFit.coefficients));
    const checkpointValidated = VALIDATED_CHECKPOINTS.has(resolved.checkpoint);
    const promoted = Boolean(validation?.promoted && fitReady && checkpointValidated);

    const schedule = await fetchSchedule(date);
    const probables = probablePitchers(schedule);
    const probableByKey = new Map(probables.map((row) => [row.playerKey, row]));
    const matched = (resolved.payload.rows || [])
      .map((oddsRow) => ({ oddsRow, probable: probableByKey.get(oddsRow.playerKey) }))
      .filter((row) => row.probable);
    const season = Number(date.slice(0, 4));
    const uniquePitchers = [...new Map(matched.map((row) => [row.probable.mlbamId, row.probable])).values()];
    const opponentIds = [...new Set(uniquePitchers.map((row) => row.opponentId).filter(Boolean))];

    const [pitcherResults, teamResults, priorPayloads] = await Promise.all([
      mapWithConcurrency(uniquePitchers, 12, async (pitcher) => {
        try {
          return [pitcher.mlbamId, await pitcherGameLog(pitcher.mlbamId, season)];
        } catch (error) {
          return [pitcher.mlbamId, { error: error instanceof Error ? error.message : String(error) }];
        }
      }),
      mapWithConcurrency(opponentIds, 10, async (teamId) => {
        try {
          return [teamId, await teamHittingGameLog(teamId, season)];
        } catch (error) {
          return [teamId, { error: error instanceof Error ? error.message : String(error) }];
        }
      }),
      Promise.all(earlierCheckpoints(resolved.checkpoint).map(async (checkpoint) => {
        try {
          return [checkpoint, await readStrikeoutsCheckpoint(date, checkpoint)];
        } catch {
          return [checkpoint, null];
        }
      })),
    ]);
    const pitcherLogs = new Map(pitcherResults);
    const teamLogs = new Map(teamResults);

    const currentOverRows = [];
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

      for (const [book, sides] of Object.entries(oddsRow.odds || {})) {
        const over = sides?.over;
        const under = sides?.under;
        if (!over || !under || !Number.isFinite(Number(over.line)) || Number(under.line) !== Number(over.line)) continue;
        const line = Number(over.line);
        const market = noVigProbabilities(over, under);
        if (market.method !== 'two-way de-vig' || !Number.isFinite(Number(market.over))) continue;
        const probabilities = outcomeProbabilities(projection.expectedKs, projection.variance, line);
        const form = formMetrics(starts, line);
        currentOverRows.push({
          date,
          checkpoint: resolved.checkpoint,
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
          overOdds: Number(over.americanOdds),
          underOdds: Number(under.americanOdds),
          modelProbability: Number(probabilities.fairOver),
          marketProbability: Number(market.over),
          pushProbability: Number(probabilities.push),
          formScore: form.formScore,
          expectedKs: projection.expectedKs,
          sampleStarts: projection.sampleStarts,
          opponentFactor: projection.opponentFactor,
          projectedBF: projection.projectedBF,
          pitcherKRate: projection.pitcherKRate,
          restDays: projection.restDays,
          projection,
          confidence: confidence(projection.sampleStarts),
          marketMethod: market.method,
        });
      }
    }

    const priorRows = priorPayloads.flatMap(([checkpoint, payload]) =>
      priorMarketRows(payload, checkpoint, date, probableByKey)
    );
    const decorated = decorateOverRows([...priorRows, ...currentOverRows], CHECKPOINT_ORDER)
      .filter((row) => row.checkpoint === resolved.checkpoint && row.pitcherName);

    const bets = [];
    for (const row of decorated) {
      const probability = fitReady ? predictResidualProbability(row, finalFit) : null;
      if (probability == null) continue;
      for (const rawCandidate of candidateSidesFromOver(row, probability)) {
        const candidate = orientCandidate(rawCandidate);
        bets.push({
          ...candidate,
          v3Probability: Number(candidate.v3Probability.toFixed(4)),
          v3FairOdds: fairAmerican(candidate.v3Probability),
          marketProbability: Number(candidate.marketProbability.toFixed(4)),
          v1Probability: candidate.v1Probability == null ? null : Number(candidate.v1Probability.toFixed(4)),
          v3ProbabilityEdge: Number(candidate.v3ProbabilityEdge.toFixed(4)),
          v3ExpectedValue: candidate.v3ExpectedValue == null ? null : Number(candidate.v3ExpectedValue.toFixed(4)),
          marketFeatures: {
            consensusProbability: row.consensusProbability == null ? null : Number(row.consensusProbability.toFixed(4)),
            consensusGap: Number((row.consensusGap || 0).toFixed(4)),
            consensusSpread: Number((row.consensusSpread || 0).toFixed(4)),
            lineGap: Number((row.lineGap || 0).toFixed(2)),
            lineSpan: Number((row.lineSpan || 0).toFixed(2)),
            lineMove: Number((row.lineMove || 0).toFixed(2)),
            probabilityMoveSameLine: Number((row.probMoveSameLine || 0).toFixed(4)),
            hasPrior: Boolean(row.hasPrior),
            priorSameLine: Boolean(row.priorSameLine),
          },
          featureVector: rawFeatureObject(row),
        });
      }
    }

    bets.sort((a, b) => Number(b.v3ExpectedValue ?? -999) - Number(a.v3ExpectedValue ?? -999));
    const byPitcher = new Map();
    for (const bet of bets) {
      if (!byPitcher.has(bet.mlbamId)) byPitcher.set(bet.mlbamId, []);
      byPitcher.get(bet.mlbamId).push(bet);
    }
    const pitcherRows = [...byPitcher.values()].map((values) => {
      values.sort((a, b) => Number(b.v3ExpectedValue ?? -999) - Number(a.v3ExpectedValue ?? -999));
      const best = values[0];
      return {
        pitcherName: best.pitcherName,
        mlbamId: best.mlbamId,
        team: best.team,
        opponent: best.opponent,
        matchup: best.matchup,
        gameStartAt: best.gameStartAt,
        gameStatus: best.gameStatus,
        expectedKs: best.expectedKs,
        projection: best.projection,
        bestBet: best,
        availableBets: values.length,
      };
    }).sort((a, b) => Number(b.bestBet?.v3ExpectedValue ?? -999) - Number(a.bestBet?.v3ExpectedValue ?? -999));

    const researchCandidates = bets.filter((row) =>
      row.marketMethod === 'two-way de-vig'
      && row.v3ExpectedValue != null
      && row.v3ExpectedValue >= MIN_V3_EV
      && row.v3ProbabilityEdge != null
      && row.v3ProbabilityEdge >= MIN_V3_EDGE
      && row.sampleStarts >= MIN_SAMPLE_STARTS
      && isPregame(row)
    );
    const candidates = promoted ? researchCandidates : [];
    const promotionReason = !fitReady
      ? 'Validation fit unavailable; v3 cannot be promoted.'
      : !checkpointValidated
        ? `${resolved.checkpoint} is research-only because that checkpoint is not included in the historical v3 validation set.`
        : (validation?.promotionReason || 'v3 validation has not passed the promotion gate.');

    const output = {
      schemaVersion: 3,
      kind: 'pitcher_strikeouts_market_residual_model',
      modelVersion: 'k-market-residual-v3.0',
      status: pitcherRows.length ? 'ready' : 'no_rows',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: resolved.checkpoint,
      checkpointAsOf: resolved.payload.asOf,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      promoted,
      checkpointValidated,
      promotionReason,
      validation: validation ? {
        calibration: validation.calibration || null,
        finalFit,
        strategy: validation.strategy || null,
      } : null,
      methodology: {
        target: 'Residual correction to each exact two-way de-vigged sportsbook strikeout probability.',
        prior: 'Sportsbook no-vig probability is the offset. v3 cannot discard the market and rebuild probability from scratch.',
        residualFeatures: 'Structural-model disagreement, form, workload, opponent context, cross-book probability/line dispersion, book identity, and earlier same-day checkpoint movement.',
        fitting: 'Ridge-regularized logistic residual with strict date walk-forward and past-only inner lambda selection. Multiple books on the same pitcher/checkpoint are group-weighted during training.',
        candidateGate: `Two-way de-vig only, at least ${MIN_SAMPLE_STARTS} prior starts, v3 edge >= ${(MIN_V3_EDGE * 100).toFixed(2)} points, EV >= ${(MIN_V3_EV * 100).toFixed(1)}%, and game not yet started.`,
        promotion: 'Research candidates become promoted only after v3 beats the market by the preset calibration margin and has positive walk-forward executable ROI. 8:17 PM remains research-only until that checkpoint has historical validation.',
      },
      dataQuality: {
        probablePitchers: probables.length,
        archivedPropRows: resolved.payload.rows?.length || 0,
        matchedPitchers: matched.length,
        modeledPitchers: pitcherRows.length,
        modeledQuotes: bets.length,
        priorCheckpointFiles: priorPayloads.filter(([, payload]) => payload?.status === 'ready').length,
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
