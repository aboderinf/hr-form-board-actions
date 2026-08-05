const EDGE_TRACKER_URL = "https://mlb-hr-edge.feranmi.chatgpt.site/tracker";
const EDGE_LEGACY_TRACKER_URL = "https://mlb-hr-edge.feranmi.chatgpt.site/ledger";
const EDGE_LEDGER_ENDPOINT = "/api/edge-ledger";

let edgeLedger = null;
let edgeError = null;
let edgeLoading = false;
let lastLoadedAt = 0;

function trackerRouteActive() {
  return (location.hash.slice(1) || "today") === "tracker";
}

function activeEdgeTrackerUrl() {
  return edgeLedger?.activeTrackerUrl || EDGE_LEGACY_TRACKER_URL;
}

function percent(value) {
  if (value == null) return "—";
  return `${Number(value) >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(1)}%`;
}

function dollars(cents) {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(cents) / 100);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function networkMarkup() {
  const summary = edgeLedger?.summary || {};
  const trackerUrl = activeEdgeTrackerUrl();
  if (edgeLoading && !edgeLedger) {
    return `<div class="eyebrow">Cross-site tracker</div><h2>Loading MLB HR Edge tracker…</h2><p class="muted">Reading the central database ledger. The Form Board ledger below remains independent and available.</p>`;
  }
  if (edgeError) {
    return `<div class="eyebrow">Cross-site tracker</div><h2>MLB HR Edge tracker unavailable</h2><p class="muted">${escapeHtml(edgeError)}. No stale Edge record is being substituted.</p><p><button class="nav" type="button" data-edge-tracker-retry>Retry Edge tracker</button> <a class="nav" href="${EDGE_LEGACY_TRACKER_URL}">Open Edge ledger</a></p>`;
  }
  const routeNote = edgeLedger?.trackerRoute === "tracker"
    ? "The standardized /tracker route is live."
    : "The legacy /ledger route is being used until the standardized /tracker deployment is live.";
  return `<div class="eyebrow">Tracker network</div>
    <h2>Form strategy here · model strategy on MLB HR Edge</h2>
    <p class="muted">This page tracks the frozen Top 10 and Top 20 cumulative-form portfolios. MLB HR Edge separately tracks up to seven +500 to +900 model-EV selections from the same central odds database.</p>
    <div class="grid">
      <div class="card"><div class="metric"><strong>${summary.wins || 0}–${summary.losses || 0}${summary.pushes ? `–${summary.pushes}P` : ""}</strong><span>Edge model record</span></div></div>
      <div class="card"><div class="metric"><strong>${percent(summary.roi)}</strong><span>Edge model ROI</span></div></div>
      <div class="card"><div class="metric"><strong>${dollars(summary.profitCents)}</strong><span>Edge model net</span></div></div>
      <div class="card"><div class="metric"><strong>${edgeLedger?.rowCount ?? edgeLedger?.rows?.length ?? 0}</strong><span>Frozen Edge selections</span></div></div>
    </div>
    <p class="muted">${escapeHtml(routeNote)}</p>
    <p><a class="nav" href="${trackerUrl}">Open full MLB HR Edge tracker</a></p>`;
}

function mountTrackerNetwork() {
  const existing = document.querySelector("#edge-tracker-network");
  if (!trackerRouteActive()) {
    existing?.remove();
    return;
  }

  const sections = [...document.querySelectorAll("#app .shell > section")];
  if (!sections.length) return;
  const target = sections[1] || sections[0].nextSibling;
  const section = existing || document.createElement("section");
  section.id = "edge-tracker-network";
  section.className = "card section";
  const markup = networkMarkup();
  if (section.dataset.signature !== markup) {
    section.innerHTML = markup;
    section.dataset.signature = markup;
  }
  if (!existing) {
    if (target) target.parentNode.insertBefore(section, target);
    else sections[0].parentNode.appendChild(section);
  }
}

async function loadEdgeTracker(force = false) {
  if (edgeLoading) return;
  if (!force && edgeLedger && Date.now() - lastLoadedAt < 60_000) {
    mountTrackerNetwork();
    return;
  }
  edgeLoading = true;
  edgeError = null;
  mountTrackerNetwork();
  try {
    const response = await fetch(EDGE_LEDGER_ENDPOINT, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.source !== "mlb-hr-edge-database" || !Array.isArray(payload?.rows)) {
      throw new Error(payload?.message || `Tracker request failed: ${response.status}`);
    }
    edgeLedger = payload;
    lastLoadedAt = Date.now();
  } catch (error) {
    edgeError = error instanceof Error ? error.message : String(error);
  } finally {
    edgeLoading = false;
    mountTrackerNetwork();
  }
}

function syncTrackerRoute() {
  mountTrackerNetwork();
  if (trackerRouteActive()) void loadEdgeTracker();
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-edge-tracker-retry]")) return;
  void loadEdgeTracker(true);
});

addEventListener("hashchange", () => setTimeout(syncTrackerRoute, 0));
new MutationObserver(() => mountTrackerNetwork()).observe(document.querySelector("#app"), {
  childList: true,
  subtree: true,
});
setTimeout(syncTrackerRoute, 0);
