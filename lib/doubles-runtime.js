const crypto = require('node:crypto');
const {
  normalizeCheckpoint,
  checkpointTargetUtc,
  parseEntity,
  playerKey,
  readRawArchive,
  redisCommand,
} = require('./checkpoint-runtime');

const BOOKS = ['fanduel', 'draftkings', 'betmgm'];
const BOOK_SET = new Set(BOOKS);
const DOUBLES_KEYS = new Set(['battingdoubles', 'doubles', 'batterdoubles']);
const SCHEMA_VERSION = 1;

function normalizeStat(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isDoublesOdd(odd) {
  if (!DOUBLES_KEYS.has(normalizeStat(odd?.statID))) return false;
  if (String(odd?.periodID || 'game').toLowerCase() !== 'game') return false;
  const entity = String(odd?.statEntityID || '');
  if (!entity || ['all', 'home', 'away'].includes(entity.toLowerCase())) return false;
  const side = String(odd?.sideID || '').toLowerCase();
  const betType = String(odd?.betTypeID || '').toLowerCase();
  if (betType === 'yn') return side === 'yes';
  if (betType === 'ou' && side === 'over') {
    const line = odd?.bookOverUnder ?? odd?.fairOverUnder;
    return line == null || Number(line) <= 0.5;
  }
  return false;
}

function teamName(event, side) {
  const names = event?.teams?.[side]?.names || {};
  return names.short || names.medium || names.long || null;
}

function normalizeDoublesPayload(raw, slateDate, checkpoint, requestedAt, completedAt) {
  const rows = new Map();
  let allAvailableQuoteCount = 0;
  let excludedLiveOrPostStartQuoteCount = 0;

  for (const event of raw?.data || []) {
    const eventId = String(event?.eventID || '');
    const gameStartAt = event?.status?.startsAt || null;
    const home = teamName(event, 'home');
    const away = teamName(event, 'away');

    for (const [oddKey, oddValue] of Object.entries(event?.odds || {})) {
      const odd = oddValue || {};
      if (!isDoublesOdd(odd)) continue;
      const providerEntityId = String(odd.statEntityID || '');
      const { batterName } = parseEntity(providerEntityId);
      if (!batterName) continue;

      const rowKey = `${eventId}:${providerEntityId || playerKey(batterName)}`;
      if (!rows.has(rowKey)) {
        rows.set(rowKey, {
          predictionId: null,
          gameDate: slateDate,
          gamePk: null,
          gameStartAt,
          batterId: null,
          batterName,
          batterTeam: null,
          matchup: away && home ? `${away} @ ${home}` : null,
          lineupPosition: null,
          lineupConfirmed: false,
          playerKey: playerKey(batterName),
          providerEntityId,
          sourceEventId: eventId,
          odds: {},
        });
      }

      const row = rows.get(rowKey);
      for (const [bookName, bookValue] of Object.entries(odd?.byBookmaker || {})) {
        const book = String(bookName).toLowerCase();
        if (!BOOK_SET.has(book)) continue;
        const info = bookValue || {};
        if ([false, 'false', '0', 'no', 'off', ''].includes(info.available)) continue;
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
          source: 'archived-sportsgameodds-events',
          sourceEventId: eventId,
          sourceOddId: String(odd.oddID || oddKey),
        };
      }
    }
  }

  const filteredRows = [...rows.values()].filter((row) => Object.keys(row.odds).length > 0);
  const quoteCount = filteredRows.reduce((sum, row) => sum + Object.keys(row.odds).length, 0);
  const responseSha256 = crypto.createHash('sha256').update(canonical(raw)).digest('hex');
  const providerCallId = `${slateDate}:${checkpoint}:${completedAt}:${responseSha256.slice(0, 12)}`;
  for (const row of filteredRows) {
    for (const quote of Object.values(row.odds)) quote.callId = providerCallId;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    market: 'batter-doubles-yes',
    date: slateDate,
    checkpoint,
    asOf: checkpointTargetUtc(slateDate, checkpoint).toISOString(),
    generatedAt: completedAt,
    latestIngestAt: completedAt,
    status: quoteCount > 0 ? 'ready' : 'pending',
    source: 'archived-sportsgameodds-events',
    delivery: 'existing-archive-readonly',
    identityMapping: 'provider-name-awaiting-mlbam-hydration',
    books: BOOKS,
    rowCount: filteredRows.length,
    quoteCount,
    allAvailableQuoteCount,
    excludedLiveOrPostStartQuoteCount,
    eventCount: Array.isArray(raw?.data) ? raw.data.length : 0,
    archivedCallCount: 1,
    providerRequests: 0,
    quotaObjectsAdded: 0,
    providerCallId,
    providerResponseSha256: responseSha256,
    providerRequestedAt: requestedAt,
    providerCompletedAt: completedAt,
    rows: filteredRows,
  };
}

function archiveKey(date, checkpoint) {
  return `mlbdoubles:checkpoint:${date}:${checkpoint}`;
}

async function readDoublesCheckpoint(date, checkpoint) {
  const cp = normalizeCheckpoint(checkpoint);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !cp) return null;

  try {
    const cached = await redisCommand(['GET', archiveKey(date, cp)]);
    if (cached) {
      const payload = JSON.parse(cached);
      if (Number(payload.schemaVersion || 0) >= SCHEMA_VERSION) return payload;
    }
  } catch (_) {
    // Fall through to the immutable raw checkpoint archive.
  }

  const stored = await readRawArchive(date, cp);
  if (!stored) return null;
  const { archive, responsePayload } = stored;
  const rebuilt = normalizeDoublesPayload(
    responsePayload,
    date,
    cp,
    archive.requestedAt || archive.completedAt,
    archive.completedAt || new Date().toISOString(),
  );
  if (archive.responseSha256 && rebuilt.providerResponseSha256 !== archive.responseSha256) {
    throw new Error('Raw provider archive SHA does not match rebuilt doubles checkpoint');
  }
  try {
    await redisCommand(['SET', archiveKey(date, cp), JSON.stringify(rebuilt), 'EX', 34560000]);
  } catch (_) {
    // Read-only delivery still succeeds even if the derived cache write fails.
  }
  return rebuilt;
}

module.exports = {
  BOOKS,
  DOUBLES_KEYS,
  isDoublesOdd,
  normalizeDoublesPayload,
  readDoublesCheckpoint,
};
