const crypto = require("node:crypto");

const EDGE_BASE_URL = "https://mlb-hr-edge.feranmi.chatgpt.site";
const ALLOWED_QUERY_KEYS = new Set(["date", "checkpoint", "asOf", "latest"]);

async function fetchJson(url) {
  const upstream = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": "hr-form-central-db-proxy/2.0" },
    cache: "no-store",
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    throw new Error(`HTTP ${upstream.status} from ${url}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

function normalizeDashboard(dashboard, slateDate, sourceUrl) {
  if (dashboard?.source !== "database" || !Array.isArray(dashboard.rows)) {
    throw new Error("Dashboard response is not database-backed");
  }
  const canonical = JSON.stringify(dashboard);
  const generatedAt = dashboard.generatedAt || new Date().toISOString();
  const quoteCount = dashboard.rows.reduce(
    (total, row) => total + Object.keys(row?.odds || {}).length,
    0,
  );
  return {
    schemaVersion: 2,
    date: dashboard.date || slateDate,
    checkpoint: dashboard.checkpoint || null,
    asOf: generatedAt,
    generatedAt,
    latestIngestAt: generatedAt,
    status: quoteCount > 0 ? "ready" : "pending",
    source: "mlb-hr-edge-database",
    delivery: "central-database-dashboard-read",
    books: ["fanduel", "draftkings", "betmgm"],
    rowCount: dashboard.rows.length,
    quoteCount,
    allAvailableQuoteCount: Number(dashboard.allAvailableQuoteCount || quoteCount),
    excludedLiveOrPostStartQuoteCount: Number(
      dashboard.excludedLiveOrPostStartQuoteCount || 0,
    ),
    archivedCallCount: Number(dashboard.archivedCallCount || 1),
    providerCallId:
      dashboard.providerCallId || `dashboard:${slateDate}:${generatedAt}`,
    providerResponseSha256:
      dashboard.providerResponseSha256
      || crypto.createHash("sha256").update(canonical).digest("hex"),
    databaseUrl: sourceUrl,
    rows: dashboard.rows,
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const query = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(request.query || {})) {
    if (!ALLOWED_QUERY_KEYS.has(key)) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value != null && String(value).trim()) query.set(key, String(value).trim());
  }
  if (![...query.keys()].length) query.set("latest", "1");

  const oddsUrl = `${EDGE_BASE_URL}/api/odds?${query.toString()}`;
  const errors = [];
  let payload;
  let selectedUrl;

  try {
    const candidate = await fetchJson(oddsUrl);
    if (candidate?.source !== "mlb-hr-edge-database") {
      throw new Error("Odds response is not database-backed");
    }
    payload = candidate;
    selectedUrl = oddsUrl;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const slateDate = query.get("date");
  if (!payload && slateDate) {
    const dashboardUrl = `${EDGE_BASE_URL}/api/dashboard?${new URLSearchParams({ date: slateDate })}`;
    try {
      payload = normalizeDashboard(
        await fetchJson(dashboardUrl),
        slateDate,
        dashboardUrl,
      );
      selectedUrl = dashboardUrl;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!payload || !selectedUrl) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(502).json({
      status: "error",
      source: "mlb-hr-edge-database",
      message: "Central database is temporarily unavailable for this query",
      errors,
    });
  }

  response.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=45");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("X-Odds-Source", "mlb-hr-edge-database");
  response.setHeader("X-Central-Database-Url", selectedUrl);
  if (request.method === "HEAD") return response.status(200).end();
  return response.status(200).json(payload);
};
