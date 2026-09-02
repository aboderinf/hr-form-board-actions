const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildV3Segments,
  expectedValueBand,
  formBand,
  marketMovementBand,
  oddsBand,
  residualEdgeBand,
  sampleStartsBand,
  segmentSummary,
} = require('../lib/strikeouts-discovery-segments');

test('uses stable v3 discovery bands at the strategy thresholds', () => {
  assert.equal(oddsBand(-150), '≤ -150');
  assert.equal(oddsBand(-120), '-149 to -120');
  assert.equal(oddsBand(100), '-119 to +100');
  assert.equal(oddsBand(101), '+101 to +130');
  assert.equal(formBand(75), '75+');
  assert.equal(formBand(60), '60–74.9');
  assert.equal(residualEdgeBand(0.0125), '1.25–2.49 pts');
  assert.equal(residualEdgeBand(0.025), '2.50–4.99 pts');
  assert.equal(expectedValueBand(0.015), '1.5–2.9%');
  assert.equal(expectedValueBand(0.05), '5.0–9.9%');
  assert.equal(sampleStartsBand(8), '8–11 starts');
  assert.equal(sampleStartsBand(20), '20+ starts');
});

test('summarizes realized v3 performance and calibration by segment', () => {
  const rows = [
    {
      date: '2026-08-20', result: 'WIN', profitUnits: 1, odds: 100, line: 5.5,
      formScore: 80, marketProbability: 0.48, v3Probability: 0.55,
      v3ProbabilityEdge: 0.07, v3ExpectedValue: 0.10, sampleStarts: 12,
    },
    {
      date: '2026-08-21', result: 'LOSS', profitUnits: -1, odds: 100, line: 5.5,
      formScore: 80, marketProbability: 0.48, v3Probability: 0.55,
      v3ProbabilityEdge: 0.07, v3ExpectedValue: 0.10, sampleStarts: 12,
    },
  ];
  const stats = segmentSummary(rows);
  assert.equal(stats.bets, 2);
  assert.equal(stats.slates, 2);
  assert.equal(stats.hitRate, 0.5);
  assert.equal(stats.roi, 0);
  assert.equal(stats.averageV3Probability, 0.55);
  assert.equal(stats.calibrationGap, -0.05);
  assert.equal(stats.averageExpectedValue, 0.10);
  assert.equal(stats.roiVsExpected, -0.10);
  assert.equal(stats.averagePrice, 100);
});

test('builds the requested odds, form, K-line, and interaction cuts', () => {
  const base = {
    date: '2026-08-20', checkpoint: '0817', pitcherName: 'Test Pitcher',
    book: 'draftkings', actualKs: 7, result: 'WIN', profitUnits: 1,
    marketProbability: 0.50, v3Probability: 0.56, v3ProbabilityEdge: 0.06,
    v3ExpectedValue: 0.08, sampleStarts: 14, hasPrior: 0,
  };
  const rows = [
    { ...base, side: 'over', odds: 100, line: 5.5, formScore: 80 },
    { ...base, side: 'under', odds: -125, line: 6.5, formScore: 40, result: 'LOSS', profitUnits: -1 },
  ];
  const segments = buildV3Segments(rows);
  assert.equal(segments.byOdds.length, 2);
  assert.deepEqual(segments.byLine.map((row) => row.label), ['5.5 Ks', '6.5 Ks']);
  assert.deepEqual(segments.bySideForm.map((row) => row.label), ['Over · 75+', 'Under · Below 45']);
  assert.deepEqual(segments.bySideLine.map((row) => row.label), ['Over · 5.5 Ks', 'Under · 6.5 Ks']);
  assert.equal(marketMovementBand(rows[0]), 'First snapshot');
});
