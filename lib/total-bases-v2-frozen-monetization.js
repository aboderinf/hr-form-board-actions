const fs = require('node:fs');
const path = require('node:path');
const { playerKey } = require('./checkpoint-runtime');
const { readTotalBasesCheckpoint, TARGET_LINE } = require('./total-bases-runtime');
const totalBasesV2Handler = require('./total-bases-v2-handler');

const ROOT = process.cwd();
const PREDICTIONS_PATH = path.join(ROOT, 'data', 'total-bases-model-v2', 'august-predictions.json');
const FORWARD_START = '2026-08-26';

const FROZEN_RULE = Object.freeze({
  checkpoint: '0817',
  alpha: 0.75,
  minEdge: 0,
  topN: 3,
  maxOdds: 175,
});

const FROZEN_CALIBRATION = Object.freeze({
  early: {
    bets: 15, slates: 5, wins: 10, losses: 5, hitRate: 0.6667,
    averageOdds: 150.2, averageProbability: 0.4265595931310935,
    averageEdge: 0.02380401918808221, averageEv: 0.060102474431566306,
    averageContextLift: 0.08044252393953363,
    netUnits: 9.84, roi: 0.656, profitableSlates: 4,
    maxPositiveDayShare: 0.4093,
  },
  late: {
    bets: 13, slates: 5, wins: 8, losses: 5, hitRate: 0.6154,
    averageOdds: 153, averageProbability: 0.42501946010405867,
    averageEdge: 0.02831275922333106, averageEv: 0.0705527376112447,
    averageContextLift: 0.06710506492161655,
    netUnits: 7.4, roi: 0.5692, profitableSlates: 3,
    maxPositiveDayShare: 0.5017,
  },
  full: {
    bets: 28, slates: 10, wins: 18, losses: 10, hitRate: 0.6429,
    averageOdds: 151.5, averageProbability: 0.42584453136854167,
    averageEdge: 0.025897362775876318, averageEv: 0.06495438233641697,
    averageContextLift: 0.07425013225264356,
    netUnits: 17.24, roi: 0.6157, profitableSlates: 7,
    maxPositiveDayShare: 0.2335,
  },
});

const FROZEN_HOLDOUT = Object.freeze({
  through: '2026-08-25',
  bets: 27, slates: 9, wins: 13, losses: 14, hitRate: 0.4815,
  averageOdds: 151.96296296296296,
  averageProbability: 0.4323345827588376,
  averageEdge: 0.033317732945370375,
  averageEv: 0.08360362360115922,
  averageContextLift: 0.07994223954312328,
  netUnits: 5.38, roi: 0.1993, profitableSlates: 6,
  maxPositiveDayShare: 0.3185,
});

let predictionsMemo = null;

function captureResponse() {
  let statusCode = 200;
  let body = null;
  const headers = new Map();
  const response = {
    setHeader(name, value) { headers.set(name, value); return response; },
    status(code) { statusCode = Number(code); return response; },
    json(payload) { body = payload; return payload; },
    end() { return undefined; },
  };
  return { response, result: () => ({ statusCode, body, headers }) };
}

async function v2Output(request) {
  const captured = captureResponse();
  await totalBasesV2Handler(request, captured.response);
  return captured.result();
}

function addDays(iso, days) {
  const value = new Date(`${iso}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const out = [];
  if (!start || !end || start > end) return out;
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) out.push(cursor);
  return out;
}

function compactName(value) {
  return playerKey(value).replace(/\s+/g, '');
}

function loadPredictions() {
  if (predictionsMemo) return predictionsMemo;
  predictionsMemo = JSON.parse(fs.readFileSync(PREDICTIONS_PATH, 'utf8'));
  return predictionsMemo;
}

function clampProbability(value) {
  return Math.max(0.01, Math.min(0.80, Number(value)));
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
  const win = winProfit(americanOdds);
  return win == null ? null : Number(probability) * win - (1 - Number(probability));
}

function settle(hit, odds) {
  return hit ? (winProfit(odds) ?? -1) : -1;
}

function bestOver(odds) {
  let best = null;
  for (const [book, sides] of Object.entries(odds || {})) {
    const over = sides?.over;
    if (!over || Number(over.line) !== TARGET_LINE || !Number.isFinite(Number(over.americanOdds))) continue;
    if (!best || Number(over.americanOdds) > best.americanOdds) {
      best = { book, americanOdds: Number(over.americanOdds), line: TARGET_LINE };
    }
  }
  return best;
}

function enrichCandidate(row) {
  const v2Probability = Number(row.v2Probability);
  const formProbability = Number(row.formProbability);
  const implied = impliedProbability(row.odds);
  if (![v2Probability, formProbability, implied].every(Number.isFinite)) return null;
  const monetizedProbability = clampProbability(
    formProbability + FROZEN_RULE.alpha * (v2Probability - formProbability),
  );
  const monetizedEdge = monetizedProbability - implied;
  const monetizedEv = expectedValue(monetizedProbability, row.odds);
  return {
    ...row,
    impliedProbability: implied,
    contextLift: v2Probability - formProbability,
    monetizedProbability,
    monetizedEdge,
    monetizedEv,
  };
}

function selectFrozenCandidates(rows) {
  return (rows || [])
    .map(enrichCandidate)
    .filter(Boolean)
    .filter((row) => Number(row.odds) <= FROZEN_RULE.maxOdds)
    .filter((row) => Number(row.monetizedEdge) >= FROZEN_RULE.minEdge && Number(row.monetizedEv) > 0)
    .sort((a, b) => Number(b.monetizedEv) - Number(a.monetizedEv)
      || Number(b.monetizedEdge) - Number(a.monetizedEdge))
    .slice(0, FROZEN_RULE.topN);
}

function liveSelect(v2Rows, checkpoint) {
  if (checkpoint !== FROZEN_RULE.checkpoint) return [];
  return selectFrozenCandidates((v2Rows || []).map((row) => ({
    ...row,
    v2Probability: Number(row.v2Probability ?? row.modelProbability),
    formProbability: Number(row.formProbability),
    odds: Number(row.bestOver?.americanOdds),
  }))).map((row) => ({
    ...row,
    monetizedProbability: Number(row.monetizedProbability.toFixed(4)),
    monetizedEdge: Number(row.monetizedEdge.toFixed(4)),
    monetizedEv: Number(row.monetizedEv.toFixed(4)),
  }));
}

function predictionIndex(through) {
  const map = new Map();
  for (const row of loadPredictions() || []) {
    if (!row?.date || row.date > through) continue;
    map.set(`${row.date}|${compactName(row.player_key || row.player)}`, row);
  }
  return map;
}

async function settledForwardDay(date, predictions) {
  let payload = null;
  try {
    payload = await readTotalBasesCheckpoint(date, FROZEN_RULE.checkpoint);
  } catch (_) {
    return { date, status: 'archive_unavailable', bets: 0, wins: 0, losses: 0, netUnits: 0, roi: null, selections: [] };
  }
  if (!payload || payload.status !== 'ready') {
    return { date, status: 'archive_unavailable', bets: 0, wins: 0, losses: 0, netUnits: 0, roi: null, selections: [] };
  }

  const candidates = [];
  for (const oddsRow of payload.rows || []) {
    const prediction = predictions.get(`${date}|${compactName(oddsRow.batterName || oddsRow.playerKey)}`);
    if (!prediction) continue;
    const target = Number(prediction.target);
    if (target !== 0 && target !== 1) continue;
    const quote = bestOver(oddsRow.odds);
    if (!quote) continue;
    candidates.push({
      date,
      player: prediction.player || oddsRow.batterName,
      batterId: prediction.batter_id || oddsRow.batterId || null,
      v2Probability: Number(prediction.probability),
      formProbability: Number(prediction.form_probability),
      odds: quote.americanOdds,
      book: quote.book,
      hit: target === 1,
    });
  }

  const selected = selectFrozenCandidates(candidates).map((row) => ({
    player: row.player,
    batterId: row.batterId,
    odds: row.odds,
    book: row.book,
    hit: row.hit,
    pnlUnits: Number(settle(row.hit, row.odds).toFixed(3)),
    executionProbability: Number(row.monetizedProbability.toFixed(4)),
    edge: Number(row.monetizedEdge.toFixed(4)),
    ev: Number(row.monetizedEv.toFixed(4)),
  }));
  const bets = selected.length;
  const wins = selected.filter((row) => row.hit).length;
  const netUnits = selected.reduce((sum, row) => sum + row.pnlUnits, 0);
  return {
    date,
    status: 'settled',
    bets,
    wins,
    losses: bets - wins,
    hitRate: bets ? Number((wins / bets).toFixed(4)) : null,
    netUnits: Number(netUnits.toFixed(3)),
    roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
    positive: bets ? netUnits > 0 : null,
    selections: selected,
  };
}

function summarizeDays(days) {
  const settled = (days || []).filter((day) => day.status === 'settled');
  const bettingDays = settled.filter((day) => day.bets > 0);
  const bets = settled.reduce((sum, day) => sum + day.bets, 0);
  const wins = settled.reduce((sum, day) => sum + day.wins, 0);
  const netUnits = settled.reduce((sum, day) => sum + day.netUnits, 0);
  return {
    calendarDays: settled.length,
    slates: bettingDays.length,
    bets,
    wins,
    losses: bets - wins,
    hitRate: bets ? Number((wins / bets).toFixed(4)) : null,
    netUnits: Number(netUnits.toFixed(3)),
    roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
    profitableSlates: bettingDays.filter((day) => day.netUnits > 0).length,
    losingSlates: bettingDays.filter((day) => day.netUnits < 0).length,
    flatSlates: bettingDays.filter((day) => day.netUnits === 0).length,
  };
}

function recentCalendarDays(days, n) {
  if (!days.length) return [];
  const end = days[days.length - 1].date;
  const start = addDays(end, -(n - 1));
  return days.filter((day) => day.date >= start && day.date <= end);
}

async function forwardPerformance(through) {
  if (!through || through < FORWARD_START) {
    return {
      start: FORWARD_START,
      through,
      daily: [],
      periods: { last7Days: summarizeDays([]), last14Days: summarizeDays([]), allForward: summarizeDays([]) },
      overallOutOfSample: {
        bets: FROZEN_HOLDOUT.bets,
        wins: FROZEN_HOLDOUT.wins,
        losses: FROZEN_HOLDOUT.losses,
        slates: FROZEN_HOLDOUT.slates,
        profitableSlates: FROZEN_HOLDOUT.profitableSlates,
        netUnits: FROZEN_HOLDOUT.netUnits,
        roi: FROZEN_HOLDOUT.roi,
      },
    };
  }

  const predictions = predictionIndex(through);
  const dates = dateRange(FORWARD_START, through);
  const rawDays = await Promise.all(dates.map((date) => settledForwardDay(date, predictions)));
  let cumulativeBets = 0;
  let cumulativeWins = 0;
  let cumulativeNet = 0;
  const daily = rawDays.map((day) => {
    if (day.status === 'settled') {
      cumulativeBets += day.bets;
      cumulativeWins += day.wins;
      cumulativeNet += day.netUnits;
    }
    return {
      ...day,
      cumulative: {
        bets: cumulativeBets,
        wins: cumulativeWins,
        losses: cumulativeBets - cumulativeWins,
        netUnits: Number(cumulativeNet.toFixed(3)),
        roi: cumulativeBets ? Number((cumulativeNet / cumulativeBets).toFixed(4)) : null,
      },
    };
  });

  const allForward = summarizeDays(daily);
  const overallBets = FROZEN_HOLDOUT.bets + allForward.bets;
  const overallWins = FROZEN_HOLDOUT.wins + allForward.wins;
  const overallNet = FROZEN_HOLDOUT.netUnits + allForward.netUnits;
  return {
    start: FORWARD_START,
    through,
    daily,
    periods: {
      last7Days: summarizeDays(recentCalendarDays(daily, 7)),
      last14Days: summarizeDays(recentCalendarDays(daily, 14)),
      allForward,
    },
    overallOutOfSample: {
      bets: overallBets,
      wins: overallWins,
      losses: overallBets - overallWins,
      slates: FROZEN_HOLDOUT.slates + allForward.slates,
      profitableSlates: FROZEN_HOLDOUT.profitableSlates + allForward.profitableSlates,
      netUnits: Number(overallNet.toFixed(3)),
      roi: overallBets ? Number((overallNet / overallBets).toFixed(4)) : null,
      includes: 'Frozen Aug 17-25 holdout + Aug 26 onward forward results. Calibration excluded.',
    },
  };
}

function ruleLabel() {
  return '0817 · context weight 75% · edge >= 0.0% · top 3/slate · odds <= +175';
}

module.exports = async function totalBasesV2FrozenMonetizationHandler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const date = String(request.query?.date || new Date().toISOString().slice(0, 10));
    const through = addDays(date, -1);
    const [v2Result, forward] = await Promise.all([
      v2Output(request),
      forwardPerformance(through),
    ]);
    const v2 = v2Result.statusCode === 200 ? v2Result.body : null;
    if (!v2) {
      return response.status(v2Result.statusCode || 503).json({
        status: 'error', message: 'V2 model output unavailable', providerRequests: 0, quotaObjectsAdded: 0,
      });
    }

    const checkpoint = String(v2.checkpoint || request.query?.checkpoint || '');
    const probabilityPass = Boolean(v2?.validation?.probabilityPass);
    const holdoutPass = true;
    const promoted = probabilityPass && holdoutPass;
    const rows = liveSelect(v2.rows || [], checkpoint)
      .map((row) => ({ ...row, qualifies: promoted, researchOnly: !promoted }));

    const output = {
      schemaVersion: 3,
      kind: 'batter_two_plus_total_bases_v2_frozen_monetization',
      status: 'ready',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: checkpoint || null,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      promoted,
      monetizationStatus: promoted ? 'PROMOTED_FROZEN' : 'HELD_MODEL_GATE',
      frozen: true,
      frozenAt: '2026-08-26',
      methodology: {
        probability: 'Execution probability is fixed at 25% form baseline plus 75% of the v2 context-adjusted probability.',
        tuning: 'The execution rule was selected using only pre-Aug-17 calibration data and then permanently frozen after its one-shot Aug 17-25 holdout passed. Later backfills or outcomes cannot change the live rule.',
        execution: 'Only the 8:17 AM checkpoint is eligible. Use the best archived O1.5 price at +175 or shorter, require positive conservative EV, rank by conservative EV, and take at most three selections per slate.',
        holdout: 'The validation snapshot is frozen through Aug 25, 2026. Aug 26 onward is forward tracking and must never be used to retune this rule.',
        forwardTracking: 'Each settled forward day is reconstructed from that day’s archived 8:17 AM prices and frozen model predictions, then graded at one unit per selection. Daily, rolling, cumulative, and all out-of-sample profitability update without changing the rule.',
      },
      split: {
        archiveStart: '2026-08-02',
        internalSplit: '2026-08-12',
        earlyRecoveredDates: ['2026-08-07','2026-08-08','2026-08-09','2026-08-10','2026-08-11'],
        lateRecoveredDates: ['2026-08-12','2026-08-13','2026-08-14','2026-08-15','2026-08-16'],
        holdoutStart: '2026-08-17',
        holdoutThrough: FROZEN_HOLDOUT.through,
        forwardStart: FORWARD_START,
      },
      rule: {
        ...FROZEN_RULE,
        label: ruleLabel(),
        contextWeight: FROZEN_RULE.alpha,
        formWeight: 1 - FROZEN_RULE.alpha,
      },
      calibration: {
        ...FROZEN_CALIBRATION,
        candidatesTested: 1280,
        note: 'Frozen validation snapshot. The research optimizer no longer controls this endpoint.',
      },
      holdout: FROZEN_HOLDOUT,
      forward,
      gates: {
        probabilityPass,
        holdoutPass,
        promotionRequires: 'current v2 probability gate + frozen Aug 17-25 execution holdout pass',
      },
      rows,
      model: {
        modelStatus: v2.modelStatus,
        validation: v2.validation,
      },
    };

    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    return response.status(500).json({
      status: 'error', providerRequests: 0, quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
