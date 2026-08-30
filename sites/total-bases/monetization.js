const MONEY_API = 'https://hr-form-board-actions.vercel.app/api/total-bases-monetization';
const panel = document.getElementById('monetization-panel');
const dateInput = document.getElementById('slate-date');
const picksTab = document.querySelector('.tab[data-view="picks"]');
const refreshButton = document.getElementById('refresh');
let latestMoneyData = null;
const ledgerState = { page: 1, pageSize: 10, betOnly: false };

function escMoney(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function pctMoney(value, digits = 1) {
  return value == null ? '—' : `${(Number(value) * 100).toFixed(digits)}%`;
}
function americanMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? (n > 0 ? `+${n}` : String(n)) : '—';
}
function bookMoney(value) {
  return ({draftkings:'DK',fanduel:'FD',betmgm:'MGM'})[value] || String(value || '').toUpperCase();
}
function unitsMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(2)}u` : '—';
}
function recordMoney(value) {
  if (!value) return '—';
  const voids = Number(value.voids || 0);
  return `${value.wins || 0}-${value.losses || 0}${voids ? `-${voids}V` : ''}`;
}
function shortDateMoney(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(Date.UTC(year, month - 1, day)));
}
function gameTimeMoney(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
}
function timeMoney(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}
function pnlClass(value) {
  const n = Number(value);
  return n > 0 ? 'money-positive' : n < 0 ? 'money-negative' : '';
}
function etTodayMoney() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function loadMonetization() {
  if (!panel || panel.hidden) return;
  panel.innerHTML = '<div class="money-loading">Loading frozen 8:17 AM execution layer and latest settled ledger…</div>';
  const date = dateInput?.value || etTodayMoney();
  try {
    const url = `${MONEY_API}?date=${encodeURIComponent(date)}&checkpoint=0817&_=${Date.now()}`;
    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    latestMoneyData = data;
    ledgerState.page = 1;
    renderMonetization(data);
  } catch (error) {
    panel.innerHTML = `<div class="money-error">Unable to load execution layer: ${escMoney(error.message || error)}</div>`;
  }
}

function periodCard(label, period, detail = '') {
  const value = period || {};
  return `<article>
    <span>${escMoney(label)}</span>
    <strong class="${pnlClass(value.roi)}">${pctMoney(value.roi)}</strong>
    <small>${recordMoney(value)} · ${unitsMoney(value.netUnits)}${detail ? ` · ${escMoney(detail)}` : ''}</small>
  </article>`;
}

function selectionResult(pick) {
  const result = String(pick?.result || '').toLowerCase();
  if (result === 'win') return { cls: 'win', label: 'W' };
  if (result === 'loss') return { cls: 'loss', label: 'L' };
  if (result === 'void') return { cls: 'void', label: 'VOID' };
  return { cls: 'void', label: result ? result.toUpperCase() : '—' };
}

function selectionsDetails(day) {
  if (!['settled', 'partial'].includes(day.status)) return '<span class="money-muted">Snapshot unavailable</span>';
  if (!(day.selections || []).length) return '<span class="money-muted">No qualified bets</span>';
  const auditLabel = day.snapshotAuditStatus === 'verified' ? ' · audited 8:17 replay' : '';
  const chips = (day.selections || []).map((pick) => {
    const result = selectionResult(pick);
    const actual = pick.actualTb == null ? '' : ` · ${pick.actualTb} TB`;
    return `<span class="money-selection ${result.cls}"><b>${escMoney(pick.batterName || pick.player)}</b> ${americanMoney(pick.odds)} ${escMoney(bookMoney(pick.book))} · ${result.label}${actual} · ${unitsMoney(pick.pnlUnits)}</span>`;
  }).join('');
  return `<details class="money-day-details"><summary>${day.selections.length} selection${day.selections.length === 1 ? '' : 's'}${auditLabel}</summary><div class="money-selections">${chips}</div></details>`;
}

function renderDailyLedger(forward) {
  let days = [...(forward?.daily || [])].reverse();
  if (ledgerState.betOnly) days = days.filter((day) => Number(day.bets || 0) > 0 || Number(day.voids || 0) > 0);
  if (!days.length) return '<div class="money-none">No forward ledger rows match this view.</div>';

  const totalPages = Math.max(1, Math.ceil(days.length / ledgerState.pageSize));
  ledgerState.page = Math.min(Math.max(1, ledgerState.page), totalPages);
  const start = (ledgerState.page - 1) * ledgerState.pageSize;
  const pageDays = days.slice(start, start + ledgerState.pageSize);
  const end = Math.min(start + pageDays.length, days.length);

  const rows = pageDays.map((day) => {
    const unavailable = !['settled', 'partial'].includes(day.status);
    const cumulativeDetail = day.cumulative ? `${unitsMoney(day.cumulative.netUnits)} cumulative` : '—';
    return `<tr>
      <td><strong>${escMoney(shortDateMoney(day.date))}</strong><small>${escMoney(day.date)}</small></td>
      <td>${unavailable ? '—' : recordMoney(day)}</td>
      <td class="${pnlClass(day.netUnits)}"><strong>${unavailable ? '—' : unitsMoney(day.netUnits)}</strong></td>
      <td class="${pnlClass(day.roi)}">${unavailable ? '—' : pctMoney(day.roi)}</td>
      <td class="${pnlClass(day.cumulative?.roi)}"><strong>${pctMoney(day.cumulative?.roi)}</strong><small>${escMoney(cumulativeDetail)}</small></td>
      <td>${selectionsDetails(day)}</td>
    </tr>`;
  }).join('');

  return `<section class="money-history">
    <div class="money-ledger-controls">
      <div class="money-ledger-range">Showing <strong>${start + 1}–${end}</strong> of <strong>${days.length}</strong> days · settled through <strong>${escMoney(shortDateMoney(forward.through))}</strong></div>
      <div class="money-ledger-actions">
        <label><input id="ledger-bet-only" type="checkbox" ${ledgerState.betOnly ? 'checked' : ''}> Bet days only</label>
        <label>Rows <select id="ledger-page-size"><option value="10" ${ledgerState.pageSize === 10 ? 'selected' : ''}>10</option><option value="25" ${ledgerState.pageSize === 25 ? 'selected' : ''}>25</option><option value="50" ${ledgerState.pageSize === 50 ? 'selected' : ''}>50</option></select></label>
        <button id="ledger-prev" ${ledgerState.page <= 1 ? 'disabled' : ''}>← Newer</button>
        <span>Page ${ledgerState.page} / ${totalPages}</span>
        <button id="ledger-next" ${ledgerState.page >= totalPages ? 'disabled' : ''}>Older →</button>
      </div>
    </div>
    <div class="money-table-scroll"><table>
      <thead><tr><th>Date</th><th>Record</th><th>Net</th><th>Day ROI</th><th>Cumulative</th><th>Picks</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function snapshotHealth(data) {
  const snapshot = data.selectionSnapshot || {};
  if (snapshot.status === 'saved') {
    const label = snapshot.auditStatus === 'verified' ? '8:17 slate audit verified' : '8:17 snapshot saved';
    return `<div class="money-snapshot-ok"><strong>${label}</strong><span>${snapshot.selections ?? 0} selection${snapshot.selections === 1 ? '' : 's'} · ${escMoney(timeMoney(snapshot.capturedAt))}</span></div>`;
  }
  return `<div class="money-snapshot-missing"><strong>8:17 snapshot missing</strong><span>Today's displayed projections will not be added to the official ledger unless the checkpoint writer saved them.</span></div>`;
}

function wireLedgerControls() {
  document.getElementById('ledger-bet-only')?.addEventListener('change', (event) => {
    ledgerState.betOnly = Boolean(event.target.checked);
    ledgerState.page = 1;
    if (latestMoneyData) renderMonetization(latestMoneyData);
  });
  document.getElementById('ledger-page-size')?.addEventListener('change', (event) => {
    ledgerState.pageSize = Number(event.target.value) || 10;
    ledgerState.page = 1;
    if (latestMoneyData) renderMonetization(latestMoneyData);
  });
  document.getElementById('ledger-prev')?.addEventListener('click', () => {
    ledgerState.page = Math.max(1, ledgerState.page - 1);
    if (latestMoneyData) renderMonetization(latestMoneyData);
  });
  document.getElementById('ledger-next')?.addEventListener('click', () => {
    ledgerState.page += 1;
    if (latestMoneyData) renderMonetization(latestMoneyData);
  });
}

function renderMonetization(data) {
  const rule = data.rule || {};
  const early = data.calibration?.early || {};
  const late = data.calibration?.late || {};
  const full = data.calibration?.full || {};
  const holdout = data.holdout || {};
  const forward = data.forward || {};
  const periods = forward.periods || {};
  const allForward = periods.allForward || {};
  const overallOos = forward.overallOutOfSample || {};
  const promoted = Boolean(data.promoted);
  const rows = data.rows || [];
  const ruleText = rule.checkpoint
    ? `8:17 AM · top ${rule.topN}/slate · best price no longer than +${rule.maxOdds} · ${Math.round(Number(rule.contextWeight) * 100)}% v2 context + ${Math.round(Number(rule.formWeight) * 100)}% form anchor`
    : 'No frozen execution rule';

  const picks = rows.length ? `<div class="money-picks">${rows.map((row, i) => `
    <article class="money-pick">
      <div class="money-rank">${i + 1}</div>
      <div class="money-player"><strong>${escMoney(row.batterName)}</strong><span>${escMoney(row.matchup || '')} · ${escMoney(gameTimeMoney(row.gameStartAt))}</span></div>
      <div><small>Best O1.5</small><strong>${americanMoney(row.bestOver?.americanOdds)} ${escMoney(bookMoney(row.bestOver?.book))}</strong></div>
      <div><small>Execution P</small><strong>${pctMoney(row.monetizedProbability)}</strong></div>
      <div><small>Edge</small><strong class="money-positive">${pctMoney(row.monetizedEdge)}</strong></div>
      <div><small>EV</small><strong class="money-positive">${pctMoney(row.monetizedEv)}</strong></div>
    </article>`).join('')}</div>` : `<div class="money-none">No qualified 8:17 AM bets for this slate under the frozen top-three rule.</div>`;

  panel.innerHTML = `
    <section class="money-hero ${promoted ? 'promoted' : 'held'}">
      <div>
        <div class="money-eyebrow">EXECUTION LAYER · ${data.frozen ? 'FROZEN' : 'RESEARCH'}</div>
        <h2>${promoted ? 'Validated monetization rule' : 'Execution held by model gate'}</h2>
        <p>${escMoney(ruleText)}. The rule is frozen; the ledger is read-only and updates from authoritative 8:17 snapshots.</p>
      </div>
      <div class="money-badge">${escMoney(data.monetizationStatus || (promoted ? 'PROMOTED' : 'HELD'))}</div>
    </section>

    <div class="money-stats validation-stats">
      <article><span>Early calibration</span><strong>${pctMoney(early.roi)}</strong><small>${early.wins || 0}-${early.losses || 0} · ${early.slates || 0} slates</small></article>
      <article><span>Late calibration</span><strong>${pctMoney(late.roi)}</strong><small>${late.wins || 0}-${late.losses || 0} · ${late.slates || 0} slates</small></article>
      <article><span>Full calibration</span><strong>${pctMoney(full.roi)}</strong><small>${full.bets || 0} bets · ${unitsMoney(full.netUnits)}</small></article>
      <article class="holdout"><span>Frozen holdout</span><strong>${pctMoney(holdout.roi)}</strong><small>${holdout.wins || 0}-${holdout.losses || 0} · ${unitsMoney(holdout.netUnits)}</small></article>
    </div>

    <div class="money-heading forward-title"><div><span>Live profitability</span><h3>Forward results · Aug. 26 onward</h3></div><p>Ledger settled through ${escMoney(shortDateMoney(forward.through))}. One unit per graded selection; voids do not enter ROI.</p></div>
    <div class="money-stats forward-stats">
      ${periodCard('Last 7 days', periods.last7Days)}
      ${periodCard('Last 14 days', periods.last14Days)}
      ${periodCard('Forward to date', allForward, `${allForward.profitableSlates || 0}/${allForward.slates || 0} positive slates`)}
      ${periodCard('All out-of-sample', overallOos, `${overallOos.profitableSlates || 0}/${overallOos.slates || 0} positive slates`)}
    </div>

    <div class="money-heading"><div><span>Day by day</span><h3>Frozen-rule performance ledger</h3></div><p>Newest 10 days by default. Expand a row's picks only when you need them.</p></div>
    ${renderDailyLedger(forward)}

    <div class="money-heading"><div><span>Selected slate execution</span><h3>Qualified 8:17 AM bets</h3></div><p>The ledger above always stays current even when you browse another slate date.</p></div>
    ${snapshotHealth(data)}
    ${picks}
    <div class="money-footnote"><strong>Important:</strong> the checkpoint workflow creates the official daily pick snapshot. A versioned correction can only replay the frozen rule from an exact archived 8:17 checkpoint. Opening or refreshing this page cannot create or alter ledger selections. Existing archived odds are reused, adding 0 SportsGameOdds calls.</div>`;
  wireLedgerControls();
}

function showMoney(show) {
  if (!panel) return;
  panel.hidden = !show;
  if (show) loadMonetization();
}

picksTab?.addEventListener('click', () => showMoney(true));
document.querySelectorAll('.tab').forEach((tab) => {
  if (tab !== picksTab) tab.addEventListener('click', () => showMoney(false));
});
dateInput?.addEventListener('change', () => {
  if (panel && !panel.hidden) loadMonetization();
});
refreshButton?.addEventListener('click', () => {
  if (panel && !panel.hidden) loadMonetization();
});
showMoney(true);
