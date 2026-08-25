const API = 'https://hr-form-board-actions.vercel.app/api/total-bases-form';
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
function pct(value) { return value == null ? '—' : `${(Number(value) * 100).toFixed(0)}%`; }
function american(value) { const n = Number(value); return Number.isFinite(n) ? (n > 0 ? `+${n}` : String(n)) : '—'; }
function book(book) { return ({draftkings:'DK',fanduel:'FD',betmgm:'MGM'})[book] || String(book || '').toUpperCase(); }
function cpLabel(value) { return value ? `${value.slice(0,2)}:${value.slice(2)}` : '—'; }

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

function renderDiscovery() {
  status.hidden = true;
  metrics([['Market','O1.5 TB'],['Books','DK · FD · MGM'],['Odds source','Shared archive'],['Provider calls','0 extra']]);
  content.innerHTML = `<section class="panel"><h2>Discovery</h2><div class="cards">
    <article><span>Outcome</span><strong>TB ≥ 2</strong><p>Official game result.</p></article>
    <article><span>Checkpoints</span><strong>08:17 → 20:17</strong><p>Archived price snapshots.</p></article>
    <article><span>Features</span><strong>L5 / L10 / L15</strong><p>Hit rate, TB/game, XBH rate, PA/game, trend.</p></article>
    <article><span>Status</span><strong>UNPROMOTED</strong><p>No ROI rule until it survives date-split validation.</p></article>
  </div><div class="note">Discovery will test score bands, odds bands, book attribution, checkpoint timing, streak shape and intersections. No rule is promoted from in-sample results alone.</div></section>`;
}

function renderModel() {
  status.hidden = true;
  metrics([['Target','P(TB ≥ 2)'],['Validation','Walk-forward'],['Price feature','Excluded'],['Status','SCaffold']]);
  content.innerHTML = `<section class="panel"><h2>Predictive model path</h2><div class="cards">
    <article><span>Batter</span><strong>Contact quality</strong><p>TB, hits, XBH, xSLG, barrels, hard-hit.</p></article>
    <article><span>Matchup</span><strong>Pitcher + arsenal</strong><p>Handedness, pitch mix and contact allowed.</p></article>
    <article><span>Opportunity</span><strong>Expected PA</strong><p>Lineup slot, team context and bullpen.</p></article>
    <article><span>Environment</span><strong>Park + weather</strong><p>Park factors, temperature, wind and roof.</p></article>
  </div><div class="note">The model will not replace the form board until walk-forward calibration and executable ROI beat the form baseline. Hit-probability ranking and price/EV ranking remain separate.</div></section>`;
}

async function loadForm() {
  status.hidden = false;
  status.textContent = 'Loading form and archived O1.5 prices…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`${API}?${params()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderForm(data);
  } catch (error) {
    status.hidden = false;
    status.textContent = `Unable to load board: ${error.message || error}`;
  }
}

function render() {
  toolbar.hidden = activeView !== 'form';
  summary.hidden = true;
  if (activeView === 'form') return loadForm();
  if (activeView === 'discovery') return renderDiscovery();
  return renderModel();
}

dateInput.value = etToday();
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  activeView = tab.dataset.view;
  document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('active', node === tab));
  render();
}));
$('refresh').addEventListener('click', loadForm);
dateInput.addEventListener('change', loadForm);
checkpoint.addEventListener('change', loadForm);
render();
