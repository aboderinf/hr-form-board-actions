const zlib = require("node:zlib");
const {
  envFirst,
  normalizeCheckpoint,
  redisCommand,
  redisConfig,
} = require("../lib/checkpoint-runtime");
const { resolveQstash } = require("../lib/qstash-runtime");

async function handleRawIdentity(request, response) {
  const date = String(request.query?.date || "");
  const checkpoint = normalizeCheckpoint(request.query?.checkpoint);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !checkpoint) {
    return response.status(400).json({ error: "invalid date/checkpoint" });
  }
  const stored = await redisCommand(["GET", `mlbhr:raw:${date}:${checkpoint}`]);
  if (!stored) return response.status(404).json({ error: "raw checkpoint not found" });
  const archive = JSON.parse(stored);
  const raw = JSON.parse(
    zlib.gunzipSync(Buffer.from(archive.responseGzipBase64, "base64")).toString("utf8"),
  );
  const rows = [];
  for (const event of raw?.data || []) {
    for (const [oddKey, oddValue] of Object.entries(event?.odds || {})) {
      const odd = oddValue || {};
      const stat = String(odd.statID || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!["battinghomeruns", "homeruns", "batterhomeruns"].includes(stat)) continue;
      const side = String(odd.sideID || "").toLowerCase();
      const betType = String(odd.betTypeID || "").toLowerCase();
      if (!((betType === "yn" && side === "yes") || (betType === "ou" && side === "over"))) continue;
      rows.push({
        eventID: event.eventID || null,
        oddKey,
        oddID: odd.oddID || null,
        statEntityID: odd.statEntityID || null,
        books: Object.fromEntries(
          Object.entries(odd.byBookmaker || {})
            .filter(([book]) => ["fanduel", "draftkings", "betmgm"].includes(String(book).toLowerCase()))
            .map(([book, value]) => [book, value?.odds ?? null]),
        ),
      });
    }
  }
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "HEAD") return response.status(200).end();
  return response.status(200).json({
    date,
    checkpoint,
    responseSha256: archive.responseSha256,
    rows,
  });
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  if (String(request.query?.action || "") === "raw-identity") {
    return handleRawIdentity(request, response);
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
