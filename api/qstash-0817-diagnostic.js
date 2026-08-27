const { resolveQstash } = require("../lib/qstash-runtime");
const { redisCommand } = require("../lib/checkpoint-runtime");

const TOP100_DESTINATION = "https://hr-form-board-actions.vercel.app/api/top100-refresh";
const TOP100_CRON = "5 8,10 * * *";

function safeLog(row) {
  return {
    time: row.time || null,
    messageId: row.messageId || null,
    scheduleId: row.scheduleId || null,
    state: row.state || null,
    error: row.error || null,
    responseStatus: row.responseStatus ?? null,
    responseBody: row.responseBody || null,
    nextDeliveryTime: row.nextDeliveryTime || null,
    url: row.url || null,
    method: row.method || null,
    maxRetries: row.maxRetries ?? null,
    retryDelayExpression: row.retryDelayExpression || null,
  };
}

function destinationOf(schedule) {
  return String(schedule?.destination || schedule?.url || "").replace(/\/+$/, "");
}

async function ensureTop100Schedule(response) {
  const resolved = await resolveQstash();
  const existing = (resolved.schedules || []).filter(
    (schedule) => destinationOf(schedule) === TOP100_DESTINATION,
  );
  const exact = existing.find((schedule) => String(schedule?.cron || "").trim() === TOP100_CRON);
  response.setHeader("Cache-Control", "no-store");
  if (exact) {
    return response.status(200).json({
      status: "already_configured",
      qstashApiBase: resolved.base,
      scheduleId: exact.scheduleId || null,
      cron: exact.cron || TOP100_CRON,
      destination: TOP100_DESTINATION,
      isPaused: Boolean(exact.isPaused),
      nextScheduleTime: exact.nextScheduleTime || null,
    });
  }
  if (existing.length) {
    return response.status(409).json({
      status: "conflicting_schedule_exists",
      destination: TOP100_DESTINATION,
      desiredCron: TOP100_CRON,
      schedules: existing.map((schedule) => ({
        scheduleId: schedule.scheduleId || null,
        cron: schedule.cron || null,
        isPaused: Boolean(schedule.isPaused),
      })),
    });
  }

  const create = await fetch(`${resolved.base}/v2/schedules/${encodeURIComponent(TOP100_DESTINATION)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.token}`,
      "Content-Type": "application/json",
      "Upstash-Cron": TOP100_CRON,
      "Upstash-Retries": "2",
      "Upstash-Timeout": "5m",
      "Upstash-Label": "mlb-top100-daily",
    },
    body: "{}",
    cache: "no-store",
  });
  const payload = await create.json().catch(() => ({}));
  if (!create.ok) {
    return response.status(502).json({
      status: "qstash_create_failed",
      qstashStatus: create.status,
      message: payload?.error || payload?.message || `HTTP ${create.status}`,
    });
  }
  return response.status(201).json({
    status: "created",
    qstashApiBase: resolved.base,
    scheduleId: payload.scheduleId || null,
    cron: TOP100_CRON,
    destination: TOP100_DESTINATION,
    cadence: "08:05 and 10:05 UTC daily; second delivery is an idempotent recovery",
  });
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  if (String(request.query?.action || "") === "ensure-top100-schedule") {
    try {
      return await ensureTop100Schedule(response);
    } catch (error) {
      return response.status(500).json({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  try {
    const resolved = await resolveQstash();
    const headers = { Authorization: `Bearer ${resolved.token}` };
    const logParams = new URLSearchParams({
      fromDate: String(Date.parse("2026-08-07T12:15:00Z")),
      toDate: String(Date.parse("2026-08-07T13:30:00Z")),
      count: "100",
    });
    const [logsResponse, scheduleResponse, checkpointRaw, attemptRaw, failureRaw, rawArchiveRaw] = await Promise.all([
      fetch(`${resolved.base}/v2/logs?${logParams}`, { headers, cache: "no-store" }),
      fetch(`${resolved.base}/v2/schedules/mlb-hr-checkpoint-0817`, { headers, cache: "no-store" }),
      redisCommand(["GET", "mlbhr:checkpoint:2026-08-07:0817"]),
      redisCommand(["GET", "mlbhr:attempt:2026-08-07:0817"]),
      redisCommand(["GET", "mlbhr:failure:2026-08-07:0817"]),
      redisCommand(["GET", "mlbhr:raw:2026-08-07:0817"]),
    ]);
    const logsPayload = await logsResponse.json().catch(() => ({}));
    const schedule = await scheduleResponse.json().catch(() => ({}));
    if (!logsResponse.ok || !scheduleResponse.ok) {
      return response.status(502).json({
        status: "error",
        logsStatus: logsResponse.status,
        scheduleStatus: scheduleResponse.status,
      });
    }
    const allLogs = (logsPayload.logs || []).map(safeLog);
    const relevantLogs = allLogs.filter((row) =>
      row.scheduleId === "mlb-hr-checkpoint-0817"
      || row.url === "https://hr-form-board-actions.vercel.app/api/capture-checkpoint"
    );
    const safeSchedule = {
      scheduleId: schedule.scheduleId || null,
      cron: schedule.cron || null,
      destination: schedule.destination || schedule.url || null,
      method: schedule.method || null,
      body: schedule.body || null,
      bodyBase64: schedule.bodyBase64 || null,
      headerNames: Object.keys(schedule.header || {}),
      retries: schedule.retries ?? null,
      delay: schedule.delay ?? null,
      callback: schedule.callback || null,
      failureCallback: schedule.failureCallback || null,
      label: schedule.label || null,
      isPaused: Boolean(schedule.isPaused),
      lastScheduleTime: schedule.lastScheduleTime || null,
      nextScheduleTime: schedule.nextScheduleTime || null,
      lastScheduleStates: schedule.lastScheduleStates || null,
    };
    let failure = null;
    try { failure = failureRaw ? JSON.parse(failureRaw) : null; } catch { failure = { raw: String(failureRaw) }; }
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({
      status: "ok",
      qstashApiBase: resolved.base,
      schedule: safeSchedule,
      redis: {
        checkpointPresent: Boolean(checkpointRaw),
        attemptPresent: Boolean(attemptRaw),
        attemptValue: attemptRaw || null,
        failurePresent: Boolean(failureRaw),
        failure,
        rawArchivePresent: Boolean(rawArchiveRaw),
      },
      allLogCount: allLogs.length,
      relevantLogCount: relevantLogs.length,
      relevantLogs,
      allLogs,
    });
  } catch (error) {
    return response.status(500).json({ status: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
