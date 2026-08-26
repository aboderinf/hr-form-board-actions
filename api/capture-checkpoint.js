const {
  captureCheckpoint,
  checkpointAuth,
  envFirst,
  intendedSlateDate,
  normalizeCheckpoint,
  redisCommand,
  redisConfig,
  safeEqual,
} = require("../lib/checkpoint-runtime");
const {
  ensureDiscoveryArchive,
} = require("../lib/discovery-runtime");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const expected = checkpointAuth();
  const supplied = request.headers["x-checkpoint-auth"];
  if (!expected || !safeEqual(supplied, expected)) {
    return response.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const redis = redisConfig();
  const missing = [];
  if (!redis.url || !redis.token) missing.push("Upstash Redis");

  let providerKey = envFirst("SPORTSGAMEODDS_API_KEY");
  if (!providerKey && redis.url && redis.token) {
    try {
      providerKey = String(await redisCommand(["GET", "mlbhr:config:sportsgameodds-api-key"]) || "").trim();
      if (providerKey) process.env.SPORTSGAMEODDS_API_KEY = providerKey;
    } catch {
      providerKey = "";
    }
  }
  if (!providerKey) missing.push("SPORTSGAMEODDS_API_KEY");

  if (missing.length) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(503).json({
      status: "configuration_missing",
      providerRequests: 0,
      missing,
    });
  }

  const body = request.body && typeof request.body === "object" ? request.body : {};
  const checkpoint = normalizeCheckpoint(body.checkpoint);
  if (!checkpoint) {
    return response.status(400).json({ status: "error", message: "Invalid checkpoint" });
  }

  const now = new Date();
  const slateDate = String(body.date || intendedSlateDate(checkpoint, now));
  try {
    const result = await captureCheckpoint({ slateDate, checkpoint, now });
    const payload = result.payload || null;
    let discoveryArchive = null;
    let discoveryArchiveError = null;

    if (payload && ["captured", "reused"].includes(result.outcome)) {
      try {
        const projected = await ensureDiscoveryArchive(slateDate, checkpoint);
        discoveryArchive = projected ? {
          status: "ready",
          top100Rows: Number(projected.top100_rows || 0),
          pricedRows: Number(projected.priced_rows || 0),
          pregamePricedRows: Number(projected.pregame_priced_rows || 0),
          providerCallId: projected.source?.provider_call_id || null,
        } : { status: "not_ready" };
      } catch (error) {
        discoveryArchive = { status: "projection_error" };
        discoveryArchiveError = error instanceof Error ? error.message : String(error);
      }
    }

    const terminal = [
      "captured",
      "reused",
      "already_attempted",
      "outside_window",
      "provider_failed_after_single_attempt",
      "pagination_refused_second_call",
    ].includes(result.outcome);
    response.setHeader("Cache-Control", "no-store");
    return response.status(terminal ? 200 : 500).json({
      status: result.outcome,
      date: slateDate,
      checkpoint,
      providerRequests: result.providerRequests,
      quoteCount: payload ? Number(payload.quoteCount || 0) : null,
      providerCallId: payload?.providerCallId || null,
      providerResponseSha256: payload?.providerResponseSha256 || null,
      discoveryArchive,
      discoveryArchiveError,
      targetAt: result.targetAt || null,
      observedAt: result.observedAt || now.toISOString(),
      error: result.error || null,
    });
  } catch (error) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(503).json({
      status: "infrastructure_error",
      date: slateDate,
      checkpoint,
      providerRequests: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
