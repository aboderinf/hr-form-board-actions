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

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[ch]);
}

function bookLabel(book) {
  return ({ draftkings: 'DK', fanduel: 'FD', betmgm: 'MGM' })[book] || book;
}

function scoreClass(score) {
  if (score >= 60) return 'high';
  if (score >= 48) return 'mid';
  return '';
}

function renderMetrics(metrics) {
  summary.innerHTML = metrics.map(([label, value, klass = '']) => (
    `<div class="metric"><strong class="${klass}">${esc(value)}</strong><span>${esc(label)}</span></div>`
  )).join('');
  summary.hidden = false;
}

function formParams() {
  const params = new URLSearchParams({ date: dateInput.value || etToday() });
  if (checkpoint.value) params.set('checkpoint', checkpoint.value);
  return params;
}

function checkpointLabel(value) {
  if (!value) return '—';
  return `${value.slice(0, 2)}:${value.slice(2)}`;
}

function renderForm(data) {
  const top = data.rows?.[0];
  renderMetrics([
    ['Ranked batters', data.rows?.length || 0],
    ['Checkpoint', checkpointLabel(data.checkpoint)],
    ['Top form score', top ? top.form.formScore.toFixed(1) : '—'],
    ['SportsGameOdds calls', data.providerRequests ?? 0],
  ]);
  status.hidden = true;

  if (!data.rows?.length) {
    content.innerHTML = '<div class="placeholder"><h2>No ranked 2+ TB props yet</h2><p>The selected archived checkpoint may not contain Over 1.5 total-bases markets, or MLB identity/game-log hydration may still be unavailable for those quoted players.</p></div>';
    return;
  }

  const rows = data.rows.map((row, i) => {
    const overQuotes = (row.quotes || [])
      .filter((q) => q.side === 'over')
      .sort((a, b) => Number(b.americanOdds) - Number(a.americanOdds));
    const quoteHtml = overQuotes.map((q) => {
      const best = row.bestOver
        && q.book === row.bestOver.book
        && Number(q.americanOdds) === Number(row.bestOver.americanOdds);
      return `<span class="quote ref"><span class="book">${esc(bookLabel(q.book))}</span>O 1.5 <span class="${best ? 'best' : ''}">${esc(american(q.americanOdds))}</span></span>`;
    }).join('');
    const recent = (row.form.recentTb || []).map((tb) => `<span class="k-chip">${esc(tb)}</span>`).join('');
    const team = row.batterTeam ? `${row.batterTeam} · ` : '';
    return `<tr>
      <td class="rank">${i + 1}</td>
      <td class="pitcher"><strong>${esc(row.batterName)}</strong><small>${esc(team + (row.matchup || ''))}</small></td>
      <td><span class="score ${scoreClass(row.form.formScore)}">${row.form.formScore.toFixed(1)}</span><div class="muted">${esc(row.form.gamesAvailable)} starts</div></td>
      <td>${pct(row.form.l5.hitRate)} <span class="muted">(${row.form.l5.hits2Plus}/${row.form.l5.games})</span></td>
      <td>${pct(row.form.l10.hitRate)} <span class="muted">(${row.form.l10.hits2Plus}/${row.form.l10.games})</span></td>
      <td>${pct(row.form.l15.hitRate)} <span class="muted">(${row.form.l15.hits2Plus}/${row.form.l15.games})</span></td>
      <td><strong>${esc(row.form.weightedAvgTb)}</strong><div class="muted">L15 XBH ${pct(row.form.l15.xbhRate)}</div></td>
      <td><div class="recent">${recent}</div></td>
      <td><strong class="best">${esc(american(row.bestOver?.americanOdds))}</strong><div class="muted">${esc(bookLabel(row.bestOver?.book))} · O 1.5</div></td>
      <td><div class="quote-stack">${quoteHtml}</div></td>
    </tr>`;
  }).join('');

  content.innerHTML = `<div class="table-card"><div class="table-scroll"><table>
    <thead><tr><th>#</th><th>Batter</th><th>Form</th><th>L5 2+</th><th>L10 2+</th><th>L15 2+</th><th>TB form</th><th>Recent TB</th><th>Best O1.5</th><th>Archived prices</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>
    <div class="method"><strong>Form score:</strong> 50% L5 + 30% L10 + 20% L15 2+ TB hit-rate after four-game empirical-Bayes shrinkage toward this slate’s offered-player prior. Price does not enter the score. Players with fewer than 15 starts remain eligible; average TB only breaks score ties. Only actual Over 1.5 total-bases quotes count as the 2+ market.</div>`;
}

function renderDiscovery() {
  status.hidden = true;
  renderMetrics([
    ['Market', 'O 1.5 TB'],
    ['Books', 'DK · FD · MGM'],
    ['Price source', 'Shared archive'],
    ['Extra provider calls', '0'],
  ]);
  content.innerHTML = `
    <section class="report-section">
      <div class="section-head"><h2>Discovery archive</h2><span class="pill">form first</span></div>
      <div class="validation-grid">
        <div class="validation-card"><span>Primary target</span><strong>2+ TB</strong><small>settled from official MLB game results</small></div>
        <div class="validation-card"><span>Checkpoint prices</span><strong>08:17 → 20:17</strong><small>same central SportsGameOdds calls already used by the other boards</small></div>
        <div class="validation-card"><span>Form dimensions</span><strong>L5 / L10 / L15</strong><small>hit rate, average TB, XBH rate, PA/game, trend</small></div>
        <div class="validation-card"><span>Rule status</span><strong>UNPROMOTED</strong><small>no ROI rule is assumed before backtest evidence</small></div>
      </div>
      <div class="method"><strong>Discovery policy:</strong> archive every quoted O1.5 batter, each book price, the form features available at that checkpoint, and the eventual outcome. Test score bands, odds bands, book attribution, checkpoint timing, streak shape, XBH rate and their intersections. Rules are descriptive until they survive minimum sample and date-split validation.</div>
    </section>`;
}

function renderModel() {
  status.hidden = true;
  renderMetrics([
    ['Stage', 'SCaffold'],
    ['Target', 'P(TB ≥ 2)'],
    ['Validation', 'Walk-forward'],
    ['Price in features', 'No'],
  ]);
  content.innerHTML = `
    <section class="report-section">
      <div class="section-head"><h2>Predictive model path</h2><span class="pill">not promoted</span></div>
      <div class="validation-grid">
        <div class="validation-card"><span>Batter form</span><strong>TB quality</strong><small>rolling TB, hits, XBH, xSLG, barrels, hard-hit quality</small></div>
        <div class="validation-card"><span>Matchup</span><strong>Pitcher + arsenal</strong><small>handedness, pitch mix, xSLG allowed, contact quality</small></div>
        <div class="validation-card"><span>Opportunity</span><strong>Expected PA</strong><small>lineup slot, team total, bullpen, home/away</small></div>
        <div class="validation-card"><span>Environment</span><strong>Park + weather</strong><small>park factors, temperature, wind, roof and game context</small></div>
      </div>
      <div class="model-callout"><div><span>MODEL GATE</span><strong>Form remains the live ranking</strong></div><p>The model does not replace the form board until leakage-safe date walk-forward improves probability calibration and produces executable ROI after applying only the archived price available at each checkpoint. Hit-probability ranking and price/EV ranking will remain separate.</p></div>
    </section>`;
}

async function loadForm() {
  status.hidden = false;
  status.textContent = 'Loading 2+ total-bases form and archived prices…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`/api/total-bases-form?${formParams().toString()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderForm(data);
  } catch (error) {
    status.hidden = false;
    status.textContent = `Unable to load the board: ${error.message || error}`;
  }
}

function renderActive() {
  toolbar.hidden = activeView !== 'form';
  summary.hidden = true;
  content.innerHTML = '';
  status.hidden = false;
  if (activeView === 'form') return loadForm();
  if (activeView === 'discovery') return renderDiscovery();
  return renderModel();
}

dateInput.value = etToday();

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeView = tab.dataset.view;
    document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('active', node === tab));
    renderActive();
  });
});

$('refresh').addEventListener('click', () => loadForm());
dateInput.addEventListener('change', () => loadForm());
checkpoint.addEventListener('change', () => loadForm());

renderActive();
