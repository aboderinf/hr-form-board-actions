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

function renderDiscovery(data, v2 = null) {
  status.hidden = true;
  const overall = data.form?.overall || {};
  const model = data.model?.selectedStrategy || {};
  renderMetrics([
    ['Archive bets', overall.bets ?? 0],
    ['Form ROI', pct(overall.roi,1), valueClass(overall.roi)],
    ['v1 ROI', pct(model.roi,1), valueClass(model.roi)],
    ['v2 status', v2 ? (v2.promoted ? 'PROMOTED' : 'HOLD') : '—', v2?.promoted ? 'positive' : 'negative'],
  ]);

  const edgeRows = (data.form?.edgeCandidates || []).map((row) => `<tr>
    <td><strong>${esc(row.dimension)}</strong><div class="muted">${esc(row.rule)}</div></td>
    <td>${esc(row.bets)}</td><td>${esc(row.slates)}</td><td>${pct(row.hitRate,1)}</td>
    <td class="${valueClass(row.netUnits)}">${units(row.netUnits)}</td><td class="${valueClass(row.roi)}">${pct(row.roi,1)}</td>
  </tr>`).join('');

  const calibration = data.model?.referenceLineCalibration || {};
  const marketCalibration = data.model?.marketCalibration || {};
  const modelPanel = `<section class="report-section"><div class="section-head"><h2>v1 validation</h2><span class="pill">${esc(data.methodology?.model || 'k-count-v1')}</span></div>
    <div class="validation-grid">
      <div class="validation-card"><span>v1 Brier</span><strong>${calibration.brier ?? '—'}</strong><small>${esc(calibration.n || 0)} decisive reference-line bets</small></div>
      <div class="validation-card"><span>Market Brier</span><strong>${marketCalibration.brier ?? '—'}</strong><small>de-vig where both sides existed</small></div>
      <div class="validation-card"><span>v1 selected bets</span><strong>${esc(model.bets || 0)}</strong><small>${units(model.netUnits)} · ${pct(model.roi,1)} ROI</small></div>
      <div class="validation-card"><span>Archive through</span><strong>${esc(data.archive?.through || '—')}</strong><small>${esc(data.archive?.checkpointFiles || 0)} checkpoint files</small></div>
    </div>
  </section>`;

  const v2Calibration = v2?.calibration || {};
  const v2Strategy = v2?.strategy || {};
  const v2Panel = v2 ? `<section class="report-section"><div class="section-head"><h2>v2 walk-forward validation</h2><span class="pill">market anchored · β ${esc(v2.finalFit?.beta ?? 0)}</span></div>
    <div class="validation-grid">
      <div class="validation-card"><span>Market Brier</span><strong>${v2Calibration.marketBrier ?? '—'}</strong><small>${esc(v2Calibration.n || 0)} strict OOS exact-line rows</small></div>
      <div class="validation-card"><span>Raw v1 Brier</span><strong>${v2Calibration.structuralBrier ?? '—'}</strong><small>same walk-forward rows</small></div>
      <div class="validation-card"><span>Anchored v2 Brier</span><strong>${v2Calibration.anchoredBrier ?? '—'}</strong><small>first evaluated ${esc(v2Calibration.firstEvaluatedDate || '—')}</small></div>
      <div class="validation-card"><span>Executable v2</span><strong>${esc(v2Strategy.bets || 0)} bets</strong><small>${units(v2Strategy.netUnits)} · ${pct(v2Strategy.roi,1)} ROI</small></div>
    </div>
    <div class="method"><strong>${v2.promoted ? 'PASS' : 'HOLD'}:</strong> ${esc(v2.promotionReason || '')} β is fitted separately for every historical date using only earlier slates; the final β shown above is trained through ${esc(v2.archive?.through || '—')} for the next live slate.</div>
  </section>` : '';

  const edges = edgeRows ? `<section class="report-section"><div class="section-head"><h2>Positive historical slices</h2><span class="pill">min 20 bets · 5 slates</span></div><div class="table-card compact"><div class="table-scroll"><table>
    <thead><tr><th>Rule</th><th>Bets</th><th>Slates</th><th>Hit</th><th>Net</th><th>ROI</th></tr></thead><tbody>${edgeRows}</tbody></table></div></div></section>` : '';

  content.innerHTML = `<div class="method"><strong>Executable form benchmark:</strong> at each 8:17 / 11:17 / 5:17 checkpoint, take the lower median FD/DK/MGM over line and the best price at that exact line. Settlement uses official MLB strikeouts; integer ties push. No extra SportsGameOdds calls are made.</div>
    ${statTable('Form score bands', data.form?.byFormScore)}
    ${statTable('Price bands', data.form?.byOdds)}
    ${statTable('Checkpoint timing', data.form?.byCheckpoint)}
    ${edges}
    ${modelPanel}
    ${v2Panel}`;
}

function renderModel(data) {
  status.hidden = true;
  const displayRows = data.candidates?.length ? data.candidates : (data.researchCandidates?.length ? data.researchCandidates : data.bets || []);
  const top = displayRows[0];
  const validation = data.validation?.calibration || {};
  const strategy = data.validation?.strategy || {};
  renderMetrics([
    ['β market→v1', data.validation?.finalFit?.beta ?? 0],
    ['v2 Brier', validation.anchoredBrier ?? '—'],
    ['Research candidates', data.dataQuality?.researchCandidateQuotes ?? 0],
    ['Promoted bets', data.dataQuality?.promotedCandidateQuotes ?? 0, data.promoted ? 'positive' : 'negative'],
  ]);

  const rows = displayRows.slice(0,60).map((row, i) => `<tr>
    <td class="rank">${i+1}</td>
    <td class="pitcher"><strong>${esc(row.pitcherName)}</strong><small>${esc(row.team)} vs ${esc(row.opponent)}</small></td>
    <td><span class="side ${row.side}">${esc(row.side.toUpperCase())}</span> <strong>${esc(row.line)}</strong></td>
    <td><span class="book">${esc(bookLabel(row.book))}</span> <strong>${esc(american(row.odds))}</strong></td>
    <td><strong>${Number(row.expectedKs).toFixed(2)}</strong></td>
    <td>${pct(row.v1Probability,1)}</td>
    <td>${pct(row.marketProbability,1)}</td>
    <td><strong>${pct(row.v2Probability,1)}</strong><div class="muted">fair ${american(row.v2FairOdds)}</div></td>
    <td class="${valueClass(row.v2ProbabilityEdge)}"><strong>${pct(row.v2ProbabilityEdge,1)}</strong></td>
    <td class="${valueClass(row.v2ExpectedValue)}"><strong>${pct(row.v2ExpectedValue,1)}</strong></td>
    <td>${Number(row.formScore).toFixed(1)}</td>
    <td>${esc(row.confidence)}</td>
  </tr>`).join('');

  const badge = data.promoted ? 'PROMOTED v2' : 'RESEARCH v2';
  const title = data.promoted ? 'Market-anchored strikeout model' : 'Market-anchored model — promotion held';
  content.innerHTML = `<div class="model-callout"><div><span>${esc(badge)}</span><strong>${esc(title)}</strong></div><p>${esc(data.promotionReason || '')}</p></div>
    <section class="report-section"><div class="validation-grid">
      <div class="validation-card"><span>Market Brier</span><strong>${validation.marketBrier ?? '—'}</strong><small>strict walk-forward rows</small></div>
      <div class="validation-card"><span>Raw v1 Brier</span><strong>${validation.structuralBrier ?? '—'}</strong><small>same rows</small></div>
      <div class="validation-card"><span>Anchored v2 Brier</span><strong>${validation.anchoredBrier ?? '—'}</strong><small>β ${esc(data.validation?.finalFit?.beta ?? 0)}</small></div>
      <div class="validation-card"><span>v2 strategy</span><strong>${esc(strategy.bets || 0)} bets</strong><small>${units(strategy.netUnits)} · ${pct(strategy.roi,1)} ROI</small></div>
    </div></section>
    <div class="table-card"><div class="table-scroll"><table>
      <thead><tr><th>#</th><th>Pitcher</th><th>Bet</th><th>Book</th><th>Exp K</th><th>Raw v1 P</th><th>Market P</th><th>v2 P</th><th>v2 edge</th><th>v2 EV</th><th>Form</th><th>Sample</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="12">No two-way de-vigged v2 research candidates at this checkpoint.</td></tr>'}</tbody>
    </table></div></div>
    <div class="method"><strong>v2 rule:</strong> every exact sportsbook line begins at the book’s two-way de-vigged probability. The structural baseball model can move that probability only by learned β. β is fitted from settled prior slates only. Research rows require ≥8 prior starts, ≥1.5 percentage-point v2 edge, ≥2% EV, and a game that has not started; they are promoted only if the historical gate passes.</div>`;
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
  status.textContent = 'Building historical Discovery and strict walk-forward v2 validation…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const [baseResponse, v2Response] = await Promise.all([
      fetch('/api/strikeouts-discovery', { cache: 'no-store' }),
      fetch('/api/strikeouts-v2-validation', { cache: 'no-store' }),
    ]);
    const data = await baseResponse.json();
    if (!baseResponse.ok) throw new Error(data.message || `HTTP ${baseResponse.status}`);
    let v2 = null;
    if (v2Response.ok) v2 = await v2Response.json();
    renderDiscovery(data, v2);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    content.innerHTML = '<div class="placeholder"><h2>Discovery unavailable</h2><p>The archive analysis did not complete. This path adds zero SportsGameOdds calls; it only reads stored checkpoints and official MLB results.</p></div>';
  }
}

async function loadModel() {
  status.hidden = false;
  status.textContent = 'Pricing exact strikeout lines with market-anchored v2…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`/api/strikeouts-model-v2?${formParams()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderModel(data);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    content.innerHTML = '<div class="placeholder"><h2>Model not ready</h2><p>No usable archived strikeout market, validation history, or starter data was available for this checkpoint.</p></div>';
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
