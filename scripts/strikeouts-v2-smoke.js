const assert = require('node:assert/strict');
const {
  anchoredProbability,
  fitBeta,
  repriceCandidate,
  walkForwardCalibration,
} = require('../lib/strikeouts-market-anchor');

assert.equal(Number(anchoredProbability(0.6, 0.8, 0).toFixed(6)), 0.6);
assert.equal(Number(anchoredProbability(0.6, 0.8, 1).toFixed(6)), 0.8);

const rows = [];
for (let day = 1; day <= 8; day += 1) {
  const date = `2026-08-${String(day).padStart(2, '0')}`;
  for (let i = 0; i < 30; i += 1) {
    const market = i % 2 ? 0.6 : 0.4;
    const structural = i % 2 ? 0.8 : 0.2;
    const win = i % 2 === 1;
    rows.push({ date, result: win ? 'WIN' : 'LOSS', marketProbability: market, modelProbability: structural });
  }
}
const fit = fitBeta(rows, { minRows: 30, minDates: 2 });
assert.equal(fit.ready, true);
assert(fit.beta > 0);
const wf = walkForwardCalibration(rows, { minRows: 60, minDates: 2 });
assert(wf.n > 0);

const repriced = repriceCandidate({
  marketMethod: 'two-way de-vig', marketProbability: 0.5, modelProbability: 0.6,
  pushProbability: 0, odds: 110,
}, 0.5);
assert(repriced.v2Probability > 0.5 && repriced.v2Probability < 0.6);
assert(Number.isFinite(repriced.v2ExpectedValue));

console.log('strikeouts-v2-smoke ok');
