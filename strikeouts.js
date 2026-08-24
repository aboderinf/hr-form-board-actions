const $ = (id) => document.getElementById(id);
const content = $('content');
const status = $('status');
const summary = $('summary');
const toolbar = $('form-toolbar');
const dateInput = $('slate-date');
const checkpoint = $('checkpoint');

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

function pct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Math.round(Number(value) * 100)}%`;
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

function renderSummary(data) {
  const top = data.rows?.[0];
  const metrics = [
    ['Ranked pitchers', data.rows?.length || 0],
    ['Checkpoint', data.checkpoint ? `${data.checkpoint.slice(0,2)}:${data.checkpoint.slice(2)}` : '—'],
    ['Top form score', top ? top.form.formScore.toFixed(1) : '—'],
    ['SportsGameOdds calls', data.providerRequests ?? 0],
  ];
  summary.innerHTML = metrics.map(([label,value]) => `<div class="metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join('');
  summary.hidden = false;
}

function renderForm(data) {
  renderSummary(data);
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
    <div class="method"><strong>Form score:</strong> 50% last-3 over rate + 30% last-5 + 20% last-10 against today’s reference line. Price is deliberately excluded. The reference line is the lower median of available FD/DK/MGM lines, so it is always an actually offered line. Quotes remain line-specific.</div>`;
}

async function loadForm() {
  status.hidden = false;
  status.textContent = 'Loading strikeout form and archived lines…';
  summary.hidden = true;
  content.innerHTML = '';
  const params = new URLSearchParams({ date: dateInput.value || etToday() });
  if (checkpoint.value) params.set('checkpoint', checkpoint.value);
  try {
    const response = await fetch(`/api/strikeouts-form?${params}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    renderForm(data);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    content.innerHTML = '<div class="placeholder"><h2>Board not ready</h2><p>Try another checkpoint or slate date. The site only reads archived provider responses; it will not spend another SportsGameOdds call to fill a missing checkpoint.</p></div>';
  }
}

function renderPlaceholder(kind) {
  status.hidden = true;
  summary.hidden = true;
  toolbar.hidden = true;
  if (kind === 'discovery') {
    content.innerHTML = '<div class="placeholder"><h2>Discovery — archive analysis next</h2><p>This will mirror the triples discovery workflow: fixed-checkpoint results, line-aware ROI, form-score × price analysis, sportsbook attribution, and complete-slate gates. Strikeout lines will be analyzed separately so a 5.5 and 6.5 are never pooled as the same wager.</p></div>';
  } else {
    content.innerHTML = '<div class="placeholder"><h2>Model — after the form baseline</h2><p>The predictive model will be kept separate from form. Planned pregame features include pitcher K rate and recent workload, innings/pitch-count depth, opponent strikeout tendency and projected lineup, handedness splits, rest, umpire/park/weather where they add signal, and the exact sportsbook line. Validation will be date-ordered and the odds archive will remain out-of-sample for ROI testing.</p></div>';
  }
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tab));
  const view = tab.dataset.view;
  if (view === 'form') { toolbar.hidden = false; loadForm(); }
  else renderPlaceholder(view);
}));

$('refresh').addEventListener('click', loadForm);
dateInput.value = etToday();
loadForm();
