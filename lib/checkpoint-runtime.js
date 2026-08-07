const crypto = require("node:crypto");
const zlib = require("node:zlib");

const API_BASE = "https://api.sportsgameodds.com/v2";
const BOOKS = ["fanduel", "draftkings", "betmgm"];
const BOOK_SET = new Set(BOOKS);
const HR_KEYS = new Set(["battinghomeruns", "homeruns", "batterhomeruns"]);
const VALID_CHECKPOINTS = new Set(["0817", "1117", "1717", "2017"]);
const ET = "America/New_York";

function envFirst(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function redisConfig() {
  return {
    url: envFirst("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"),
    token: envFirst("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"),
  };
}

async function redisCommand(command) {
  const { url, token } = redisConfig();
  if (!url || !token) throw new Error("Upstash Redis REST environment is missing");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Redis HTTP ${response.status}`);
  }
  return payload.result;
}

async function redisWriteWithRetry(command, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await redisCommand(command);
    } catch (error) {
      last = error;
      if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 150 * (i + 1)));
    }
  }
  throw last;
}

function normalizeCheckpoint(value) {
  const digits = String(value || "").replace(/\D/g, "").padStart(4, "0");
  return VALID_CHECKPOINTS.has(digits) ? digits : null;
}

function etParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter.formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
}

function currentEtDate(now = new Date()) {
  const p = etParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

function addDaysIso(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function intendedSlateDate(checkpoint, now = new Date()) {
  const cp = normalizeCheckpoint(checkpoint);
  if (!cp) throw new Error("Invalid checkpoint");
  const p = etParts(now);
  const today = `${p.year}-${p.month}-${p.day}`;
  const hour = Number(p.hour);
  if (cp === "2017" && hour < 4) return addDaysIso(today, -1);
  return today;
}

function tzOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return asUtc - date.getTime();
}

function zonedToUtc(isoDate, hour, minute, timeZone = ET) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  let utc = new Date(guess.getTime() - tzOffsetMs(guess, timeZone));
  const correction = tzOffsetMs(utc, timeZone);
  utc = new Date(guess.getTime() - correction);
  return utc;
}

function checkpointTargetUtc(slateDate, checkpoint) {
  const cp = normalizeCheckpoint(checkpoint);
  if (!cp) throw new Error("Invalid checkpoint");
  return zonedToUtc(slateDate, Number(cp.slice(0, 2)), Number(cp.slice(2)));
}

function requestBounds(slateDate) {
  return {
    startsAfter: zonedToUtc(slateDate, 0, 0).toISOString(),
    startsBefore: zonedToUtc(addDaysIso(slateDate, 1), 0, 0).toISOString(),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeStat(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseEntity(entity) {
  const parts = String(entity || "").split("_");
  let batterId = null;
  let nameParts = parts;
  if (parts.length >= 3 && /^\d+$/.test(parts.at(-2) || "") && String(parts.at(-1)).toUpperCase() === "MLB") {
    batterId = Number(parts.at(-2));
    nameParts = parts.slice(0, -2);
  }
  const batterName = nameParts.map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ").trim();
  return { batterId, batterName };
}

function playerKey(name) {
  return String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim().replace(/\s+/g, " ")
    .replace(/\s+(jr|sr|ii|iii|iv)$/i, "");
}

function isHrOdd(odd) {
  if (!HR_KEYS.has(normalizeStat(odd?.statID))) return false;
  if (String(odd?.periodID || "game").toLowerCase() !== "game") return false;
  const entity = String(odd?.statEntityID || "");
  if (!entity || ["all", "home", "away"].includes(entity.toLowerCase())) return false;
  const side = String(odd?.sideID || "").toLowerCase();
  const betType = String(odd?.betTypeID || "").toLowerCase();
  if (betType === "yn") return side === "yes";
  if (betType === "ou" && side === "over") {
    const line = odd?.bookOverUnder ?? odd?.fairOverUnder;
    return line == null || Number(line) <= 0.5;
  }
  return false;
}

function teamName(event, side) {
  const names = event?.teams?.[side]?.names || {};
  return names.short || names.medium || names.long || null;
}

function normalizeProviderPayload(raw, slateDate, checkpoint, requestedAt, completedAt) {
  const rows = new Map();
  let allAvailableQuoteCount = 0;
  let excludedLiveOrPostStartQuoteCount = 0;
  for (const event of raw?.data || []) {
    const eventId = String(event?.eventID || "");
    const gameStartAt = event?.status?.startsAt || null;
    const home = teamName(event, "home");
    const away = teamName(event, "away");
    for (const [oddKey, oddValue] of Object.entries(event?.odds || {})) {
      const odd = oddValue || {};
      if (!isHrOdd(odd)) continue;
      const { batterId, batterName } = parseEntity(odd.statEntityID);
      if (!batterId || !batterName) continue;
      const rowKey = `${batterId}:${eventId}`;
      if (!rows.has(rowKey)) {
        rows.set(rowKey, {
          predictionId: null,
          gameDate: slateDate,
          gamePk: null,
          gameStartAt,
          batterId,
          batterName,
          batterTeam: null,
          matchup: away && home ? `${away} @ ${home}` : null,
          lineupPosition: null,
          lineupConfirmed: false,
          playerKey: playerKey(batterName),
          sourceEventId: eventId,
          odds: {},
        });
      }
      const row = rows.get(rowKey);
      for (const [bookName, bookValue] of Object.entries(odd?.byBookmaker || {})) {
        const book = String(bookName).toLowerCase();
        if (!BOOK_SET.has(book)) continue;
        const info = bookValue || {};
        if ([false, "false", "0", "no", "off", ""].includes(info.available)) continue;
        const americanOdds = Number(info.odds);
        if (!Number.isFinite(americanOdds) || americanOdds === 0) continue;
        allAvailableQuoteCount += 1;
        const capturedAt = String(info.lastUpdatedAt || completedAt);
        if (gameStartAt && Date.parse(capturedAt) >= Date.parse(gameStartAt)) {
          excludedLiveOrPostStartQuoteCount += 1;
          continue;
        }
        row.odds[book] = {
          americanOdds: Math.trunc(americanOdds),
          capturedAt,
          source: "qstash-vercel-sportsgameodds",
          sourceEventId: eventId,
          sourceOddId: String(odd.oddID || oddKey),
        };
      }
    }
  }
  const filteredRows = [...rows.values()].filter((row) => Object.keys(row.odds).length > 0);
  const quoteCount = filteredRows.reduce((sum, row) => sum + Object.keys(row.odds).length, 0);
  const responseSha256 = crypto.createHash("sha256").update(canonical(raw)).digest("hex");
  const providerCallId = `${slateDate}:${checkpoint}:${completedAt}:${responseSha256.slice(0, 12)}`;
  for (const row of filteredRows) {
    for (const quote of Object.values(row.odds)) quote.callId = providerCallId;
  }
  return {
    schemaVersion: 4,
    date: slateDate,
    checkpoint,
    asOf: checkpointTargetUtc(slateDate, checkpoint).toISOString(),
    generatedAt: completedAt,
    latestIngestAt: completedAt,
    status: quoteCount > 0 ? "ready" : "pending",
    source: "mlb-hr-edge-database",
    delivery: "qstash-vercel-redis",
    books: BOOKS,
    rowCount: filteredRows.length,
    quoteCount,
    allAvailableQuoteCount,
    excludedLiveOrPostStartQuoteCount,
    archivedCallCount: 1,
    providerCallId,
    providerResponseSha256: responseSha256,
    providerRequestedAt: requestedAt,
    providerCompletedAt: completedAt,
    rows: filteredRows,
  };
}

function archiveKey(date, checkpoint) {
  return `mlbhr:checkpoint:${date}:${checkpoint}`;
}
function rawKey(date, checkpoint) {
  return `mlbhr:raw:${date}:${checkpoint}`;
}
function attemptKey(date, checkpoint) {
  return `mlbhr:attempt:${date}:${checkpoint}`;
}

async function readCheckpoint(date, checkpoint) {
  const cp = normalizeCheckpoint(checkpoint);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || !cp) return null;
  const raw = await redisCommand(["GET", archiveKey(date, cp)]);
  return raw ? JSON.parse(raw) : null;
}

async function captureCheckpoint({ slateDate, checkpoint, now = new Date() }) {
  const cp = normalizeCheckpoint(checkpoint);
  if (!cp) throw new Error("Invalid checkpoint");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slateDate)) throw new Error("Invalid slate date");
  const existing = await readCheckpoint(slateDate, cp);
  if (existing) return { outcome: "reused", providerRequests: 0, payload: existing };

  const target = checkpointTargetUtc(slateDate, cp);
  const latenessMs = now.getTime() - target.getTime();
  if (latenessMs < -60_000 || latenessMs > 15 * 60_000) {
    return { outcome: "outside_window", providerRequests: 0, targetAt: target.toISOString(), observedAt: now.toISOString() };
  }

  const attempt = await redisCommand(["SET", attemptKey(slateDate, cp), now.toISOString(), "NX", "EX", 172800]);
  if (attempt !== "OK") {
    const raced = await readCheckpoint(slateDate, cp);
    return raced
      ? { outcome: "reused", providerRequests: 0, payload: raced }
      : { outcome: "already_attempted", providerRequests: 0 };
  }

  const apiKey = envFirst("SPORTSGAMEODDS_API_KEY");
  if (!apiKey) throw new Error("SPORTSGAMEODDS_API_KEY is missing in Vercel production");
  const bounds = requestBounds(slateDate);
  const params = new URLSearchParams({
    leagueID: "MLB",
    startsAfter: bounds.startsAfter,
    startsBefore: bounds.startsBefore,
    oddsAvailable: "true",
    bookmakerID: BOOKS.join(","),
    limit: "50",
    includeOpenCloseOdds: "false",
  });
  const endpoint = `${API_BASE}/events?${params}`;
  const requestedAt = new Date().toISOString();
  let raw;
  try {
    const upstream = await fetch(endpoint, {
      headers: { "x-api-key": apiKey, Accept: "application/json", "User-Agent": "hr-form-qstash-checkpoint/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstream.text();
    if (!upstream.ok) throw new Error(`SportsGameOdds HTTP ${upstream.status}`);
    raw = JSON.parse(text);
  } catch (error) {
    await redisWriteWithRetry(["SET", `mlbhr:failure:${slateDate}:${cp}`, JSON.stringify({
      status: "provider_failed_after_single_attempt",
      message: error instanceof Error ? error.message : String(error),
      requestedAt,
    }), "EX", 34560000]);
    return { outcome: "provider_failed_after_single_attempt", providerRequests: 1, error: error instanceof Error ? error.message : String(error) };
  }
  const completedAt = new Date().toISOString();
  if (raw?.nextCursor) {
    await redisWriteWithRetry(["SET", `mlbhr:failure:${slateDate}:${cp}`, JSON.stringify({
      status: "pagination_refused_second_call", requestedAt, completedAt,
    }), "EX", 34560000]);
    return { outcome: "pagination_refused_second_call", providerRequests: 1 };
  }

  const compact = normalizeProviderPayload(raw, slateDate, cp, requestedAt, completedAt);
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(raw))).toString("base64");
  const rawArchive = {
    schemaVersion: 1,
    date: slateDate,
    checkpoint: cp,
    provider: "sportsgameodds",
    endpoint: `${API_BASE}/events`,
    requestParams: Object.fromEntries(params.entries()),
    requestedAt,
    completedAt,
    responseSha256: compact.providerResponseSha256,
    responseEncoding: "gzip+base64",
    responseGzipBase64: compressed,
    eventCount: Array.isArray(raw?.data) ? raw.data.length : 0,
    quoteCount: compact.quoteCount,
  };

  const compactJson = JSON.stringify(compact);
  const rawJson = JSON.stringify(rawArchive);
  const score = Math.floor(Date.parse(completedAt) / 1000);
  await redisWriteWithRetry(["SET", archiveKey(slateDate, cp), compactJson, "EX", 34560000]);
  await redisWriteWithRetry(["SET", rawKey(slateDate, cp), rawJson, "EX", 3888000]);
  await redisWriteWithRetry(["SET", "mlbhr:latest", compactJson, "EX", 34560000]);
  await redisWriteWithRetry(["ZADD", "mlbhr:checkpoint-history", score, archiveKey(slateDate, cp)]);
  return { outcome: "captured", providerRequests: 1, payload: compact };
}

function checkpointAuth() {
  const token = envFirst("QSTASH_TOKEN");
  if (!token) return "";
  return crypto.createHmac("sha256", token).update("hr-form-checkpoint-v1").digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = {
  BOOKS,
  VALID_CHECKPOINTS,
  archiveKey,
  captureCheckpoint,
  checkpointAuth,
  checkpointTargetUtc,
  currentEtDate,
  envFirst,
  intendedSlateDate,
  normalizeCheckpoint,
  readCheckpoint,
  redisCommand,
  redisConfig,
  safeEqual,
};
