const { resolveQstash } = require("../lib/qstash-runtime");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }
  try {
    const resolved = await resolveQstash();
    const params = new URLSearchParams({
      scheduleId: "mlb-hr-checkpoint-0817",
      fromDate: String(Date.parse("2026-08-07T12:15:00Z")),
      toDate: String(Date.parse("2026-08-07T13:30:00Z")),
      count: "50",
    });
    const upstream = await fetch(`${resolved.base}/v2/logs?${params}`, {
      headers: { Authorization: `Bearer ${resolved.token}` },
      cache: "no-store",
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return response.status(502).json({ status: "error", qstashStatus: upstream.status, message: payload?.error || "QStash log read failed" });
    }
    const logs = (payload.logs || []).map((row) => ({
      time: row.time || null,
      messageId: row.messageId || null,
      scheduleId: row.scheduleId || null,
      state: row.state || null,
      error: row.error || null,
      responseStatus: row.responseStatus ?? null,
      responseBody: row.responseBody || null,
      nextDeliveryTime: row.nextDeliveryTime || null,
      url: row.url || null,
      method: row.method || null,
      maxRetries: row.maxRetries ?? null,
      retryDelayExpression: row.retryDelayExpression || null,
    }));
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({ status: "ok", qstashApiBase: resolved.base, logCount: logs.length, logs });
  } catch (error) {
    return response.status(500).json({ status: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
