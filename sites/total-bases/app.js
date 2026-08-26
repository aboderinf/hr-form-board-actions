const FORM_API = 'https://hr-form-board-actions.vercel.app/api/total-bases-form';
const DISCOVERY_API = 'https://hr-form-board-actions.vercel.app/api/total-bases-discovery';
const MODEL_API = 'https://hr-form-board-actions.vercel.app/api/total-bases-model-v2';
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

function modelMetricCard(label, value, detail, state = '') {
  return `<article class="model-stat ${esc(state)}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
}

function renderModel(data) {
  status.hidden = true;
  if (data.modelStatus === 'TRAINING' || data.status === 'training') {
    summary.hidden = true;
    content.innerHTML = `<section class="model-hero model-hold"><div><div class="eyebrow">STATCAST MODEL V2</div><h2>Building frozen model artifacts</h2><p>${esc(data.message || 'The Statcast model artifacts are being generated and validated.')}</p></div><div class="edge-meta"><span>0 extra odds calls</span><span>Aug 17+ reserved holdout</span></div></section>`;
    return;
  }

  const validation = data.validation || {};
  const v2 = validation.v2 || {};
  const v1 = validation.v1 || {};
  const form = validation.form || {};
  const strategy = validation.holdoutStrategy || {};
  const calibration = validation.calibrationStrategy || {};
  const out2025 = validation.outOfTime2025 || {};
  const dq = data.dataQuality || {};
  const sameSplit = Boolean(validation.sameHoldoutAsV1);
  const probabilityPass = Boolean(validation.probabilityPass);
  const bettingPass = Boolean(validation.bettingPass);
  const strategyRule = validation.strategyRule || {};

  metrics([
    ['Model status', data.modelStatus || 'UNPROMOTED'],
    ['V2 holdout Brier', decimal(v2.brier, 5)],
    ['V1 holdout Brier', decimal(v1.brier, 5)],
    ['Holdout strategy ROI', pct(strategy.roi, 1)],
  ]);

  const liveRows = data.rows || [];
  const liveTable = liveRows.length ? `<section class="table-card model-table"><div class="table-scroll"><table>
    <thead><tr><th>#</th><th>Batter</th><th>V2 P</th><th>V1 P</th><th>Form P</th><th>Fair</th><th>Best O1.5</th><th>Edge</th><th>EV</th><th>Status</th></tr></thead>
    <tbody>${liveRows.map((row, i) => `<tr>
      <td class="rank">${i + 1}</td>
      <td class="player"><strong>${esc(row.batterName)}</strong><small>${esc(row.matchup || '')}</small></td>
      <td><strong>${pct(row.v2Probability ?? row.modelProbability, 1)}</strong></td>
      <td>${pct(row.v1Probability, 1)}</td>
      <td>${pct(row.formProbability, 1)}</td>
      <td>${american(row.fairAmerican)}</td>
      <td><strong>${american(row.bestOver?.americanOdds)}</strong><small>${esc(book(row.bestOver?.book))}</small></td>
      <td class="${Number(row.probabilityEdge) > 0 ? 'positive' : 'negative'}">${pct(row.probabilityEdge, 1)}</td>
      <td class="${Number(row.expectedValue) > 0 ? 'positive' : 'negative'}">${pct(row.expectedValue, 1)}</td>
      <td>${row.qualifies ? '<span class="confidence validated">Qualified</span>' : '<span class="confidence exploratory">Research only</span>'}</td>
    </tr>`).join('')}</tbody>
  </table></div></section>` : `<section class="empty model-empty"><h2>No v2 live rows yet</h2><p>The frozen Statcast state could not match a complete batter + opposing-starter context for this checkpoint.</p></section>`;

  const ruleText = strategyRule.ready === false || strategyRule.minProbabilityEdge == null
    ? 'No profitable calibration rule survived.'
    : `${strategyRule.checkpoint ? cpLabel(strategyRule.checkpoint) + ' · ' : ''}edge ≥ ${pct(strategyRule.minProbabilityEdge, 1)} · EV ≥ ${pct(strategyRule.minExpectedValue, 1)}`;

  content.innerHTML = `<section class="model-hero ${data.promoted ? 'model-pass' : 'model-hold'}">
    <div>
      <div class="eyebrow">STATCAST MODEL V2</div>
      <h2>${data.promoted ? 'V2 promoted' : 'V2 research model · not promoted'}</h2>
      <p>${probabilityPass ? 'V2 beats both v1 and form on the frozen untouched holdout.' : 'V2 has not cleared the probability gate against both v1 and form.'} ${bettingPass ? 'The frozen price rule also remains profitable in holdout.' : 'The executable betting gate has not passed.'}</p>
    </div>
    <div class="edge-meta">
      <span>${dq.observations || 0} Statcast game examples</span>
      <span>Holdout ${esc(humanDate(data.split?.holdoutStart))}–${esc(humanDate(data.split?.through))}</span>
      <span>${data.providerRequests ?? 0} extra odds calls</span>
    </div>
  </section>

  <section class="section-heading"><div><span>Probability gate</span><h2>V2 vs v1 vs form</h2></div><p>All three are evaluated from the same Aug. 17 holdout boundary. Lower Brier and log loss are better; sportsbook price is excluded from the probability fit.</p></section>
  <div class="model-compare-grid">
    ${modelMetricCard('V2 Brier', decimal(v2.brier, 5), `V1 ${decimal(v1.brier, 5)} · Form ${decimal(form.brier, 5)}`, probabilityPass ? 'pass' : 'fail')}
    ${modelMetricCard('V2 log loss', decimal(v2.log_loss, 5), `V1 ${decimal(v1.logLoss, 5)} · Form ${decimal(form.log_loss, 5)}`, probabilityPass ? 'pass' : 'fail')}
    ${modelMetricCard('2025 out-of-time Brier', decimal(out2025.brier, 5), `${out2025.rows || 0} game outcomes`, '')}
    ${modelMetricCard('Same holdout', sameSplit ? 'YES' : 'NO', `${humanDate(data.split?.holdoutStart)} start`, sameSplit ? 'pass' : 'fail')}
  </div>

  <section class="section-heading secondary"><div><span>Betting gate</span><h2>Frozen price rule</h2></div><p>The threshold is selected only on Aug. 2–16 archived prices, then frozen before Aug. 17+ outcomes are scored.</p></section>
  <div class="model-compare-grid">
    ${modelMetricCard('Calibration ROI', pct(calibration.roi, 1), `${calibration.bets || 0} bets · ${units(calibration.netUnits)}`, Number(calibration.roi) > 0 ? 'pass' : 'fail')}
    ${modelMetricCard('Holdout ROI', pct(strategy.roi, 1), `${strategy.bets || 0} bets · ${units(strategy.netUnits)}`, bettingPass ? 'pass' : 'fail')}
    ${modelMetricCard('Holdout hit rate', pct(strategy.hitRate, 1), `${strategy.wins || 0}-${strategy.losses || 0}`, bettingPass ? 'pass' : '')}
    ${modelMetricCard('Frozen rule', ruleText, `${strategy.slates || 0} holdout slates`, bettingPass ? 'pass' : 'fail')}
  </div>

  <section class="model-warning"><strong>Promotion requires both gates.</strong> V2 must beat v1 and form on both Brier and log loss on the untouched holdout, and a rule chosen only before the holdout must stay profitable with adequate sample. Until then, positive-looking live EV is research-only.</section>

  <section class="section-heading secondary"><div><span>Current slate</span><h2>V2 research projections</h2></div><p>V2 uses leakage-safe Savant contact-quality state, opponent starter context, opportunity, park/environment, and handedness. Price is applied only after probability estimation.</p></section>
  ${liveTable}

  <section class="section-heading secondary"><div><span>Feature architecture</span><h2>What changed beyond v1</h2></div><p>This is nonlinear gradient boosting, so individual coefficients are not presented as causal effects.</p></section>
  <div class="coefficient-grid">
    <article><span>Contact quality</span><strong>xBA · xSLG · EV · Hard-hit</strong></article>
    <article><span>Outcome shape</span><strong>1B · 2B · 3B · HR · TB/PA</strong></article>
    <article><span>Opportunity</span><strong>Lineup slot · PA/game · Rest</strong></article>
    <article><span>Starter matchup</span><strong>Contact · TB allowed · Hand</strong></article>
    <article><span>Opponent</span><strong>Hit/TB allowed profile</strong></article>
    <article><span>Park</span><strong>1B · 2B · HR factors · Dimensions</strong></article>
    <article><span>Environment</span><strong>Temp · Wind · Roof · Elevation</strong></article>
    <article><span>Validation</span><strong>2025 OOT + Aug. 17 holdout</strong></article>
  </div>

  <section class="note"><strong>Model design.</strong> ${esc(data.methodology?.probabilityFit || '')} ${esc(data.methodology?.features || '')} ${esc(data.methodology?.marketValidation || '')}</section>`;
}

async function loadModel() {
  status.hidden = false;
  status.textContent = 'Loading Statcast v2 and frozen holdout validation…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`${MODEL_API}?${params()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok && data.status !== 'training') throw new Error(data.message || `HTTP ${response.status}`);
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
