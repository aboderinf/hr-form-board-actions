const { checkpointAuth } = require("../lib/checkpoint-runtime");
const { resolveQstash } = require("../lib/qstash-runtime");

const DESTINATION = "https://hr-form-board-actions.vercel.app/api/full-checkpoint-smoke";
const CALLBACK = "https://hr-form-board-actions.vercel.app/api/test-qstash-callback";

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }
  const auth = checkpointAuth();
  const resolved = await resolveQstash();
  const upstream = await fetch(`${resolved.base}/v2/publish/${DESTINATION}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.token}`,
      "Content-Type": "application/json",
      "Upstash-Method": "POST",
      "Upstash-Retries": "0",
      "Upstash-Timeout": "60s",
      "Upstash-Callback": CALLBACK,
      "Upstash-Forward-X-Checkpoint-Auth": auth,
      "Upstash-Redact-Fields": "header[X-Checkpoint-Auth]",
    },
    body: "{}",
    cache: "no-store",
  });
  const payload = await upstream.json().catch(() => ({}));
  response.setHeader("Cache-Control", "no-store");
  return response.status(upstream.ok ? 200 : 502).json({
    status: upstream.ok ? "queued" : "error",
    qstashStatus: upstream.status,
    messageId: payload.messageId || null,
    error: upstream.ok ? null : (payload.error || `QStash HTTP ${upstream.status}`),
  });
};
