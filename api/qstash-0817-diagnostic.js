const { resolveQstash } = require("../lib/qstash-runtime");
const {
  checkpointAuth,
  checkpointTargetUtc,
  currentEtDate,
  normalizeCheckpoint,
  redisCommand,
} = require("../lib/checkpoint-runtime");

const TOP100_DESTINATION = "https://hr-form-board-actions.vercel.app/api/top100-refresh";
const TOP100_CRON = "5 8,10 * * *";
const TRIPLES_MODEL_DESTINATION = "https://hr-form-board-actions.vercel.app/api/triples-model-refresh";
const TRIPLES_MODEL_CRON = "5 8,9,10,11 * * *";
const TRIPLES_MODEL_SCHEDULE_ID = "mlb-triples-model-daily";
const CHECKPOINT_DESTINATION = "https://hr-form-board-actions.vercel.app/api/capture-checkpoint";
const CHECKPOINTS = ["0817", "1117", "1717", "2017"];
const RECOVERY_MINUTES = [5];

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

function checkpointCron(checkpoint, recoveryMinutes = 0) {
  const hour = Number(checkpoint.slice(0, 2));
  const minute = Number(checkpoint.slice(2)) + Number(recoveryMinutes || 0);
  return `CRON_TZ=America/New_York ${minute} ${hour} * * *`;
}

function qstashScheduleCreateUrl(base, destination) {
  // QStash's REST API expects the full destination URL literally after
  // /v2/schedules/. Percent-encoding the whole destination turns "https://"
  // into "https%3A%2F%2F" and QStash rejects it as an invalid scheme.
  return `${base}/v2/schedules/${destination}`;
}

async function upsertCheckpointSchedule(resolved, checkpoint, recoveryMinutes = 0) {
  const suffix = recoveryMinutes
    ? (Number(recoveryMinutes) === 5 ? "-recovery" : `-recovery-${String(recoveryMinutes).padStart(2, "0")}`)
    : "";
  const scheduleId = `mlb-hr-checkpoint-${checkpoint}${suffix}`;
  const cron = checkpointCron(checkpoint, recoveryMinutes);
  const auth = checkpointAuth();
  if (!auth) throw new Error("QSTASH_TOKEN is unavailable for checkpoint authentication");

  const create = await fetch(
    qstashScheduleCreateUrl(resolved.base, CHECKPOINT_DESTINATION),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        "Content-Type": "application/json",
        "Upstash-Cron": cron,
        "Upstash-Schedule-Id": scheduleId,
        "Upstash-Retries": "2",
        "Upstash-Retry-Delay": "60000 * (1 + retried)",
        "Upstash-Timeout": "5m",
        "Upstash-Label": scheduleId,
        "Upstash-Forward-X-Checkpoint-Auth": auth,
      },
      body: JSON.stringify({ checkpoint }),
      cache: "no-store",
    },
  );
  const payload = await create.json().catch(() => ({}));
  if (!create.ok) {
    throw new Error(
      `${scheduleId}: ${payload?.error || payload?.message || `HTTP ${create.status}`}`,
    );
  }

  // Upserting a paused schedule can preserve its paused state. Resume is
  // idempotent, so always make the canonical schedules active.
  const resume = await fetch(`${resolved.base}/v2/schedules/${scheduleId}/resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${resolved.token}` },
    cache: "no-store",
  });
  if (!resume.ok) {
    const resumePayload = await resume.json().catch(() => ({}));
    throw new Error(
      `${scheduleId} resume: ${resumePayload?.error || resumePayload?.message || `HTTP ${resume.status}`}`,
    );
  }

  return {
    scheduleId,
    checkpoint,
    role: recoveryMinutes ? "recovery" : "primary",
    recoveryMinutes: Number(recoveryMinutes || 0),
    cron,
    retries: 2,
    retryDelayExpression: "60000 * (1 + retried)",
    destination: CHECKPOINT_DESTINATION,
  };
}

async function ensureCheckpointSchedules(response) {
  const resolved = await resolveQstash();
  const configured = [];
  for (const checkpoint of CHECKPOINTS) {
    configured.push(await upsertCheckpointSchedule(resolved, checkpoint, 0));
    for (const recoveryMinutes of RECOVERY_MINUTES) {
      configured.push(await upsertCheckpointSchedule(resolved, checkpoint, recoveryMinutes));
    }
  }
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({
    status: "configured",
    qstashApiBase: resolved.base,
    destination: CHECKPOINT_DESTINATION,
    recoveryDelayMinutes: RECOVERY_MINUTES,
    scheduleQuotaNote: "Uses 8 checkpoint schedules total (primary + 5-minute recovery) to stay within the Upstash schedule quota.",
    sportsGameOddsCallsOnHealthyDay: "one per checkpoint; recovery deliveries reuse Redis",
    schedules: configured,
  });
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

  const create = await fetch(qstashScheduleCreateUrl(resolved.base, TOP100_DESTINATION), {
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

async function ensureTriplesModelSchedule(response) {
  const resolved = await resolveQstash();
  const create = await fetch(qstashScheduleCreateUrl(resolved.base, TRIPLES_MODEL_DESTINATION), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.token}`,
      "Content-Type": "application/json",
      "Upstash-Cron": TRIPLES_MODEL_CRON,
      "Upstash-Schedule-Id": TRIPLES_MODEL_SCHEDULE_ID,
      "Upstash-Retries": "2",
      "Upstash-Retry-Delay": "60000 * (1 + retried)",
      "Upstash-Timeout": "5m",
      "Upstash-Label": TRIPLES_MODEL_SCHEDULE_ID,
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

  const resume = await fetch(
    `${resolved.base}/v2/schedules/${TRIPLES_MODEL_SCHEDULE_ID}/resume`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${resolved.token}` },
      cache: "no-store",
    },
  );
  if (!resume.ok) {
    const resumePayload = await resume.json().catch(() => ({}));
    return response.status(502).json({
      status: "qstash_resume_failed",
      qstashStatus: resume.status,
      message: resumePayload?.error || resumePayload?.message || `HTTP ${resume.status}`,
    });
  }

  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({
    status: "configured",
    qstashApiBase: resolved.base,
    scheduleId: TRIPLES_MODEL_SCHEDULE_ID,
    cron: TRIPLES_MODEL_CRON,
    destination: TRIPLES_MODEL_DESTINATION,
    retries: 2,
    retryDelayExpression: "60000 * (1 + retried)",
    cadence: "4:05-6:05 AM ET across daylight and standard time; duplicate-offset deliveries are idempotent",
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

  if (String(request.query?.action || "") === "ensure-triples-model-schedule") {
    try {
      return await ensureTriplesModelSchedule(response);
    } catch (error) {
      response.setHeader("Cache-Control", "no-store");
      return response.status(500).json({
        status: "triples_model_schedule_configuration_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (String(request.query?.action || "") === "ensure-checkpoint-schedules") {
    try {
      return await ensureCheckpointSchedules(response);
    } catch (error) {
      response.setHeader("Cache-Control", "no-store");
      return response.status(500).json({
        status: "checkpoint_schedule_configuration_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const resolved = await resolveQstash();
    const headers = { Authorization: `Bearer ${resolved.token}` };
    const diagnosticDate = String(request.query?.date || currentEtDate());
    const requestedCheckpoint = request.query?.checkpoint == null ? null : String(request.query.checkpoint);
    const diagnosticCheckpoint = requestedCheckpoint == null ? "0817" : normalizeCheckpoint(requestedCheckpoint);
    if (!diagnosticCheckpoint) {
      return response.status(400).json({ status: "error", message: "Invalid checkpoint" });
    }
    const target = checkpointTargetUtc(diagnosticDate, diagnosticCheckpoint);
    const logParams = new URLSearchParams({
      fromDate: String(target.getTime() - 2 * 60 * 1000),
      toDate: String(target.getTime() + 20 * 60 * 1000),
      count: "100",
    });
    const [logsResponse, scheduleResponse, checkpointRaw, attemptRaw, failureRaw, rawArchiveRaw] = await Promise.all([
      fetch(`${resolved.base}/v2/logs?${logParams}`, { headers, cache: "no-store" }),
      fetch(`${resolved.base}/v2/schedules/mlb-hr-checkpoint-${diagnosticCheckpoint}`, { headers, cache: "no-store" }),
      redisCommand(["GET", `mlbhr:checkpoint:${diagnosticDate}:${diagnosticCheckpoint}`]),
      redisCommand(["GET", `mlbhr:attempt:${diagnosticDate}:${diagnosticCheckpoint}`]),
      redisCommand(["GET", `mlbhr:failure:${diagnosticDate}:${diagnosticCheckpoint}`]),
      redisCommand(["GET", `mlbhr:raw:${diagnosticDate}:${diagnosticCheckpoint}`]),
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
      String(row.scheduleId || "").startsWith(`mlb-hr-checkpoint-${diagnosticCheckpoint}`)
      || row.url === CHECKPOINT_DESTINATION
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
      retryDelayExpression: schedule.retryDelayExpression || null,
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
      diagnosticDate,
      diagnosticCheckpoint,
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
