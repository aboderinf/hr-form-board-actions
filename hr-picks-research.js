const HR_RESEARCH_ID = "hr-picks-research-panel";

const escHr = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[char]));
const pctHr = (value) => value == null ? "—" : `${Number(value) >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(1)}%`;
const unitsHr = (value) => value == null ? "—" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}u`;
const oddsHr = (value) => value == null ? "—" : `${Number(value) > 0 ? "+" : ""}${Math.round(Number(value))}`;

function ruleText(rule) {
  if (!rule) return "No stable rule";
  return `${rule.checkpoint} ET · ${rule.form} · ${rule.odds} · ${rule.book} · top ${rule.top_n}/slate`;
}

function summaryCards(winner) {
  const full = winner?.full || {};
  const holdout = winner?.holdout || {};
  return `<div class="grid">
    <div class="card"><div class="metric"><strong>${full.bets || 0}</strong><span>Calibration bets</span></div></div>
    <div class="card"><div class="metric"><strong>${pctHr(full.roi)}</strong><span>Calibration ROI</span></div></div>
    <div class="card"><div class="metric"><strong>${holdout.bets || 0}</strong><span>Untouched holdout bets</span></div></div>
    <div class="card"><div class="metric"><strong>${pctHr(holdout.roi)}</strong><span>Untouched holdout ROI</span></div></div>
  </div>`;
}

function checkpointRows(data) {
  const checkpoints = ["0817", "1117", "1717", "2017"];
  return checkpoints.map((checkpoint) => {
    const leader = data.checkpoint_leaders?.[checkpoint]?.[0];
    if (!leader) {
      return `<tr><td><b>${checkpoint}</b></td><td colspan="6" class="muted">No candidate cleared the robust calibration screen.</td></tr>`;
    }
    return `<tr>
      <td><b>${checkpoint}</b></td>
      <td>${escHr(ruleText(leader.rule))}</td>
      <td>${leader.full?.bets ?? 0}</td>
      <td>${pctHr(leader.full?.roi)}</td>
      <td>${leader.holdout?.bets ?? 0}</td>
      <td class="${Number(leader.holdout?.net_units || 0) >= 0 ? "plus" : "loss"}">${unitsHr(leader.holdout?.net_units)}</td>
      <td>${pctHr(leader.holdout?.roi)}</td>
    </tr>`;
  }).join("");
}

function holdoutLedger(rows) {
  if (!rows?.length) return '<div class="empty">No untouched-holdout selections for the calibration winner.</div>';
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.slate_date)) byDate.set(row.slate_date, []);
    byDate.get(row.slate_date).push(row);
  }
  let cumulative = 0;
  const body = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, picks]) => {
    const settled = picks.filter((row) => row.result === "WIN" || row.result === "LOSS");
    const wins = settled.filter((row) => row.result === "WIN").length;
    const losses = settled.length - wins;
    const net = settled.reduce((sum, row) => sum + Number(row.profit_units || 0), 0);
    cumulative += net;
    const details = picks.map((row) =>
      `${escHr(row.player || row.mlbam_id)} ${oddsHr(row.odds)} ${escHr(row.book || "")} · ${escHr(row.result)} ${unitsHr(row.profit_units)}`
    ).join("<br>");
    return `<tr>
      <td><b>${escHr(date)}</b></td>
      <td>${wins}–${losses}</td>
      <td class="${net >= 0 ? "plus" : "loss"}">${unitsHr(net)}</td>
      <td class="${cumulative >= 0 ? "plus" : "loss"}">${unitsHr(cumulative)}</td>
      <td>${details}</td>
    </tr>`;
  }).join("");
  return `<div class="tablewrap"><table>
    <thead><tr><th>Date</th><th>Record</th><th>Day net</th><th>Cumulative</th><th>Selections</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderHrResearch(data) {
  const existing = document.getElementById(HR_RESEARCH_ID);
  existing?.remove();
  if (location.hash !== "#discovery") return;
  const hero = document.querySelector("#app .hero");
  if (!hero) return;

  const research = data?.picks_research;
  if (!research) return;

  const panel = document.createElement("section");
  panel.id = HR_RESEARCH_ID;
  panel.className = "card section";

  if (research.status === "collecting") {
    panel.innerHTML = `<div class="eyebrow">HR PICKS RESEARCH</div><h2>Promotion study collecting</h2><p class="muted">${escHr(research.message || "")}</p>`;
  } else if (!research.winner) {
    panel.innerHTML = `<div class="eyebrow">HR PICKS RESEARCH</div><h2>No stable execution rule yet</h2><p class="muted">All four checkpoints are being searched using the same calibration/holdout discipline used by the 2+ bases and strikeout systems. No rule currently clears the calibration guardrails.</p>`;
  } else {
    const winner = research.winner;
    const holdout = winner.holdout || {};
    const gate = research.promotion_gate || {};
    const promoted = Boolean(research.promoted);
    panel.innerHTML = `
      <div class="eyebrow">HR PICKS RESEARCH · RULE DISCOVERY → HOLDOUT → PROMOTION</div>
      <h2>${promoted ? "PROMOTED HR execution rule" : "HOLD · calibration winner remains research-only"}</h2>
      <p><span class="pill">${promoted ? "PROMOTED" : "RESEARCH ONLY"}</span> <b>${escHr(ruleText(winner.rule))}</b></p>
      <p class="muted">The winner was chosen only from the calibration block. The final ${research.split?.holdout_complete_slates || 14} complete slates were left untouched until after rule selection.</p>
      ${summaryCards(winner)}
      <div class="notice"><b>Promotion gate:</b> ≥${gate.min_holdout_bets || 20} holdout bets · ≥${gate.min_holdout_slates || 5} slates · positive ROI · ≥${gate.min_profitable_slates || 3} profitable slates. Current holdout: ${holdout.bets || 0} bets · ${holdout.slates || 0} slates · ${holdout.profitable_slates || 0} profitable · ${pctHr(holdout.roi)} ROI.</div>
      <h3>Best robust candidate by checkpoint</h3>
      <div class="tablewrap"><table>
        <thead><tr><th>Checkpoint</th><th>Rule</th><th>Cal N</th><th>Cal ROI</th><th>Holdout N</th><th>Holdout net</th><th>Holdout ROI</th></tr></thead>
        <tbody>${checkpointRows(research)}</tbody>
      </table></div>
      <h3>Untouched holdout ledger · calibration winner</h3>
      <p class="muted">This is an audit backtest, not an official forward ledger unless the promotion gate passes.</p>
      ${holdoutLedger(research.holdout_ledger || [])}
      <details><summary><b>Method</b></summary>
        <p class="muted">${escHr(research.methodology?.search || "")} ${escHr(research.methodology?.calibration || "")} ${escHr(research.methodology?.guardrails || "")} ${escHr(research.methodology?.promotion || "")}</p>
      </details>
    `;
  }
  hero.insertAdjacentElement("afterend", panel);
}

let hrResearchData = null;
let hrResearchLoading = null;

async function loadHrResearch() {
  if (hrResearchData) return hrResearchData;
  if (hrResearchLoading) return hrResearchLoading;
  hrResearchLoading = fetch(`/data/discovery.json?v=${Date.now()}`, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`Discovery fetch failed: ${response.status}`);
      return response.json();
    })
    .then((data) => {
      hrResearchData = data;
      return data;
    })
    .finally(() => { hrResearchLoading = null; });
  return hrResearchLoading;
}

async function refreshHrResearch() {
  if (location.hash !== "#discovery") return;
  try {
    renderHrResearch(await loadHrResearch());
  } catch (error) {
    console.error("HR picks research unavailable", error);
  }
}

const observer = new MutationObserver(() => {
  if (location.hash === "#discovery" && !document.getElementById(HR_RESEARCH_ID)) {
    void refreshHrResearch();
  }
});
observer.observe(document.getElementById("app"), { childList: true, subtree: true });
addEventListener("hashchange", () => {
  hrResearchData = null;
  setTimeout(() => void refreshHrResearch(), 0);
});
setTimeout(() => void refreshHrResearch(), 0);
