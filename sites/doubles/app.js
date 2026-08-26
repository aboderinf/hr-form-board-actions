const FORM_API = 'https://hr-form-board-actions.vercel.app/api/doubles-form';
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
function book(value) { return ({draftkings:'DK',fanduel:'FD',betmgm:'MGM'})[value] || String(value || '').toUpperCase(); }
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
    content.innerHTML = '<section class="empty"><h2>No doubles rows yet</h2><p>This checkpoint may not contain 1+ double prices, or no offered hitter has a double in the prior 15 games.</p></section>';
    return;
  }

  const body = data.rows.map((row, i) => {
    const prices = (row.quotes || []).slice().sort((a,b) => Number(b.americanOdds)-Number(a.americanOdds));
    const priceHtml = prices.map((q) => `<span class="quote"><b>${esc(book(q.book))}</b> ${esc(american(q.americanOdds))}</span>`).join('');
    const recent = (row.form.recentDoubles || []).map((d) => `<span class="chip ${d > 0 ? 'hit' : ''}">${esc(d)}</span>`).join('');
    return `<tr>
      <td class="rank">${i + 1}</td>
      <td class="player"><strong>${esc(row.batterName)}</strong><small>${esc([row.batterTeam,row.matchup].filter(Boolean).join(' · '))}</small></td>
      <td><span class="score">${row.form.formScore.toFixed(1)}</span><small>${row.form.gamesAvailable} games${row.form.provisional ? ' · provisional' : ''}</small></td>
      <td>${pct(row.form.l5.hitRate)}<small>${row.form.l5.doubleGames}/${row.form.l5.games}</small></td>
      <td>${pct(row.form.l7.hitRate)}<small>${row.form.l7.doubleGames}/${row.form.l7.games}</small></td>
      <td>${pct(row.form.l15.hitRate)}<small>${row.form.l15.doubleGames}/${row.form.l15.games}</small></td>
      <td><strong>${row.form.doublesL15}</strong><small>doubles in L15</small></td>
      <td><div class="chips">${recent}</div></td>
      <td><strong class="best">${american(row.bestYes?.americanOdds)}</strong><small>${esc(book(row.bestYes?.book))}</small></td>
      <td><div class="prices">${priceHtml}</div></td>
    </tr>`;
  }).join('');

  content.innerHTML = `<section class="table-card"><div class="table-scroll"><table>
    <thead><tr><th>#</th><th>Batter</th><th>Form</th><th>L5</th><th>L7</th><th>L15</th><th>2B L15</th><th>Recent 2B</th><th>Best 1+</th><th>Books</th></tr></thead>
    <tbody>${body}</tbody></table></div></section>
    <section class="note"><strong>Form score:</strong> 50% L5 + 30% L7 + 20% L15 double-game rate with fixed denominators, matching the triples form-board convention. Sportsbook price is excluded from ranking.</section>`;
}

function renderDiscovery() {
  status.hidden = true;
  summary.hidden = true;
  content.innerHTML = `<section class="stage-card">
    <div class="eyebrow">PHASE 2 · ARCHIVE FIRST</div>
    <h2>Discovery is collecting clean doubles observations</h2>
    <p>The board is intentionally not declaring an odds band, book effect, checkpoint edge, or form cutoff before the doubles archive is settled. The shared checkpoints preserve the prices without adding provider calls.</p>
    <div class="stage-grid">
      <article><strong>Checkpoint</strong><span>Compare 08:17 / 11:17 / 17:17 / 20:17</span></article>
      <article><strong>Book</strong><span>DK vs FD vs MGM best-price attribution</span></article>
      <article><strong>Form</strong><span>Test score bands without price leakage</span></article>
      <article><strong>Odds</strong><span>Search price bands with holdout validation</span></article>
    </div>
  </section>`;
}

function renderModel() {
  status.hidden = true;
  summary.hidden = true;
  content.innerHTML = `<section class="stage-card model-hold">
    <div class="eyebrow">PHASE 3 · GATED</div>
    <h2>Model training is deliberately held back</h2>
    <p>The doubles model will be built only after enough settled form + price history exists for chronological train/holdout validation. This prevents copying thresholds from triples into a materially higher-frequency event.</p>
    <div class="gate">Promotion gate: out-of-time probability improvement + positive executable holdout ROI.</div>
  </section>`;
}

async function loadForm() {
  status.hidden = false;
  status.textContent = 'Loading archived doubles prices and pre-slate form…';
  summary.hidden = true;
  content.innerHTML = '';
  try {
    const response = await fetch(`${FORM_API}?${params().toString()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderForm(data);
  } catch (error) {
    status.hidden = false;
    status.textContent = `Unable to load doubles board: ${error.message || error}`;
  }
}

function loadActive() {
  toolbar.hidden = activeView !== 'form';
  if (activeView === 'form') return loadForm();
  if (activeView === 'discovery') return renderDiscovery();
  return renderModel();
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    activeView = button.dataset.view;
    loadActive();
  });
});
$('refresh').addEventListener('click', loadForm);
dateInput.addEventListener('change', loadForm);
checkpoint.addEventListener('change', loadForm);
dateInput.value = etToday();
loadForm();
