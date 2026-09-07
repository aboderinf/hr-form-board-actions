const $ = (s) => document.querySelector(s);
const fmtOdds = (n) => n == null ? '—' : `${n > 0 ? '+' : ''}${n}`;
const fmtPct = (n) => n == null ? '—' : `${(n * 100).toFixed(1)}%`;
const fmtU = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}u`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

async function getJson(path){
  const r = await fetch(`${path}?v=${Date.now()}`, {cache:'no-store'});
  if(!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function renderToday(d){
  const status = $('#todayStatus');
  const out = $('#todayPicks');
  if(d.status !== 'ready'){
    status.textContent = `11:17 AM checkpoint pending for ${d.slate_date || 'today'}. Picks lock only after the archived checkpoint exists.`;
    out.innerHTML = '<div class="notice">No forward selections have been locked yet.</div>';
    return;
  }
  const picks = d.picks || [];
  status.textContent = `${d.slate_date} · ${picks.length} qualifying pick${picks.length===1?'':'s'} · captured ${d.captured_at ? new Date(d.captured_at).toLocaleString() : 'at checkpoint'}`;
  if(!picks.length){ out.innerHTML = '<div class="notice"><b>No bet.</b> None of today’s Top-3 form hitters met the exact two-game HR-gap condition at 11:17 AM.</div>'; return; }
  out.innerHTML = picks.map(p => `<div class="pick">
    <div><div class="player">#${p.rank} ${esc(p.player)}</div><div class="sub">${esc(p.team || '')} · form score ${p.score == null ? '—' : Number(p.score).toFixed(3)}</div></div>
    <div><div class="odds">${fmtOdds(p.odds)}</div><div class="sub">${esc(p.book)}</div></div>
    <div><b>HR 2 back</b><div class="sub">${esc(p.recent_games?.two_games_back?.date || '')}</div></div>
    <div><b>No HR last game</b><div class="sub">${esc(p.recent_games?.last_game?.date || '')}</div></div>
  </div>`).join('');
}

function renderLedger(d){
  const s=d.summary||{};
  $('#stats').innerHTML = `<div class="stat"><b>${s.bets ?? 0}</b><span>Settled bets</span></div><div class="stat"><b>${s.wins ?? 0}-${s.losses ?? 0}</b><span>Record</span></div><div class="stat"><b>${fmtPct(s.roi)}</b><span>Forward ROI</span></div><div class="stat"><b>${fmtU(s.net_units || 0)}</b><span>Net units</span></div>`;
  const rows=[...(d.entries||[])].reverse();
  $('#ledgerBody').innerHTML = rows.length ? rows.map(p=>`<tr class="${String(p.result||'pending').toLowerCase()}"><td>${esc(p.slate_date)}</td><td>${esc(p.player)}</td><td>#${p.rank}</td><td>${fmtOdds(p.odds)}</td><td>${esc(p.book)}</td><td><b>${esc(p.result)}</b></td><td>${fmtU(p.profit_units)}</td></tr>`).join('') : '<tr><td colspan="7" class="pending">Forward tracking begins September 7, 2026. No locked picks yet.</td></tr>';
}

(async()=>{
  try{
    const [latest, ledger] = await Promise.all([getJson('/data/recent-hr-rule/latest.json'), getJson('/data/recent-hr-rule/ledger.json')]);
    renderToday(latest); renderLedger(ledger);
  }catch(err){
    $('#todayStatus').textContent = `Unable to load rule data: ${err.message}`;
  }
})();
