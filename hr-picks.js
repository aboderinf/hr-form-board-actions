const PRIMARY_URL = "/data/hr-picks.json";
const COMPANION_URL = "/data/hr-companion.json";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[c]));
const pct = (value, digits = 1) => value == null ? "-" : `${Number(value) >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(digits)}%`;
const units = (value) => value == null ? "-" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}u`;
const odds = (value) => value == null ? "-" : `${Number(value) > 0 ? "+" : ""}${Math.round(Number(value))}`;
const record = (summary = {}) => `${Number(summary.wins || 0)}-${Number(summary.losses || 0)}${Number(summary.voids || 0) ? ` | ${Number(summary.voids || 0)}V` : ""}`;

let bundle = null;
let loading = null;

async function fetchJson(url, required = true) {
  const response = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    if (!required) return null;
    throw new Error(`${url} HTTP ${response.status}`);
  }
  return response.json();
}

async function load() {
  if (bundle) return bundle;
  if (!loading) {
    loading = Promise.all([
      fetchJson(PRIMARY_URL, true),
      fetchJson(COMPANION_URL, false),
    ]).then(([primary, companion]) => {
      bundle = { primary, companion };
      return bundle;
    }).finally(() => { loading = null; });
  }
  return loading;
}

function ensureNav() {
  const nav = document.querySelector(".top nav");
  if (!nav || nav.querySelector('[href="#picks"]')) return;
  const link = document.createElement("a");
  link.className = "nav";
  link.href = "#picks";
  link.textContent = "HR Picks";
  const discovery = nav.querySelector('[href="#discovery"]');
  if (discovery?.nextSibling) nav.insertBefore(link, discovery.nextSibling);
  else nav.appendChild(link);
}

function setNavActive() {
  document.querySelectorAll(".top nav .nav").forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === "#picks");
  });
}

function metricCard(label, summary, detail = "") {
  return `<article class="hrp-stat">
    <span>${esc(label)}</span>
    <strong class="${Number(summary?.roi || 0) >= 0 ? "plus" : "loss"}">${pct(summary?.roi)}</strong>
    <small>${esc(record(summary))} | ${units(summary?.net_units)}${detail ? ` | ${esc(detail)}` : ""}</small>
  </article>`;
}

function picksTable(rows = [], showCell = false) {
  if (!rows.length) return '<div class="empty">No selections are frozen for the available checkpoint(s) yet.</div>';
  return `<div class="tablewrap"><table class="hrp-table">
    <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Price</th><th>Book</th>${showCell ? "<th>Trigger cell</th>" : ""}<th>Game</th><th>Status</th></tr></thead>
    <tbody>${rows.map((row, index) => `<tr>
      <td>${index + 1}</td>
      <td><b>${esc(row.player)}</b><div class="muted">${esc(row.team || "")}${row.matchup ? ` | ${esc(row.matchup)}` : ""}</div></td>
      <td>${row.score == null ? "-" : Number(row.score).toFixed(4)}</td>
      <td class="plus"><b>${odds(row.odds)}</b></td>
      <td>${esc(row.book)}</td>
      ${showCell ? `<td>${esc(row.cell?.label || "-")}</td>` : ""}
      <td>${esc(row.game_start_at || "-")}</td>
      <td><span class="pill">${esc(row.result || "PENDING")}</span></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function ledgerTable(daily = [], type = "primary") {
  if (!daily.length) return '<div class="empty">Forward tracking begins September 21, 2026. No daily ledger rows are available yet.</div>';
  return `<div class="tablewrap"><table class="hrp-table">
    <thead><tr><th>Date</th><th>${type === "companion" ? "Checkpoints" : "Mode"}</th><th>Bets</th><th>Record</th><th>Net</th><th>ROI</th><th>Cumulative</th></tr></thead>
    <tbody>${[...daily].reverse().map((day) => `<tr>
      <td><b>${esc(day.slate_date)}</b></td>
      <td><span class="pill">${esc(type === "companion" ? (day.checkpoints || []).join(", ") : (day.mode || "primary"))}</span></td>
      <td>${Number(day.bets || 0)}</td>
      <td>${esc(record(day))}</td>
      <td class="${Number(day.net_units || 0) >= 0 ? "plus" : "loss"}">${units(day.net_units)}</td>
      <td class="${Number(day.roi || 0) >= 0 ? "plus" : "loss"}">${pct(day.roi)}</td>
      <td class="${Number(day.cumulative?.net_units || 0) >= 0 ? "plus" : "loss"}">${units(day.cumulative?.net_units)}<div class="muted">${pct(day.cumulative?.roi)}</div></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function candidateTable(rows = []) {
  if (!rows.length) return '<div class="empty">No calibration candidate cleared the robustness screen.</div>';
  return `<div class="tablewrap"><table class="hrp-table">
    <thead><tr><th>#</th><th>Rule</th><th>Score</th><th>Early</th><th>Late</th><th>Full</th><th>Positive slates</th></tr></thead>
    <tbody>${rows.map((row, index) => `<tr>
      <td>${index + 1}</td>
      <td><b>${esc(row.rule?.label)}</b></td>
      <td>${Number(row.score || 0).toFixed(3)}</td>
      <td class="${Number(row.early?.roi || 0) >= 0 ? "plus" : "loss"}">${pct(row.early?.roi)}<div class="muted">${esc(record(row.early))} | N=${Number(row.early?.bets || 0)}</div></td>
      <td class="${Number(row.late?.roi || 0) >= 0 ? "plus" : "loss"}">${pct(row.late?.roi)}<div class="muted">${esc(record(row.late))} | N=${Number(row.late?.bets || 0)}</div></td>
      <td class="${Number(row.full?.roi || 0) >= 0 ? "plus" : "loss"}">${pct(row.full?.roi)}<div class="muted">${esc(record(row.full))} | N=${Number(row.full?.bets || 0)}</div></td>
      <td>${Number(row.full?.profitable_slates || 0)}/${Number(row.full?.slates || 0)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function companionCheckpointCards(current = {}) {
  const rows = current.checkpoints || [];
  if (!rows.length) return '<div class="empty">No companion checkpoint has been frozen for this slate yet.</div>';
  return `<div class="hrp-checkpoint-grid">${rows.map((row) => `
    <article class="hrp-stat">
      <span>${esc(row.checkpoint)} ET</span>
      <strong>${Number(row.picks?.length || 0)}</strong>
      <small>${Number(row.qualified_cells?.length || 0)} qualifying evidence-gated cells</small>
    </article>`).join("")}</div>`;
}

function renderBody(primary, companion) {
  const shell = document.querySelector("#app .shell");
  if (!shell) return;
  ensureNav();
  setNavActive();

  const header = shell.querySelector("header.top");
  const footer = shell.querySelector("footer.footer");
  [...shell.children].forEach((node) => {
    if (node !== header && node !== footer) node.remove();
  });

  const rule = primary.rule || {};
  const winner = primary.calibration?.winner || null;
  const full = winner?.full || {};
  const pForward = primary.forward?.summary || {};
  const pCurrent = primary.current || {};
  const gate = primary.promotion_gate || {};
  const cForward = companion?.forward?.summary || {};
  const cCurrent = companion?.current || {};

  const wrap = document.createElement("div");
  wrap.className = "hrp-root";
  wrap.innerHTML = `
    <section class="hero hrp-hero">
      <div class="card">
        <div class="eyebrow">HR PICKS | TWO DAILY STRATEGIES</div>
        <h1>Primary + companion.</h1>
        <p class="muted">Both strategies freeze pregame sportsbook prices into separate daily ledgers. The primary is a fixed validated slice; the companion dynamically re-evaluates evidence-gated slices at all four checkpoints using prior settled data only.</p>
        <div class="hrp-stats">
          ${metricCard("Primary forward", pForward)}
          ${metricCard("Companion forward", cForward)}
        </div>
      </div>
      <div class="card">
        <div class="eyebrow">PRIMARY RULE | ACTIVE</div>
        <h2>${esc(rule.label || "1717 · 0.100–0.199 · +400–499 · top 3/slate")}</h2>
        <div class="hrp-rule-grid">
          <div><span>Checkpoint</span><b>17:17 ET</b></div>
          <div><span>Form</span><b>${esc(rule.form_label || "0.100–0.199")}</b></div>
          <div><span>Odds</span><b>${esc(rule.odds_label || "+400–499")}</b></div>
          <div><span>Daily cap</span><b>Top 3</b></div>
        </div>
        <p class="muted">Ranking: highest HR Form score, then best archived price. The exact checkpoint price is frozen in the ledger.</p>
      </div>
    </section>

    <section class="card section">
      <div class="eyebrow">PRIMARY | TODAY</div>
      <h2>${esc(pCurrent.slate_date || "Today")} · 17:17 ET</h2>
      <p class="muted">${pCurrent.status === "checkpoint_pending" ? "The primary checkpoint has not been archived yet." : "Primary selections are active and frozen for forward tracking."}</p>
      ${picksTable(pCurrent.picks || [])}
    </section>

    <section class="card section">
      <div class="eyebrow">PRIMARY | DAILY LEDGER</div>
      <h2>Frozen primary record</h2>
      <div class="hrp-stats">
        ${metricCard("Forward ROI", pForward)}
        <article class="hrp-stat"><span>Settled bets</span><strong>${Number(pForward.bets || 0)}</strong><small>${esc(record(pForward))}</small></article>
        <article class="hrp-stat"><span>Betting slates</span><strong>${Number(pForward.slates || 0)}</strong><small>Forward only</small></article>
        <article class="hrp-stat"><span>Validation gate</span><strong>${gate.passed ? "PASS" : "TRACKING"}</strong><small>Evidence metric; does not suppress daily primary execution</small></article>
      </div>
      ${ledgerTable(primary.forward?.daily || [], "primary")}
    </section>

    <section class="card section hrp-companion">
      <div class="eyebrow">COMPANION RULE | ACTIVE</div>
      <h2>Dynamic evidence-gated volume</h2>
      <p class="muted">At 08:17, 11:17, 17:17 and 20:17 ET, the companion evaluates checkpoint × HR Form band × odds band cells. A cell must be profitable and evidence-gated in all-history, trailing 30 days and trailing 14 days, with broader parent-slice support. Every qualifying pregame player is selected; there is no pick cap.</p>
      <div class="notice"><b>Freeze rule:</b> if the same player qualifies again later, the first qualifying checkpoint wins. The original book and price never change.</div>
      ${companion ? companionCheckpointCards(cCurrent) : '<div class="empty">Companion data is being initialized by the next Discovery rebuild.</div>'}
      ${companion ? picksTable(cCurrent.picks || [], true) : ""}
    </section>

    <section class="card section">
      <div class="eyebrow">COMPANION | DAILY LEDGER</div>
      <h2>Higher-volume companion record</h2>
      <div class="hrp-stats">
        ${metricCard("Forward ROI", cForward)}
        <article class="hrp-stat"><span>Settled bets</span><strong>${Number(cForward.bets || 0)}</strong><small>${esc(record(cForward))}</small></article>
        <article class="hrp-stat"><span>Betting slates</span><strong>${Number(cForward.slates || 0)}</strong><small>All four checkpoints combined</small></article>
        <article class="hrp-stat"><span>Selection cap</span><strong>NONE</strong><small>Every qualifying pregame candidate</small></article>
      </div>
      ${companion ? ledgerTable(companion.forward?.daily || [], "companion") : '<div class="empty">Companion ledger will appear after the Discovery rebuild creates its first snapshot.</div>'}
    </section>

    <section class="card section">
      <div class="eyebrow">PRIMARY EVIDENCE</div>
      <h2>Frozen-rule validation</h2>
      <p class="muted">The primary rule came from the fixed Aug. 4–Sep. 5 calibration block and remains frozen for forward execution.</p>
      <div class="hrp-stats">
        ${metricCard("Full calibration", full, `${Number(full.profitable_slates || 0)}/${Number(full.slates || 0)} profitable slates`)}
        ${metricCard("Sep. 6–20 diagnostic", primary.retrospective?.summary || {})}
      </div>
      <details><summary>Top calibration candidates</summary>${candidateTable(primary.calibration?.top_candidates || [])}</details>
    </section>

    <section class="card section">
      <div class="eyebrow">COMPANION GUARDRAILS</div>
      <h2>Dynamic, but not hindsight-driven</h2>
      <table><tbody>
        <tr><td>Historical input</td><td>${esc(companion?.methodology?.history || "Prior complete settled slates only")}</td></tr>
        <tr><td>Evidence gate</td><td>${esc(companion?.methodology?.evidence_gate || "40 settled, 4 wins, 5 slates, positive net in all-history / 30d / 14d")}</td></tr>
        <tr><td>Expected return</td><td>${esc(companion?.methodology?.weighted_return || "Positive settled-bet-weighted ROI across all three horizons")}</td></tr>
        <tr><td>Support</td><td>${esc(companion?.methodology?.support || "At least two broader parent slices must remain positive with sample")}</td></tr>
        <tr><td>Execution</td><td>${esc(companion?.methodology?.execution || "All qualifying pregame players; first checkpoint freezes duplicates")}</td></tr>
      </tbody></table>
    </section>
  `;

  if (footer) shell.insertBefore(wrap, footer);
  else shell.appendChild(wrap);
}

async function renderIfNeeded() {
  ensureNav();
  if ((location.hash.slice(1) || "today") !== "picks") return;
  setNavActive();
  if (document.querySelector("#app .hrp-root")) return;
  const shell = document.querySelector("#app .shell");
  if (!shell) return;
  try {
    const data = await load();
    if ((location.hash.slice(1) || "today") !== "picks") return;
    renderBody(data.primary, data.companion);
  } catch (error) {
    const header = shell.querySelector("header.top");
    const footer = shell.querySelector("footer.footer");
    [...shell.children].forEach((node) => {
      if (node !== header && node !== footer) node.remove();
    });
    const section = document.createElement("section");
    section.className = "card section";
    section.innerHTML = `<div class="eyebrow">HR PICKS</div><h2>Daily rules unavailable</h2><p class="loss">${esc(error.message || error)}</p>`;
    if (footer) shell.insertBefore(section, footer);
    else shell.appendChild(section);
  }
}

const style = document.createElement("style");
style.textContent = `
  .hrp-root{display:contents}
  .hrp-hero{margin-top:0}
  .hrp-rule-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}
  .hrp-rule-grid>div{border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:12px}
  .hrp-rule-grid span,.hrp-stat span{display:block;font-size:.76rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted,#8492a6)}
  .hrp-rule-grid b{display:block;margin-top:4px}
  .hrp-stats,.hrp-checkpoint-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0}
  .hrp-stat{border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:14px}
  .hrp-stat strong{display:block;font-size:1.35rem;margin:6px 0}
  .hrp-stat small{color:var(--muted,#8492a6)}
  .hrp-table .muted{font-size:.78rem;margin-top:3px}
  .hrp-root details{margin-top:16px}
  .hrp-root summary{cursor:pointer;font-weight:700}
  .hrp-companion{border-width:2px}
  @media(max-width:800px){.hrp-stats,.hrp-checkpoint-grid,.hrp-rule-grid{grid-template-columns:1fr 1fr}}
  @media(max-width:520px){.hrp-stats,.hrp-checkpoint-grid,.hrp-rule-grid{grid-template-columns:1fr}}
`;
document.head.appendChild(style);

const observer = new MutationObserver(() => {
  ensureNav();
  void renderIfNeeded();
});
observer.observe(document.getElementById("app"), { childList: true, subtree: true });
addEventListener("hashchange", () => setTimeout(() => void renderIfNeeded(), 0));
setTimeout(() => void renderIfNeeded(), 0);
