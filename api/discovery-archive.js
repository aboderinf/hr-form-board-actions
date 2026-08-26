const {
  ensureDiscoveryArchive,
} = require("../lib/discovery-runtime");
const {
  normalizeCheckpoint,
} = require("../lib/checkpoint-runtime");

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const date = String(request.query?.date || "").trim();
  const checkpoint = normalizeCheckpoint(request.query?.checkpoint);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !checkpoint) {
    return response.status(400).json({
      status: "error",
      message: "Use date=YYYY-MM-DD and checkpoint=0817|1117|1717|2017",
    });
  }

  try {
    const archive = await ensureDiscoveryArchive(date, checkpoint);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("X-Discovery-Source", "upstash-checkpoint-projection");
    if (!archive) {
      return response.status(404).json({
        status: "not_ready",
        date,
        checkpoint,
        message: "Exact Redis checkpoint is not available yet",
      });
    }
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).json(archive);
  } catch (error) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(503).json({
      status: "projection_error",
      date,
      checkpoint,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
