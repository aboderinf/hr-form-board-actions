const DATA_URL = "/data/hr-picks.json";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[c]));
const pct = (value, digits = 1) => value == null ? "-" : `${Number(value) >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(digits)}%`;
const units = (value) => value == null ? "-" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}u`;
const odds = (value) => value == null ? "-" : `${Number(value) > 0 ? "+" : ""}${Math.round(Number(value))}`;
const safe = (value) => value == null || value === "" ? "-" : String(value);
const record = (summary = {}) => `${Number(summary.wins || 0)}-${Number(summary.losses || 0)}${Number(summary.voids || 0) ? `  |  ${Number(summary.voids || 0)}V` : ""}`;

let payload = null;
let loading = null;

async function load() {
  if (payload) return payload;
  if (!loading) {
    loading = fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HR Picks data HTTP ${response.status}`);
        payload = await response.json();
        return payload;
      })
      .finally(() => { loading = null; });
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
    <small>${esc(record(summary))}  |  ${units(summary?.net_units)}${detail ? `  |  ${esc(detail)}` : ""}</small>
  </article>`;
}

function candidateTable(rows = []) {
  if (!rows.length) return '<div class="empty">No calibration candidate cleared the robustness screen.</div>';
  return `<div class="tablewrap"><table class="hrp-table">
    <thead><tr><th>#</th><th>Rule</th><th>Score</th><th>Early</th><th>Late</th><th>Full</th><th>Positive slates</th></tr></thead>
    <tbody>${rows.map((row, index) => `<tr>
      <td>${index + 1}</td>
      <td><b>${esc(row.rule?.label)}</b></td>
      <td>${Number(row.score || 0).toFixed(3)}</td>
      <td class="${Number(row.early?.roi || 0) >= 0 ? "plus" : "loss"}">${pct(row.early?.roi)}<div class="muted">${esc(record(row.early))}  |  N=${Number(row.early?.bets || 0)}</div></td>
      <td class="${Number(row.late?.roi || 0) >= 0 ? "plus" : "loss"}">${pct(row.late?.roi)}<div class="muted">${esc(record(row.late))}  |  N=${Number(row.late?.bets || 0)}</div></td>
      <td class="${Number(row.full?.roi || 0) >= 0 ? "plus" : "loss"}">${pct(row.full?.roi)}<div class="muted">${esc(record(row.full))}  |  N=${Number(row.full?.bets || 0)}</div></td>
      <td>${Number(row.full?.profitable_slates || 0)}/${Number(row.full?.slates || 0)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function picksTable(rows = []) {
  if (!rows.length) return '<div class="empty">No frozen-rule selections are available for this checkpoint yet.</div>';
  return `<div class="tablewrap"><table class="hrp-table">
    <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Best price</th><th>Book</th><th>Game</th><th>Status</th></tr></thead>
    <tbody>${rows.map((row, index) => `<tr>
      <td>${index + 1}</td>
      <td><b>${esc(row.player)}</b><div class="muted">${esc(row.team || "")}${row.matchup ? `  |  ${esc(row.matchup)}` : ""}</div></td>
      <td>${row.score == null ? "-" : Number(row.score).toFixed(4)}</td>
      <td class="plus"><b>${odds(row.odds)}</b></td>
      <td>${esc(row.book)}</td>
      <td>${esc(row.game_start_at || "-")}</td>
      <td><span class="pill">${esc(row.result || "PENDING")}</span></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function ledgerTable(daily = []) {
  if (!daily.length) return '<div class="empty">Clean forward tracking starts September 21, 2026. No frozen research snapshots have settled yet.</div>';
  return `<div class="tablewrap"><table class="hrp-table">
    <thead><tr><th>Date</th><th>Mode</th><th>Bets</th><th>Record</th><th>Net</th><th>ROI</th><th>Cumulative</th></tr></thead>
    <tbody>${[...daily].reverse().map((day) => `<tr>
      <td><b>${esc(day.slate_date)}</b></td>
      <td><span class="pill">${esc(day.mode || "research")}</span></td>
      <td>${Number(day.bets || 0)}</td>
      <td>${esc(record(day))}</td>
      <td class="${Number(day.net_units || 0) >= 0 ? "plus" : "loss"}">${units(day.net_units)}</td>
      <td class="${Number(day.roi || 0) >= 0 ? "plus" : "loss"}">${pct(day.roi)}</td>
      <td class="${Number(day.cumulative?.net_units || 0) >= 0 ? "plus" : "loss"}">${units(day.cumulative?.net_units)}<div class="muted">${pct(day.cumulative?.roi)}</div></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderBody(data) {
  const shell = document.querySelector("#app .shell");
  if (!shell) return;
  ensureNav();
  setNavActive();

  const header = shell.querySelector("header.top");
  const footer = shell.querySelector("footer.footer");
  [...shell.children].forEach((node) => {
    if (node !== header && node !== footer) node.remove();
  });

  const rule = data.rule || {};
  const winner = data.calibration?.winner || null;
  const early = winner?.early || {};
  const late = winner?.late || {};
  const full = winner?.full || {};
  const retro = data.retrospective?.summary || {};
  const forward = data.forward?.summary || {};
  const gate = data.promotion_gate || {};
  const promoted = Boolean(data.promoted);
  const current = data.current || {};

  const wrap = document.createElement("div");
  wrap.className = "hrp-root";
  wrap.innerHTML = `
    <section class="hero hrp-hero">
      <div class="card">
        <div class="eyebrow">HR PICKS  |  VALIDATED EXECUTION RESEARCH</div>
        <h1>${promoted ? "Promoted HR picks." : "Research first. Promote later."}</h1>
        <p class="muted">This uses the same architecture as the 2+ bases and strikeout systems: calibration-only rule discovery, stability gates, a frozen execution rule, clean forward tracking, and promotion only after the prospective sample passes.</p>
        <div class="notice"><b>${promoted ? "PROMOTED" : "RESEARCH / HOLD"}:</b> ${promoted ? `Official tracking began ${esc(gate.promoted_at)}.` : "Retrospective results cannot promote this rule. Only the clean forward ledger can."}</div>
      </div>
      <div class="card">
        <div class="eyebrow">Frozen research rule</div>
        <h2>${esc(rule.label || "Awaiting first rebuild")}</h2>
        <p class="muted">${rule.checkpoint ? `${esc(rule.checkpoint.slice(0,2))}:${esc(rule.checkpoint.slice(2))} ET  |  top ${esc(rule.top_n)} per slate` : "Discovery will populate this after the next archive rebuild."}</p>
        <div class="hrp-rule-grid">
          <div><span>Form</span><b>${esc(rule.form_label)}</b></div>
          <div><span>Odds</span><b>${esc(rule.odds_label)}</b></div>
          <div><span>Best-price book</span><b>${esc(rule.book_label)}</b></div>
          <div><span>Selection cap</span><b>${rule.top_n ? `Top ${esc(rule.top_n)}` : "-"}</b></div>
        </div>
      </div>
    </section>

    <section class="card section">
      <div class="eyebrow">Calibration only</div>
      <h2>How the rule was discovered</h2>
      <p class="muted">The winner is selected only from the fixed Aug. 4-Sep. 5 calibration block. The block is split into early and late recovered slates; both halves must stay profitable with positive market edge, minimum sample and slate coverage, and controlled profit concentration.</p>
      <div class="hrp-stats">
        ${metricCard("Early calibration", early)}
        ${metricCard("Late calibration", late)}
        ${metricCard("Full calibration", full, `${Number(full.profitable_slates || 0)}/${Number(full.slates || 0)} profitable slates`)}
      </div>
      <p class="muted">${Number(data.calibration?.passing_candidates || 0)} of ${Number(data.calibration?.candidates_tested || 0)} candidate rules cleared the full robustness screen  |  internal split ${esc(data.calibration?.split_date || "-")}.</p>
      <details><summary>Top calibration candidates</summary>${candidateTable(data.calibration?.top_candidates || [])}</details>
    </section>

    <section class="card section">
      <div class="eyebrow">Retrospective diagnostic  |  not promotion evidence</div>
      <h2>What happened after calibration</h2>
      <div class="hrp-stats">
        ${metricCard("Sep. 6-20 diagnostic", retro, `${Number(retro.profitable_slates || 0)}/${Number(retro.slates || 0)} profitable slates`)}
      </div>
      <p class="notice">${esc(data.retrospective?.note || "This period is diagnostic only.")}</p>
    </section>

    <section class="card section">
      <div class="eyebrow">Clean forward validation</div>
      <h2>Promotion ledger  |  ${esc(data.forward?.start || "2026-09-21")} onward</h2>
      <div class="hrp-stats">
        ${metricCard("Forward ROI", forward)}
        <article class="hrp-stat"><span>Settled bets</span><strong>${Number(forward.bets || 0)}</strong><small>Need ${Number(gate.requirements?.min_settled_bets || 20)}</small></article>
        <article class="hrp-stat"><span>Betting slates</span><strong>${Number(forward.slates || 0)}</strong><small>Need ${Number(gate.requirements?.min_betting_slates || 5)}</small></article>
        <article class="hrp-stat"><span>Profitable slates</span><strong>${Number(forward.profitable_slates || 0)}</strong><small>Need ${Number(gate.requirements?.min_profitable_slates || 3)}</small></article>
      </div>
      <p><span class="pill">${gate.passed ? "PROMOTION PASSED" : "PROMOTION HELD"}</span></p>
      ${ledgerTable(data.forward?.daily || [])}
    </section>

    <section class="card section">
      <div class="eyebrow">Selected slate execution</div>
      <h2>${esc(current.slate_date || "Today")}  |  ${rule.checkpoint ? `${esc(rule.checkpoint.slice(0,2))}:${esc(rule.checkpoint.slice(2))} ET` : "checkpoint pending"}</h2>
      <p class="muted">${current.status === "official" ? "Official frozen selections." : current.status === "research" ? "Frozen research selections. These are tracked prospectively but are not promoted official picks yet." : "The frozen checkpoint snapshot is not available yet."}</p>
      ${picksTable(current.picks || [])}
    </section>

    <section class="card section">
      <div class="eyebrow">Method guardrails</div>
      <h2>Why this is different from chasing Discovery ROI</h2>
      <table><tbody>
        <tr><td>Candidate choice</td><td>${esc(data.methodology?.discovery || "Calibration-only rule grid")}</td></tr>
        <tr><td>Calibration</td><td>${esc(data.methodology?.calibration || "Early/late stability")}</td></tr>
        <tr><td>Retrospective block</td>${esc(data.methodology?.retrospective || "Diagnostic only")}</td></tr>
        <tr><td>Forward promotion</td><td>${esc(data.methodology?.forward || "Clean prospective tracking")}</td></tr>
        <tr><td>Execution</td><td>${esc(data.methodology?.execution || "Frozen checkpoint snapshot")}</td></tr>
      </tbody></table>
    </section>
  </div>`;

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
    renderBody(data);
  } catch (error) {
    const header = shell.querySelector("header.top");
    const footer = shell.querySelector("footer.footer");
    [...shell.children].forEach((node) => {
      if (node !== header && node !== footer) node.remove();
    });
    const section = document.createElement("section");
    section.className = "card section";
    section.innerHTML = `<div class="eyebrow">HR PICKS</div><h2>Research data unavailable</h2><p class="loss">${esc(error.message || error)}</p>`;
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
  .hrp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0}
  .hrp-stat{border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:14px}
  .hrp-stat strong{display:block;font-size:1.35rem;margin:6px 0}
  .hrp-stat small{color:var(--muted,#8492a6)}
  .hrp-table .muted{font-size:.78rem;margin-top:3px}
  .hrp-root details{margin-top:16px}
  .hrp-root summary{cursor:pointer;font-weight:700}
  @media(max-width:800px){.hrp-stats,.hrp-rule-grid{grid-template-columns:1fr 1fr}}
  @media(max-width:520px){.hrp-stats,.hrp-rule-grid{grid-template-columns:1fr}}
`;
document.head.appendChild(style);

const observer = new MutationObserver(() => {
  ensureNav();
  void renderIfNeeded();
});
observer.observe(document.getElementById("app"), { childList: true, subtree: true });
addEventListener("hashchange", () => setTimeout(() => void renderIfNeeded(), 0));
setTimeout(() => void renderIfNeeded(), 0);
