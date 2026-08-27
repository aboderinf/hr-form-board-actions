const fs = require("node:fs");
const path = require("node:path");
const { currentEtDate, readTop100, validDate } = require("../lib/top100-runtime");

function localTop100(date) {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "top100.json"), "utf8"));
    return payload?.slate_date === date && Array.isArray(payload?.players) ? payload : null;
  } catch {
    return null;
  }
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const requested = String(request.query?.date || "").trim();
  const date = requested || currentEtDate();
  if (!validDate(date)) {
    return response.status(400).json({ status: "error", message: "Invalid date" });
  }

  try {
    const redis = await readTop100(date);
    const payload = redis || localTop100(date);
    response.setHeader("Cache-Control", "no-store");
    if (!payload) {
      return response.status(404).json({
        status: "not_ready",
        slate_date: date,
        source: "qstash-vercel-redis",
      });
    }
    response.setHeader("X-Top100-Source", redis ? "redis" : "static-fallback");
    return response.status(200).json(payload);
  } catch (error) {
    const fallback = localTop100(date);
    response.setHeader("Cache-Control", "no-store");
    if (fallback) {
      response.setHeader("X-Top100-Source", "static-fallback-after-redis-error");
      return response.status(200).json(fallback);
    }
    return response.status(503).json({
      status: "infrastructure_error",
      slate_date: date,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
