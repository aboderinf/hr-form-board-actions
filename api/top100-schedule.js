const { resolveQstash } = require("../lib/qstash-runtime");

const DESTINATION = "https://hr-form-board-actions.vercel.app/api/top100-refresh";
const CRON = "5 8,10 * * *";

function destinationOf(schedule) {
  return String(schedule?.destination || schedule?.url || "").replace(/\/+$/, "");
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  response.setHeader("Cache-Control", "no-store");
  try {
    const resolved = await resolveQstash();
    const existing = (resolved.schedules || []).filter(
      (schedule) => destinationOf(schedule) === DESTINATION,
    );
    const exact = existing.find((schedule) => String(schedule?.cron || "").trim() === CRON);
    if (exact) {
      return response.status(200).json({
        status: "already_configured",
        qstashApiBase: resolved.base,
        scheduleId: exact.scheduleId || null,
        cron: exact.cron || CRON,
        destination: DESTINATION,
        isPaused: Boolean(exact.isPaused),
        nextScheduleTime: exact.nextScheduleTime || null,
      });
    }

    if (existing.length) {
      return response.status(409).json({
        status: "conflicting_schedule_exists",
        destination: DESTINATION,
        desiredCron: CRON,
        schedules: existing.map((schedule) => ({
          scheduleId: schedule.scheduleId || null,
          cron: schedule.cron || null,
          isPaused: Boolean(schedule.isPaused),
        })),
      });
    }

    const create = await fetch(
      `${resolved.base}/v2/schedules/${encodeURIComponent(DESTINATION)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resolved.token}`,
          "Content-Type": "application/json",
          "Upstash-Cron": CRON,
          "Upstash-Retries": "2",
          "Upstash-Timeout": "5m",
          "Upstash-Label": "mlb-top100-daily",
        },
        body: "{}",
        cache: "no-store",
      },
    );
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
      cron: CRON,
      destination: DESTINATION,
      cadence: "08:05 and 10:05 UTC daily (3/4 AM primary, 5/6 AM ET recovery across DST)",
    });
  } catch (error) {
    return response.status(500).json({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
