function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function decimalOdds(odds) {
  const american = Number(odds);
  if (!Number.isFinite(american) || american === 0) return null;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
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

function anchoredProbability(marketProbability, structuralProbability, beta) {
  if (!Number.isFinite(Number(marketProbability))) return null;
  if (!Number.isFinite(Number(structuralProbability))) return clampProbability(marketProbability);
  const weight = clamp(Number(beta) || 0, 0, 1);
  const marketLogit = logit(marketProbability);
  const structuralLogit = logit(structuralProbability);
  return clampProbability(sigmoid(marketLogit + weight * (structuralLogit - marketLogit)));
}

function brier(rows, probabilityFn) {
  const usable = rows.filter((row) => ['WIN', 'LOSS'].includes(row.result));
  if (!usable.length) return null;
  let total = 0;
  let n = 0;
  for (const row of usable) {
    const probability = probabilityFn(row);
    if (!Number.isFinite(Number(probability))) continue;
    const y = row.result === 'WIN' ? 1 : 0;
    total += (Number(probability) - y) ** 2;
    n += 1;
  }
  return n ? total / n : null;
}

function logLoss(rows, probabilityFn) {
  const usable = rows.filter((row) => ['WIN', 'LOSS'].includes(row.result));
  if (!usable.length) return null;
  let total = 0;
  let n = 0;
  for (const row of usable) {
    const probability = probabilityFn(row);
    if (!Number.isFinite(Number(probability))) continue;
    const p = clampProbability(probability);
    const y = row.result === 'WIN' ? 1 : 0;
    total += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    n += 1;
  }
  return n ? total / n : null;
}

function fitBeta(rows, options = {}) {
  const minRows = Number(options.minRows ?? 120);
  const minDates = Number(options.minDates ?? 5);
  const ridge = Number(options.ridge ?? 0.0005);
  const usable = rows.filter((row) =>
    ['WIN', 'LOSS'].includes(row.result)
    && Number.isFinite(Number(row.marketProbability))
    && Number.isFinite(Number(row.modelProbability))
  );
  const dates = new Set(usable.map((row) => row.date));
  const marketBrier = brier(usable, (row) => row.marketProbability);
  const structuralBrier = brier(usable, (row) => row.modelProbability);
  if (usable.length < minRows || dates.size < minDates) {
    return {
      ready: false,
      beta: 0,
      n: usable.length,
      dates: dates.size,
      marketBrier,
      structuralBrier,
      anchoredBrier: marketBrier,
      objective: marketBrier,
    };
  }

  let best = { beta: 0, objective: Number.POSITIVE_INFINITY, anchoredBrier: marketBrier };
  for (let step = 0; step <= 40; step += 1) {
    const beta = step / 40;
    const anchoredBrier = brier(usable, (row) => anchoredProbability(row.marketProbability, row.modelProbability, beta));
    if (!Number.isFinite(anchoredBrier)) continue;
    const objective = anchoredBrier + ridge * beta * beta;
    if (objective < best.objective - 1e-12 || (Math.abs(objective - best.objective) <= 1e-12 && beta < best.beta)) {
      best = { beta, objective, anchoredBrier };
    }
  }

  return {
    ready: true,
    beta: Number(best.beta.toFixed(3)),
    n: usable.length,
    dates: dates.size,
    marketBrier,
    structuralBrier,
    anchoredBrier: best.anchoredBrier,
    objective: best.objective,
  };
}

function walkForwardCalibration(rows, options = {}) {
  const dates = [...new Set(rows.map((row) => row.date).filter(Boolean))].sort();
  const evaluated = [];
  const dailyFits = [];
  for (const date of dates) {
    const training = rows.filter((row) => row.date < date);
    const fit = fitBeta(training, options);
    const testRows = rows.filter((row) => row.date === date && ['WIN', 'LOSS'].includes(row.result));
    dailyFits.push({ date, ...fit, testRows: testRows.length });
    if (!fit.ready) continue;
    for (const row of testRows) {
      evaluated.push({
        ...row,
        v2Beta: fit.beta,
        v2Probability: anchoredProbability(row.marketProbability, row.modelProbability, fit.beta),
      });
    }
  }

  const marketBrier = brier(evaluated, (row) => row.marketProbability);
  const structuralBrier = brier(evaluated, (row) => row.modelProbability);
  const anchoredBrier = brier(evaluated, (row) => row.v2Probability);
  const marketLogLoss = logLoss(evaluated, (row) => row.marketProbability);
  const structuralLogLoss = logLoss(evaluated, (row) => row.modelProbability);
  const anchoredLogLoss = logLoss(evaluated, (row) => row.v2Probability);
  const finalFit = fitBeta(rows, options);

  return {
    n: evaluated.length,
    dates: new Set(evaluated.map((row) => row.date)).size,
    firstEvaluatedDate: evaluated.length ? evaluated.map((row) => row.date).sort()[0] : null,
    marketBrier,
    structuralBrier,
    anchoredBrier,
    marketLogLoss,
    structuralLogLoss,
    anchoredLogLoss,
    finalFit,
    dailyFits,
    evaluated,
  };
}

function evFromDecisiveProbability(probability, pushProbability, odds) {
  const decimal = decimalOdds(odds);
  if (!Number.isFinite(decimal)) return null;
  const push = clamp(Number(pushProbability) || 0, 0, 0.95);
  const decisiveMass = 1 - push;
  const p = clampProbability(probability);
  const win = decisiveMass * p;
  const loss = decisiveMass * (1 - p);
  return win * (decimal - 1) - loss;
}

function repriceCandidate(candidate, beta) {
  if (!candidate || candidate.marketMethod !== 'two-way de-vig') return null;
  const probability = anchoredProbability(candidate.marketProbability, candidate.modelProbability, beta);
  if (!Number.isFinite(probability)) return null;
  const expectedValue = evFromDecisiveProbability(probability, candidate.pushProbability, candidate.odds);
  return {
    ...candidate,
    v2Beta: beta,
    v2Probability: probability,
    v2ProbabilityEdge: probability - Number(candidate.marketProbability),
    v2ExpectedValue: expectedValue,
  };
}

module.exports = {
  anchoredProbability,
  brier,
  clampProbability,
  evFromDecisiveProbability,
  fitBeta,
  logLoss,
  repriceCandidate,
  walkForwardCalibration,
};
