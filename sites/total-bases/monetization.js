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
function etTodayMoney() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function loadMonetization() {
  if (!panel || panel.hidden) return;
  panel.innerHTML = '<div class="money-loading">Loading promoted 8:17 AM execution layer…</div>';
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

function renderMonetization(data) {
  const rule = data.rule || {};
  const early = data.calibration?.early || {};
  const late = data.calibration?.late || {};
  const full = data.calibration?.full || {};
  const holdout = data.holdout || {};
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
        <div class="money-eyebrow">EXECUTION LAYER · ${promoted ? 'PROMOTED' : 'HELD'}</div>
        <h2>${promoted ? 'Validated monetization rule' : 'Monetization not promoted'}</h2>
        <p>${escMoney(ruleText)}. This rule was selected entirely before Aug. 17 and is not retuned on holdout outcomes.</p>
      </div>
      <div class="money-badge">${promoted ? 'PROMOTED' : escMoney(data.monetizationStatus || 'HELD')}</div>
    </section>
    <div class="money-stats">
      <article><span>Early calibration</span><strong>${pctMoney(early.roi)}</strong><small>${early.wins || 0}-${early.losses || 0} · ${early.slates || 0} slates</small></article>
      <article><span>Late calibration</span><strong>${pctMoney(late.roi)}</strong><small>${late.wins || 0}-${late.losses || 0} · ${late.slates || 0} slates</small></article>
      <article><span>Full calibration</span><strong>${pctMoney(full.roi)}</strong><small>${full.bets || 0} bets · ${unitsMoney(full.netUnits)}</small></article>
      <article class="holdout"><span>Untouched holdout</span><strong>${pctMoney(holdout.roi)}</strong><small>${holdout.wins || 0}-${holdout.losses || 0} · ${unitsMoney(holdout.netUnits)}</small></article>
    </div>
    <div class="money-heading"><div><span>Today's execution</span><h3>Qualified 8:17 AM bets</h3></div><p>Later checkpoints do not replace these selections.</p></div>
    ${picks}
    <div class="money-footnote"><strong>Important:</strong> the broad raw-v2 EV strategy below still failed its betting holdout. Promotion applies only to this conservative top-three execution layer. It uses the existing odds archive and adds 0 SportsGameOdds calls.</div>`;
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
