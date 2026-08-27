const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  currentEtDate,
  normalizeCheckpoint,
  readCheckpoint,
  redisCommand,
} = require("../lib/checkpoint-runtime");
const {
  ensureDiscoveryArchive,
} = require("../lib/discovery-runtime");
const { readTop100 } = require("../lib/top100-build-runtime");

const EDGE_BASE_URL = "https://mlb-hr-edge.feranmi.chatgpt.site";
const RAW_DISCOVERY_BASE = "https://raw.githubusercontent.com/aboderinf/hr-form-board-actions/main/data/discovery/archive";
const ALLOWED_QUERY_KEYS = new Set(["date", "checkpoint", "asOf", "latest"]);
const ALLOWED_BOOKS = new Set(["fanduel", "draftkings", "betmgm"]);

async function fetchJson(url) {
  const upstream = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": "hr-form-central-db-proxy/3.0" },
    cache: "no-store",
  });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error(`HTTP ${upstream.status} from ${url}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

function localTop100(date) {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "top100.json"), "utf8"));
    return payload?.slate_date === date && Array.isArray(payload?.players) ? payload : null;
  } catch {
    return null;
  }
}

function parseDiscoveryName(value) {
  const match = /^(\d{4}-\d{2}-\d{2})_(0817|1117|1717|2017)\.json$/.exec(String(value || ""));
  return match ? { date: match[1], checkpoint: match[2], name: match[0] } : null;
}

async function discoveryStaticFallback(name) {
  try {
    return await fetchJson(`${RAW_DISCOVERY_BASE}/${encodeURIComponent(name)}?t=${Date.now()}`);
  } catch {
    return null;
  }
}

async function handleTop100View(request, response) {
  const requested = String(request.query?.date || request.query?.slate || "").trim();
  const date = requested || currentEtDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return response.status(400).json({ status: "error", message: "Invalid Top 100 date" });
  }
  try {
    const redis = await readTop100(date);
    const payload = redis || localTop100(date);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (!payload) return response.status(404).json({ status: "not_ready", slate_date: date });
    response.setHeader("X-Top100-Source", redis ? "redis" : "static-fallback");
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).json(payload);
  } catch (error) {
    const fallback = localTop100(date);
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
}

async function handleDiscoveryArchiveView(request, response) {
  const parsed = parseDiscoveryName(request.query?.name);
  if (!parsed) {
    return response.status(400).json({ status: "error", message: "Invalid Discovery archive name" });
  }
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const archive = await ensureDiscoveryArchive(parsed.date, parsed.checkpoint);
    if (archive) {
      response.setHeader("X-Discovery-Source", "redis");
      if (request.method === "HEAD") return response.status(200).end();
      return response.status(200).json(archive);
    }
  } catch (error) {
    const fallback = await discoveryStaticFallback(parsed.name);
    if (fallback) {
      response.setHeader("X-Discovery-Source", "github-static-fallback-after-projection-error");
      if (request.method === "HEAD") return response.status(200).end();
      return response.status(200).json(fallback);
    }
    return response.status(409).json({
      status: "projection_error",
      slate_date: parsed.date,
      checkpoint: parsed.checkpoint,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const fallback = await discoveryStaticFallback(parsed.name);
  if (fallback) {
    response.setHeader("X-Discovery-Source", "github-static-fallback");
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).json(fallback);
  }
  return response.status(404).json({
    status: "not_ready",
    slate_date: parsed.date,
    checkpoint: parsed.checkpoint,
  });
}

function validTime(value) {
  const milliseconds = Date.parse(String(value || ""));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function filterPregameRows(rows) {
  let allAvailableQuoteCount = 0;
  let excludedLiveOrPostStartQuoteCount = 0;
  const filteredRows = rows.map((row) => {
    const gameStart = validTime(row?.gameStartAt);
    const odds = {};
    for (const [book, quote] of Object.entries(row?.odds || {})) {
      if (!ALLOWED_BOOKS.has(book) || !quote || typeof quote !== "object") continue;
      const americanOdds = Number(quote.americanOdds);
      const capturedAt = validTime(quote.capturedAt);
      if (!Number.isFinite(americanOdds) || capturedAt == null) continue;
      allAvailableQuoteCount += 1;
      if (gameStart != null && capturedAt >= gameStart) {
        excludedLiveOrPostStartQuoteCount += 1;
        continue;
      }
      odds[book] = quote;
    }
    return { ...row, odds };
  });
  const quoteCount = filteredRows.reduce((total, row) => total + Object.keys(row.odds || {}).length, 0);
  return { rows: filteredRows, quoteCount, allAvailableQuoteCount, excludedLiveOrPostStartQuoteCount };
}

function normalizeDashboard(dashboard, slateDate, sourceUrl) {
  if (dashboard?.source !== "database" || !Array.isArray(dashboard.rows)) {
    throw new Error("Dashboard response is not database-backed");
  }
  const canonical = JSON.stringify(dashboard);
  const generatedAt = dashboard.generatedAt || new Date().toISOString();
  const filtered = filterPregameRows(dashboard.rows);
  return {
    schemaVersion: 2,
    date: dashboard.date || slateDate,
    checkpoint: null,
    asOf: generatedAt,
    generatedAt,
    latestIngestAt: generatedAt,
    status: filtered.quoteCount > 0 ? "ready" : "pending",
    source: "mlb-hr-edge-database",
    delivery: "central-database-dashboard-read",
    books: ["fanduel", "draftkings", "betmgm"],
    rowCount: filtered.rows.length,
    quoteCount: filtered.quoteCount,
    allAvailableQuoteCount: filtered.allAvailableQuoteCount,
    excludedLiveOrPostStartQuoteCount: filtered.excludedLiveOrPostStartQuoteCount,
    archivedCallCount: Number(dashboard.archivedCallCount || 1),
    providerCallId: dashboard.providerCallId || `dashboard:${slateDate}:${generatedAt}`,
    providerResponseSha256: dashboard.providerResponseSha256
      || crypto.createHash("sha256").update(canonical).digest("hex"),
    databaseUrl: sourceUrl,
    rows: filtered.rows,
  };
}

function compactSummary(payload) {
  return {
    schemaVersion: payload.schemaVersion,
    date: payload.date,
    checkpoint: payload.checkpoint,
    status: payload.status,
    source: payload.source,
    delivery: payload.delivery,
    databaseUrl: payload.databaseUrl || null,
    rowCount: Number(payload.rowCount || 0),
    quoteCount: Number(payload.quoteCount || 0),
    allAvailableQuoteCount: Number(payload.allAvailableQuoteCount || 0),
    excludedLiveOrPostStartQuoteCount: Number(payload.excludedLiveOrPostStartQuoteCount || 0),
    providerCallId: payload.providerCallId || null,
    providerResponseSha256: payload.providerResponseSha256 || null,
  };
}

async function readLatestRedis() {
  const raw = await redisCommand(["GET", "mlbhr:latest"]);
  return raw ? JSON.parse(raw) : null;
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const view = String(request.query?.view || "");
  if (view === "top100") return handleTop100View(request, response);
  if (view === "discovery-archive") return handleDiscoveryArchiveView(request, response);

  const summaryRequested = String(request.query?.summary || "") === "1";
  const discoveryRequested = String(request.query?.discovery || "") === "1";
  const query = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(request.query || {})) {
    if (!ALLOWED_QUERY_KEYS.has(key)) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value != null && String(value).trim()) query.set(key, String(value).trim());
  }
  if (![...query.keys()].length && !discoveryRequested) query.set("latest", "1");

  const requestedCheckpoint = normalizeCheckpoint(query.get("checkpoint"));
  const slateDate = query.get("date");

  if (discoveryRequested) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(slateDate || "")) || !requestedCheckpoint) {
      return response.status(400).json({
        status: "error",
        message: "Discovery reads require date=YYYY-MM-DD and checkpoint=0817|1117|1717|2017",
      });
    }
    try {
      const archive = await ensureDiscoveryArchive(slateDate, requestedCheckpoint);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("X-Discovery-Source", "upstash-checkpoint-projection");
      if (!archive) {
        return response.status(404).json({
          status: "not_ready",
          date: slateDate,
          checkpoint: requestedCheckpoint,
          message: "Exact Redis checkpoint is not available yet",
        });
      }
      if (request.method === "HEAD") return response.status(200).end();
      return response.status(200).json(archive);
    } catch (error) {
      response.setHeader("Cache-Control", "no-store");
      return response.status(503).json({
        status: "projection_error",
        date: slateDate,
        checkpoint: requestedCheckpoint,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const errors = [];
  let payload = null;
  let selectedUrl = null;

  // Authoritative checkpoint path: the QStash-triggered Vercel capture stored in
  // Redis. This no longer depends on the ChatGPT Site being deployed or healthy.
  if (slateDate && requestedCheckpoint) {
    try {
      const candidate = await readCheckpoint(slateDate, requestedCheckpoint);
      if (candidate) {
        payload = { ...candidate, databaseUrl: `upstash-redis://${slateDate}/${requestedCheckpoint}` };
        selectedUrl = payload.databaseUrl;
      }
    } catch (error) {
      errors.push(`redis checkpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (query.get("latest") === "1") {
    try {
      const candidate = await readLatestRedis();
      if (candidate) {
        payload = { ...candidate, databaseUrl: "upstash-redis://latest" };
        selectedUrl = payload.databaseUrl;
      }
    } catch (error) {
      errors.push(`redis latest: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Compatibility fallback for historical data and during migration.
  if (!payload) {
    const oddsUrl = `${EDGE_BASE_URL}/api/odds?${query.toString()}`;
    try {
      const candidate = await fetchJson(oddsUrl);
      if (candidate?.source !== "mlb-hr-edge-database") {
        throw new Error("Odds response is not database-backed");
      }
      if (requestedCheckpoint && normalizeCheckpoint(candidate.checkpoint) !== requestedCheckpoint) {
        throw new Error(
          `Central odds checkpoint mismatch: requested ${requestedCheckpoint}, received ${candidate.checkpoint || "none"}`,
        );
      }
      payload = candidate;
      selectedUrl = oddsUrl;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!payload && slateDate && !requestedCheckpoint) {
    const dashboardUrl = `${EDGE_BASE_URL}/api/dashboard?${new URLSearchParams({ date: slateDate })}`;
    try {
      payload = normalizeDashboard(await fetchJson(dashboardUrl), slateDate, dashboardUrl);
      selectedUrl = dashboardUrl;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!payload || !selectedUrl) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(502).json({
      status: "error",
      source: "mlb-hr-edge-database",
      checkpoint: requestedCheckpoint || null,
      message: requestedCheckpoint
        ? "Exact checkpoint is not yet available from Upstash or the legacy central database"
        : "Central odds storage is temporarily unavailable for this query",
      errors,
    });
  }

  response.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=45");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("X-Odds-Source", payload.delivery === "qstash-vercel-redis" ? "upstash-qstash" : "mlb-hr-edge-database");
  response.setHeader("X-Central-Database-Url", selectedUrl);
  if (request.method === "HEAD") return response.status(200).end();
  return response.status(200).json(summaryRequested ? compactSummary(payload) : payload);
};
