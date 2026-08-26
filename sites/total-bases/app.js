const FORM_API = 'https://hr-form-board-actions.vercel.app/api/total-bases-form';
const DISCOVERY_API = 'https://hr-form-board-actions.vercel.app/api/total-bases-discovery';
const MODEL_API = 'https://hr-form-board-actions.vercel.app/api/total-bases-model';
const $ = (id) => document.getElementById(id);
const content = $('content');
const status = $('status');
const summary = $('summary');
const toolbar = $('toolbar');
const dateInput = $('slate-date');
const checkpoint = $('checkpoint');
let activeView = 'form';

function etToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function pct(value, digits = 0) { return value == null ? '—' : `${(Number(value) * 100).toFixed(digits)}%`; }
function american(value) { const n = Number(value); return Number.isFinite(n) ? (n > 0 ? `+${n}` : String(n)) : '—'; }
function units(value) { const n = Number(value); return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(1)}u` : '—'; }
function decimal(value, digits = 4) { const n = Number(value); return Number.isFinite(n) ? n.toFixed(digits) : '—'; }
function book(bookName) { return ({draftkings:'DK',fanduel:'FD',betmgm:'MGM'})[bookName] || String(bookName || '').toUpperCase(); }
function cpLabel(value) { return value ? `${value.slice(0,2)}:${value.slice(2)}` : '—'; }
function humanDate(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(Date.UTC(year, month - 1, day)));
}
function displayRule(value) {
  return String(value || '')
    .replaceAll('draftkings', 'DK')
    .replaceAll('fanduel', 'FD')
    .replaceAll('betmgm', 'MGM');
}

function metrics(items) {
  summary.innerHTML = items.map(([label, value]) => `<div class="metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join('');
  summary.hidden = false;
}

function params() {
  const p = new URLSearchParams({ date: dateInput.value || etToday() });
  if (checkpoint.value) p.set('checkpoint', checkpoint.value);
  return p;
}

function renderForm(data) {
  status.hidden = true;
  const top = data.rows?.[0];
  metrics([
    ['Ranked batters', data.rows?.length || 0],
    ['Checkpoint', cpLabel(data.checkpoint)],
    ['Top form score', top ? top.form.formScore.toFixed(1) : '—'],
    ['Extra odds calls', data.providerRequests ?? 0],
  ]);
  if (!data.rows?.length) {
    content.innerHTML = '<section class="empty"><h2>No ranked O1.5 props yet</h2><p>The checkpoint may not contain 2+ total-bases prices or MLB history is unavailable.</p></section>';
    return;
  }

  const body = data.rows.map((row, i) => {
    const prices = (row.quotes || []).filter((q) => q.side === 'over').sort((a,b) => Number(b.americanOdds)-Number(a.americanOdds));
    const priceHtml = prices.map((q) => `<span class="quote"><b>${esc(book(q.book))}</b> O1.5 ${esc(american(q.americanOdds))}</span>`).join('');
    const recent = (row.form.recentTb || []).map((tb) => `<span class="chip ${tb >= 2 ? 'hit' : ''}">${esc(tb)}</span>`).join('');
    return `<tr>
      <td class="rank">${i + 1}</td>
      <td class="player"><strong>${esc(row.batterName)}</strong><small>${esc([row.batterTeam,row.matchup].filter(Boolean).join(' · '))}</small></td>
      <td><span class="score">${row.form.formScore.toFixed(1)}</span><small>${row.form.gamesAvailable} starts</small></td>
      <td>${pct(row.form.l5.hitRate)}<small>${row.form.l5.hits2Plus}/${row.form.l5.games}</small></td>
      <td>${pct(row.form.l10.hitRate)}<small>${row.form.l10.hits2Plus}/${row.form.l10.games}</small></td>
      <td>${pct(row.form.l15.hitRate)}<small>${row.form.l15.hits2Plus}/${row.form.l15.games}</small></td>
      <td><strong>${row.form.weightedAvgTb}</strong><small>XBH ${pct(row.form.l15.xbhRate)}</small></td>
      <td><div class="chips">${recent}</div></td>
      <td><strong class="best">${american(row.bestOver?.americanOdds)}</strong><small>${esc(book(row.bestOver?.book))} · O1.5</small></td>
      <td><div class="prices">${priceHtml}</div></td>
    </tr>`;
  }).join('');

  content.innerHTML = `<section class="table-card"><div class="table-scroll"><table>
    <thead><tr><th>#</th><th>Batter</th><th>Form</th><th>L5 2+</th><th>L10 2+</th><th>L15 2+</th><th>TB form</th><th>Recent TB</th><th>Best O1.5</th><th>Books</th></tr></thead>
    <tbody>${body}</tbody></table></div></section>
    <section class="note"><strong>Form score</strong> = 50% L5 + 30% L10 + 20% L15 empirical-Bayes 2+ TB hit rate. Price is excluded from the score; only actual Over 1.5 total-bases quotes are treated as 2+ TB.</section>`;
}

function confidenceBadge(value) {
  const label = value === 'validated' ? 'Validated' : value === 'promising' ? 'Promising' : 'Exploratory';
  return `<span class="confidence ${esc(value)}">${label}</span>`;
}

function breakdownTable(title, rows) {
  const usable = (rows || []).filter((row) => row.bets >= 10).slice(0, 8);
  if (!usable.length) return '';
  return `<section class="breakdown-card"><h3>${esc(title)}</h3><div class="table-scroll compact-table"><table>
    <thead><tr><th>Segment</th><th>N</th><th>Hit</th><th>BE</th><th>ROI</th><th>Net</th></tr></thead>
    <tbody>${usable.map((row) => `<tr>
      <td><strong>${esc(displayRule(row.label))}</strong></td>
      <td>${row.bets}<small>${row.slates} slates</small></td>
      <td>${pct(row.hitRate, 1)}</td>
      <td>${pct(row.averageBreakEven, 1)}</td>
      <td class="${Number(row.roi) > 0 ? 'positive' : Number(row.roi) < 0 ? 'negative' : ''}">${pct(row.roi, 1)}</td>
      <td>${units(row.netUnits)}</td>
    </tr>`).join('')}</tbody>
  </table></div></section>`;
}

function renderDiscovery(data) {
  status.hidden = true;
  const counts = data.validationCounts || {};
  const coverage = data.coverage || {};
  metrics([
    ['Settled snapshots', coverage.settledBestPriceObservations || 0],
    ['Settled slates', coverage.settledDates || 0],
    ['Validated edges', counts.validated || 0],
    ['Promising edges', counts.promising || 0],
  ]);

  const edges = data.edges || [];
  const edgeRows = edges.length ? `<section class="table-card edge-table"><div class="table-scroll"><table>
    <thead><tr><th>Confidence</th><th>Rule</th><th>Execution</th><th>Sample</th><th>Hit vs BE</th><th>Full ROI</th><th>Train ROI</th><th>Holdout ROI</th><th>Net</th></tr></thead>
    <tbody>${edges.map((edge) => `<tr>
      <td>${confidenceBadge(edge.confidence)}</td>
      <td class="edge-rule"><strong>${esc(displayRule(edge.rule))}</strong><small>${esc(edge.dimension)}</small></td>
      <td>${esc(edge.execution)}</td>
      <td><strong>${edge.total.bets}</strong><small>${edge.total.slates} slates</small></td>
      <td><strong>${pct(edge.total.hitRate, 1)}</strong><small>BE ${pct(edge.total.averageBreakEven, 1)} · edge ${pct(edge.total.empiricalProbabilityEdge, 1)}</small></td>
      <td class="${Number(edge.total.roi) > 0 ? 'positive' : 'negative'}"><strong>${pct(edge.total.roi, 1)}</strong></td>
      <td class="${Number(edge.train.roi) > 0 ? 'positive' : Number(edge.train.roi) < 0 ? 'negative' : ''}">${pct(edge.train.roi, 1)}<small>${edge.train.bets} bets</small></td>
      <td class="${Number(edge.holdout.roi) > 0 ? 'positive' : Number(edge.holdout.roi) < 0 ? 'negative' : ''}"><strong>${pct(edge.holdout.roi, 1)}</strong><small>${edge.holdout.bets} bets</small></td>
      <td>${units(edge.total.netUnits)}</td>
    </tr>`).join('')}</tbody>
  </table></div></section>` : `<section class="empty"><h2>No durable profitable segment yet</h2><p>Nothing currently clears the minimum sample plus positive holdout requirements. Discovery will keep updating as August settlements accumulate.</p></section>`;

  const breakdowns = data.breakdowns || {};
  content.innerHTML = `<section class="edge-hero">
    <div>
      <div class="eyebrow">MONTH-TO-DATE BACKTEST</div>
      <h2>Profitable edge discovery</h2>
      <p>Archived O1.5 Total Bases prices from ${esc(humanDate(data.start))} through ${esc(humanDate(data.through))}. The holdout begins ${esc(humanDate(data.holdoutStart))}; the form score for every historical bet only sees games before that slate.</p>
    </div>
    <div class="edge-meta">
      <span>${coverage.readyCaptures || 0}/${coverage.requestedCaptures || 0} checkpoints recovered</span>
      <span>${coverage.settledBookQuoteObservations || 0} exact-book observations</span>
      <span>${data.providerRequests ?? 0} extra odds calls</span>
    </div>
  </section>
  <section class="section-heading"><div><span>Edges</span><h2>Segments profitable in the holdout</h2></div><p>Validated is the strongest label. Promising requires positive training and holdout ROI with minimum sample. Exploratory passed the basic profitable holdout filter but remains thin.</p></section>
  ${edgeRows}
  <section class="section-heading secondary"><div><span>Diagnostics</span><h2>Where the returns came from</h2></div><p>These tables include all sufficiently populated segments, including losing ones, so the edge list is not viewed without context.</p></section>
  <div class="breakdown-grid">
    ${breakdownTable('Checkpoint', breakdowns.checkpoint)}
    ${breakdownTable('Checkpoint × best book', breakdowns.bestBook)}
    ${breakdownTable('Checkpoint × form', breakdowns.form)}
    ${breakdownTable('Checkpoint × odds', breakdowns.odds)}
  </div>
  <section class="note"><strong>Validation guardrails.</strong> ${esc(data.methodology?.validation || '')} ${esc(data.methodology?.settlement || '')} ${esc(data.methodology?.caution || '')}</section>`;
}

async function loadDiscovery() {
  status.hidden = false;
  status.textContent = 'Mining August archived prices and settled MLB results…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(DISCOVERY_API, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderDiscovery(data);
  } catch (error) {
    status.hidden = false;
    status.textContent = `Unable to load discovery: ${error.message || error}`;
  }
}

function featureName(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function renderModel(data) {
  status.hidden = true;
  const validation = data.validation || {};
  const model = validation.modelProbability || {};
  const form = validation.formBaseline || {};
  const strategy = validation.holdoutStrategy || {};
  const dq = data.dataQuality || {};
  metrics([
    ['Model status', data.modelStatus || 'UNPROMOTED'],
    ['Holdout Brier', decimal(model.brier, 5)],
    ['Form Brier', decimal(form.brier, 5)],
    ['Holdout strategy ROI', pct(strategy.roi, 1)],
  ]);

  const betterBrier = Number(model.brier) < Number(form.brier);
  const betterLogLoss = Number(model.logLoss) < Number(form.logLoss);
  const probabilityPass = betterBrier && betterLogLoss;
  const strategyPass = Boolean(validation.strategyReady && Number(strategy.roi) > 0);
  const coefficients = (data.fit?.coefficients || []).slice(0, 12);
  const liveRows = data.rows || [];

  const liveTable = liveRows.length ? `<section class="table-card model-table"><div class="table-scroll"><table>
    <thead><tr><th>#</th><th>Batter</th><th>Model P</th><th>Form P</th><th>Fair</th><th>Best O1.5</th><th>Edge</th><th>EV</th><th>Starter sample</th><th>Status</th></tr></thead>
    <tbody>${liveRows.map((row, i) => `<tr>
      <td class="rank">${i + 1}</td>
      <td class="player"><strong>${esc(row.batterName)}</strong><small>${esc(row.matchup || '')}</small></td>
      <td><strong>${pct(row.modelProbability, 1)}</strong></td>
      <td>${pct(row.formProbability, 1)}</td>
      <td>${american(row.fairAmerican)}</td>
      <td><strong>${american(row.bestOver?.americanOdds)}</strong><small>${esc(book(row.bestOver?.book))}</small></td>
      <td class="${Number(row.probabilityEdge) > 0 ? 'positive' : 'negative'}">${pct(row.probabilityEdge, 1)}</td>
      <td class="${Number(row.expectedValue) > 0 ? 'positive' : 'negative'}">${pct(row.expectedValue, 1)}</td>
      <td>${row.starterGames || 0}</td>
      <td><span class="confidence exploratory">Research only</span></td>
    </tr>`).join('')}</tbody>
  </table></div></section>` : `<section class="empty model-empty"><h2>Live model rows withheld</h2><p>${dq.withheldLiveRowsMissingStarter || 0} current projections were blocked because the live batter → team → opposing-starter join is not complete. The historical model validation below is still valid; no live bet is being promoted from fallback starter inputs.</p></section>`;

  content.innerHTML = `<section class="model-hero ${data.promoted ? 'model-pass' : 'model-hold'}">
    <div>
      <div class="eyebrow">MARKET-INDEPENDENT MODEL V1</div>
      <h2>${data.promoted ? 'Promoted model' : 'Research model · not promoted'}</h2>
      <p>${probabilityPass ? 'The baseball-only model beats the calibrated form baseline on both holdout scoring metrics.' : 'The model has not beaten the form baseline on both holdout scoring metrics.'} ${strategyPass ? 'Its separately tuned betting rule is also profitable in holdout.' : 'The betting layer fails validation, so model EV is not actionable yet.'}</p>
    </div>
    <div class="edge-meta">
      <span>${dq.baseRows || 0} pre-August fit rows</span>
      <span>${model.n || 0} untouched holdout outcomes</span>
      <span>${data.providerRequests ?? 0} extra odds calls</span>
    </div>
  </section>

  <section class="section-heading"><div><span>Probability validation</span><h2>Does context beat form?</h2></div><p>Lower Brier and log loss are better. Sportsbook price is excluded from both probability models.</p></section>
  <div class="model-compare-grid">
    <article class="model-stat ${betterBrier ? 'pass' : 'fail'}"><span>Brier score</span><strong>${decimal(model.brier, 5)}</strong><small>Form ${decimal(form.brier, 5)} · improvement ${decimal(validation.improvement?.brier, 5)}</small></article>
    <article class="model-stat ${betterLogLoss ? 'pass' : 'fail'}"><span>Log loss</span><strong>${decimal(model.logLoss, 5)}</strong><small>Form ${decimal(form.logLoss, 5)} · improvement ${decimal(validation.improvement?.logLoss, 5)}</small></article>
    <article class="model-stat"><span>Holdout hit rate</span><strong>${pct(model.hitRate, 1)}</strong><small>Average model P ${pct(model.averageProbability, 1)}</small></article>
    <article class="model-stat fail"><span>Betting holdout</span><strong>${pct(strategy.roi, 1)}</strong><small>${strategy.bets || 0} bets · ${units(strategy.netUnits)}</small></article>
  </div>

  <section class="model-warning"><strong>Why it is unpromoted:</strong> the probability model improved discrimination/calibration versus form, but the early-August EV threshold was not profitable and the same research threshold returned ${pct(strategy.roi, 1)} in the ${esc(humanDate(data.split?.holdoutStart))}–${esc(humanDate(data.split?.through))} holdout. Positive-looking model edges are therefore not treated as bets.</section>

  <section class="section-heading secondary"><div><span>Current slate</span><h2>Research projections</h2></div><p>Rows are shown only when an opposing probable starter is matched with usable prior history. No row is labeled actionable while the model is unpromoted.</p></section>
  ${liveTable}

  <section class="section-heading secondary"><div><span>What the model learned</span><h2>Largest standardized coefficients</h2></div><p>Magnitude is conditional on the other features and should not be read as causal importance.</p></section>
  <div class="coefficient-grid">${coefficients.map((row) => `<article><span>${esc(featureName(row.name))}</span><strong class="${Number(row.standardizedCoefficient) >= 0 ? 'positive' : 'negative'}">${Number(row.standardizedCoefficient) > 0 ? '+' : ''}${Number(row.standardizedCoefficient).toFixed(3)}</strong></article>`).join('')}</div>

  <section class="note"><strong>Model design.</strong> ${esc(data.methodology?.marketIndependent || '')} ${esc(data.methodology?.context || '')} ${esc(data.methodology?.validation || '')} ${esc(data.methodology?.liveGuard || '')}</section>`;
}

async function loadModel() {
  status.hidden = false;
  status.textContent = 'Fitting and validating the market-independent 2+ TB model…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`${MODEL_API}?${params()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderModel(data);
  } catch (error) {
    status.hidden = false;
    status.textContent = `Unable to load model: ${error.message || error}`;
  }
}

async function loadForm() {
  status.hidden = false;
  status.textContent = 'Loading form and archived O1.5 prices…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`${FORM_API}?${params()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderForm(data);
  } catch (error) {
    status.hidden = false;
    status.textContent = `Unable to load board: ${error.message || error}`;
  }
}

function render() {
  toolbar.hidden = activeView === 'discovery';
  summary.hidden = true;
  if (activeView === 'form') return loadForm();
  if (activeView === 'discovery') return loadDiscovery();
  return loadModel();
}

dateInput.value = etToday();
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  activeView = tab.dataset.view;
  document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('active', node === tab));
  render();
}));
$('refresh').addEventListener('click', render);
dateInput.addEventListener('change', render);
checkpoint.addEventListener('change', render);
render();
