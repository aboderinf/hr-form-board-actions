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
const { refreshTop100 } = require("../lib/top100-build-runtime");
const frozenTotalBasesExecution = require("../lib/total-bases-v2-frozen-monetization");

const RETRYABLE_CAPTURE_OUTCOMES = new Set([
  "already_attempted",
  "provider_failed_after_single_attempt",
]);

function attemptKey(date, checkpoint) {
  return `mlbhr:attempt:${date}:${checkpoint}`;
}

async function releaseAttemptForRetry(date, checkpoint) {
  try {
    await redisCommand(["DEL", attemptKey(date, checkpoint)]);
  } catch (error) {
    console.error("Unable to release checkpoint attempt lock for retry", error);
  }
}

async function handleTop100Refresh(request, response) {
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const redis = redisConfig();
  if (!redis.url || !redis.token) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(503).json({ status: "configuration_missing", missing: ["Upstash Redis"] });
  }

  try {
    const result = await refreshTop100();
    const payload = result.payload || null;
    const projections = {};
    if (payload?.slate_date && ["built", "reused", "reused_after_race"].includes(result.outcome)) {
      for (const checkpoint of ["0817", "1117", "1717", "2017"]) {
        try {
          const archive = await ensureDiscoveryArchive(payload.slate_date, checkpoint);
          projections[checkpoint] = archive ? {
            status: "ready",
            top100Rows: Number(archive.top100_rows || 0),
            pricedRows: Number(archive.priced_rows || 0),
            providerCallId: archive.source?.provider_call_id || null,
          } : { status: "checkpoint_not_captured" };
        } catch (error) {
          projections[checkpoint] = {
            status: "projection_error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    response.setHeader("Cache-Control", "no-store");
    return response.status(result.outcome === "build_in_progress" ? 202 : 200).json({
      status: result.outcome,
      slate_date: payload?.slate_date || null,
      generated_at: payload?.generated_at || null,
      player_pool_count: Number(payload?.player_pool_count || 0),
      scored_player_count: Number(payload?.scored_player_count || 0),
      published_count: Array.isArray(payload?.players) ? payload.players.length : 0,
      delivery: payload?.delivery || "qstash-vercel-redis",
      providerRequests: 0,
      projections,
      diagnostics: payload?.diagnostics || [],
    });
  } catch (error) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(503).json({
      status: "top100_refresh_error",
      providerRequests: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

module.exports = async function handler(request, response) {
  if (String(request.query?.action || "") === "top100-refresh") {
    return handleTop100Refresh(request, response);
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const expected = checkpointAuth();
  const supplied = request.headers["x-checkpoint-auth"];
  if (!expected || !safeEqual(supplied, expected)) {
    response.setHeader("Upstash-NonRetryable-Error", "true");
    return response.status(489).json({ status: "error", message: "Unauthorized" });
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
    response.setHeader("Retry-After", "60");
    return response.status(503).json({
      status: "configuration_missing",
      providerRequests: 0,
      missing,
    });
  }

  const body = request.body && typeof request.body === "object" ? request.body : {};
  const checkpoint = normalizeCheckpoint(body.checkpoint);
  if (!checkpoint) {
    response.setHeader("Upstash-NonRetryable-Error", "true");
    return response.status(489).json({ status: "error", message: "Invalid checkpoint" });
  }

  const now = new Date();
  const slateDate = String(body.date || intendedSlateDate(checkpoint, now));
  try {
    const result = await captureCheckpoint({ slateDate, checkpoint, now });
    const payload = result.payload || null;
    let discoveryArchive = null;
    let discoveryArchiveError = null;
    let frozenTotalBasesSnapshot = null;
    let frozenTotalBasesSnapshotError = null;

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

      if (checkpoint === "0817") {
        try {
          const snapshot = await frozenTotalBasesExecution.snapshotFrozenSelectionsForDate(slateDate);
          frozenTotalBasesSnapshot = snapshot ? {
            status: "snapshotted",
            date: snapshot.date,
            checkpoint: snapshot.checkpoint,
            selections: Array.isArray(snapshot.selections) ? snapshot.selections.length : 0,
            capturedAt: snapshot.capturedAt || null,
          } : { status: "not_ready" };
        } catch (error) {
          frozenTotalBasesSnapshot = { status: "snapshot_error" };
          frozenTotalBasesSnapshotError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    const retryable = RETRYABLE_CAPTURE_OUTCOMES.has(result.outcome);
    if (retryable) {
      // The old implementation held this lock for two days even after the
      // one allowed provider request failed. Releasing it lets QStash perform
      // its delivery retry without allowing overlapping requests: QStash only
      // retries after this response, and the provider fetch itself times out
      // after 30 seconds.
      await releaseAttemptForRetry(slateDate, checkpoint);
      response.setHeader("Retry-After", "60");
    }

    const terminal = [
      "captured",
      "reused",
      "outside_window",
      "pagination_refused_second_call",
    ].includes(result.outcome);
    response.setHeader("Cache-Control", "no-store");
    return response.status(retryable ? 503 : (terminal ? 200 : 500)).json({
      status: result.outcome,
      date: slateDate,
      checkpoint,
      providerRequests: result.providerRequests,
      quoteCount: payload ? Number(payload.quoteCount || 0) : null,
      providerCallId: payload?.providerCallId || null,
      providerResponseSha256: payload?.providerResponseSha256 || null,
      discoveryArchive,
      discoveryArchiveError,
      frozenTotalBasesSnapshot,
      frozenTotalBasesSnapshotError,
      targetAt: result.targetAt || null,
      observedAt: result.observedAt || now.toISOString(),
      error: result.error || null,
    });
  } catch (error) {
    await releaseAttemptForRetry(slateDate, checkpoint);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Retry-After", "60");
    return response.status(503).json({
      status: "infrastructure_error",
      date: slateDate,
      checkpoint,
      providerRequests: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
