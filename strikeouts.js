const $ = (id) => document.getElementById(id);
const content = $('content');
const status = $('status');
const summary = $('summary');
const toolbar = $('form-toolbar');
const dateInput = $('slate-date');
const checkpoint = $('checkpoint');
let activeView = 'form';

function etToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function american(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n > 0 ? `+${n}` : String(n);
}

function pct(value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function units(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}u`;
}

function signed(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

function bookLabel(book) {
  return ({draftkings:'DK',fanduel:'FD',betmgm:'MGM'})[book] || book;
}

function scoreClass(score) {
  if (score >= 75) return 'high';
  if (score >= 55) return 'mid';
  return '';
}

function valueClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n > 0 ? 'positive' : n < 0 ? 'negative' : '';
}

function renderMetrics(metrics) {
  summary.innerHTML = metrics.map(([label,value,klass='']) => `<div class="metric"><strong class="${klass}">${esc(value)}</strong><span>${esc(label)}</span></div>`).join('');
  summary.hidden = false;
}

function formParams() {
  const params = new URLSearchParams({ date: dateInput.value || etToday() });
  if (checkpoint.value) params.set('checkpoint', checkpoint.value);
  return params;
}

function renderForm(data) {
  const top = data.rows?.[0];
  renderMetrics([
    ['Ranked pitchers', data.rows?.length || 0],
    ['Checkpoint', data.checkpoint ? `${data.checkpoint.slice(0,2)}:${data.checkpoint.slice(2)}` : '—'],
    ['Top form score', top ? top.form.formScore.toFixed(1) : '—'],
    ['SportsGameOdds calls', data.providerRequests ?? 0],
  ]);
  status.hidden = true;
  if (!data.rows?.length) {
    content.innerHTML = '<div class="placeholder"><h2>No ranked strikeout props yet</h2><p>The archived checkpoint may not contain pitcher strikeout markets, or probable pitchers are not posted yet.</p></div>';
    return;
  }
  const rows = data.rows.map((row, i) => {
    const quotes = [...(row.quotes || [])].sort((a,b) => Number(a.line) - Number(b.line) || Number(b.americanOdds) - Number(a.americanOdds));
    const quoteHtml = quotes.map((q) => {
      const ref = Number(q.line) === Number(row.referenceLine) ? ' ref' : '';
      const best = row.bestAtReference && q.book === row.bestAtReference.book && Number(q.line) === Number(row.bestAtReference.line) && Number(q.americanOdds) === Number(row.bestAtReference.americanOdds);
      return `<span class="quote${ref}"><span class="book">${esc(bookLabel(q.book))}</span>O ${esc(q.line)} <span class="${best?'best':''}">${esc(american(q.americanOdds))}</span></span>`;
    }).join('');
    const recent = (row.form.recentKs || []).map((k) => `<span class="k-chip">${esc(k)}</span>`).join('');
    return `<tr>
      <td class="rank">${i+1}</td>
      <td class="pitcher"><strong>${esc(row.pitcherName)}</strong><small>${esc(row.team)} vs ${esc(row.opponent)}</small></td>
      <td><span class="score ${scoreClass(row.form.formScore)}">${row.form.formScore.toFixed(1)}</span></td>
      <td><strong>${esc(row.referenceLine)}</strong><div class="muted">weighted avg ${esc(row.form.weightedAvgKs)}</div></td>
      <td>${pct(row.form.l3.overRate)} <span class="muted">(${row.form.l3.overs}/${row.form.l3.games})</span></td>
      <td>${pct(row.form.l5.overRate)} <span class="muted">(${row.form.l5.overs}/${row.form.l5.games})</span></td>
      <td>${pct(row.form.l10.overRate)} <span class="muted">(${row.form.l10.overs}/${row.form.l10.games})</span></td>
      <td><div class="recent">${recent}</div></td>
      <td><div class="quote-stack">${quoteHtml}</div></td>
    </tr>`;
  }).join('');
  content.innerHTML = `<div class="table-card"><div class="table-scroll"><table>
    <thead><tr><th>#</th><th>Pitcher</th><th>Form</th><th>Ref line</th><th>L3 over</th><th>L5 over</th><th>L10 over</th><th>Recent Ks</th><th>Archived over quotes</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>
    <div class="method"><strong>Form score:</strong> 50% last-3 over rate + 30% last-5 + 20% last-10 against today’s reference line. Price is deliberately excluded. The reference line is the lower median of available FD/DK/MGM book lines, so it is always an actually offered line. Quotes remain line-specific.</div>`;
}

function statTable(title, rows, extra = '') {
  if (!rows?.length) return '';
  return `<section class="report-section"><div class="section-head"><h2>${esc(title)}</h2>${extra}</div><div class="table-card compact"><div class="table-scroll"><table>
    <thead><tr><th>Segment</th><th>Bets</th><th>W-L-P</th><th>Hit</th><th>Net</th><th>ROI</th><th>Avg line</th></tr></thead>
    <tbody>${rows.map((row) => `<tr><td><strong>${esc(row.label)}</strong></td><td>${esc(row.bets)}</td><td>${esc(row.wins)}-${esc(row.losses)}-${esc(row.pushes)}</td><td>${pct(row.hitRate,1)}</td><td class="${valueClass(row.netUnits)}">${units(row.netUnits)}</td><td class="${valueClass(row.roi)}">${pct(row.roi,1)}</td><td>${row.averageLine == null ? '—' : Number(row.averageLine).toFixed(2)}</td></tr>`).join('')}</tbody>
  </table></div></div></section>`;
}

function renderDiscovery(data) {
  status.hidden = true;
  const overall = data.form?.overall || {};
  const v1 = data.model?.selectedStrategy || {};
  const v2 = data.modelV2 || null;
  const v3 = data.modelV3 || null;
  renderMetrics([
    ['Archive bets', overall.bets ?? 0],
    ['Form ROI', pct(overall.roi,1), valueClass(overall.roi)],
    ['v3 walk-forward ROI', pct(v3?.strategy?.roi,2), valueClass(v3?.strategy?.roi)],
    ['v3 status', v3 ? (v3.promoted ? 'PROMOTED' : 'HOLD') : '—', v3?.promoted ? 'positive' : 'negative'],
  ]);

  const edgeRows = (data.form?.edgeCandidates || []).map((row) => `<tr>
    <td><strong>${esc(row.dimension)}</strong><div class="muted">${esc(row.rule)}</div></td>
    <td>${esc(row.bets)}</td><td>${esc(row.slates)}</td><td>${pct(row.hitRate,1)}</td>
    <td class="${valueClass(row.netUnits)}">${units(row.netUnits)}</td><td class="${valueClass(row.roi)}">${pct(row.roi,1)}</td>
  </tr>`).join('');

  const v1Calibration = data.model?.referenceLineCalibration || {};
  const marketCalibration = data.model?.marketCalibration || {};
  const v1Panel = `<section class="report-section"><div class="section-head"><h2>v1 structural benchmark</h2><span class="pill">${esc(data.methodology?.model || 'k-count-v1')}</span></div>
    <div class="validation-grid">
      <div class="validation-card"><span>v1 Brier</span><strong>${v1Calibration.brier ?? '—'}</strong><small>${esc(v1Calibration.n || 0)} reference-line outcomes</small></div>
      <div class="validation-card"><span>Market Brier</span><strong>${marketCalibration.brier ?? '—'}</strong><small>same historical reference rows</small></div>
      <div class="validation-card"><span>v1 strategy</span><strong>${esc(v1.bets || 0)} bets</strong><small>${units(v1.netUnits)} · ${pct(v1.roi,1)} ROI</small></div>
      <div class="validation-card"><span>Archive through</span><strong>${esc(data.archive?.through || '—')}</strong><small>${esc(data.archive?.checkpointFiles || 0)} checkpoint files</small></div>
    </div>
  </section>`;

  const v2Calibration = v2?.calibration || {};
  const v2Strategy = v2?.strategy || {};
  const v2Panel = v2 ? `<section class="report-section"><div class="section-head"><h2>v2 market anchor</h2><span class="pill">β ${esc(v2.finalFit?.beta ?? 0)}</span></div>
    <div class="validation-grid">
      <div class="validation-card"><span>Market Brier</span><strong>${v2Calibration.marketBrier ?? '—'}</strong><small>${esc(v2Calibration.n || 0)} strict OOS rows</small></div>
      <div class="validation-card"><span>Raw v1 Brier</span><strong>${v2Calibration.structuralBrier ?? '—'}</strong><small>same walk-forward rows</small></div>
      <div class="validation-card"><span>v2 Brier</span><strong>${v2Calibration.anchoredBrier ?? '—'}</strong><small>market + learned v1 weight</small></div>
      <div class="validation-card"><span>Executable v2</span><strong>${esc(v2Strategy.bets || 0)} bets</strong><small>${units(v2Strategy.netUnits)} · ${pct(v2Strategy.roi,1)} ROI</small></div>
    </div>
    <div class="method"><strong>${v2.promoted ? 'PASS' : 'HOLD'}:</strong> ${esc(v2.promotionReason || '')} The learned β of ${esc(v2.finalFit?.beta ?? 0)} means the current structural v1 adds no validated information beyond the market prior.</div>
  </section>` : '';

  const v3Calibration = v3?.calibration || {};
  const v3Strategy = v3?.strategy || {};
  const v3Panel = v3 ? `<section class="report-section"><div class="section-head"><h2>v3 residual-market validation</h2><span class="pill">ridge λ ${esc(v3.finalFit?.lambda ?? '—')}</span></div>
    <div class="validation-grid">
      <div class="validation-card"><span>Market Brier</span><strong>${v3Calibration.marketBrier ?? '—'}</strong><small>${esc(v3Calibration.n || 0)} group-weighted OOS rows</small></div>
      <div class="validation-card"><span>Residual v3 Brier</span><strong>${v3Calibration.residualBrier ?? '—'}</strong><small>required gain ≥ 0.00050</small></div>
      <div class="validation-card"><span>Market → v3 log loss</span><strong>${v3Calibration.marketLogLoss ?? '—'} → ${v3Calibration.residualLogLoss ?? '—'}</strong><small>first evaluated ${esc(v3Calibration.firstEvaluatedDate || '—')}</small></div>
      <div class="validation-card"><span>v3 research strategy</span><strong>${esc(v3Strategy.bets || 0)} bets</strong><small>${units(v3Strategy.netUnits)} · ${pct(v3Strategy.roi,2)} ROI</small></div>
    </div>
    <div class="method"><strong>${v3.promoted ? 'PASS' : 'HOLD'}:</strong> ${esc(v3.promotionReason || '')} The current Brier gain is ${v3Calibration.marketBrier != null && v3Calibration.residualBrier != null ? (Number(v3Calibration.marketBrier) - Number(v3Calibration.residualBrier)).toFixed(5) : '—'}, so v3 is still below the preset promotion margin even though both Brier and log loss improved slightly.</div>
    ${statTable('v3 research strategy by side', v3.bySide)}
    ${statTable('v3 research strategy by book', v3.byBook)}
    ${statTable('v3 research strategy by checkpoint', v3.byCheckpoint)}
  </section>` : '';

  const edges = edgeRows ? `<section class="report-section"><div class="section-head"><h2>Positive historical Form slices</h2><span class="pill">hypothesis-generating</span></div><div class="table-card compact"><div class="table-scroll"><table>
    <thead><tr><th>Rule</th><th>Bets</th><th>Slates</th><th>Hit</th><th>Net</th><th>ROI</th></tr></thead><tbody>${edgeRows}</tbody></table></div></div></section>` : '';

  content.innerHTML = `<div class="method"><strong>Validation hierarchy:</strong> Form is descriptive; v1 is an independent structural benchmark; v2 tested whether v1 adds signal to the sportsbook prior; v3 directly models residual market error with strict date walk-forward and strong shrinkage. No Discovery calculation adds a SportsGameOdds call.</div>
    ${statTable('Form score bands', data.form?.byFormScore)}
    ${statTable('Price bands', data.form?.byOdds)}
    ${statTable('Checkpoint timing', data.form?.byCheckpoint)}
    ${edges}
    ${v1Panel}
    ${v2Panel}
    ${v3Panel}`;
}

function movementLabel(row) {
  const move = row.marketFeatures || {};
  if (!move.hasPrior) return '<span class="muted">first snapshot</span>';
  const line = Number(move.lineMove || 0);
  const probability = Number(move.probabilityMoveSameLine || 0);
  if (line !== 0) return `<strong>${signed(line,1)} K line</strong><div class="muted">vs prior checkpoint</div>`;
  if (move.priorSameLine) return `<strong>${signed(probability * 100,1)} pp</strong><div class="muted">same-line market P</div>`;
  return '<span class="muted">prior line changed</span>';
}

function renderModel(data) {
  status.hidden = true;
  const displayRows = data.candidates?.length ? data.candidates : (data.researchCandidates?.length ? data.researchCandidates : data.bets || []);
  const validation = data.validation?.calibration || {};
  const strategy = data.validation?.strategy || {};
  const topResearch = data.researchCandidates?.[0] || null;
  renderMetrics([
    ['Modeled pitchers', data.dataQuality?.modeledPitchers ?? 0],
    ['Research candidates', data.dataQuality?.researchCandidateQuotes ?? 0],
    ['Promoted bets', data.dataQuality?.promotedCandidateQuotes ?? 0, data.promoted ? 'positive' : 'negative'],
    ['Top research EV', topResearch ? pct(topResearch.v3ExpectedValue,1) : '—', topResearch ? valueClass(topResearch.v3ExpectedValue) : ''],
  ]);

  const rows = displayRows.slice(0,60).map((row, i) => `<tr>
    <td class="rank">${i+1}</td>
    <td class="pitcher"><strong>${esc(row.pitcherName)}</strong><small>${esc(row.team)} vs ${esc(row.opponent)}</small></td>
    <td><span class="side ${row.side}">${esc(row.side.toUpperCase())}</span> <strong>${esc(row.line)}</strong></td>
    <td><span class="book">${esc(bookLabel(row.book))}</span> <strong>${esc(american(row.odds))}</strong></td>
    <td><strong>${Number(row.expectedKs).toFixed(2)}</strong></td>
    <td>${pct(row.v1Probability,1)}</td>
    <td>${pct(row.marketProbability,1)}</td>
    <td><strong>${pct(row.v3Probability,1)}</strong><div class="muted">fair ${american(row.v3FairOdds)}</div></td>
    <td class="${valueClass(row.v3ProbabilityEdge)}"><strong>${pct(row.v3ProbabilityEdge,1)}</strong></td>
    <td class="${valueClass(row.v3ExpectedValue)}"><strong>${pct(row.v3ExpectedValue,1)}</strong></td>
    <td>${movementLabel(row)}</td>
    <td>${Number(row.formScore).toFixed(1)}<div class="muted">${esc(row.sampleStarts)} starts</div></td>
  </tr>`).join('');

  const badge = data.promoted ? 'PROMOTED v3' : 'RESEARCH v3';
  const title = data.promoted ? 'Residual market strikeout model' : 'Residual market model — promotion held';
  const checkpointNote = data.checkpointValidated === false
    ? ' This checkpoint itself is not in the historical validation set, so promotion is blocked regardless of global model status.'
    : '';
  content.innerHTML = `<div class="model-callout"><div><span>${esc(badge)}</span><strong>${esc(title)}</strong></div><p>${esc(data.promotionReason || '')}${esc(checkpointNote)}</p></div>
    <section class="report-section"><div class="validation-grid">
      <div class="validation-card"><span>Market Brier</span><strong>${validation.marketBrier ?? '—'}</strong><small>strict group-weighted walk-forward</small></div>
      <div class="validation-card"><span>Residual v3 Brier</span><strong>${validation.residualBrier ?? '—'}</strong><small>${esc(validation.n || 0)} OOS quote rows</small></div>
      <div class="validation-card"><span>Market → v3 log loss</span><strong>${validation.marketLogLoss ?? '—'} → ${validation.residualLogLoss ?? '—'}</strong><small>lower is better</small></div>
      <div class="validation-card"><span>Research strategy</span><strong>${esc(strategy.bets || 0)} bets</strong><small>${units(strategy.netUnits)} · ${pct(strategy.roi,2)} ROI</small></div>
    </div></section>
    <div class="table-card"><div class="table-scroll"><table>
      <thead><tr><th>#</th><th>Pitcher</th><th>Bet</th><th>Book</th><th>Exp K</th><th>Raw v1 P</th><th>Market P</th><th>v3 P</th><th>Residual edge</th><th>v3 EV</th><th>Market move</th><th>Form / sample</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="12">No two-way v3 research rows at this checkpoint.</td></tr>'}</tbody>
    </table></div></div>
    <div class="method"><strong>v3 rule:</strong> sportsbook no-vig probability is the starting point. The model learns only a ridge-shrunk residual correction using pre-checkpoint information: structural disagreement, Form/workload/opponent context, cross-book disagreement, exact-line dispersion, and earlier same-day line/price movement. Research rows require ≥8 starts, ≥1.25 percentage-point residual edge and ≥1.5% EV. They are not picks unless the promotion gate passes. SportsGameOdds calls from this view: ${esc(data.providerRequests ?? 0)}.</div>`;
}

async function loadForm() {
  status.hidden = false;
  status.textContent = 'Loading strikeout form and archived lines…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`/api/strikeouts-form?${formParams()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderForm(data);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    content.innerHTML = '<div class="placeholder"><h2>Board not ready</h2><p>Try another checkpoint or slate date. The site only reads archived provider responses; it will not spend another SportsGameOdds call to fill a missing checkpoint.</p></div>';
  }
}

async function loadDiscovery() {
  status.hidden = false;
  status.textContent = 'Building historical Discovery with v1, v2 and residual v3 walk-forward validation…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch('/api/strikeouts-discovery', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderDiscovery(data);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    content.innerHTML = '<div class="placeholder"><h2>Discovery unavailable</h2><p>The archive analysis did not complete. This path adds zero SportsGameOdds calls; it only reads stored checkpoints and official MLB results.</p></div>';
  }
}

async function loadModel() {
  status.hidden = false;
  status.textContent = 'Applying residual v3 to the exact archived strikeout market…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`/api/strikeouts-model?${formParams()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderModel(data);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    content.innerHTML = '<div class="placeholder"><h2>Model not ready</h2><p>No usable archived strikeout market, residual validation history, or starter data was available for this checkpoint.</p></div>';
  }
}

function loadActive() {
  if (activeView === 'discovery') return loadDiscovery();
  if (activeView === 'model') return loadModel();
  return loadForm();
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tab));
  activeView = tab.dataset.view;
  toolbar.hidden = activeView === 'discovery';
  loadActive();
}));

$('refresh').addEventListener('click', loadActive);
dateInput.value = etToday();
loadForm();
