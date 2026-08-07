const { checkpointAuth } = require("../lib/checkpoint-runtime");
const { resolveQstash } = require("../lib/qstash-runtime");

const DESTINATION = "https://hr-form-board-actions.vercel.app/api/capture-checkpoint";

module.exports = async function handler(request, response) {
  if (request.method !== "POST" && request.method !== "GET") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const auth = checkpointAuth();
  if (!auth) {
    return response.status(503).json({ status: "not_ready", message: "Checkpoint auth unavailable" });
  }

  let resolved;
  try {
    resolved = await resolveQstash();
  } catch (error) {
    return response.status(503).json({
      status: "not_ready",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const upstream = await fetch(`${resolved.base}/v2/publish/${DESTINATION}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.token}`,
      "Content-Type": "application/json",
      "Upstash-Method": "POST",
      "Upstash-Retries": "0",
      "Upstash-Timeout": "30s",
      "Upstash-Forward-X-Checkpoint-Auth": auth,
      "Upstash-Redact-Fields": "header[X-Checkpoint-Auth]",
    },
    body: JSON.stringify({ date: "2026-08-07", checkpoint: "0817" }),
    cache: "no-store",
  });
  const payload = await upstream.json().catch(() => ({}));
  response.setHeader("Cache-Control", "no-store");
  return response.status(upstream.ok ? 200 : 502).json({
    status: upstream.ok ? "queued" : "error",
    qstashApiBase: resolved.base,
    destination: DESTINATION,
    testDate: "2026-08-07",
    testCheckpoint: "0817",
    expectedCaptureOutcome: "outside_window",
    expectedProviderRequests: 0,
    qstashStatus: upstream.status,
    messageId: payload.messageId || null,
    error: upstream.ok ? null : (payload.error || `QStash HTTP ${upstream.status}`),
  });
};
