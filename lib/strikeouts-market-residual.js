const { evFromDecisiveProbability } = require('./strikeouts-market-anchor');

const FEATURE_NAMES = [
  'structuralGap',
  'expectedMargin',
  'formCentered',
  'opponentFactorDelta',
  'projectedBF',
  'pitcherKRate',
  'sampleDepth',
  'restDelta',
  'marketCentered',
  'checkpointProgress',
  'bookDraftKings',
  'bookBetMGM',
  'consensusGap',
  'consensusSpread',
  'lineGap',
  'lineSpan',
  'lineMove',
  'probMoveSameLine',
  'hasPrior',
  'priorSameLine',
];

const DEFAULT_CHECKPOINT_ORDER = ['0817', '1117', '1717', '2017'];
const DEFAULT_LAMBDAS = [10, 30, 100, 300];

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function clampProbability(value) {
  return clamp(Number(value), 0.001, 0.999);
}

function logit(probability) {
  const p = clampProbability(probability);
  return Math.log(p / (1 - p));
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function mean(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function median(values) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function checkpointProgress(checkpoint) {
  return ({ '0817': 0, '1117': 0.25, '1717': 0.75, '2017': 1 })[String(checkpoint)] ?? 0;
}

function decorateOverRows(rows, checkpointOrder = DEFAULT_CHECKPOINT_ORDER) {
  const output = (rows || []).map((row) => ({ ...row }));
  const checkpointIndex = new Map(checkpointOrder.map((value, index) => [value, index]));
  const slateGroups = new Map();
  for (const row of output) {
    const key = `${row.date}|${row.checkpoint}|${row.mlbamId}`;
    if (!slateGroups.has(key)) slateGroups.set(key, []);
    slateGroups.get(key).push(row);
  }

  for (const values of slateGroups.values()) {
    const lines = values.map((row) => Number(row.line)).filter(Number.isFinite);
    const medianLine = median(lines);
    const lineMin = lines.length ? Math.min(...lines) : null;
    const lineMax = lines.length ? Math.max(...lines) : null;
    const exactLineGroups = new Map();
    for (const row of values) {
      const key = String(Number(row.line));
      if (!exactLineGroups.has(key)) exactLineGroups.set(key, []);
      exactLineGroups.get(key).push(row);
    }
    for (const row of values) {
      const exact = exactLineGroups.get(String(Number(row.line))) || [];
      const probabilities = exact.map((item) => Number(item.marketProbability)).filter(Number.isFinite);
      const consensusProbability = mean(probabilities);
      const probabilityMin = probabilities.length ? Math.min(...probabilities) : null;
      const probabilityMax = probabilities.length ? Math.max(...probabilities) : null;
      row.consensusProbability = consensusProbability;
      row.consensusGap = consensusProbability == null ? 0 : Number(row.marketProbability) - consensusProbability;
      row.consensusSpread = probabilityMin == null || probabilityMax == null ? 0 : probabilityMax - probabilityMin;
      row.lineGap = medianLine == null ? 0 : Number(row.line) - medianLine;
      row.lineSpan = lineMin == null || lineMax == null ? 0 : lineMax - lineMin;
      row.booksAtExactLine = probabilities.length;
    }
  }

  const historyGroups = new Map();
  for (const row of output) {
    const key = `${row.date}|${row.mlbamId}|${row.book}`;
    if (!historyGroups.has(key)) historyGroups.set(key, []);
    historyGroups.get(key).push(row);
  }
  for (const values of historyGroups.values()) {
    values.sort((a, b) => {
      const ai = checkpointIndex.get(String(a.checkpoint)) ?? 999;
      const bi = checkpointIndex.get(String(b.checkpoint)) ?? 999;
      return ai - bi;
    });
    let previous = null;
    for (const row of values) {
      row.hasPrior = previous ? 1 : 0;
      row.priorLine = previous ? Number(previous.line) : null;
      row.priorMarketProbability = previous ? Number(previous.marketProbability) : null;
      row.priorSameLine = previous && Number(previous.line) === Number(row.line) ? 1 : 0;
      row.lineMove = previous ? Number(row.line) - Number(previous.line) : 0;
      row.probMoveSameLine = row.priorSameLine
        ? Number(row.marketProbability) - Number(previous.marketProbability)
        : 0;
      previous = row;
    }
  }
  return output;
}

function rawFeatureObject(row) {
  const market = clampProbability(row.marketProbability);
  const structural = Number.isFinite(Number(row.modelProbability))
    ? clampProbability(row.modelProbability)
    : market;
  const expectedKs = Number(row.expectedKs);
  const line = Number(row.line);
  const restDays = Number(row.restDays);
  return {
    structuralGap: clamp(logit(structural) - logit(market), -2.5, 2.5),
    expectedMargin: clamp((Number.isFinite(expectedKs) ? expectedKs : line) - line, -4, 4),
    formCentered: clamp((Number(row.formScore) || 50) / 100 - 0.5, -0.5, 0.5),
    opponentFactorDelta: clamp((Number(row.opponentFactor) || 1) - 1, -0.2, 0.2),
    projectedBF: clamp((Number(row.projectedBF) || 23) - 23, -8, 8),
    pitcherKRate: clamp((Number(row.pitcherKRate) || 0.225) - 0.225, -0.15, 0.2),
    sampleDepth: Math.log1p(clamp(Number(row.sampleStarts) || 0, 0, 30)),
    restDelta: clamp((Number.isFinite(restDays) ? restDays : 5) - 5, -2, 5),
    marketCentered: market - 0.5,
    checkpointProgress: checkpointProgress(row.checkpoint),
    bookDraftKings: row.book === 'draftkings' ? 1 : 0,
    bookBetMGM: row.book === 'betmgm' ? 1 : 0,
    consensusGap: clamp(Number(row.consensusGap) || 0, -0.2, 0.2),
    consensusSpread: clamp(Number(row.consensusSpread) || 0, 0, 0.3),
    lineGap: clamp(Number(row.lineGap) || 0, -2, 2),
    lineSpan: clamp(Number(row.lineSpan) || 0, 0, 3),
    lineMove: clamp(Number(row.lineMove) || 0, -2, 2),
    probMoveSameLine: clamp(Number(row.probMoveSameLine) || 0, -0.2, 0.2),
    hasPrior: Number(row.hasPrior) ? 1 : 0,
    priorSameLine: Number(row.priorSameLine) ? 1 : 0,
  };
}

function rawFeatureVector(row) {
  const object = rawFeatureObject(row);
  return FEATURE_NAMES.map((name) => Number(object[name]) || 0);
}

function dateCount(rows) {
  return new Set(rows.map((row) => row.date).filter(Boolean)).size;
}

function groupWeights(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = `${row.date}|${row.checkpoint}|${row.mlbamId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return rows.map((row) => {
    const key = `${row.date}|${row.checkpoint}|${row.mlbamId}`;
    return 1 / Math.max(1, counts.get(key) || 1);
  });
}

function buildStandardizer(rows) {
  const vectors = rows.map(rawFeatureVector);
  const means = FEATURE_NAMES.map((_, j) => mean(vectors.map((row) => row[j])) || 0);
  const scales = FEATURE_NAMES.map((_, j) => {
    const values = vectors.map((row) => row[j]);
    const center = means[j];
    const variance = values.length
      ? values.reduce((sum, value) => sum + ((value - center) ** 2), 0) / values.length
      : 0;
    const scale = Math.sqrt(variance);
    return scale > 1e-6 ? scale : 1;
  });
  return { means, scales };
}

function standardizeVector(row, fit) {
  const raw = rawFeatureVector(row);
  return raw.map((value, index) => (value - fit.means[index]) / fit.scales[index]);
}

function solveLinear(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null;
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      if (Math.abs(factor) < 1e-15) continue;
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function usableRows(rows) {
  return (rows || []).filter((row) =>
    ['WIN', 'LOSS'].includes(row.result)
    && Number.isFinite(Number(row.marketProbability))
  );
}

function fitOffsetLogistic(rows, lambda = 100, options = {}) {
  const usable = usableRows(rows);
  const minRows = Number(options.minRows ?? 50);
  if (usable.length < minRows) return { ready: false, n: usable.length, dates: dateCount(usable), lambda };
  const standardizer = buildStandardizer(usable);
  const fit = {
    ready: true,
    n: usable.length,
    dates: dateCount(usable),
    lambda: Number(lambda),
    featureNames: FEATURE_NAMES,
    means: standardizer.means,
    scales: standardizer.scales,
    intercept: 0,
    coefficients: new Array(FEATURE_NAMES.length).fill(0),
  };
  const weights = groupWeights(usable);
  const dimension = FEATURE_NAMES.length + 1;
  const maxIter = Number(options.maxIter ?? 30);
  let parameters = new Array(dimension).fill(0);

  for (let iter = 0; iter < maxIter; iter += 1) {
    const gradient = new Array(dimension).fill(0);
    const hessian = Array.from({ length: dimension }, () => new Array(dimension).fill(0));
    for (let i = 0; i < usable.length; i += 1) {
      const row = usable[i];
      const x = [1, ...standardizeVector(row, fit)];
      const offset = logit(row.marketProbability);
      const eta = offset + x.reduce((sum, value, j) => sum + value * parameters[j], 0);
      const probability = clampProbability(sigmoid(eta));
      const y = row.result === 'WIN' ? 1 : 0;
      const weight = weights[i];
      const residual = weight * (y - probability);
      const curvature = weight * probability * (1 - probability);
      for (let j = 0; j < dimension; j += 1) {
        gradient[j] += x[j] * residual;
        for (let k = 0; k <= j; k += 1) hessian[j][k] += x[j] * x[k] * curvature;
      }
    }
    for (let j = 0; j < dimension; j += 1) {
      const penalty = j === 0 ? Number(lambda) * 0.05 : Number(lambda);
      gradient[j] -= penalty * parameters[j];
      hessian[j][j] += penalty + 1e-6;
      for (let k = 0; k < j; k += 1) hessian[k][j] = hessian[j][k];
    }
    const delta = solveLinear(hessian, gradient);
    if (!delta) break;
    let maxDelta = 0;
    for (let j = 0; j < dimension; j += 1) {
      const step = clamp(delta[j], -1, 1);
      parameters[j] = clamp(parameters[j] + step, -4, 4);
      maxDelta = Math.max(maxDelta, Math.abs(step));
    }
    if (maxDelta < 1e-6) break;
  }

  fit.intercept = parameters[0];
  fit.coefficients = parameters.slice(1);
  return fit;
}

function predictResidualProbability(row, fit) {
  if (!fit?.ready || !Number.isFinite(Number(row?.marketProbability))) return null;
  const vector = standardizeVector(row, fit);
  let correction = Number(fit.intercept || 0);
  for (let i = 0; i < vector.length; i += 1) correction += vector[i] * Number(fit.coefficients?.[i] || 0);
  return clampProbability(sigmoid(logit(row.marketProbability) + correction));
}

function weightedMetric(rows, probabilityFn, type = 'brier') {
  const usable = usableRows(rows);
  if (!usable.length) return null;
  const weights = groupWeights(usable);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < usable.length; i += 1) {
    const row = usable[i];
    const probability = probabilityFn(row);
    if (!Number.isFinite(Number(probability))) continue;
    const p = clampProbability(probability);
    const y = row.result === 'WIN' ? 1 : 0;
    const loss = type === 'logloss'
      ? -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
      : (p - y) ** 2;
    numerator += weights[i] * loss;
    denominator += weights[i];
  }
  return denominator ? numerator / denominator : null;
}

function chooseLambda(rows, options = {}) {
  const usable = usableRows(rows);
  const lambdas = options.lambdas || DEFAULT_LAMBDAS;
  const dates = [...new Set(usable.map((row) => row.date))].sort();
  const defaultLambda = Number(options.defaultLambda ?? 100);
  if (dates.length < 7 || usable.length < 500) return { lambda: defaultLambda, validationRows: 0, validationDates: 0 };
  const validationDateCount = Math.min(3, Math.max(2, Math.floor(dates.length / 4)));
  const validationDates = dates.slice(-validationDateCount);
  const firstValidation = validationDates[0];
  const innerTrain = usable.filter((row) => row.date < firstValidation);
  const validation = usable.filter((row) => validationDates.includes(row.date));
  if (innerTrain.length < 300 || validation.length < 100) {
    return { lambda: defaultLambda, validationRows: validation.length, validationDates: validationDates.length };
  }
  let best = { lambda: defaultLambda, brier: Number.POSITIVE_INFINITY, logLoss: Number.POSITIVE_INFINITY };
  for (const lambda of lambdas) {
    const fit = fitOffsetLogistic(innerTrain, lambda, { minRows: 300 });
    if (!fit.ready) continue;
    const brier = weightedMetric(validation, (row) => predictResidualProbability(row, fit), 'brier');
    const logLoss = weightedMetric(validation, (row) => predictResidualProbability(row, fit), 'logloss');
    if (!Number.isFinite(brier)) continue;
    if (brier < best.brier - 1e-9 || (Math.abs(brier - best.brier) <= 1e-9 && logLoss < best.logLoss)) {
      best = { lambda: Number(lambda), brier, logLoss };
    }
  }
  return {
    lambda: best.lambda,
    validationRows: validation.length,
    validationDates: validationDates.length,
    validationBrier: Number.isFinite(best.brier) ? best.brier : null,
    validationLogLoss: Number.isFinite(best.logLoss) ? best.logLoss : null,
  };
}

function fitResidualModel(rows, options = {}) {
  const usable = usableRows(rows);
  const minRows = Number(options.minRows ?? 600);
  const minDates = Number(options.minDates ?? 5);
  if (usable.length < minRows || dateCount(usable) < minDates) {
    return { ready: false, n: usable.length, dates: dateCount(usable), lambda: Number(options.defaultLambda ?? 100) };
  }
  const selection = chooseLambda(usable, options);
  const fit = fitOffsetLogistic(usable, selection.lambda, { minRows });
  return { ...fit, lambdaSelection: selection };
}

function walkForwardResidual(rows, options = {}) {
  const usable = usableRows(rows);
  const dates = [...new Set(usable.map((row) => row.date))].sort();
  const evaluated = [];
  const dailyFits = [];
  for (const date of dates) {
    const training = usable.filter((row) => row.date < date);
    const fit = fitResidualModel(training, options);
    const test = usable.filter((row) => row.date === date);
    dailyFits.push({
      date,
      ready: Boolean(fit.ready),
      trainingRows: fit.n || training.length,
      trainingDates: fit.dates || dateCount(training),
      lambda: fit.lambda || null,
      testRows: test.length,
    });
    if (!fit.ready) continue;
    for (const row of test) {
      const probability = predictResidualProbability(row, fit);
      if (probability == null) continue;
      evaluated.push({ ...row, v3Probability: probability, v3Lambda: fit.lambda });
    }
  }
  const finalFit = fitResidualModel(usable, options);
  return {
    n: evaluated.length,
    dates: dateCount(evaluated),
    firstEvaluatedDate: evaluated.length ? [...new Set(evaluated.map((row) => row.date))].sort()[0] : null,
    marketBrier: weightedMetric(evaluated, (row) => row.marketProbability, 'brier'),
    structuralBrier: weightedMetric(evaluated, (row) => row.modelProbability, 'brier'),
    residualBrier: weightedMetric(evaluated, (row) => row.v3Probability, 'brier'),
    marketLogLoss: weightedMetric(evaluated, (row) => row.marketProbability, 'logloss'),
    structuralLogLoss: weightedMetric(evaluated, (row) => row.modelProbability, 'logloss'),
    residualLogLoss: weightedMetric(evaluated, (row) => row.v3Probability, 'logloss'),
    finalFit,
    dailyFits,
    evaluated,
  };
}

function candidateSidesFromOver(row, probability) {
  if (!Number.isFinite(Number(probability))) return [];
  const overProbability = clampProbability(probability);
  const underProbability = 1 - overProbability;
  const overMarket = clampProbability(row.marketProbability);
  const underMarket = 1 - overMarket;
  const output = [];
  if (Number.isFinite(Number(row.overOdds))) {
    output.push({
      ...row,
      side: 'over',
      odds: Number(row.overOdds),
      v3Probability: overProbability,
      v3ProbabilityEdge: overProbability - overMarket,
      v3ExpectedValue: evFromDecisiveProbability(overProbability, row.pushProbability, row.overOdds),
    });
  }
  if (Number.isFinite(Number(row.underOdds))) {
    output.push({
      ...row,
      side: 'under',
      odds: Number(row.underOdds),
      v3Probability: underProbability,
      v3ProbabilityEdge: underProbability - underMarket,
      v3ExpectedValue: evFromDecisiveProbability(underProbability, row.pushProbability, row.underOdds),
    });
  }
  return output;
}

function compactResidualFit(fit) {
  if (!fit) return null;
  return {
    ready: Boolean(fit.ready),
    n: Number(fit.n || 0),
    dates: Number(fit.dates || 0),
    lambda: fit.lambda == null ? null : Number(fit.lambda),
    featureNames: fit.featureNames || FEATURE_NAMES,
    means: (fit.means || []).map((value) => Number(Number(value).toFixed(6))),
    scales: (fit.scales || []).map((value) => Number(Number(value).toFixed(6))),
    intercept: fit.intercept == null ? null : Number(Number(fit.intercept).toFixed(6)),
    coefficients: (fit.coefficients || []).map((value) => Number(Number(value).toFixed(6))),
    lambdaSelection: fit.lambdaSelection ? {
      lambda: Number(fit.lambdaSelection.lambda),
      validationRows: Number(fit.lambdaSelection.validationRows || 0),
      validationDates: Number(fit.lambdaSelection.validationDates || 0),
      validationBrier: fit.lambdaSelection.validationBrier == null ? null : Number(Number(fit.lambdaSelection.validationBrier).toFixed(6)),
      validationLogLoss: fit.lambdaSelection.validationLogLoss == null ? null : Number(Number(fit.lambdaSelection.validationLogLoss).toFixed(6)),
    } : null,
  };
}

module.exports = {
  DEFAULT_CHECKPOINT_ORDER,
  FEATURE_NAMES,
  candidateSidesFromOver,
  compactResidualFit,
  decorateOverRows,
  fitResidualModel,
  predictResidualProbability,
  rawFeatureObject,
  walkForwardResidual,
  weightedMetric,
};
