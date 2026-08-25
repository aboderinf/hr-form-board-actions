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

function renderDiscovery(data) {
  status.hidden = true;
  const overall = data.form?.overall || {};
  const model = data.model?.selectedStrategy || {};
  renderMetrics([
    ['Archive bets', overall.bets ?? 0],
    ['Form net', units(overall.netUnits), valueClass(overall.netUnits)],
    ['Form ROI', pct(overall.roi,1), valueClass(overall.roi)],
    ['Model-filter ROI', pct(model.roi,1), valueClass(model.roi)],
  ]);

  const edgeRows = (data.form?.edgeCandidates || []).map((row) => `<tr>
    <td><strong>${esc(row.dimension)}</strong><div class="muted">${esc(row.rule)}</div></td>
    <td>${esc(row.bets)}</td><td>${esc(row.slates)}</td><td>${pct(row.hitRate,1)}</td>
    <td class="${valueClass(row.netUnits)}">${units(row.netUnits)}</td><td class="${valueClass(row.roi)}">${pct(row.roi,1)}</td>
  </tr>`).join('');

  const calibration = data.model?.referenceLineCalibration || {};
  const marketCalibration = data.model?.marketCalibration || {};
  const modelPanel = `<section class="report-section"><div class="section-head"><h2>Model validation</h2><span class="pill">${esc(data.methodology?.model || 'k-count-v1')}</span></div>
    <div class="validation-grid">
      <div class="validation-card"><span>Model Brier</span><strong>${calibration.brier ?? '—'}</strong><small>${esc(calibration.n || 0)} decisive reference-line bets</small></div>
      <div class="validation-card"><span>Market Brier</span><strong>${marketCalibration.brier ?? '—'}</strong><small>de-vig where both sides existed</small></div>
      <div class="validation-card"><span>Selected bets</span><strong>${esc(model.bets || 0)}</strong><small>${units(model.netUnits)} · ${pct(model.roi,1)} ROI</small></div>
      <div class="validation-card"><span>Archive through</span><strong>${esc(data.archive?.through || '—')}</strong><small>${esc(data.archive?.checkpointFiles || 0)} checkpoint files</small></div>
    </div>
    <div class="method"><strong>Important:</strong> this archive is still short. Discovery surfaces candidate structure; it does not promote a rule as durable until it survives a materially larger forward sample.</div>
  </section>`;

  const edges = edgeRows ? `<section class="report-section"><div class="section-head"><h2>Positive historical slices</h2><span class="pill">min 20 bets · 5 slates</span></div><div class="table-card compact"><div class="table-scroll"><table>
    <thead><tr><th>Rule</th><th>Bets</th><th>Slates</th><th>Hit</th><th>Net</th><th>ROI</th></tr></thead><tbody>${edgeRows}</tbody></table></div></div></section>` : '';

  content.innerHTML = `<div class="method"><strong>Executable form benchmark:</strong> at each 8:17 / 11:17 / 5:17 checkpoint, take the lower median FD/DK/MGM over line and the best price at that exact line. Settlement uses official MLB strikeouts; integer ties push. No extra SportsGameOdds calls are made.</div>
    ${statTable('Form score bands', data.form?.byFormScore)}
    ${statTable('Price bands', data.form?.byOdds)}
    ${statTable('Checkpoint timing', data.form?.byCheckpoint)}
    ${edges}
    ${modelPanel}`;
}

function renderModel(data) {
  status.hidden = true;
  const top = data.candidates?.[0] || data.bets?.[0];
  renderMetrics([
    ['Modeled pitchers', data.dataQuality?.modeledPitchers ?? 0],
    ['Value candidates', data.dataQuality?.candidateQuotes ?? 0],
    ['Top model EV', top?.expectedValue == null ? '—' : pct(top.expectedValue,1), valueClass(top?.expectedValue)],
    ['SportsGameOdds calls', data.providerRequests ?? 0],
  ]);

  const rows = (data.candidates?.length ? data.candidates : data.bets || []).slice(0,60).map((row, i) => `<tr>
    <td class="rank">${i+1}</td>
    <td class="pitcher"><strong>${esc(row.pitcherName)}</strong><small>${esc(row.team)} vs ${esc(row.opponent)}</small></td>
    <td><span class="side ${row.side}">${esc(row.side.toUpperCase())}</span> <strong>${esc(row.line)}</strong></td>
    <td><span class="book">${esc(bookLabel(row.book))}</span> <strong>${esc(american(row.odds))}</strong></td>
    <td><strong>${Number(row.expectedKs).toFixed(2)}</strong></td>
    <td>${pct(row.modelProbability,1)}<div class="muted">fair ${american(row.fairOdds)}</div></td>
    <td>${pct(row.marketNoVigProbability,1)}</td>
    <td class="${valueClass(row.probabilityEdge)}"><strong>${pct(row.probabilityEdge,1)}</strong></td>
    <td class="${valueClass(row.expectedValue)}"><strong>${pct(row.expectedValue,1)}</strong></td>
    <td>${Number(row.formScore).toFixed(1)}</td>
    <td>${esc(row.confidence)}</td>
  </tr>`).join('');

  content.innerHTML = `<div class="model-callout"><div><span>MODEL v1</span><strong>Structural K-count model</strong></div><p>Pitcher K/BF + projected batters faced + opponent strikeout tendency + rest → Poisson/negative-binomial strikeout distribution. It prices every exact book line independently.</p></div>
    <div class="table-card"><div class="table-scroll"><table>
      <thead><tr><th>#</th><th>Pitcher</th><th>Bet</th><th>Book</th><th>Exp K</th><th>Model P</th><th>Market P</th><th>Edge</th><th>EV</th><th>Form</th><th>Sample</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="11">No model candidates at this checkpoint.</td></tr>'}</tbody>
    </table></div></div>
    <div class="method"><strong>Candidate gate:</strong> EV ≥ 4%, probability edge ≥ 2.5 percentage points, at least five prior starts. Model and Form remain separate: Form never uses price; Model uses the exact line and de-vigged market only for value comparison. ${esc(data.methodology?.warning || '')}</div>`;
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
  status.textContent = 'Building line-aware historical Discovery from archived checkpoints…';
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
  status.textContent = 'Pricing today’s exact strikeout lines with the count model…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`/api/strikeouts-model?${formParams()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderModel(data);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    content.innerHTML = '<div class="placeholder"><h2>Model not ready</h2><p>No usable archived strikeout market or starter data was available for this checkpoint.</p></div>';
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
