const {
  checkpointTargetUtc,
  currentEtDate,
  envFirst,
  normalizeCheckpoint,
  readRawArchive,
  redisCommand,
  redisConfig,
} = require("../lib/checkpoint-runtime");
const { resolveQstash } = require("../lib/qstash-runtime");
const { storageSummary, storageAudit } = require("../lib/storage-health");

async function handleRawIdentity(request, response) {
  const date = String(request.query?.date || "");
  const checkpoint = normalizeCheckpoint(request.query?.checkpoint);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !checkpoint) {
    return response.status(400).json({ error: "invalid date/checkpoint" });
  }
  const stored = await readRawArchive(date, checkpoint);
  if (!stored) return response.status(404).json({ error: "raw checkpoint not found" });
  const { archive, responsePayload: raw } = stored;
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
  if (String(request.query?.action || '') === 'archive-health') {
    response.setHeader('Cache-Control', 'no-store');
    const archive = await require('../lib/archive-health').archiveHealth({ checkCaptures: true });
    return response.status(archive.status === 'attention_required' ? 503 : 200).json(archive);
  }
  if (String(request.query?.action || "") === "storage-audit") {
    response.setHeader("Cache-Control", "no-store");
    try {
      return response.status(200).json(await storageAudit());
    } catch (error) {
      return response.status(503).json({ status: "unavailable", message: String(error.message || error) });
    }
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
  let capacity = null;
  if (env.redisUrl && env.redisToken) {
    try {
      redisOk = (await redisCommand(["PING"])) === "PONG";
      redisProviderKey = Boolean(await redisCommand(["EXISTS", "mlbhr:config:sportsgameodds-api-key"]));
      capacity = await storageSummary({ probeWrites: true });
      if (capacity.capacityAvailable === false) {
        const maintenance = await require('../lib/storage-maintenance').maintainStorage({ maxRecords: 8, force: true });
        capacity = { ...await storageSummary({ probeWrites: true }), maintenance };
      }
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
  const checkpointIds = ["0817", "1117", "1717", "2017"];
  const expectedIds = checkpointIds.flatMap((cp) => [
    `mlb-hr-checkpoint-${cp}`,
    `mlb-hr-checkpoint-${cp}-recovery`,
    `mlb-hr-checkpoint-${cp}-recovery-10`,
    `mlb-hr-checkpoint-${cp}-recovery-14`,
  ]);
  const schedulesReady = expectedIds.every((id) => qstashSchedules.some((row) =>
    row.scheduleId === id && !row.isPaused && row.destination === "https://hr-form-board-actions.vercel.app/api/capture-checkpoint"));
  const archive = await require('../lib/archive-health').archiveHealth();
  const archiveReady = archive.mode === 'active' && archive.writable && archive.status === 'ready';

  const now = new Date();
  const captureDate = currentEtDate(now);
  const captureGraceMinutes = 20;
  const captures = await Promise.all(checkpointIds.map(async (checkpoint) => {
    const targetAt = checkpointTargetUtc(captureDate, checkpoint);
    if (now.getTime() < targetAt.getTime() + captureGraceMinutes * 60_000) {
      return { date: captureDate, checkpoint, status: 'not_due', targetAt: targetAt.toISOString() };
    }
    try {
      const stored = await readRawArchive(captureDate, checkpoint);
      return stored
        ? { date: captureDate, checkpoint, status: 'saved', targetAt: targetAt.toISOString(), completedAt: stored.archive?.completedAt || null }
        : { date: captureDate, checkpoint, status: 'missing', targetAt: targetAt.toISOString() };
    } catch (error) {
      return { date: captureDate, checkpoint, status: 'unavailable', targetAt: targetAt.toISOString(), error: String(error.message || error) };
    }
  }));
  const dueCapturesReady = captures.every((row) => row.status === 'saved' || row.status === 'not_due');

  const ready = baseEnvReady && providerKeyReady && (archiveReady || (redisOk && capacity?.capacityAvailable === true)) && qstashOk && schedulesReady
    && dueCapturesReady && (archive.mode === 'off' || archive.status === 'ready');
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "HEAD") return response.status(ready ? 200 : 503).end();
  return response.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    scheduler: "upstash-qstash",
    captureHost: "vercel",
    storage: archive.mode === 'active' ? 'cloudflare-r2-with-redis-cache' : 'upstash-redis',
    archive,
    env,
    providerKey: {
      ready: providerKeyReady,
      source: envProviderKey ? "vercel-env" : redisProviderKey ? "upstash-redis" : "missing",
    },
    redis: { ok: redisOk, error: redisError, capacity },
    captures: { date: captureDate, graceMinutes: captureGraceMinutes, ready: dueCapturesReady, checks: captures },
    qstash: {
      ok: qstashOk,
      apiBase: qstashRegionBase,
      checkpointScheduleCount: qstashSchedules.length,
      schedulesReady,
      schedules: qstashSchedules,
      error: qstashError,
    },
  });
};
