const totalBasesModelHandler = require('./total-bases-model-handler');

function captureResponse() {
  const headers = new Map();
  let statusCode = 200;
  let body = null;
  let ended = false;
  const response = {
    setHeader(name, value) { headers.set(String(name), value); return response; },
    status(code) { statusCode = Number(code) || 200; return response; },
    json(payload) { body = payload; return payload; },
    end() { ended = true; return undefined; },
  };
  return {
    response,
    result: () => ({ headers, statusCode, body, ended }),
  };
}

module.exports = async function totalBasesModelSafeHandler(request, response) {
  const captured = captureResponse();
  await totalBasesModelHandler(request, captured.response);
  const result = captured.result();

  for (const [name, value] of result.headers.entries()) response.setHeader(name, value);
  if (!result.body || typeof result.body !== 'object') {
    response.status(result.statusCode);
    return result.ended ? response.end() : response.json(result.body);
  }

  const output = result.body;
  if (String(output.kind || '').startsWith('batter_two_plus_total_bases_model_v1')) {
    const originalRows = Array.isArray(output.rows) ? output.rows : [];
    const completeRows = originalRows.filter((row) =>
      Number.isFinite(Number(row?.starterId)) && Number(row.starterId) > 0 && Number(row?.starterGames) > 0
    );
    const calibrationRoi = Number(output?.validation?.calibrationStrategy?.roi);
    const calibrationBets = Number(output?.validation?.calibrationStrategy?.bets || 0);
    const internalReady = output?.validation?.strategyRule?.ready !== false;
    const strategyReady = Boolean(internalReady && Number.isFinite(calibrationRoi) && calibrationRoi > 0 && calibrationBets >= 25);

    output.rows = completeRows.map((row) => ({
      ...row,
      qualifies: Boolean(output.promoted && strategyReady && row.qualifies),
      researchOnly: true,
    }));
    output.promoted = Boolean(output.promoted && strategyReady);
    output.modelStatus = output.promoted ? 'PROMOTED' : 'UNPROMOTED';
    output.status = output.rows.length ? 'ready' : 'validation_only';
    output.dataQuality = {
      ...(output.dataQuality || {}),
      liveRowsBeforeStarterGuard: originalRows.length,
      liveRowsWithMatchedStarter: completeRows.length,
      withheldLiveRowsMissingStarter: originalRows.length - completeRows.length,
    };
    output.validation = {
      ...(output.validation || {}),
      strategyReady,
      strategyRule: {
        ...(output?.validation?.strategyRule || {}),
        ready: strategyReady,
      },
    };
    output.methodology = {
      ...(output.methodology || {}),
      liveGuard: 'Live projections are withheld unless the batter is mapped to a current game and the opposing probable starter has prior-start history. An unprofitable calibration threshold cannot create promoted or qualifying bets.',
    };
  }

  response.status(result.statusCode);
  if (request.method === 'HEAD' || result.ended) return response.end();
  return response.json(output);
};
