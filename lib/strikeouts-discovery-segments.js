function mean(values) {
  const rows = values.filter((value) => value != null && value !== '').map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function decimalOdds(americanOdds) {
  const odds = Number(americanOdds);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 1 + (odds / 100) : 1 + (100 / Math.abs(odds));
}

function americanFromDecimal(decimal) {
  const odds = Number(decimal);
  if (!Number.isFinite(odds) || odds <= 1) return null;
  return odds >= 2 ? Math.round((odds - 1) * 100) : Math.round(-100 / (odds - 1));
}

function oddsBand(value) {
  const odds = Number(value);
  if (odds <= -150) return '≤ -150';
  if (odds <= -120) return '-149 to -120';
  if (odds <= 100) return '-119 to +100';
  if (odds <= 130) return '+101 to +130';
  return '+131 or longer';
}

function formBand(value) {
  const score = Number(value);
  if (score >= 75) return '75+';
  if (score >= 60) return '60–74.9';
  if (score >= 45) return '45–59.9';
  return 'Below 45';
}

function residualEdgeBand(value) {
  const edge = Number(value);
  if (edge >= 0.10) return '10.00+ pts';
  if (edge >= 0.075) return '7.50–9.99 pts';
  if (edge >= 0.05) return '5.00–7.49 pts';
  if (edge >= 0.025) return '2.50–4.99 pts';
  return '1.25–2.49 pts';
}

function expectedValueBand(value) {
  const expectedValue = Number(value);
  if (expectedValue >= 0.20) return '20.0%+';
  if (expectedValue >= 0.10) return '10.0–19.9%';
  if (expectedValue >= 0.05) return '5.0–9.9%';
  if (expectedValue >= 0.03) return '3.0–4.9%';
  return '1.5–2.9%';
}

function sampleStartsBand(value) {
  const starts = Number(value);
  if (starts >= 20) return '20+ starts';
  if (starts >= 12) return '12–19 starts';
  return '8–11 starts';
}

function marketMovementBand(row) {
  if (!Number(row?.hasPrior)) return 'First snapshot';
  const lineMove = Number(row?.lineMove || 0);
  if (lineMove > 0) return 'K line moved up';
  if (lineMove < 0) return 'K line moved down';
  const probabilityMove = Number(row?.probMoveSameLine || 0);
  if (probabilityMove >= 0.005) return 'Same line · over price strengthened';
  if (probabilityMove <= -0.005) return 'Same line · under price strengthened';
  return 'Same line · price stable';
}

function lineLabel(value) {
  return `${Number(value)} Ks`;
}

function sideLabel(value) {
  return String(value).toLowerCase() === 'under' ? 'Under' : 'Over';
}

function segmentSummary(rows) {
  const resolved = (rows || []).filter((row) => ['WIN', 'LOSS', 'PUSH'].includes(row.result));
  const decisive = resolved.filter((row) => row.result !== 'PUSH');
  const wins = decisive.filter((row) => row.result === 'WIN').length;
  const losses = decisive.length - wins;
  const pushes = resolved.length - decisive.length;
  const netUnits = resolved.reduce((sum, row) => sum + Number(row.profitUnits || 0), 0);
  const slates = new Set(resolved.map((row) => row.date).filter(Boolean)).size;
  const hitRate = decisive.length ? wins / decisive.length : null;
  const averageV3Probability = mean(decisive.map((row) => row.v3Probability));
  const averageExpectedValue = mean(resolved.map((row) => row.v3ExpectedValue));
  const averageDecimal = mean(resolved.map((row) => decimalOdds(row.odds)));
  const roi = resolved.length ? netUnits / resolved.length : null;
  return {
    bets: resolved.length,
    decisive: decisive.length,
    slates,
    wins,
    losses,
    pushes,
    hitRate,
    netUnits: Number(netUnits.toFixed(3)),
    roi: roi == null ? null : Number(roi.toFixed(4)),
    averageOdds: mean(resolved.map((row) => row.odds)),
    averageLine: mean(resolved.map((row) => row.line)),
    averageFormScore: mean(resolved.map((row) => row.formScore)),
    averageBeta: null,
    averageEdge: mean(resolved.map((row) => row.v3ProbabilityEdge)),
    averagePrice: americanFromDecimal(averageDecimal),
    averageMarketProbability: mean(decisive.map((row) => row.marketProbability)),
    averageV3Probability,
    calibrationGap: hitRate == null || averageV3Probability == null
      ? null
      : Number((hitRate - averageV3Probability).toFixed(4)),
    averageExpectedValue,
    roiVsExpected: roi == null || averageExpectedValue == null
      ? null
      : Number((roi - averageExpectedValue).toFixed(4)),
    sampleTier: resolved.length >= 100 && slates >= 10
      ? 'larger'
      : resolved.length >= 40 && slates >= 7
        ? 'developing'
        : 'small',
  };
}

function grouped(rows, keyFn, order = null) {
  const buckets = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const labels = order || [...buckets.keys()].sort();
  return labels
    .filter((label) => buckets.has(label))
    .map((label) => ({ label, ...segmentSummary(buckets.get(label)) }));
}

function buildV3Segments(rows) {
  const values = rows || [];
  const oddsOrder = ['≤ -150', '-149 to -120', '-119 to +100', '+101 to +130', '+131 or longer'];
  const formOrder = ['75+', '60–74.9', '45–59.9', 'Below 45'];
  const edgeOrder = ['10.00+ pts', '7.50–9.99 pts', '5.00–7.49 pts', '2.50–4.99 pts', '1.25–2.49 pts'];
  const expectedValueOrder = ['20.0%+', '10.0–19.9%', '5.0–9.9%', '3.0–4.9%', '1.5–2.9%'];
  const sampleOrder = ['20+ starts', '12–19 starts', '8–11 starts'];
  const movementOrder = [
    'First snapshot',
    'K line moved up',
    'K line moved down',
    'Same line · over price strengthened',
    'Same line · under price strengthened',
    'Same line · price stable',
  ];
  const lineOrder = [...new Set(values.map((row) => Number(row.line)).filter(Number.isFinite))]
    .sort((a, b) => a - b)
    .map(lineLabel);
  const sides = ['Over', 'Under'];

  return {
    bySide: grouped(values, (row) => sideLabel(row.side), sides),
    byBook: grouped(values, (row) => row.book, ['fanduel', 'draftkings', 'betmgm']),
    byCheckpoint: grouped(values, (row) => row.checkpoint, ['0817', '1117', '1717']),
    byOdds: grouped(values, (row) => oddsBand(row.odds), oddsOrder),
    byFormScore: grouped(values, (row) => formBand(row.formScore), formOrder),
    byLine: grouped(values, (row) => lineLabel(row.line), lineOrder),
    byResidualEdge: grouped(values, (row) => residualEdgeBand(row.v3ProbabilityEdge), edgeOrder),
    byExpectedValue: grouped(values, (row) => expectedValueBand(row.v3ExpectedValue), expectedValueOrder),
    bySampleStarts: grouped(values, (row) => sampleStartsBand(row.sampleStarts), sampleOrder),
    byMarketMovement: grouped(values, marketMovementBand, movementOrder),
    bySideOdds: grouped(
      values,
      (row) => `${sideLabel(row.side)} · ${oddsBand(row.odds)}`,
      sides.flatMap((side) => oddsOrder.map((band) => `${side} · ${band}`)),
    ),
    bySideForm: grouped(
      values,
      (row) => `${sideLabel(row.side)} · ${formBand(row.formScore)}`,
      sides.flatMap((side) => formOrder.map((band) => `${side} · ${band}`)),
    ),
    bySideLine: grouped(
      values,
      (row) => `${sideLabel(row.side)} · ${lineLabel(row.line)}`,
      sides.flatMap((side) => lineOrder.map((line) => `${side} · ${line}`)),
    ),
  };
}

module.exports = {
  buildV3Segments,
  expectedValueBand,
  formBand,
  marketMovementBand,
  oddsBand,
  residualEdgeBand,
  sampleStartsBand,
  segmentSummary,
};
