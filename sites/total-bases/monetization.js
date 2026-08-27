const MONEY_API = 'https://hr-form-board-actions.vercel.app/api/total-bases-monetization';
const panel = document.getElementById('monetization-panel');
const dateInput = document.getElementById('slate-date');
const modelTab = document.querySelector('.tab[data-view="model"]');

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
  return `${value.wins || 0}-${value.losses || 0}`;
}
function shortDateMoney(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(Date.UTC(year, month - 1, day)));
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
  panel.innerHTML = '<div class="money-loading">Loading frozen 8:17 AM execution layer and results…</div>';
  const date = dateInput?.value || etTodayMoney();
  try {
    const response = await fetch(`${MONEY_API}?date=${encodeURIComponent(date)}&checkpoint=0817`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
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

function renderDailyLedger(forward) {
  const days = [...(forward?.daily || [])].reverse();
  if (!days.length) {
    return '<div class="money-none">No settled forward slates yet. Forward tracking begins Aug. 26.</div>';
  }
  const rows = days.map((day) => {
    const unavailable = day.status !== 'settled';
    const selections = unavailable
      ? '<span class="money-muted">Archive/result unavailable</span>'
      : day.bets === 0
        ? '<span class="money-muted">No qualified bets</span>'
        : (day.selections || []).map((pick) => `<span class="money-selection ${pick.hit ? 'win' : 'loss'}"><b>${escMoney(pick.player)}</b> ${americanMoney(pick.odds)} ${escMoney(bookMoney(pick.book))} · ${pick.hit ? 'W' : 'L'} ${unitsMoney(pick.pnlUnits)}</span>`).join('');
    return `<tr>
      <td><strong>${escMoney(shortDateMoney(day.date))}</strong><small>${escMoney(day.date)}</small></td>
      <td>${unavailable ? '—' : `${day.wins || 0}-${day.losses || 0}`}</td>
      <td class="${pnlClass(day.netUnits)}"><strong>${unavailable ? '—' : unitsMoney(day.netUnits)}</strong></td>
      <td class="${pnlClass(day.roi)}">${unavailable ? '—' : pctMoney(day.roi)}</td>
      <td class="${pnlClass(day.cumulative?.netUnits)}">${unitsMoney(day.cumulative?.netUnits)}</td>
      <td class="${pnlClass(day.cumulative?.roi)}">${pctMoney(day.cumulative?.roi)}</td>
      <td><div class="money-selections">${selections}</div></td>
    </tr>`;
  }).join('');
  return `<section class="money-history"><div class="money-table-scroll"><table>
    <thead><tr><th>Date</th><th>Record</th><th>Net</th><th>Day ROI</th><th>Cum. net</th><th>Cum. ROI</th><th>Selections</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></section>`;
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
      <div class="money-player"><strong>${escMoney(row.batterName)}</strong><span>${escMoney(row.matchup || '')}</span></div>
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
        <p>${escMoney(ruleText)}. The rule is frozen; results update daily without retuning it.</p>
      </div>
      <div class="money-badge">${escMoney(data.monetizationStatus || (promoted ? 'PROMOTED' : 'HELD'))}</div>
    </section>

    <div class="money-stats validation-stats">
      <article><span>Early calibration</span><strong>${pctMoney(early.roi)}</strong><small>${early.wins || 0}-${early.losses || 0} · ${early.slates || 0} slates</small></article>
      <article><span>Late calibration</span><strong>${pctMoney(late.roi)}</strong><small>${late.wins || 0}-${late.losses || 0} · ${late.slates || 0} slates</small></article>
      <article><span>Full calibration</span><strong>${pctMoney(full.roi)}</strong><small>${full.bets || 0} bets · ${unitsMoney(full.netUnits)}</small></article>
      <article class="holdout"><span>Frozen holdout</span><strong>${pctMoney(holdout.roi)}</strong><small>${holdout.wins || 0}-${holdout.losses || 0} · ${unitsMoney(holdout.netUnits)}</small></article>
    </div>

    <div class="money-heading forward-title"><div><span>Live profitability</span><h3>Forward results · Aug. 26 onward</h3></div><p>One unit per selection. Calibration is excluded from live performance.</p></div>
    <div class="money-stats forward-stats">
      ${periodCard('Last 7 days', periods.last7Days)}
      ${periodCard('Last 14 days', periods.last14Days)}
      ${periodCard('Forward to date', allForward, `${allForward.profitableSlates || 0}/${allForward.slates || 0} positive slates`)}
      ${periodCard('All out-of-sample', overallOos, `${overallOos.profitableSlates || 0}/${overallOos.slates || 0} positive slates`)}
    </div>

    <div class="money-heading"><div><span>Day by day</span><h3>Frozen-rule performance ledger</h3></div><p>Daily and cumulative profitability from archived 8:17 AM selections.</p></div>
    ${renderDailyLedger(forward)}

    <div class="money-heading"><div><span>Today's execution</span><h3>Qualified 8:17 AM bets</h3></div><p>Later checkpoints do not replace these selections.</p></div>
    ${picks}
    <div class="money-footnote"><strong>Important:</strong> the broad raw-v2 EV strategy below remains separate. Promotion applies only to this frozen top-three execution layer. Forward outcomes update the ledger but never change the rule. Existing archived odds are reused, adding 0 SportsGameOdds calls.</div>`;
}

function showMoney(show) {
  if (!panel) return;
  panel.hidden = !show;
  if (show) loadMonetization();
}

modelTab?.addEventListener('click', () => showMoney(true));
document.querySelectorAll('.tab').forEach((tab) => {
  if (tab !== modelTab) tab.addEventListener('click', () => showMoney(false));
});
dateInput?.addEventListener('change', () => {
  if (panel && !panel.hidden) loadMonetization();
});
