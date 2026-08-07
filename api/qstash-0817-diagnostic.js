const { resolveQstash } = require("../lib/qstash-runtime");
const { redisCommand } = require("../lib/checkpoint-runtime");

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

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
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
