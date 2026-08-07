const {
  envFirst,
  redisCommand,
  redisConfig,
} = require("../lib/checkpoint-runtime");
const { resolveQstash } = require("../lib/qstash-runtime");

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const redis = redisConfig();
  const env = {
    qstashToken: Boolean(envFirst("QSTASH_TOKEN", "US_EAST_1_QSTASH_TOKEN", "EU_CENTRAL_1_QSTASH_TOKEN")),
    qstashCurrentSigningKey: Boolean(envFirst("QSTASH_CURRENT_SIGNING_KEY", "US_EAST_1_QSTASH_CURRENT_SIGNING_KEY", "EU_CENTRAL_1_QSTASH_CURRENT_SIGNING_KEY")),
    qstashNextSigningKey: Boolean(envFirst("QSTASH_NEXT_SIGNING_KEY", "US_EAST_1_QSTASH_NEXT_SIGNING_KEY", "EU_CENTRAL_1_QSTASH_NEXT_SIGNING_KEY")),
    redisUrl: Boolean(redis.url),
    redisToken: Boolean(redis.token),
    sportsGameOddsApiKey: Boolean(envFirst("SPORTSGAMEODDS_API_KEY")),
  };

  let redisOk = false;
  let redisError = null;
  if (env.redisUrl && env.redisToken) {
    try {
      redisOk = (await redisCommand(["PING"])) === "PONG";
    } catch (error) {
      redisError = error instanceof Error ? error.message : String(error);
    }
  }

  let qstashOk = false;
  let qstashSchedules = [];
  let qstashRegionBase = null;
  let qstashError = null;
  if (env.qstashToken) {
    try {
      const resolved = await resolveQstash();
      qstashOk = true;
      qstashRegionBase = resolved.base;
      qstashSchedules = resolved.schedules
        .filter((row) => String(row.scheduleId || "").startsWith("mlb-hr-checkpoint-"))
        .map((row) => ({
          scheduleId: row.scheduleId,
          cron: row.cron,
          destination: row.destination,
          isPaused: Boolean(row.isPaused),
          lastScheduleTime: row.lastScheduleTime || null,
          nextScheduleTime: row.nextScheduleTime || null,
        }));
    } catch (error) {
      qstashError = error instanceof Error ? error.message : String(error);
    }
  }

  const ready = Object.values(env).every(Boolean) && redisOk && qstashOk && qstashSchedules.length === 4;
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "HEAD") return response.status(ready ? 200 : 503).end();
  return response.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    scheduler: "upstash-qstash",
    captureHost: "vercel",
    storage: "upstash-redis",
    env,
    redis: { ok: redisOk, error: redisError },
    qstash: {
      ok: qstashOk,
      apiBase: qstashRegionBase,
      checkpointScheduleCount: qstashSchedules.length,
      schedules: qstashSchedules,
      error: qstashError,
    },
  });
};
