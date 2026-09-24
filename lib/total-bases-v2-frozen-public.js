const { redisCommand } = require('./checkpoint-runtime');
const readonlyHandler = require('./total-bases-v2-frozen-monetization-readonly');
const totalBasesV2Handler = require('./total-bases-v2-handler');
const { resolveSelectionSnapshot } = require('./total-bases-v2-frozen-audited-snapshots');

const RECOVERY_CHECKPOINTS = ['1117', '1717', '2017'];
const RECOVERY_RULE = Object.freeze({ alpha: 0.75, minEdge: 0, topN: 3, maxOdds: 175 });

function captureResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    setHeader() { return response; },
    status(code) { statusCode = Number(code); return response; },
    json(payload) { body = payload; return payload; },
    end() { return undefined; },
  };
  return { response, result: () => ({ statusCode, body }) };
}

function etDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function readSnapshot(date) {
  return resolveSelectionSnapshot(date, async () => {
    const raw = await redisCommand(['GET', `mlbtb2:frozen-selections:${date}:0817`]);
    return raw ? JSON.parse(raw) : null;
  });
}

function snapshotRows(snapshot) {
  return (snapshot?.selections || []).map((pick) => ({
    batterId: Number(pick.batterId) || null,
    batterName: pick.batterName || '',
    matchup: pick.matchup || null,
    gameStartAt: pick.gameStartAt || null,
    bestOver: {
      book: pick.book || null,
      americanOdds: Number(pick.odds),
      line: 1.5,
    },
    monetizedProbability: Number(pick.executionProbability),
    monetizedEdge: Number(pick.edge),
    monetizedEv: Number(pick.ev),
    qualifies: true,
    researchOnly: false,
    officialSnapshot: true,
  }));
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

function recoverySelections(v2Rows) {
  return (v2Rows || []).map((row) => {
    const v2Probability = Number(row.v2Probability ?? row.modelProbability);
    const formProbability = Number(row.formProbability);
    const odds = Number(row.bestOver?.americanOdds);
    const implied = impliedProbability(odds);
    if (![v2Probability, formProbability, odds, implied].every(Number.isFinite)) return null;
    const monetizedProbability = clampProbability(
      formProbability + RECOVERY_RULE.alpha * (v2Probability - formProbability),
    );
    const monetizedEdge = monetizedProbability - implied;
    const monetizedEv = expectedValue(monetizedProbability, odds);
    return {
      ...row,
      monetizedProbability: Number(monetizedProbability.toFixed(4)),
      monetizedEdge: Number(monetizedEdge.toFixed(4)),
      monetizedEv: Number(monetizedEv.toFixed(4)),
      qualifies: true,
      researchOnly: false,
      officialSnapshot: false,
    };
  }).filter(Boolean)
    .filter((row) => Number(row.bestOver?.americanOdds) <= RECOVERY_RULE.maxOdds)
    .filter((row) => Number(row.monetizedEdge) >= RECOVERY_RULE.minEdge && Number(row.monetizedEv) > 0)
    .sort((a, b) => Number(b.monetizedEv) - Number(a.monetizedEv)
      || Number(b.monetizedEdge) - Number(a.monetizedEdge))
    .slice(0, RECOVERY_RULE.topN);
}

async function sameDayRecovery(request, date) {
  if (date !== etDate()) return null;
  for (const checkpoint of RECOVERY_CHECKPOINTS) {
    const captured = captureResponse();
    await totalBasesV2Handler({
      method: 'GET',
      headers: request.headers || {},
      query: { ...(request.query || {}), date, checkpoint },
    }, captured.response);
    const result = captured.result();
    if (result.statusCode !== 200 || !Array.isArray(result.body?.rows) || !result.body.rows.length) continue;
    return {
      checkpoint,
      generatedAt: result.body.generatedAt || null,
      rows: recoverySelections(result.body.rows).map((row) => ({ ...row, recoveryCheckpoint: checkpoint })),
    };
  }
  return null;
}

module.exports = async function totalBasesFrozenPublicHandler(request, response) {
  const captured = captureResponse();
  await readonlyHandler(request, captured.response);
  const result = captured.result();
  if (result.statusCode !== 200 || !result.body) {
    return response.status(result.statusCode || 500).json(result.body || { status: 'error', message: 'Frozen execution unavailable' });
  }

  const output = { ...result.body };
  const snapshot = await readSnapshot(output.date);

  if (snapshot) {
    output.rows = snapshotRows(snapshot);
    output.selectionSnapshot = {
      status: 'saved',
      selections: output.rows.length,
      capturedAt: snapshot.capturedAt || null,
      source: snapshot.source || null,
      auditStatus: snapshot.audit?.status || null,
    };
    output.executionDisplay = 'authoritative_0817_snapshot_only';
    output.methodology = {
      ...(output.methodology || {}),
      display: 'The execution list shown to users comes only from the authoritative 8:17 AM snapshot, including any versioned correction replayed from the exact archived checkpoint. Later model recomputations cannot alter official selections.',
    };
  } else {
    const recovery = await sameDayRecovery(request, output.date);
    output.rows = recovery?.rows || [];
    output.selectionSnapshot = {
      status: 'missing', selections: null, capturedAt: null, source: null, auditStatus: null,
    };
    output.recovery = recovery ? {
      status: 'live',
      checkpoint: recovery.checkpoint,
      generatedAt: recovery.generatedAt,
      selections: output.rows.length,
      ledgered: false,
      officialCheckpoint: '0817',
    } : {
      status: 'unavailable',
      checkpoint: null,
      generatedAt: null,
      selections: 0,
      ledgered: false,
      officialCheckpoint: '0817',
    };
    output.executionDisplay = recovery ? 'same_day_recovery_not_ledgered' : 'authoritative_0817_snapshot_missing';
    if (recovery) {
      output.monetizationStatus = `LIVE_RECOVERY_${recovery.checkpoint}_NOT_LEDGERED`;
    }
    output.methodology = {
      ...(output.methodology || {}),
      display: recovery
        ? `The official 8:17 AM snapshot is missing. Today's visible picks use the earliest later verified checkpoint (${recovery.checkpoint}) under the same frozen thresholds. These recovery picks are display-only and are never written to the official 8:17 ledger.`
        : 'The official 8:17 AM snapshot is missing and no later verified checkpoint is available for a same-day display recovery. No replacement is written to the official ledger.',
    };
  }

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'HEAD') return response.status(200).end();
  return response.status(200).json(output);
};
