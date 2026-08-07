const {
  archiveKey,
  captureCheckpoint,
  checkpointAuth,
  checkpointTargetUtc,
  envFirst,
  readCheckpoint,
  redisCommand,
  safeEqual,
} = require("../lib/checkpoint-runtime");

const TEST_DATE = "2026-08-07";
const TEST_CHECKPOINT = "0817";
const CENTRAL_URL = `https://hr-form-board-actions.vercel.app/api/central-odds?date=${TEST_DATE}&checkpoint=${TEST_CHECKPOINT}`;

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const expected = checkpointAuth();
  const supplied = request.headers["x-checkpoint-auth"];
  if (!expected || !safeEqual(supplied, expected)) {
    return response.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const key = archiveKey(TEST_DATE, TEST_CHECKPOINT);
  const rawKey = `mlbhr:raw:${TEST_DATE}:${TEST_CHECKPOINT}`;
  const attemptKey = `mlbhr:attempt:${TEST_DATE}:${TEST_CHECKPOINT}`;
  const failureKey = `mlbhr:failure:${TEST_DATE}:${TEST_CHECKPOINT}`;
  const existing = await readCheckpoint(TEST_DATE, TEST_CHECKPOINT);
  if (existing) {
    return response.status(409).json({
      status: "refused",
      message: "Real 08:17 checkpoint already exists; smoke test will not overwrite it",
      providerRequests: 0,
    });
  }

  let providerKey = envFirst("SPORTSGAMEODDS_API_KEY");
  if (!providerKey) {
    providerKey = String(await redisCommand(["GET", "mlbhr:config:sportsgameodds-api-key"]) || "").trim();
  }
  if (!providerKey) {
    return response.status(503).json({ status: "configuration_missing", providerRequests: 0 });
  }
  process.env.SPORTSGAMEODDS_API_KEY = providerKey;

  const previousLatest = await redisCommand(["GET", "mlbhr:latest"]);
  let result = null;
  let stored = null;
  let rawArchive = null;
  let central = null;
  let centralHttpStatus = null;
  let testError = null;

  try {
    const target = checkpointTargetUtc(TEST_DATE, TEST_CHECKPOINT);
    result = await captureCheckpoint({
      slateDate: TEST_DATE,
      checkpoint: TEST_CHECKPOINT,
      now: new Date(target.getTime() + 1000),
    });
    stored = await readCheckpoint(TEST_DATE, TEST_CHECKPOINT);
    const rawText = await redisCommand(["GET", rawKey]);
    rawArchive = rawText ? JSON.parse(rawText) : null;

    const centralResponse = await fetch(CENTRAL_URL, { cache: "no-store" });
    centralHttpStatus = centralResponse.status;
    central = await centralResponse.json().catch(() => null);

    const pass = Boolean(
      result?.outcome === "captured"
      && result?.providerRequests === 1
      && stored
      && rawArchive
      && rawArchive.responseEncoding === "gzip+base64"
      && rawArchive.responseGzipBase64
      && centralResponse.ok
      && central?.date === TEST_DATE
      && String(central?.checkpoint) === TEST_CHECKPOINT
      && central?.providerResponseSha256 === stored?.providerResponseSha256
      && central?.providerCallId === stored?.providerCallId
    );

    if (!pass) {
      testError = "One or more end-to-end assertions failed";
    }

    response.setHeader("Cache-Control", "no-store");
    return response.status(pass ? 200 : 500).json({
      status: pass ? "passed" : "failed",
      providerRequests: result?.providerRequests ?? 0,
      captureOutcome: result?.outcome || null,
      providerCallId: stored?.providerCallId || null,
      providerResponseSha256: stored?.providerResponseSha256 || null,
      quoteCount: Number(stored?.quoteCount || 0),
      rowCount: Number(stored?.rowCount || 0),
      rawArchivePresent: Boolean(rawArchive?.responseGzipBase64),
      rawEventCount: Number(rawArchive?.eventCount || 0),
      rawQuoteCount: Number(rawArchive?.quoteCount || 0),
      centralHttpStatus,
      centralMatchedProviderCall: Boolean(
        central?.providerCallId && central?.providerCallId === stored?.providerCallId
      ),
      centralMatchedHash: Boolean(
        central?.providerResponseSha256
        && central?.providerResponseSha256 === stored?.providerResponseSha256
      ),
      cleanup: "performed in finally",
      error: testError,
    });
  } catch (error) {
    testError = error instanceof Error ? error.message : String(error);
    response.setHeader("Cache-Control", "no-store");
    return response.status(500).json({
      status: "failed",
      providerRequests: result?.providerRequests ?? 0,
      captureOutcome: result?.outcome || null,
      error: testError,
      cleanup: "performed in finally",
    });
  } finally {
    try {
      await redisCommand(["DEL", key, rawKey, attemptKey, failureKey]);
      await redisCommand(["ZREM", "mlbhr:checkpoint-history", key]);
      if (previousLatest) {
        await redisCommand(["SET", "mlbhr:latest", previousLatest, "EX", 34560000]);
      } else {
        await redisCommand(["DEL", "mlbhr:latest"]);
      }
    } catch (cleanupError) {
      console.error("FULL_CHECKPOINT_SMOKE_CLEANUP_FAILED", cleanupError);
    }
  }
};
