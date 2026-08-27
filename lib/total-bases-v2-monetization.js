const fs = require('node:fs');
const path = require('node:path');
const { playerKey, redisCommand } = require('./checkpoint-runtime');
const { readTotalBasesCheckpoint, TARGET_LINE } = require('./total-bases-runtime');
const totalBasesV2Handler = require('./total-bases-v2-handler');

const ROOT = process.cwd();
const PREDICTIONS_PATH = path.join(ROOT, 'data', 'total-bases-model-v2', 'august-predictions.json');
const CHECKPOINTS = ['0817', '1117', '1717', '2017'];
const ARCHIVE_START = '2026-08-02';
const HOLDOUT_START = '2026-08-17';
const INTERNAL_SPLIT = '2026-08-09';
const CACHE_TTL_SECONDS = 6 * 60 * 60;

let predictionsMemo = null;

function addDays(iso, days) {
  const value = new Date(`${iso}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const out = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) out.push(cursor);
  return out;
}

function compactName(value) {
  return playerKey(value).replace(/\s+/g, '');
}

function avg(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
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

function loadPredictions() {
  if (predictionsMemo) return predictionsMemo;
  predictionsMemo = JSON.parse(fs.readFileSync(PREDICTIONS_PATH, 'utf8'));
  return predictionsMemo;
}

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

function strategySummary(rows) {
  const bets = rows.length;
  const wins = rows.reduce((sum, row) => sum + Number(row.hit), 0);
  const netUnits = rows.reduce((sum, row) => sum + settle(row.hit, row.odds), 0);
  const daily = new Map();
  for (const row of rows) daily.set(row.date, (daily.get(row.date) || 0) + settle(row.hit, row.odds));
  const dailyNets = [...daily.values()];
  const positiveDaily = dailyNets.filter((value) => value > 0);
  const positiveGross = positiveDaily.reduce((sum, value) => sum + value, 0);
  const maxPositiveDay = positiveDaily.length ? Math.max(...positiveDaily) : 0;
  return {
    bets,
    slates: daily.size,
    wins,
    losses: bets - wins,
    hitRate: bets ? Number((wins / bets).toFixed(4)) : null,
    averageOdds: avg(rows.map((row) => row.odds)),
    averageProbability: avg(rows.map((row) => row.monetizedProbability)),
    averageEdge: avg(rows.map((row) => row.monetizedEdge)),
    averageEv: avg(rows.map((row) => row.monetizedEv)),
    averageContextLift: avg(rows.map((row) => row.contextLift)),
    netUnits: Number(netUnits.toFixed(3)),
    roi: bets ? Number((netUnits / bets).toFixed(4)) : null,
    profitableSlates: positiveDaily.length,
    maxPositiveDayShare: positiveGross > 0 ? Number((maxPositiveDay / positiveGross).toFixed(4)) : null,
  };
}

async function archiveEvaluation(through) {
  const predictions = loadPredictions();
  const predictionMap = new Map();
  for (const row of predictions || []) {
    if (row.date > through) continue;
    predictionMap.set(`${row.date}|${compactName(row.player_key || row.player)}`, row);
  }

  const requests = dateRange(ARCHIVE_START, through)
    .flatMap((date) => CHECKPOINTS.map((checkpoint) => ({ date, checkpoint })));
  const captures = await Promise.all(requests.map(async ({ date, checkpoint }) => {
    try {
      const payload = await readTotalBasesCheckpoint(date, checkpoint);
      return payload?.status === 'ready' ? { date, checkpoint, rows: payload.rows || [] } : null;
    } catch {
      return null;
    }
  }));

  const output = [];
  for (const capture of captures.filter(Boolean)) {
    for (const oddsRow of capture.rows) {
      const prediction = predictionMap.get(`${capture.date}|${compactName(oddsRow.batterName || oddsRow.playerKey)}`);
      if (!prediction) continue;
      const quote = bestOver(oddsRow.odds);
      if (!quote) continue;
      const implied = impliedProbability(quote.americanOdds);
      const v2Probability = Number(prediction.probability);
      const formProbability = Number(prediction.form_probability);
      if (![implied, v2Probability, formProbability].every(Number.isFinite)) continue;
      output.push({
        date: capture.date,
        checkpoint: capture.checkpoint,
        player: prediction.player,
        hit: Number(prediction.target) === 1,
        v2Probability,
        rankingProbability: Number(prediction.ranking_probability),
        formProbability,
        contextLift: v2Probability - formProbability,
        odds: quote.americanOdds,
        book: quote.book,
        impliedProbability: implied,
      });
    }
  }
  return output;
}

function enrichRows(rows, alpha) {
  return rows.map((row) => {
    const monetizedProbability = clampProbability(row.formProbability + alpha * (row.v2Probability - row.formProbability));
    const monetizedEdge = monetizedProbability - row.impliedProbability;
    const monetizedEv = expectedValue(monetizedProbability, row.odds);
    return { ...row, monetizedProbability, monetizedEdge, monetizedEv };
  });
}

function ruleSelect(rows, rule) {
  const filtered = enrichRows(rows, rule.alpha).filter((row) => {
    if (row.checkpoint !== rule.checkpoint) return false;
    if (rule.maxOdds != null && Number(row.odds) > Number(rule.maxOdds)) return false;
    if (row.monetizedEdge < rule.minEdge) return false;
    if (!(row.monetizedEv > 0)) return false;
    return true;
  });

  const byDate = new Map();
  for (const row of filtered) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  const selected = [];
  for (const date of [...byDate.keys()].sort()) {
    const ordered = byDate.get(date).sort((a, b) => b.monetizedEv - a.monetizedEv || b.monetizedEdge - a.monetizedEdge);
    selected.push(...ordered.slice(0, rule.topN));
  }
  return selected;
}

function candidateGrid() {
  const alphas = [0.25, 0.50, 0.75, 1.00];
  const minEdges = [0, 0.01, 0.02, 0.03, 0.04];
  const topNs = [3, 5, 8, 10];
  const maxOddsValues = [175, 225, 300, null];
  const candidates = [];
  for (const checkpoint of CHECKPOINTS) {
    for (const alpha of alphas) {
      for (const minEdge of minEdges) {
        for (const topN of topNs) {
          for (const maxOdds of maxOddsValues) {
            candidates.push({ checkpoint, alpha, minEdge, topN, maxOdds });
          }
        }
      }
    }
  }
  return candidates;
}

function robustTuneStrategy(calibrationRows) {
  const earlyRows = calibrationRows.filter((row) => row.date < INTERNAL_SPLIT);
  const lateRows = calibrationRows.filter((row) => row.date >= INTERNAL_SPLIT);
  let best = null;
  let passingCandidates = 0;

  for (const rule of candidateGrid()) {
    const earlySelected = ruleSelect(earlyRows, rule);
    const lateSelected = ruleSelect(lateRows, rule);
    const fullSelected = ruleSelect(calibrationRows, rule);
    const early = strategySummary(earlySelected);
    const late = strategySummary(lateSelected);
    const full = strategySummary(fullSelected);

    if (early.bets < 8 || early.slates < 3 || late.bets < 8 || late.slates < 3) continue;
    if (full.bets < 20 || full.slates < 7) continue;
    if (!(early.roi > 0 && late.roi > 0 && full.roi > 0)) continue;
    if (early.profitableSlates < 2 || late.profitableSlates < 2 || full.profitableSlates < 4) continue;
    if (full.maxPositiveDayShare != null && full.maxPositiveDayShare > 0.60) continue;

    passingCandidates += 1;
    const minimumHalfRoi = Math.min(early.roi, late.roi);
    const imbalancePenalty = Math.abs(early.roi - late.roi);
    const sampleBonus = Math.min(0.08, Math.log1p(full.bets) / 80);
    const score = minimumHalfRoi + 0.35 * full.roi + sampleBonus - 0.20 * imbalancePenalty;
    if (!best || score > best.score) best = { rule, score, early, late, full };
  }

  return best
    ? { ready: true, ...best, passingCandidates, candidatesTested: candidateGrid().length }
    : { ready: false, rule: null, score: null, early: strategySummary([]), late: strategySummary([]), full: strategySummary([]), passingCandidates, candidatesTested: candidateGrid().length };
}

function ruleLabel(rule) {
  if (!rule) return 'No stable calibration rule';
  return `${rule.checkpoint} · context weight ${Math.round(rule.alpha * 100)}% · edge >= ${(rule.minEdge * 100).toFixed(1)}% · top ${rule.topN}/slate${rule.maxOdds == null ? '' : ` · odds <= +${rule.maxOdds}`}`;
}

function liveSelect(v2Rows, checkpoint, rule) {
  if (!rule || checkpoint !== rule.checkpoint) return [];
  const prepared = (v2Rows || []).map((row) => {
    const v2Probability = Number(row.v2Probability ?? row.modelProbability);
    const formProbability = Number(row.formProbability);
    const odds = Number(row.bestOver?.americanOdds);
    const implied = impliedProbability(odds);
    const monetizedProbability = clampProbability(formProbability + rule.alpha * (v2Probability - formProbability));
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
    if (rule.maxOdds != null && Number(row.bestOver?.americanOdds) > Number(rule.maxOdds)) return false;
    if (!(Number(row.monetizedEdge) >= rule.minEdge && Number(row.monetizedEv) > 0)) return false;
    return true;
  });
  return prepared
    .sort((a, b) => Number(b.monetizedEv) - Number(a.monetizedEv) || Number(b.monetizedEdge) - Number(a.monetizedEdge))
    .slice(0, rule.topN);
}

module.exports = async function totalBasesV2MonetizationHandler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const date = String(request.query?.date || new Date().toISOString().slice(0, 10));
  const through = addDays(date, -1);
  const cacheKey = `mlbtb2:monetization:v1:${date}:${String(request.query?.checkpoint || 'latest')}:${through}`;
  try {
    const cached = await redisCommand(['GET', cacheKey]);
    if (cached) return response.status(200).json(JSON.parse(cached));
  } catch (_) {}

  try {
    const [evaluation, v2Result] = await Promise.all([
      archiveEvaluation(through),
      v2Output(request),
    ]);
    const calibrationRows = evaluation.filter((row) => row.date < HOLDOUT_START);
    const holdoutRows = evaluation.filter((row) => row.date >= HOLDOUT_START);
    const tuned = robustTuneStrategy(calibrationRows);
    const holdoutSelected = tuned.ready ? ruleSelect(holdoutRows, tuned.rule) : [];
    const holdout = strategySummary(holdoutSelected);
    const v2 = v2Result.statusCode === 200 ? v2Result.body : null;
    const probabilityPass = Boolean(v2?.validation?.probabilityPass);
    const holdoutPass = Boolean(
      tuned.ready
      && holdout.bets >= 20
      && holdout.slates >= 5
      && Number(holdout.roi) > 0
      && holdout.profitableSlates >= 3
    );
    const promoted = probabilityPass && holdoutPass;
    const currentCheckpoint = String(v2?.checkpoint || request.query?.checkpoint || '');
    const currentSelections = liveSelect(v2?.rows || [], currentCheckpoint, tuned.rule)
      .map((row) => ({ ...row, qualifies: promoted, researchOnly: !promoted }));

    const output = {
      schemaVersion: 1,
      kind: 'batter_two_plus_total_bases_v2_monetization',
      status: 'ready',
      generatedAt: new Date().toISOString(),
      date,
      checkpoint: currentCheckpoint || null,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      promoted,
      monetizationStatus: promoted ? 'PROMOTED' : tuned.ready ? 'CALIBRATION_READY' : 'NO_STABLE_RULE',
      methodology: {
        probability: 'Execution probability shrinks the v2 context adjustment toward the separately calibrated form baseline. The shrink weight is selected only inside the Aug 2-16 calibration block.',
        tuning: `Candidate rules are evaluated only before ${HOLDOUT_START}. Aug 2-8 and Aug 9-16 must both be profitable with minimum sample, multiple profitable slates, and no single-day profit concentration above 60%.`,
        execution: 'Rules use one checkpoint, a conservative probability edge threshold, an optional long-odds cap, and a top-N per-slate cap ranked by conservative EV. Book identity is not a selection feature; the best archived O1.5 price is used.',
        holdout: `The selected calibration rule is frozen, then evaluated once from ${HOLDOUT_START} onward. Holdout results are not used to choose among candidates.`,
      },
      split: { archiveStart: ARCHIVE_START, internalSplit: INTERNAL_SPLIT, holdoutStart: HOLDOUT_START, through },
      rule: tuned.rule ? {
        ...tuned.rule,
        label: ruleLabel(tuned.rule),
        contextWeight: tuned.rule.alpha,
        formWeight: Number((1 - tuned.rule.alpha).toFixed(2)),
      } : null,
      calibration: {
        early: tuned.early,
        late: tuned.late,
        full: tuned.full,
        candidatesTested: tuned.candidatesTested,
        passingCandidates: tuned.passingCandidates,
        score: tuned.score,
      },
      holdout,
      gates: {
        probabilityPass,
        holdoutPass,
        promotionRequires: 'v2 probability gate + positive frozen holdout ROI with >=20 bets, >=5 slates, and >=3 profitable slates',
      },
      dataQuality: {
        archiveRows: evaluation.length,
        calibrationRows: calibrationRows.length,
        holdoutRows: holdoutRows.length,
        currentV2Rows: v2?.rows?.length || 0,
      },
      rows: currentSelections,
    };

    try { await redisCommand(['SET', cacheKey, JSON.stringify(output), 'EX', CACHE_TTL_SECONDS]); } catch (_) {}
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).json(output);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    return response.status(500).json({
      status: 'error',
      date,
      providerRequests: 0,
      quotaObjectsAdded: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
