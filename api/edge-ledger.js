const EDGE_BASE_URL = "https://mlb-hr-edge.feranmi.chatgpt.site";
const EDGE_LEDGER_URL = `${EDGE_BASE_URL}/api/ledger`;
const EDGE_TRACKER_URL = `${EDGE_BASE_URL}/tracker`;
const EDGE_LEGACY_TRACKER_URL = `${EDGE_BASE_URL}/ledger`;

function validLedger(payload) {
  return (
    payload &&
    Array.isArray(payload.rows) &&
    payload.summary &&
    typeof payload.summary.settledBets === "number"
  );
}

async function inspectTrackerRoute(url, markers) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "hr-form-tracker-route-check/1.1" },
      cache: "no-store",
    });
    const html = await response.text();
    return response.ok && markers.every((marker) => html.includes(marker));
  } catch {
    return false;
  }
}

async function resolveTrackerRoute() {
  const [trackerReady, legacyReady] = await Promise.all([
    inspectTrackerRoute(EDGE_TRACKER_URL, [
      "FORWARD-TRACKED RECORD",
      "Central database ledger",
    ]),
    inspectTrackerRoute(EDGE_LEGACY_TRACKER_URL, ["Results ledger"]),
  ]);
  if (trackerReady) {
    return {
      activeTrackerUrl: EDGE_TRACKER_URL,
      trackerRoute: "tracker",
    };
  }
  if (legacyReady) {
    return {
      activeTrackerUrl: EDGE_LEGACY_TRACKER_URL,
      trackerRoute: "legacy-ledger",
    };
  }
  throw new Error("Neither MLB HR Edge tracker route is currently available");
}

function normalizeLedger(payload, route) {
  return {
    schemaVersion: Number(payload.schemaVersion || 1),
    status: payload.status === "unavailable" ? "unavailable" : "ready",
    source: "mlb-hr-edge-database",
    generatedAt: payload.generatedAt || new Date().toISOString(),
    rowCount: Number(payload.rowCount ?? payload.rows.length),
    rows: payload.rows,
    summary: payload.summary,
    trackerUrl: EDGE_TRACKER_URL,
    legacyTrackerUrl: EDGE_LEGACY_TRACKER_URL,
    activeTrackerUrl: route.activeTrackerUrl,
    trackerRoute: route.trackerRoute,
    compatibilityMode:
      payload.source === "mlb-hr-edge-database" ? "current-contract" : "legacy-ledger-normalized",
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  try {
    const [upstream, route] = await Promise.all([
      fetch(EDGE_LEDGER_URL, {
        headers: { "User-Agent": "hr-form-tracker-network/1.3" },
        cache: "no-store",
      }),
      resolveTrackerRoute(),
    ]);
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok || !validLedger(payload)) {
      throw new Error(
        payload?.message || `MLB HR Edge tracker returned HTTP ${upstream.status}`,
      );
    }
    const normalized = normalizeLedger(payload, route);

    response.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=90");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("X-Tracker-Source", "mlb-hr-edge-database");
    response.setHeader("X-Tracker-Compatibility", normalized.compatibilityMode);
    response.setHeader("X-Tracker-Route", normalized.trackerRoute);
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).json(normalized);
  } catch (error) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(502).json({
      schemaVersion: 1,
      status: "unavailable",
      source: "mlb-hr-edge-database",
      rows: [],
      summary: {
        settledBets: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        stakeCents: 0,
        profitCents: 0,
        roi: null,
        maximumDrawdownCents: null,
      },
      trackerUrl: EDGE_TRACKER_URL,
      legacyTrackerUrl: EDGE_LEGACY_TRACKER_URL,
      activeTrackerUrl: null,
      trackerRoute: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
