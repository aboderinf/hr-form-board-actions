const EDGE_LEDGER_URL = "https://mlb-hr-edge.feranmi.chatgpt.site/api/ledger";

function validLedger(payload) {
  return (
    payload &&
    payload.source === "mlb-hr-edge-database" &&
    Array.isArray(payload.rows) &&
    payload.summary &&
    typeof payload.summary.settledBets === "number"
  );
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  try {
    const upstream = await fetch(EDGE_LEDGER_URL, {
      headers: { "User-Agent": "hr-form-tracker-network/1.0" },
      cache: "no-store",
    });
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok || !validLedger(payload)) {
      throw new Error(
        payload?.message || `MLB HR Edge tracker returned HTTP ${upstream.status}`,
      );
    }

    response.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=90");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("X-Tracker-Source", "mlb-hr-edge-database");
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).json(payload);
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
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
