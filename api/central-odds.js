const CENTRAL_ODDS_URL = "https://mlb-hr-edge.feranmi.chatgpt.site/api/odds";
const ALLOWED_QUERY_KEYS = new Set(["date", "checkpoint", "asOf", "latest"]);

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

  const target = `${CENTRAL_ODDS_URL}?${query.toString()}`;
  try {
    const upstream = await fetch(target, {
      method: "GET",
      headers: { "User-Agent": "hr-form-central-db-proxy/1.0" },
      cache: "no-store",
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      response.setHeader("Cache-Control", "no-store");
      return response.status(502).json({
        status: "error",
        source: "mlb-hr-edge-database",
        message: `Central database returned HTTP ${upstream.status}`,
      });
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      response.setHeader("Cache-Control", "no-store");
      return response.status(502).json({
        status: "error",
        source: "mlb-hr-edge-database",
        message: "Central database returned invalid JSON",
      });
    }

    if (payload?.source !== "mlb-hr-edge-database") {
      response.setHeader("Cache-Control", "no-store");
      return response.status(502).json({
        status: "error",
        source: "mlb-hr-edge-database",
        message: "Upstream response was not the central odds database",
      });
    }

    response.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=45");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("X-Odds-Source", "mlb-hr-edge-database");
    response.setHeader("X-Central-Database-Url", target);
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).json(payload);
  } catch (error) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(502).json({
      status: "error",
      source: "mlb-hr-edge-database",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
