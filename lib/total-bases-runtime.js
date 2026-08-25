const crypto = require('node:crypto');
const {
  checkpointTargetUtc,
  normalizeCheckpoint,
  playerKey,
  readRawArchive,
  redisCommand,
} = require('./checkpoint-runtime');

const BOOKS = ['fanduel', 'draftkings', 'betmgm'];
const BOOK_SET = new Set(BOOKS);
const TOTAL_BASES_KEYS = new Set(['battingtotalbases', 'totalbases', 'battertotalbases']);
const TARGET_LINE = 1.5;
const SCHEMA_VERSION = 1;

function normalizeStat(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parsePlayerName(entity) {
  const parts = String(entity || '').split('_');
  let nameParts = parts;
  if (
    parts.length >= 3
    && /^\d+$/.test(parts.at(-2) || '')
    && String(parts.at(-1)).toUpperCase() === 'MLB'
  ) {
    nameParts = parts.slice(0, -2);
  }
  return nameParts
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : ''))
    .join(' ')
    .trim();
}

function isTotalBasesOdd(odd) {
  if (!TOTAL_BASES_KEYS.has(normalizeStat(odd?.statID))) return false;
  if (String(odd?.periodID || 'game').toLowerCase() !== 'game') return false;
  const entity = String(odd?.statEntityID || '');
  if (!entity || ['all', 'home', 'away'].includes(entity.toLowerCase())) return false;
  if (String(odd?.betTypeID || '').toLowerCase() !== 'ou') return false;
  return ['over', 'under'].includes(String(odd?.sideID || '').toLowerCase());
}

function teamName(event, side) {
  const names = event?.teams?.[side]?.names || {};
  return names.short || names.medium || names.long || null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isAvailable(value) {
  return ![false, 'false', '0', 'no', 'off', ''].includes(value);
}

function quoteLine(odd, info) {
  for (const value of [
    info?.overUnder,
    info?.bookOverUnder,
    info?.line,
    odd?.bookOverUnder,
    odd?.fairOverUnder,
    odd?.overUnder,
    odd?.line,
  ]) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeTotalBasesProviderPayload(raw, slateDate, checkpoint, requestedAt, completedAt) {
  const rows = new Map();
  let allAvailableQuoteCount = 0;
  let excludedWrongLineQuoteCount = 0;
  let excludedLiveOrPostStartQuoteCount = 0;

  for (const event of raw?.data || []) {
    const eventId = String(event?.eventID || '');
    const gameStartAt = event?.status?.startsAt || null;
    const home = teamName(event, 'home');
    const away = teamName(event, 'away');

    for (const [oddKey, oddValue] of Object.entries(event?.odds || {})) {
      const odd = oddValue || {};
      if (!isTotalBasesOdd(odd)) continue;

      const providerEntityId = String(odd.statEntityID || '');
      const batterName = parsePlayerName(providerEntityId);
      if (!batterName) continue;
      const side = String(odd.sideID || '').toLowerCase();
      const rowKey = `${eventId}:${providerEntityId || playerKey(batterName)}`;

      if (!rows.has(rowKey)) {
        rows.set(rowKey, {
          gameDate: slateDate,
          gameStartAt,
          batterId: null,
          batterName,
          playerKey: playerKey(batterName),
          matchup: away && home ? `${away} @ ${home}` : null,
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
        if (!isAvailable(info.available)) continue;

        const americanOdds = Number(info.odds);
        const line = quoteLine(odd, info);
        if (!Number.isFinite(americanOdds) || americanOdds === 0 || !Number.isFinite(line)) continue;
        allAvailableQuoteCount += 1;
        if (Math.abs(line - TARGET_LINE) > 1e-9) {
          excludedWrongLineQuoteCount += 1;
          continue;
        }

        const capturedAt = String(info.lastUpdatedAt || completedAt);
        if (gameStartAt && Date.parse(capturedAt) >= Date.parse(gameStartAt)) {
          excludedLiveOrPostStartQuoteCount += 1;
          continue;
        }

        if (!row.odds[book]) row.odds[book] = {};
        row.odds[book][side] = {
          americanOdds: Math.trunc(americanOdds),
          line: TARGET_LINE,
          capturedAt,
          source: 'archived-sportsgameodds-events',
          sourceEventId: eventId,
          sourceOddId: String(odd.oddID || oddKey),
        };
      }
    }
  }

  const filteredRows = [...rows.values()].filter((row) =>
    Object.values(row.odds).some((book) => book?.over || book?.under));
  const quoteCount = filteredRows.reduce(
    (sum, row) => sum + Object.values(row.odds).reduce(
      (bookSum, quote) => bookSum + Number(Boolean(quote?.over)) + Number(Boolean(quote?.under)),
      0,
    ),
    0,
  );
  const responseSha256 = crypto.createHash('sha256').update(canonical(raw)).digest('hex');
  const providerCallId = `${slateDate}:${checkpoint}:${completedAt}:${responseSha256.slice(0, 12)}`;
  for (const row of filteredRows) {
    for (const book of Object.values(row.odds)) {
      if (book.over) book.over.callId = providerCallId;
      if (book.under) book.under.callId = providerCallId;
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    market: 'batter-total-bases-ou-1.5',
    label: '2+ Total Bases',
    statID: 'batting_totalBases',
    targetLine: TARGET_LINE,
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
    excludedWrongLineQuoteCount,
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

function totalBasesArchiveKey(date, checkpoint) {
  return `mlbtb2:checkpoint:${date}:${checkpoint}`;
}

async function repairTotalBasesCheckpointFromRaw(date, checkpoint, existing = null) {
  const stored = await readRawArchive(date, checkpoint);
  if (!stored) return existing;
  const { archive, responsePayload } = stored;
  const rebuilt = normalizeTotalBasesProviderPayload(
    responsePayload,
    date,
    checkpoint,
    archive.requestedAt || existing?.providerRequestedAt || archive.completedAt,
    archive.completedAt || existing?.providerCompletedAt || new Date().toISOString(),
  );
  if (archive.responseSha256 && rebuilt.providerResponseSha256 !== archive.responseSha256) {
    throw new Error('Raw provider archive SHA does not match rebuilt total-bases checkpoint');
  }
  await redisCommand([
    'SET',
    totalBasesArchiveKey(date, checkpoint),
    JSON.stringify(rebuilt),
    'EX',
    34560000,
  ]);
  return rebuilt;
}

async function readTotalBasesCheckpoint(date, checkpoint) {
  const cp = normalizeCheckpoint(checkpoint);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !cp) return null;
  const raw = await redisCommand(['GET', totalBasesArchiveKey(date, cp)]);
  if (raw) {
    const payload = JSON.parse(raw);
    if (Number(payload.schemaVersion || 0) >= SCHEMA_VERSION) return payload;
  }
  return repairTotalBasesCheckpointFromRaw(date, cp, raw ? JSON.parse(raw) : null);
}

module.exports = {
  BOOKS,
  TARGET_LINE,
  normalizeTotalBasesProviderPayload,
  readTotalBasesCheckpoint,
  repairTotalBasesCheckpointFromRaw,
  totalBasesArchiveKey,
};
