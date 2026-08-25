const { normalizeCheckpoint } = require('../lib/checkpoint-runtime');
const { readStrikeoutsCheckpoint } = require('../lib/strikeouts-runtime');
const {
  LEAGUE_K_PA_FALLBACK,
  expectedValue,
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

const CHECKPOINTS = ['2017', '1717', '1117', '0817'];

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
  if (sampleStarts >= 6) return 'medium';
  return 'limited';
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
    const resolved = await resolveCheckpoint(date, request.query?.checkpoint);
    if (!resolved?.payload) {
      response.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
      return response.status(404).json({
        status: 'pending', date, checkpoint: resolved?.checkpoint || null,
        message: 'No archived strikeout checkpoint is available for this slate yet',
        providerRequests: 0, quotaObjectsAdded: 0,
      });
    }

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
        if (!over || !Number.isFinite(Number(over.line))) continue;
        const under = sides?.under && Number(sides.under.line) === Number(over.line) ? sides.under : null;
        const line = Number(over.line);
        const probabilities = outcomeProbabilities(projection.expectedKs, projection.variance, line);
        const market = noVigProbabilities(over, under);
        const form = formMetrics(starts, line);
        const overEv = expectedValue(probabilities, over, 'over');
        const overBet = {
          pitcherName: probable.pitcherName,
          mlbamId: probable.mlbamId,
          team: probable.team,
          opponent: probable.opponent,
          matchup: oddsRow.matchup,
          gamePk: probable.gamePk,
          gameStartAt: probable.gameStartAt,
          gameStatus: probable.gameStatus,
          book,
          side: 'over',
          line,
          odds: Number(over.americanOdds),
          modelProbability: Number(probabilities.fairOver.toFixed(4)),
          fairOdds: fairAmerican(probabilities.fairOver),
          marketNoVigProbability: market.over == null ? null : Number(market.over.toFixed(4)),
          probabilityEdge: market.over == null ? null : Number((probabilities.fairOver - market.over).toFixed(4)),
          expectedValue: overEv == null ? null : Number(overEv.toFixed(4)),
          pushProbability: Number(probabilities.push.toFixed(4)),
          formScore: form.formScore,
          expectedKs: projection.expectedKs,
          projection,
          confidence: confidence(projection.sampleStarts),
          marketMethod: market.method,
        };
        bets.push(overBet);
        pitcherBets.push(overBet);

        if (under) {
          const underEv = expectedValue(probabilities, under, 'under');
          const underBet = {
            ...overBet,
            side: 'under',
            odds: Number(under.americanOdds),
            modelProbability: Number(probabilities.fairUnder.toFixed(4)),
            fairOdds: fairAmerican(probabilities.fairUnder),
            marketNoVigProbability: market.under == null ? null : Number(market.under.toFixed(4)),
            probabilityEdge: market.under == null ? null : Number((probabilities.fairUnder - market.under).toFixed(4)),
            expectedValue: underEv == null ? null : Number(underEv.toFixed(4)),
          };
          bets.push(underBet);
          pitcherBets.push(underBet);
        }
      }

      pitcherBets.sort((a, b) => Number(b.expectedValue ?? -999) - Number(a.expectedValue ?? -999));
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

    bets.sort((a, b) => Number(b.expectedValue ?? -999) - Number(a.expectedValue ?? -999));
    pitcherRows.sort((a, b) => Number(b.bestBet?.expectedValue ?? -999) - Number(a.bestBet?.expectedValue ?? -999));
    const candidates = bets.filter((row) =>
      row.expectedValue != null
      && row.expectedValue >= 0.04
      && row.probabilityEdge != null
      && row.probabilityEdge >= 0.025
      && row.projection.sampleStarts >= 5
    );

    const output = {
      schemaVersion: 1,
      kind: 'pitcher_strikeouts_count_model',
      modelVersion: 'k-count-v1.0',
      status: pitcherRows.length ? 'ready' : 'no_rows',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: resolved.checkpoint,
      checkpointAsOf: resolved.payload.asOf,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      methodology: {
        target: 'Full-game starting-pitcher strikeout count, evaluated against each exact sportsbook line.',
        pitcherRate: '55% recent-five K per batter faced + 45% longer rolling K per batter faced.',
        workload: 'Projected batters faced = 50% L3 + 30% L5 + 20% L10 recent-start depth.',
        opponent: 'Opponent batting strikeout rate, 65% season + 35% recent 10 games, relative to a 22.5% league baseline and capped to ±15%.',
        distribution: 'Poisson when dispersion is low; moment-matched negative binomial when recent strikeout variance exceeds the mean.',
        market: 'Two-way de-vig when the same book posts both over and under at the same line; one-sided implied probability otherwise.',
        warning: 'v1 is a transparent structural count model, not yet a trained gradient-boosting model. Discovery is used to validate it before promotion.',
      },
      dataQuality: {
        probablePitchers: probables.length,
        archivedPropRows: resolved.payload.rows?.length || 0,
        matchedPitchers: matched.length,
        modeledPitchers: pitcherRows.length,
        modeledQuotes: bets.length,
        candidateQuotes: candidates.length,
        diagnostics,
      },
      candidates: candidates.slice(0, 40),
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
