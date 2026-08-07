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
  const envProviderKey = Boolean(envFirst("SPORTSGAMEODDS_API_KEY"));
  const env = {
    qstashToken: Boolean(envFirst("QSTASH_TOKEN", "US_EAST_1_QSTASH_TOKEN", "EU_CENTRAL_1_QSTASH_TOKEN")),
    qstashCurrentSigningKey: Boolean(envFirst("QSTASH_CURRENT_SIGNING_KEY", "US_EAST_1_QSTASH_CURRENT_SIGNING_KEY", "EU_CENTRAL_1_QSTASH_CURRENT_SIGNING_KEY")),
    qstashNextSigningKey: Boolean(envFirst("QSTASH_NEXT_SIGNING_KEY", "US_EAST_1_QSTASH_NEXT_SIGNING_KEY", "EU_CENTRAL_1_QSTASH_NEXT_SIGNING_KEY")),
    redisUrl: Boolean(redis.url),
    redisToken: Boolean(redis.token),
    sportsGameOddsApiKey: envProviderKey,
  };

  let redisOk = false;
  let redisError = null;
  let redisProviderKey = false;
  if (env.redisUrl && env.redisToken) {
    try {
      redisOk = (await redisCommand(["PING"])) === "PONG";
      redisProviderKey = Boolean(await redisCommand(["EXISTS", "mlbhr:config:sportsgameodds-api-key"]));
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

  const providerKeyReady = envProviderKey || redisProviderKey;
  const baseEnvReady = env.qstashToken && env.qstashCurrentSigningKey && env.qstashNextSigningKey && env.redisUrl && env.redisToken;
  const ready = baseEnvReady && providerKeyReady && redisOk && qstashOk && qstashSchedules.length === 4;
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "HEAD") return response.status(ready ? 200 : 503).end();
  return response.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    scheduler: "upstash-qstash",
    captureHost: "vercel",
    storage: "upstash-redis",
    env,
    providerKey: {
      ready: providerKeyReady,
      source: envProviderKey ? "vercel-env" : redisProviderKey ? "upstash-redis" : "missing",
    },
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
