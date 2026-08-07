const {
  checkpointAuth,
  envFirst,
} = require("../lib/checkpoint-runtime");

const DESTINATION = "https://hr-form-board-actions.vercel.app/api/capture-checkpoint";
const CHECKPOINTS = ["0817", "1117", "1717", "2017"];

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const token = envFirst("QSTASH_TOKEN");
  const auth = checkpointAuth();
  if (!token || !auth) {
    return response.status(503).json({
      status: "not_ready",
      message: "QStash environment is missing from Vercel production",
    });
  }

  const results = [];
  for (const checkpoint of CHECKPOINTS) {
    const hour = Number(checkpoint.slice(0, 2));
    const scheduleId = `mlb-hr-checkpoint-${checkpoint}`;
    const cron = `CRON_TZ=America/New_York 17 ${hour} * 3-11 *`;
    const upstream = await fetch(
      `https://qstash.upstash.io/v2/schedules/${encodeURIComponent(DESTINATION)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Upstash-Cron": cron,
          "Upstash-Schedule-Id": scheduleId,
          "Upstash-Method": "POST",
          "Upstash-Retries": "3",
          "Upstash-Timeout": "45s",
          "Upstash-Forward-X-Checkpoint-Auth": auth,
          "Upstash-Redact-Fields": "header[X-Checkpoint-Auth]",
        },
        body: JSON.stringify({ checkpoint }),
        cache: "no-store",
      },
    );
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return response.status(502).json({
        status: "error",
        checkpoint,
        scheduleId,
        message: payload?.error || `QStash HTTP ${upstream.status}`,
        created: results,
      });
    }
    results.push({ checkpoint, scheduleId: payload.scheduleId || scheduleId, cron });
  }

  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({
    status: "configured",
    scheduler: "upstash-qstash",
    destination: DESTINATION,
    schedules: results,
  });
};
