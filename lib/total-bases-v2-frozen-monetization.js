const totalBasesV2Handler = require('./total-bases-v2-handler');

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

function liveSelect(v2Rows, checkpoint) {
  if (checkpoint !== FROZEN_RULE.checkpoint) return [];
  return (v2Rows || []).map((row) => {
    const v2Probability = Number(row.v2Probability ?? row.modelProbability);
    const formProbability = Number(row.formProbability);
    const odds = Number(row.bestOver?.americanOdds);
    const implied = impliedProbability(odds);
    const monetizedProbability = clampProbability(
      formProbability + FROZEN_RULE.alpha * (v2Probability - formProbability),
    );
    const monetizedEdge = implied == null ? null : monetizedProbability - implied;
    const monetizedEv = expectedValue(monetizedProbability, odds);
    return {
      ...row,
      v2Probability,
      formProbability,
      contextLift: v2Probability - formProbability,
      monetizedProbability: Number(monetizedProbability.toFixed(4)),
      monetizedEdge: monetizedEdge == null ? null : Number(monetizedEdge.toFixed(4)),
      monetizedEv: monetizedEv == null ? null : Number(monetizedEv.toFixed(4)),
    };
  }).filter((row) => {
    const odds = Number(row.bestOver?.americanOdds);
    if (!Number.isFinite(odds) || odds > FROZEN_RULE.maxOdds) return false;
    if (!(Number(row.monetizedEdge) >= FROZEN_RULE.minEdge && Number(row.monetizedEv) > 0)) return false;
    return true;
  }).sort((a, b) => Number(b.monetizedEv) - Number(a.monetizedEv)
      || Number(b.monetizedEdge) - Number(a.monetizedEdge))
    .slice(0, FROZEN_RULE.topN);
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
    const v2Result = await v2Output(request);
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
      schemaVersion: 2,
      kind: 'batter_two_plus_total_bases_v2_frozen_monetization',
      status: 'ready',
      generatedAt: new Date().toISOString(),
      date: String(request.query?.date || v2.date || ''),
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
      },
      split: {
        archiveStart: '2026-08-02',
        internalSplit: '2026-08-12',
        earlyRecoveredDates: ['2026-08-07','2026-08-08','2026-08-09','2026-08-10','2026-08-11'],
        lateRecoveredDates: ['2026-08-12','2026-08-13','2026-08-14','2026-08-15','2026-08-16'],
        holdoutStart: '2026-08-17',
        holdoutThrough: FROZEN_HOLDOUT.through,
        forwardStart: '2026-08-26',
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
