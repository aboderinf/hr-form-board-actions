const { ensureDiscoveryArchive } = require("../lib/discovery-runtime");

const RAW_BASE = "https://raw.githubusercontent.com/aboderinf/hr-form-board-actions/main/data/discovery/archive";

function parseName(value) {
  const match = /^(\d{4}-\d{2}-\d{2})_(0817|1117|1717|2017)\.json$/.exec(String(value || ""));
  return match ? { date: match[1], checkpoint: match[2], name: match[0] } : null;
}

async function staticFallback(name) {
  try {
    const result = await fetch(`${RAW_BASE}/${encodeURIComponent(name)}?t=${Date.now()}`, {
      cache: "no-store",
      headers: { "User-Agent": "hr-form-discovery-archive-fallback/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok) return null;
    return await result.json();
  } catch {
    return null;
  }
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const parsed = parseName(request.query?.name);
  if (!parsed) {
    return response.status(400).json({ status: "error", message: "Invalid Discovery archive name" });
  }

  response.setHeader("Cache-Control", "no-store");
  try {
    const archive = await ensureDiscoveryArchive(parsed.date, parsed.checkpoint);
    if (archive) {
      response.setHeader("X-Discovery-Source", "redis");
      return response.status(200).json(archive);
    }
  } catch (error) {
    const fallback = await staticFallback(parsed.name);
    if (fallback) {
      response.setHeader("X-Discovery-Source", "github-static-fallback-after-projection-error");
      return response.status(200).json(fallback);
    }
    return response.status(409).json({
      status: "projection_error",
      slate_date: parsed.date,
      checkpoint: parsed.checkpoint,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const fallback = await staticFallback(parsed.name);
  if (fallback) {
    response.setHeader("X-Discovery-Source", "github-static-fallback");
    return response.status(200).json(fallback);
  }
  return response.status(404).json({
    status: "not_ready",
    slate_date: parsed.date,
    checkpoint: parsed.checkpoint,
  });
};
