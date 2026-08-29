const { redisCommand } = require('./checkpoint-runtime');
const readonlyHandler = require('./total-bases-v2-frozen-monetization-readonly');

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

async function readSnapshot(date) {
  try {
    const raw = await redisCommand(['GET', `mlbtb2:frozen-selections:${date}:0817`]);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
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

module.exports = async function totalBasesFrozenPublicHandler(request, response) {
  const captured = captureResponse();
  await readonlyHandler(request, captured.response);
  const result = captured.result();
  if (result.statusCode !== 200 || !result.body) {
    return response.status(result.statusCode || 500).json(result.body || { status: 'error', message: 'Frozen execution unavailable' });
  }

  const output = { ...result.body };
  const snapshot = await readSnapshot(output.date);
  output.rows = snapshotRows(snapshot);
  output.selectionSnapshot = snapshot ? {
    status: 'saved',
    selections: output.rows.length,
    capturedAt: snapshot.capturedAt || null,
    source: snapshot.source || null,
  } : {
    status: 'missing', selections: null, capturedAt: null, source: null,
  };
  output.executionDisplay = 'official_saved_0817_snapshot_only';
  output.methodology = {
    ...(output.methodology || {}),
    display: 'The execution list shown to users comes only from the immutable saved 8:17 AM snapshot. Later model recomputations cannot add, remove, or replace official selections.',
  };

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'HEAD') return response.status(200).end();
  return response.status(200).json(output);
};
