const $ = (s) => document.querySelector(s);
const fmtOdds = (n) => n == null || n === '' ? '—' : `${Number(n) > 0 ? '+' : ''}${Math.round(Number(n))}`;
const fmtPct = (n) => n == null ? '—' : `${(Number(n) * 100).toFixed(1)}%`;
const fmtU = (n) => n == null ? '—' : `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(2)}u`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

const DISCOVERY = {
  top3: {label:'Top 3', n1117:19, roi1117:1.3811, nAll:53, roiAll:0.839},
  extension: {label:'Ranks 4–5', n1117:15, roi1117:-0.1067, nAll:42, roiAll:-0.1593},
};

async function getJson(path){
  const r = await fetch(`${path}?v=${Date.now()}`, {cache:'no-store'});
  if(!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function getOptionalJson(path){
  try { return await getJson(path); } catch { return null; }
}

function recentPair(player){
  const games = (player.recent_games || []).filter(g => Number(g.plate_appearances || 0) > 0);
  return {last:games[0] || null, two:games[1] || null};
}

function exactTwoGap(player){
  const {last,two}=recentPair(player);
  return Boolean(last && two && Number(last.home_runs || 0) === 0 && Number(two.home_runs || 0) > 0);
}

function archiveRows(archive){
  return archive?.players || archive?.entries || [];
}

function samePlayer(a,b){
  if(a?.mlbam_id != null && b?.mlbam_id != null) return String(a.mlbam_id) === String(b.mlbam_id);
  return String(a?.player || '').trim().toLowerCase() === String(b?.player || '').trim().toLowerCase();
}

function priceFor(player, archive){
  const row = archiveRows(archive).find(r => samePlayer(player,r));
  if(row){
    const all = Array.isArray(row.all_prices) ? row.all_prices : [];
    if(all.length){
      const best=[...all].sort((a,b)=>Number(b.odds ?? -Infinity)-Number(a.odds ?? -Infinity))[0];
      return {odds:best?.odds ?? row.best_odds ?? null, book:best?.book ?? row.best_book ?? null};
    }
    return {odds:row.best_odds ?? row.odds ?? null, book:row.best_book ?? row.book ?? null};
  }
  return {odds:player.best_odds ?? null, book:player.best_book ?? null};
}

function officialIds(latest){
  return new Set((latest?.picks || []).map(p => p.mlbam_id != null ? `id:${p.mlbam_id}` : `name:${String(p.player||'').toLowerCase()}`));
}

function officialHas(player, ids){
  return ids.has(player.mlbam_id != null ? `id:${player.mlbam_id}` : `name:${String(player.player||'').toLowerCase()}`);
}

function roiCell(value,n){
  const cls=Number(value)>=0?'roi-pos':'roi-neg';
  return `<span class="${cls}">${Number(value)>=0?'+':''}${(Number(value)*100).toFixed(1)}%</span><div class="sub">N=${n}</div>`;
}

function renderBoard(top100, archive, latest){
  const status=$('#boardStatus');
  const body=$('#boardBody');
  const rows=[...(top100?.players || [])].sort((a,b)=>Number(a.rank||999)-Number(b.rank||999)).slice(0,5);
  const slate=top100?.slate_date || latest?.slate_date || 'today';
  const archiveReady=Boolean(archive);
  const ids=officialIds(latest);

  status.textContent = `${slate} · Top 5 current form ranks · ${archiveReady ? '11:17 prices available' : '11:17 archive unavailable; price cells remain blank unless present on current board'}`;
  if(!rows.length){
    body.innerHTML='<tr><td colspan="12" class="pending">No current Top-5 form rows are available.</td></tr>';
    return;
  }

  body.innerHTML=rows.map(p=>{
    const rank=Number(p.rank || 999);
    const tier=rank<=3 ? DISCOVERY.top3 : DISCOVERY.extension;
    const pair=recentPair(p);
    const qualifies=exactTwoGap(p);
    const price=priceFor(p,archive);
    const locked=officialHas(p,ids);
    let dailyStatus='Pattern not met';
    if(locked) dailyStatus='LOCKED PICK';
    else if(qualifies && rank<=3 && latest?.status==='ready') dailyStatus='Top-3 exact-2 candidate';
    else if(qualifies && rank<=3) dailyStatus='Top-3 candidate · 11:17 lock pending';
    else if(qualifies) dailyStatus='Top-5 extension candidate';
    const tagClass=locked || (qualifies && rank<=3) ? 'primary' : qualifies ? 'qualifies' : 'reject';
    const tierText=rank<=3 ? 'Top 3 · frozen tier' : 'Ranks 4–5 · extension';
    return `<tr class="${qualifies?'qualifier':''}">
      <td><b>#${rank}</b></td>
      <td><b>${esc(p.player)}</b><div class="sub">${esc(p.team || '')}</div></td>
      <td><span class="tag ${rank<=3?'primary':''}">${esc(tierText)}</span></td>
      <td>${p.score==null?'—':Number(p.score).toFixed(3)}<div class="sub">L5 ${p.hr_games_l5 ?? '—'} · L7 ${p.hr_games_l7 ?? '—'} · L15 ${p.hr_games_l15 ?? '—'}</div></td>
      <td><b>${pair.last ? Number(pair.last.home_runs||0) : '—'}</b><div class="sub">${esc(pair.last?.date || '')}</div></td>
      <td><b>${pair.two ? Number(pair.two.home_runs||0) : '—'}</b><div class="sub">${esc(pair.two?.date || '')}</div></td>
      <td><span class="tag ${qualifies?'qualifies':'reject'}">${qualifies?'YES':'NO'}</span></td>
      <td><b>${fmtOdds(price.odds)}</b></td>
      <td>${esc(price.book || '—')}</td>
      <td>${roiCell(tier.roi1117,tier.n1117)}</td>
      <td>${roiCell(tier.roiAll,tier.nAll)}</td>
      <td><span class="tag ${tagClass}">${esc(dailyStatus)}</span></td>
    </tr>`;
  }).join('');
}

function renderToday(d){
  const status = $('#todayStatus');
  const out = $('#todayPicks');
  if(d.status !== 'ready'){
    status.textContent = `11:17 AM checkpoint archive is not locked for ${d.slate_date || 'today'}. The broader Top-5 table above still shows current form/recent-HR candidates, but they are not counted in the forward ledger until the checkpoint is recovered.`;
    out.innerHTML = '<div class="notice">No official forward selections have been locked yet.</div>';
    return;
  }
  const picks = d.picks || [];
  status.textContent = `${d.slate_date} · ${picks.length} qualifying pick${picks.length===1?'':'s'} · captured ${d.captured_at ? new Date(d.captured_at).toLocaleString() : 'at checkpoint'}`;
  if(!picks.length){ out.innerHTML = '<div class="notice"><b>No bet.</b> None of the 11:17 Top-3 hitters met the exact two-game HR-gap condition.</div>'; return; }
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
    const [latest, ledger, top100] = await Promise.all([
      getJson('/data/recent-hr-rule/latest.json'),
      getJson('/data/recent-hr-rule/ledger.json'),
      getJson('/data/top100.json'),
    ]);
    const slate=top100?.slate_date || latest?.slate_date;
    const archive=slate ? await getOptionalJson(`/data/discovery/archive/${slate}_1117.json`) : null;
    renderBoard(top100,archive,latest);
    renderToday(latest);
    renderLedger(ledger);
  }catch(err){
    $('#boardStatus').textContent = `Unable to load today’s broader board: ${err.message}`;
    $('#todayStatus').textContent = `Unable to load rule data: ${err.message}`;
  }
})();
